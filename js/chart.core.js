/* =========================================================================
 * DarriusAI - chart.core.js (Integrated, Idempotent Init) — FINAL
 * Build: 2026-01-19
 *
 * ✅ Fixes (based on your latest evidence):
 *  1) Chart blank root-cause fixed:
 *     - Backend route that WORKS is:
 *         /api/market/bars?symbol=BTCUSDT&tf=1d
 *     - Old /ohlc /api/market/ohlc may 404/500 (crypto -> alpaca key missing)
 *     - So this file uses BARS as the primary/required OHLCV source.
 *
 *  2) EMA split-color “EMPTY_VALUE” correctly implemented:
 *     - LightweightCharts "null" IS NOT a real EMPTY_VALUE.
 *     - Correct gap/hidden data = WhitespaceData: { time } (no value field)
 *     - Only ONE EMA visible at a time (green above, red below)
 *     - Seam is stitched at switch points to avoid ugly gaps.
 *
 *  3) Robust parsing for different payload shapes
 *  4) Safe init, safe toggles; NO subscription/billing touch
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
    window.API_BASE ||
    "https://darrius-api.onrender.com";

  // ✅ Based on your /routes screenshot: this exists and returns bars for crypto.
  const BARS_PATH_CANDIDATES = [
    "/api/market/bars", // ✅ confirmed working
    "/api/bars",
    "/bars",
  ];

  // -----------------------------
  // State
  // -----------------------------
  let containerEl = null;

  let chart = null;
  let candleSeries = null;

  // EMA split (two series but only one visible per bar via WHITESPACE gaps)
  let emaUp = null;   // green
  let emaDown = null; // red

  // AUX series (single fixed color)
  let auxSeries = null;

  // caches
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
      err.url = url;
      throw err;
    }
    return r.json();
  }

  function toUnixTime(t) {
    // Convert ms/iso to seconds (LightweightCharts supports seconds epoch)
    if (t == null) return null;
    if (typeof t === "number") {
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
    // Accept shapes:
    // 1) payload = [{time,open,high,low,close}, ...]
    // 2) payload = { bars: [...] }
    // 3) payload = { data: [...] }
    const raw =
      Array.isArray(payload) ? payload :
      payload?.bars ? payload.bars :
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

    bars.sort((a, b) => a.time - b.time);
    return bars;
  }

  function normalizeLinePoints(payload, keyCandidates) {
    // payload could be:
    // - payload.ema: [{time,value}]
    // - payload.indicators.ema: ...
    // - payload.lines.ema: ...
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

  async function fetchBarsPack(sym, tf) {
    const apiBase = (DEFAULT_API_BASE || "").replace(/\/+$/, "");
    const q = `symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;

    let lastErr = null;

    for (const p of BARS_PATH_CANDIDATES) {
      const url = `${apiBase}${p}?${q}`;
      try {
        const payload = await fetchJson(url);
        return { payload, urlUsed: url };
      } catch (e) {
        lastErr = e;
        continue;
      }
    }

    const err = new Error(
      `All BARS endpoints failed. Last error: ${lastErr?.message || lastErr}`
    );
    err.cause = lastErr;
    throw err;
  }

  // -----------------------------
  // EMA split color (MT4 EMPTY_VALUE => WhitespaceData)
  // Rule: close >= ema => show green(emaUp), hide red(emaDown)
  //       close <  ema => show red(emaDown), hide green(emaUp)
  //
  // ✅ IMPORTANT:
  // - DO NOT use value:null. It's NOT "EMPTY_VALUE" in LightweightCharts.
  // - To hide a point => WhitespaceData = { time } (no value field)
  // - Stitch at switch points: give BOTH series a value at the seam bar
  //   so it looks like ONE line changing color.
  // -----------------------------
  function buildSplitEmaSeriesData(bars, emaPoints) {
    if (!bars?.length || !emaPoints?.length) return { up: [], down: [] };

    // Map EMA by time for alignment
    const emaMap = new Map(emaPoints.map((p) => [p.time, p.value]));

    const up = [];
    const down = [];

    let prevSide = 0;      //  1 = above, -1 = below
    let prevTime = null;
    let prevEma = null;

    for (let i = 0; i < bars.length; i++) {
      const t = bars[i].time;
      const ema = emaMap.get(t);

      if (!isFinite(ema)) {
        // no EMA => hide both at this time
        up.push({ time: t });
        down.push({ time: t });
        continue;
      }

      const close = bars[i].close;
      const side = close >= ema ? 1 : -1;

      // Default: one visible, one hidden(whitespace)
      let upPoint = side === 1 ? { time: t, value: ema } : { time: t };
      let dnPoint = side === -1 ? { time: t, value: ema } : { time: t };

      // Stitch seam:
      // If side changes at this bar, put a value at seam for BOTH series
      // (minimal overlap at the seam only, not over a range)
      if (prevSide !== 0 && side !== prevSide && prevTime != null && isFinite(prevEma)) {
        // Put seam point (prevTime) into BOTH so the color switch is continuous
        // Ensure the previous bar has a value on BOTH series at that bar.
        // We overwrite last element safely because we always pushed one per bar.
        const prevIdx = up.length - 1; // last pushed corresponds to prev bar
        if (prevIdx >= 0) {
          up[prevIdx] = { time: prevTime, value: prevEma };
          down[prevIdx] = { time: prevTime, value: prevEma };
        }

        // And for current bar, also allow both to have value at switch bar (optional but helps)
        upPoint = { time: t, value: ema };
        dnPoint = { time: t, value: ema };
      }

      up.push(upPoint);
      down.push(dnPoint);

      prevSide = side;
      prevTime = t;
      prevEma = ema;
    }

    return { up, down };
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

    // Alternate ids
    const altEma = $("emaCheck")?.checked;
    const altAux = $("auxCheck")?.checked;
    if (typeof altEma === "boolean") showEMA = altEma;
    if (typeof altAux === "boolean") showAUX = altAux;

    if (emaUp) emaUp.applyOptions({ visible: showEMA });
    if (emaDown) emaDown.applyOptions({ visible: showEMA });

    if (auxSeries) {
      auxSeries.applyOptions({ visible: showAUX });
      // Optional: when off, clear to avoid lingering artifacts
      if (!showAUX) auxSeries.setData([]);
    }
  }

  // -----------------------------
  // Core load
  // -----------------------------
  async function load() {
    if (!chart || !candleSeries) return;

    const sym = getUiSymbol();
    const tf = getUiTf();

    if ($("hintText")) $("hintText").textContent = "Loading...";

    let pack;
    try {
      pack = await fetchBarsPack(sym, tf);
    } catch (e) {
      log("[ChartCore] load failed:", e.message || e, e?.url ? `url=${e.url}` : "");
      if ($("hintText")) {
        const extra = e?.cause?.url ? ` (${e.cause.url})` : "";
        $("hintText").textContent = `加载失败：${e.message || e}${extra}`;
      }
      throw e;
    }

    const payload = pack.payload;

    // ✅ bars come from /api/market/bars
    const bars = normalizeBars(payload);
    if (!bars.length) {
      if ($("hintText")) $("hintText").textContent = `加载失败：bars 为空（检查后端返回结构）`;
      throw new Error("bars empty");
    }

    LAST_BARS = bars;

    // Candles
    candleSeries.setData(bars);

    // EMA points:
    // Prefer backend-provided ema; else compute fallback
    let emaPts = normalizeLinePoints(payload, ["ema", "EMA"]);
    if (!emaPts.length) {
      emaPts = computeEmaFromBars(bars, 20);
    }

    // ✅ TRUE EMPTY_VALUE behavior using WhitespaceData
    const split = buildSplitEmaSeriesData(bars, emaPts);
    emaUp.setData(split.up);
    emaDown.setData(split.down);

    // AUX points (optional)
    if (showAUX) {
      const auxPts = normalizeLinePoints(payload, ["aux", "AUX"]);
      auxSeries.setData(auxPts);
    } else {
      auxSeries.setData([]);
    }

    // Signals (B/S)
    const sigs = normalizeSignals(payload);
    applyMarkers(sigs);

    chart.timeScale().fitContent();

    // Texts
    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

    const sigCount = sigs.length;
    if ($("hintText")) $("hintText").textContent = `Loaded · 已加载（TF=${tf} · sigs=${sigCount}）`;

    applyToggles();

    return { urlUsed: pack.urlUsed, bars: bars.length, sigs: sigCount };
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

    containerEl = $(containerId);

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

    // ✅ EMA split ONLY (no third EMA baseline!)
    emaUp = chart.addLineSeries({
      color: "#2BE2A6",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    emaDown = chart.addLineSeries({
      color: "#FF5A5A",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // AUX (fixed color)
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

    // Auto load
    if (opts.autoLoad !== false) {
      load().catch((e) => log("[ChartCore] initial load failed:", e.message || e));
    }
  }

  // Expose
  window.ChartCore = { init, load, applyToggles, exportPNG };
})();
