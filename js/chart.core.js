/* =========================================================================
 * DarriusAI - chart.core.js (Hardcore, Integrated, Idempotent Init)
 * What this file guarantees:
 *  1) NO BLANK CHART from wrong endpoints:
 *     - Prefer /api/market/bars (works for crypto per your tests)
 *     - Fallback to other candidates safely
 *  2) EMA split color: ABSOLUTE NO-OVERLAP
 *     - For each bar time: only ONE of (emaUp, emaDown) has a numeric value
 *     - The other is ALWAYS { time, value: null }
 *     - NO seam-stitch => no parallel double-lines caused by overlap
 *  3) B/S markers: optional second request
 *     - Try from bars payload first
 *     - If missing, try /api/market/sigs then /api/market/signals
 *     - If not found => silent (no error, no fake signals)
 *  4) Safe init, safe toggles; NO billing/subscription touch
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
    window._API_BASE_ ||
    "https://darrius-api.onrender.com";

  // IMPORTANT: prefer /api/market/bars first (your BTCUSDT works here),
  // and keep /api/market/ohlc as a later fallback (your BTCUSDT currently 500 there).
  const BARS_PATH_CANDIDATES = [
    "/api/market/bars",
    "/api/market/ohlc",
    "/api/bars",
    "/bars",
    "/api/ohlcv",
    "/ohlcv",
    "/api/market/ohlcv",
    "/market/ohlcv",
  ];

  const SIGS_PATH_CANDIDATES = [
    "/api/market/sigs",
    "/api/market/signals",
  ];

  // -----------------------------
  // State
  // -----------------------------
  let containerEl = null;

  let chart = null;
  let candleSeries = null;

  // EMA split (two series but only one visible per bar via null gaps)
  let emaUp = null;   // green
  let emaDown = null; // red

  // AUX series (single fixed color)
  let auxSeries = null;

  let LAST_BARS = [];
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
  // Fetch helpers
  // -----------------------------
  async function fetchJson(url) {
    const r = await fetch(url, { method: "GET", credentials: "omit" });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      const err = new Error(HTTP ${r.status});
      err.status = r.status;
      err.body = text;
      throw err;
    }
    return r.json();
  }

  async function fetchJsonOptional(url) {
    try {
      return await fetchJson(url);
    } catch (e) {
      // 404/405 => treat as "not exists"
      if (e && (e.status === 404 || e.status === 405)) return null;
      // other errors also treated as optional failure for signals
      return null;
    }
  }

  function toUnixTime(t) {
    if (t == null) return null;
    if (typeof t === "number") {
      if (t > 2e10) return Math.floor(t / 1000); // ms -> sec
      return t; // already sec
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
    // Reject explicit ok:false payloads
    if (payload && typeof payload === "object" && payload.ok === false) return [];

    const raw =
      Array.isArray(payload) ? payload :
      payload?.bars ? payload.bars :
      payload?.ohlcv ? payload.ohlcv :
      payload?.ohlc ? payload.ohlc :
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

  function normalizeSignalsFromAny(payload) {
    const raw = payload?.sigs || payload?.signals || payload?.data || [];
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
    const q = symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)};

    let lastErr = null;

    for (const p of BARS_PATH_CANDIDATES) {
      const url = ${apiBase}${p}?${q};
      try {
        const payload = await fetchJson(url);
        return { payload, urlUsed: url };
      } catch (e) {
        lastErr = e;
        continue;
      }
    }

    const err = new Error(All market endpoints failed. Last error: ${lastErr?.message || lastErr});
    err.cause = lastErr;
    throw err;
  }

  async function fetchSignalsOptional(sym, tf) {
    const apiBase = (DEFAULT_API_BASE || "").replace(/\/+$/, "");
    const q = symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)};

    for (const p of SIGS_PATH_CANDIDATES) {
      const url = ${apiBase}${p}?${q};
      const payload = await fetchJsonOptional(url);
      if (!payload) continue;

      const sigs = normalizeSignalsFromAny(payload);
      if (sigs.length) return { sigs, urlUsed: url };

      // If endpoint exists but returns empty array, still considered valid
      if (payload && (payload.signals || payload.sigs || Array.isArray(payload.data))) {
        return { sigs: [], urlUsed: url };
      }
    }

    return null;
  }

  // -----------------------------
  // EMA split (ABSOLUTE NO-OVERLAP, NO STITCH)
  // Rule: close >= ema => emaUp has value, emaDown is null
  //       close <  ema => emaDown has value, emaUp is null
  // -----------------------------
  function buildSplitEmaPointsNoOverlap(bars, emaPoints) {
    if (!bars?.length || !emaPoints?.length) return { up: [], down: [] };

    const emaMap = new Map(emaPoints.map((p) => [p.time, p.value]));

    const up = [];
    const down = [];

    for (let i = 0; i < bars.length; i++) {
      const t = bars[i].time;
      const ema = emaMap.get(t);
      if (!isFinite(ema)) continue;

      const close = bars[i].close;
      const isUp = close >= ema;

      up.push({ time: t, value: isUp ? ema : null });
      down.push({ time: t, value: isUp ? null : ema });
    }

    return { up, down };
  }

  function computeEmaFromBars(bars, period) {
    const k = 2 / (period + 1);
    let ema = null;
    const out = [];
    for (let i = 0; i < bars.length; i++) {
      ema = ema == null ? bars[i].close : bars[i].close * k + ema * (1 - k);
      out.push({ time: bars[i].time, value: ema });
    }
    return out;
  }

  // -----------------------------
  // Markers (B yellow, S white)
  // -----------------------------
  function applyMarkers(sigs) {
    if (!candleSeries) return;
    const arr = sigs || [];
    candleSeries.setMarkers(
      arr.map((s) => ({
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

    if ($("hintText")) $("hintText").textContent = "Loading...";

    let pack;
    try {
      pack = await fetchBarsPack(sym, tf);
    } catch (e) {
      log("[ChartCore] load failed:", e.message || e);
      if ($("hintText")) $("hintText").textContent = 加载失败：${e.message || e};
      throw e;
    }

    const payload = pack.payload;
    const bars = normalizeBars(payload);

    if (!bars.length) {
      if ($("hintText")) $("hintText").textContent = 加载失败：bars 为空（后端 ok=false 或结构不匹配）;
      throw new Error("bars empty");
    }

    LAST_BARS = bars;

    // Candles
    candleSeries.setData(bars);

    // EMA: prefer backend ema; otherwise compute
    let emaPts = normalizeLinePoints(payload, ["ema", "EMA"]);
    if (!emaPts.length) {
      emaPts = computeEmaFromBars(bars, 20);
    }

    const split = buildSplitEmaPointsNoOverlap(bars, emaPts);
    emaUp.setData(split.up);
    emaDown.setData(split.down);

    // AUX
    const auxPts = normalizeLinePoints(payload, ["aux", "AUX"]);
    auxSeries.setData(auxPts);

    // Signals:
    // 1) Try from bars payload first
    let sigs = normalizeSignalsFromAny(payload);

    // 2) If none, try optional signals endpoint (no error if missing)
    if (!sigs.length) {
      const sigPack = await fetchSignalsOptional(sym, tf);
      if (sigPack) sigs = sigPack.sigs || [];
    }

    applyMarkers(sigs);

    // Fit
    chart.timeScale().fitContent();

    // Texts
    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

    if ($("hintText")) $("hintText").textContent = Loaded · 已加载（TF=${tf} · sigs=${sigs.length}）;

    applyToggles();

    return { urlUsed: pack.urlUsed, bars: bars.length, sigs: sigs.length };
  }

  // -----------------------------
  // Export PNG (optional)
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
      a.download = DarriusAI_${getUiSymbol()}_${getUiTf()}.png;
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

    // Candles: green up / red down (你确认：绿色上涨，红色下跌)
    candleSeries = chart.addCandlestickSeries({
      upColor: "#2BE2A6",
      downColor: "#FF5A5A",
      wickUpColor: "#2BE2A6",
      wickDownColor: "#FF5A5A",
      borderVisible: false,
    });

    // EMA split series (ABSOLUTE NO-OVERLAP)
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

    // AUX (fixed yellow)
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

    if (opts.autoLoad !== false) {
      load().catch((e) => log("[ChartCore] initial load failed:", e.message || e));
    }
  }

  // Expose
  window.ChartCore = { init, load, applyToggles, exportPNG };
})();
