/* =========================================================================
 * DarriusAI - chart.core.js (Integrated, Idempotent Init)
 * Fixes:
 *  1) Chart blank: auto-try multiple OHLCV endpoints (avoid HTTP 404)
 *  2) EMA split color: MT4 EMPTY_VALUE => LightweightCharts null gaps
 *     - Only ONE EMA visible at a time (green for above, red for below)
 *  3) Robust parsing for different backend payload shapes
 *  4) Safe toggles, safe init, no subscription/billing touch
 * ========================================================================= */

(() => {
  "use strict";

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);
  const qs = (sel) => document.querySelector(sel);

  // -----------------------------
  // Config
  // -----------------------------
  const DEFAULT_API_BASE =
    window.DARRIUS_API_BASE ||
    window.__API_BASE__ ||
    "https://darrius-api.onrender.com";

  // Try multiple paths to avoid “route mismatch => 404 => blank chart”
  const OHLCV_PATH_CANDIDATES = [
    "/api/ohlcv",
    "/ohlcv",
    "/api/bars",
    "/bars",
    "/api/market/ohlcv",
    "/market/ohlcv",
  ];

  // -----------------------------
  // State
  // -----------------------------
  let containerEl = null;
  let overlayEl = null;

  let chart = null;
  let candleSeries = null;

  // EMA split (two series but only one visible per bar via null gaps)
  let emaUp = null;   // green
  let emaDown = null; // red

  // AUX series (single fixed color)
  let auxSeries = null;

  // markers cache
  let CURRENT_SIGS = [];
  let LAST_BARS = [];

  // toggle state
  let showEMA = true;
  let showAUX = true;

  // -----------------------------
  // Logging
  // -----------------------------
  function log(...args) {
    console.log(...args);
  }

  // -----------------------------
  // UI readers (tolerant to different ids)
  // -----------------------------
  function getUiSymbol() {
    // Try common ids / inputs
    const el =
      $("symbolInput") ||
      $("symInput") ||
      $("symbol") ||
      qs('input[name="symbol"]') ||
      qs("#symbol") ||
      qs("#sym");

    const v = el && (el.value || el.textContent);
    return (v || "BTCUSDT").trim();
  }

  function getUiTf() {
    const el =
      $("tfSelect") ||
      $("timeframeSelect") ||
      $("tf") ||
      qs('select[name="timeframe"]') ||
      qs("#timeframe");

    const v = el && (el.value || el.textContent);
    return (v || "1d").trim();
  }

  // -----------------------------
  // Robust fetch helpers
  // -----------------------------
  async function fetchJson(url) {
    const r = await fetch(url, { method: "GET", credentials: "omit" });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      err.body = text;
      throw err;
    }
    return r.json();
  }

  function toUnixTime(t) {
    // LightweightCharts supports:
    // - seconds (number)
    // - { year, month, day }
    // We'll convert ms/iso to seconds number.
    if (t == null) return null;
    if (typeof t === "number") {
      // if ms
      if (t > 2e10) return Math.floor(t / 1000);
      return t;
    }
    if (typeof t === "string") {
      const ms = Date.parse(t);
      if (!Number.isFinite(ms)) return null;
      return Math.floor(ms / 1000);
    }
    if (typeof t === "object" && t.year && t.month && t.day) return t;
    return null;
  }

  function normalizeBars(payload) {
    // Accept many shapes:
    // 1) payload = [{time,open,high,low,close}, ...]
    // 2) payload = { bars: [...] }
    // 3) payload = { ohlcv: [...] }
    // 4) payload = { data: [...] }
    const raw =
      Array.isArray(payload) ? payload :
      payload?.bars ? payload.bars :
      payload?.ohlcv ? payload.ohlcv :
      payload?.data ? payload.data :
      [];

    const bars = (raw || [])
      .map((b) => {
        const time = toUnixTime(b.time ?? b.t ?? b.timestamp ?? b.ts ?? b.date);
        const open = Number(b.open ?? b.o ?? b.Open);
        const high = Number(b.high ?? b.h ?? b.High);
        const low  = Number(b.low  ?? b.l ?? b.Low);
        const close= Number(b.close?? b.c ?? b.Close);
        if (!time || !isFinite(open) || !isFinite(high) || !isFinite(low) || !isFinite(close)) return null;
        return { time, open, high, low, close };
      })
      .filter(Boolean);

    return bars;
  }

  function normalizeLinePoints(payload, keyCandidates) {
    // payload could be:
    // - payload.ema: [{time,value}]
    // - payload.indicators.ema: ...
    // - payload.lines.ema: ...
    // If not found, return [].
    const pick = (obj, keys) => {
      for (const k of keys) {
        if (obj && obj[k] != null) return obj[k];
      }
      return null;
    };

    const src =
      pick(payload, keyCandidates) ||
      pick(payload?.indicators || {}, keyCandidates) ||
      pick(payload?.lines || {}, keyCandidates) ||
      [];

    const arr = Array.isArray(src) ? src : [];
    return arr
      .map((p) => {
        const time = toUnixTime(p.time ?? p.t ?? p.timestamp ?? p.ts ?? p.date);
        const value = Number(p.value ?? p.v ?? p.val);
        if (!time || !isFinite(value)) return null;
        return { time, value };
      })
      .filter(Boolean);
  }

  function normalizeSignals(payload) {
    // Accept: payload.sigs / payload.signals
    const raw = payload?.sigs || payload?.signals || [];
    if (!Array.isArray(raw)) return [];
    return raw
      .map((s) => {
        const time = toUnixTime(s.time ?? s.t ?? s.timestamp ?? s.ts ?? s.date);
        const side = (s.side ?? s.type ?? s.action ?? "").toString().toUpperCase();
        if (!time || (side !== "B" && side !== "S")) return null;
        return { time, side };
      })
      .filter(Boolean);
  }

  async function fetchMarketPack(sym, tf) {
    const apiBase = (DEFAULT_API_BASE || "").replace(/\/+$/, "");
    const q = `symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;

    let lastErr = null;

    for (const p of OHLCV_PATH_CANDIDATES) {
      const url = `${apiBase}${p}?${q}`;
      try {
        const payload = await fetchJson(url);
        return { payload, urlUsed: url };
      } catch (e) {
        lastErr = e;
        // Try next path on 404/405; for others also try next (robust)
        continue;
      }
    }

    const err = new Error(`All OHLCV endpoints failed. Last error: ${lastErr?.message || lastErr}`);
    err.cause = lastErr;
    throw err;
  }

  // -----------------------------
  // EMA split color (EMPTY_VALUE => null)
  // Rule: close >= ema => show green(emaUp), hide red(emaDown)
  //       close <  ema => show red(emaDown), hide green(emaUp)
  // Add boundary stitching to avoid ugly gaps at color switch.
  // -----------------------------
  function buildSplitEmaPoints(bars, emaPoints) {
    if (!bars?.length || !emaPoints?.length) return { up: [], down: [] };

    // map ema by time
    const emaMap = new Map(emaPoints.map((p) => [p.time, p.value]));

    const up = [];
    const down = [];

    let prevState = null; // "UP" or "DOWN"
    let prevTime = null;
    let prevEma = null;

    for (let i = 0; i < bars.length; i++) {
      const t = bars[i].time;
      const ema = emaMap.get(t);
      if (!isFinite(ema)) continue;

      const close = bars[i].close;
      const state = close >= ema ? "UP" : "DOWN";

      // Default: one visible, one null
      let upVal = state === "UP" ? ema : null;
      let dnVal = state === "DOWN" ? ema : null;

      // Stitch at turning point (so it looks like one continuous line that changes color)
      // If state changes at this bar, also set previous bar value on both series (if possible)
      if (prevState && state !== prevState && prevTime != null && isFinite(prevEma)) {
        // Put a connecting point at prev bar on the new state series
        // and at current bar on the old state series (minimal overlap for smooth switch)
        if (state === "UP") {
          // switched DOWN -> UP
          // show green starting from prev bar
          up[up.length - 1] = { time: prevTime, value: prevEma };
          // keep red until current bar, then it goes null next bars
          dnVal = ema; // draw red at switch bar too, then red becomes null afterwards
        } else {
          // switched UP -> DOWN
          down[down.length - 1] = { time: prevTime, value: prevEma };
          upVal = ema;
        }
      }

      up.push({ time: t, value: upVal });
      down.push({ time: t, value: dnVal });

      prevState = state;
      prevTime = t;
      prevEma = ema;
    }

    return { up, down };
  }

  // -----------------------------
  // Markers (B yellow, S white)
  // -----------------------------
  function applyMarkers(sigs) {
    CURRENT_SIGS = sigs || [];
    if (!candleSeries) return;

    candleSeries.setMarkers(
      (CURRENT_SIGS || []).map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#FFD400" : "#FFFFFF",
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: s.side,
      }))
    );
  }

  // -----------------------------
  // Toggles
  // -----------------------------
  function applyToggles() {
    showEMA = !!($("toggleEMA")?.checked ?? $("emaToggle")?.checked ?? showEMA);
    showAUX = !!($("toggleAUX")?.checked ?? $("auxToggle")?.checked ?? showAUX);

    // Fallback: if your UI uses #emaCheck/#auxCheck or other ids
    const altEma = $("emaCheck")?.checked;
    const altAux = $("auxCheck")?.checked;
    if (typeof altEma === "boolean") showEMA = altEma;
    if (typeof altAux === "boolean") showAUX = altAux;

    if (emaUp) emaUp.applyOptions({ visible: showEMA });
    if (emaDown) emaDown.applyOptions({ visible: showEMA });
    if (auxSeries) auxSeries.applyOptions({ visible: showAUX });
  }

  // -----------------------------
  // Core load
  // -----------------------------
  async function load() {
    if (!chart || !candleSeries) return;

    const sym = getUiSymbol();
    const tf = getUiTf();

    // top hint (if exists)
    if ($("hintText")) $("hintText").textContent = "Loading...";

    let pack;
    try {
      pack = await fetchMarketPack(sym, tf);
    } catch (e) {
      log("[ChartCore] load failed:", e.message || e);
      if ($("hintText")) $("hintText").textContent = `加载失败：${e.message || e}`;
      throw e;
    }

    const payload = pack.payload;

    const bars = normalizeBars(payload);
    if (!bars.length) {
      if ($("hintText")) $("hintText").textContent = `加载失败：bars 为空（检查后端返回结构）`;
      throw new Error("bars empty");
    }

    LAST_BARS = bars;

    // Set candles
    candleSeries.setData(bars);

    // EMA points: prefer payload.ema; if not present, compute EMA from closes as fallback
    let emaPts = normalizeLinePoints(payload, ["ema", "EMA"]);
    if (!emaPts.length) {
      emaPts = computeEmaFromBars(bars, 20);
    }

    const split = buildSplitEmaPoints(bars, emaPts);
    emaUp.setData(split.up);
    emaDown.setData(split.down);

    // AUX points
    const auxPts = normalizeLinePoints(payload, ["aux", "AUX"]);
    auxSeries.setData(auxPts);

    // Signals (B/S)
    const sigs = normalizeSignals(payload);
    applyMarkers(sigs);

    // Fit
    chart.timeScale().fitContent();

    // Texts
    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

    const sigCount = sigs.length;
    if ($("hintText")) $("hintText").textContent = `Loaded · 已加载（TF=${tf} · sigs=${sigCount}）`;

    // Apply toggles after data set
    applyToggles();

    return { urlUsed: pack.urlUsed, bars: bars.length, sigs: sigCount };
  }

  // Simple EMA fallback if backend doesn't provide ema[]
  function computeEmaFromBars(bars, period) {
    const k = 2 / (period + 1);
    let ema = null;
    const out = [];
    for (let i = 0; i < bars.length; i++) {
      const c = bars[i].close;
      ema = ema == null ? c : c * k + ema * (1 - k);
      out.push({ time: bars[i].time, value: ema });
    }
    return out;
  }

  // -----------------------------
  // Export PNG
  // -----------------------------
  function exportPNG() {
    try {
      if (!chart || typeof chart.takeScreenshot !== "function") {
        alert("当前图表版本不支持导出（takeScreenshot 不可用）。");
        return;
      }
      const canvas = chart.takeScreenshot();
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `DarriusAI_${getUiSymbol()}_${getUiTf()}.png`;
      a.click();
    } catch (e) {
      alert("导出失败：" + (e.message || e));
    }
  }

  // -----------------------------
  // Init (idempotent)
  // -----------------------------
  function init(opts) {
    opts = opts || {};
    const containerId = opts.containerId || "chart";
    const overlayId = opts.overlayId || "sigOverlay";

    containerEl = $(containerId);
    overlayEl = $(overlayId);

    if (!containerEl || !window.LightweightCharts) {
      throw new Error("Chart container or lightweight-charts missing");
    }

    // Prevent double init
    if (chart) return;

    chart = window.LightweightCharts.createChart(containerEl, {
      layout: { background: { color: "transparent" }, textColor: "#EAF0F7" },
      grid: {
        vertLines: { color: "rgba(255,255,255,.04)" },
        horzLines: { color: "rgba(255,255,255,.04)" },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { timeVisible: true, secondsVisible: false, borderVisible: false },
      crosshair: { mode: 1 },
    });

    // Candles: green up / red down (你要求：绿色上涨，红色下跌)
    candleSeries = chart.addCandlestickSeries({
      upColor: "#2BE2A6",
      downColor: "#FF5A5A",
      wickUpColor: "#2BE2A6",
      wickDownColor: "#FF5A5A",
      borderVisible: false,
    });

    // EMA split series (ONLY one visible per time by null gaps)
    // Green (above/up)
    emaUp = chart.addLineSeries({
      color: "#2BE2A6",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // Red (below/down)
    emaDown = chart.addLineSeries({
      color: "#FF5A5A",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // AUX
    auxSeries = chart.addLineSeries({
      color: "rgba(255,184,108,.85)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // Resize
    const resize = () => {
      const r = containerEl.getBoundingClientRect();
      chart.applyOptions({
        width: Math.max(1, Math.floor(r.width)),
        height: Math.max(1, Math.floor(r.height)),
      });
      chart.timeScale().fitContent();
    };

    try {
      new ResizeObserver(resize).observe(containerEl);
    } catch (_) {}
    window.addEventListener("resize", resize);
    resize();

    // auto load
    if (opts.autoLoad !== false) {
      load().catch((e) => log("[ChartCore] initial load failed:", e.message || e));
    }
  }

  // Expose
  window.ChartCore = { init, load, applyToggles, exportPNG };
})();
