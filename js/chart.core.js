/* =========================================================================
 * DarriusAI - chart.core.js
 * FINAL-STABLE v2026.02.02-TD-PROXY-V2 (SNAPSHOT-V1 COMPAT)
 *
 * Fixes:
 *  - Main chart OK (TD proxy aggregates)
 *  - Publish snapshot_v1 schema for market.pulse.js (prevents "Waiting...")
 *  - Keep legacy flat fields for backward compatibility
 *  - HARD DIAGNOSTICS preserved
 * ========================================================================= */

console.log("=== chart.core.js ACTIVE BUILD: 2026-02-02 TD-PROXY-V2 ===");
window.__CHART_CORE_ACTIVE__ = "2026-02-02 TD-PROXY-V2";

(() => {
  "use strict";

  // -----------------------------
  // Global diagnostic (never throw)
  // -----------------------------
  const DIAG = (window.__DARRIUS_DIAG__ = window.__DARRIUS_DIAG__ || {
    lastError: null,
    chartError: null,
    lastBarsUrl: null,
    lastSigCount: null,
  });

  // hard debug vars (you check in console)
  window.__LAST_AGG_URL__ = window.__LAST_AGG_URL__ || "";
  window.__LAST_AGG_HTTP__ = window.__LAST_AGG_HTTP__ || null;
  window.__LAST_AGG_TEXT_HEAD__ = window.__LAST_AGG_TEXT_HEAD__ || "";
  window.__LAST_AGG_ERR__ = window.__LAST_AGG_ERR__ || "";

  function safeRun(tag, fn) {
    try { return fn(); }
    catch (e) {
      DIAG.lastError = { tag, message: String(e?.message || e), stack: String(e?.stack || "") };
      return undefined;
    }
  }

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);
  const qs = (sel) => document.querySelector(sel);

  function writeMutant(msg) {
    safeRun("mutant", () => {
      const el =
        qs("#darrius-mutant") ||
        qs(".darrius-mutant") ||
        qs("[data-mutant]") ||
        null;
      if (el) el.textContent = String(msg || "");
    });
  }

  // -----------------------------
  // Config
  // -----------------------------
  const API_BASE = String(
    window.__DARRIUS_API_BASE__ ||
    window.DARRIUS_API_BASE ||
    window._API_BASE_ ||
    window.API_BASE ||
    "https://darrius-api.onrender.com"
  ).replace(/\/+$/, "");

  const AGGS_PATH = "/api/data/stocks/aggregates";

  // optional (best-effort)
  const SIGS_PATH_CANDIDATES = [
    "/api/market/sigs",
    "/api/market/signals",
    "/api/sigs",
    "/api/signals",
    "/sigs",
    "/signals",
  ];

  // -----------------------------
  // Preset params (same spirit as old)
  // -----------------------------
  const EMA_PERIOD = 14;
  const AUX_PERIOD = 40;
  const AUX_METHOD = "SMA";
  const CONFIRM_WINDOW = 3;

  // -----------------------------
  // Colors
  // -----------------------------
  const COLOR_UP = "#2BE2A6";
  const COLOR_DN = "#FF5A5A";
  const COLOR_EMA = "#FFD400";
  const COLOR_AUX = "#FFFFFF";

  // -----------------------------
  // State
  // -----------------------------
  let containerEl = null;
  let chart = null;
  let candleSeries = null;
  let emaSeries = null;
  let auxSeries = null;
  let showEMA = true;
  let showAUX = true;

  // -----------------------------
  // UI readers
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
    const s = (v || window.__CURRENT_SYMBOL__ || "BTCUSDT").trim();
    return s || "BTCUSDT";
  }

  function getUiTf() {
    const el =
      $("tfSelect") ||
      $("timeframeSelect") ||
      $("tf") ||
      qs('select[name="timeframe"]') ||
      qs("#timeframe");
    const v = el && (el.value || el.textContent);
    const tf = (v || window.__CURRENT_TIMEFRAME__ || "1d").trim();
    return tf || "1d";
  }

  // -----------------------------
  // Fetch helper
  // -----------------------------
  async function fetchText(url) {
    const r = await fetch(url, { method: "GET", cache: "no-store", credentials: "omit" });
    const text = await r.text().catch(() => "");
    window.__LAST_AGG_HTTP__ = r.status;
    window.__LAST_AGG_TEXT_HEAD__ = String(text || "").slice(0, 400);
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      err.body = text;
      throw err;
    }
    return text;
  }

  async function fetchJson(url) {
    const text = await fetchText(url);
    try { return JSON.parse(text); }
    catch (e) {
      const err = new Error("JSON parse failed");
      err.body = text;
      throw err;
    }
  }

  // -----------------------------
  // tf -> agg params (old mapping)
  // -----------------------------
  function tfToAggParams(tf) {
    const m = String(tf || "1d").trim();
    const map = {
      "5m":  { multiplier: 5,   timespan: "minute", daysBack: 20 },
      "15m": { multiplier: 15,  timespan: "minute", daysBack: 35 },
      "30m": { multiplier: 30,  timespan: "minute", daysBack: 60 },
      "1h":  { multiplier: 60,  timespan: "minute", daysBack: 90 },
      "4h":  { multiplier: 240, timespan: "minute", daysBack: 180 },
      "1d":  { multiplier: 1,   timespan: "day",    daysBack: 700 },
      "1w":  { multiplier: 1,   timespan: "week",   daysBack: 1800 },
      "1M":  { multiplier: 1,   timespan: "month",  daysBack: 3600 },
      "1m":  { multiplier: 1,   timespan: "month",  daysBack: 3600 },
    };
    return map[m] || map["1d"];
  }

  function toYMD(d) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${da}`;
  }

  function rangeByDaysBack(daysBack) {
    const to = new Date();
    const from = new Date(Date.now() - (daysBack * 24 * 3600 * 1000));
    return { from: toYMD(from), to: toYMD(to) };
  }

  function buildAggUrl(sym, tf) {
    const cfg = tfToAggParams(tf);
    const { from, to } = rangeByDaysBack(cfg.daysBack);

    const url = new URL(API_BASE + AGGS_PATH);
    url.searchParams.set("ticker", String(sym || "BTCUSDT").trim().toUpperCase());
    url.searchParams.set("multiplier", String(cfg.multiplier));
    url.searchParams.set("timespan", String(cfg.timespan));
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);

    // optional passthrough flags your backend might use
    if (window.__DARRIUS_PROVIDER__) url.searchParams.set("provider", String(window.__DARRIUS_PROVIDER__));
    if (window.__DARRIUS_SOURCE__) url.searchParams.set("source", String(window.__DARRIUS_SOURCE__));

    return { url: url.toString(), cfg, range: { from, to } };
  }

  // -----------------------------
  // Normalization
  // -----------------------------
  function toUnixSec(t) {
    if (t == null) return null;
    if (typeof t === "number") {
      if (t > 2e10) return Math.floor(t / 1000);
      return Math.floor(t);
    }
    if (typeof t === "string") {
      const n = Number(t);
      if (Number.isFinite(n)) return toUnixSec(n);
      const ms = Date.parse(t);
      if (!Number.isFinite(ms)) return null;
      return Math.floor(ms / 1000);
    }
    return null;
  }

  function normalizeBars(payload) {
    const raw =
      Array.isArray(payload) ? payload :
      Array.isArray(payload?.results) ? payload.results :
      Array.isArray(payload?.bars) ? payload.bars :
      Array.isArray(payload?.data) ? payload.data :
      [];

    const bars = (raw || [])
      .map((b) => {
        const time = toUnixSec(b.time ?? b.t ?? b.timestamp ?? b.ts ?? b.date);
        const open  = Number(b.open  ?? b.o ?? b.Open);
        const high  = Number(b.high  ?? b.h ?? b.High);
        const low   = Number(b.low   ?? b.l ?? b.Low);
        const close = Number(b.close ?? b.c ?? b.Close);
        if (!time) return null;
        if (![open, high, low, close].every(Number.isFinite)) return null;
        return { time, open, high, low, close };
      })
      .filter(Boolean);

    bars.sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));

    const out = [];
    let lastT = null;
    for (const b of bars) {
      if (b.time === lastT) continue;
      lastT = b.time;
      out.push(b);
    }
    return out;
  }

  function normalizeSignals(payload) {
    const raw =
      payload?.sigs ||
      payload?.signals ||
      payload?.data?.sigs ||
      payload?.data?.signals ||
      [];
    if (!Array.isArray(raw)) return [];
    return raw
      .map((s) => {
        const time = toUnixSec(s.time ?? s.t ?? s.timestamp ?? s.ts ?? s.date);
        const sideRaw = String(s.side ?? s.type ?? s.action ?? s.text ?? "").trim();
        const up = sideRaw.toUpperCase();
        let side = "";
        if (sideRaw === "eB" || up === "EB") side = "eB";
        else if (sideRaw === "eS" || up === "ES") side = "eS";
        else if (up.includes("BUY")) side = "B";
        else if (up.includes("SELL")) side = "S";
        else if (up === "B" || up === "S") side = up;
        if (!time || !side) return null;
        return { time, side };
      })
      .filter(Boolean)
      .sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));
  }

  async function fetchOptionalSignals(sym, tf) {
    const q = `symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;
    for (const p of SIGS_PATH_CANDIDATES) {
      const url = `${API_BASE}${p}?${q}`;
      try {
        const payload = await fetchJson(url);
        const sigs = normalizeSignals(payload);
        if (sigs.length) return sigs;
      } catch (_) {}
    }
    return [];
  }

  // -----------------------------
  // Math (EMA + your AUX)
  // -----------------------------
  function ema(values, period) {
    const k = 2 / (period + 1);
    let e = null;
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) { out[i] = NaN; continue; }
      e = e == null ? v : v * k + e * (1 - k);
      out[i] = e;
    }
    return out;
  }

  function wmaAt(values, endIdx, period) {
    const start = endIdx - period + 1;
    if (start < 0) return NaN;
    let num = 0, den = 0;
    for (let i = start; i <= endIdx; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) return NaN;
      const w = i - start + 1;
      num += v * w;
      den += w;
    }
    return den ? (num / den) : NaN;
  }

  function smaAt(values, endIdx, period) {
    const start = endIdx - period + 1;
    if (start < 0) return NaN;
    let sum = 0;
    for (let i = start; i <= endIdx; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) return NaN;
      sum += v;
    }
    return sum / period;
  }

  function maOnArray(values, period, method) {
    const m = String(method || "SMA").toUpperCase();
    const out = new Array(values.length).fill(NaN);

    if (period <= 1) {
      for (let i = 0; i < values.length; i++) out[i] = values[i];
      return out;
    }

    if (m === "EMA") {
      const k = 2 / (period + 1);
      let e = null;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) { out[i] = NaN; continue; }
        e = e == null ? v : v * k + e * (1 - k);
        out[i] = e;
      }
      return out;
    }

    if (m === "WMA") {
      for (let i = 0; i < values.length; i++) out[i] = wmaAt(values, i, period);
      return out;
    }

    for (let i = 0; i < values.length; i++) out[i] = smaAt(values, i, period);
    return out;
  }

  function computeAuxByYourAlgo(closes, period, method) {
    const n = Math.max(2, Math.floor(period || 40));
    const half = Math.max(1, Math.floor(n / 2));
    const p = Math.max(1, Math.round(Math.sqrt(n)));

    const vect = new Array(closes.length).fill(NaN);
    for (let i = 0; i < closes.length; i++) {
      const w1 = wmaAt(closes, i, half);
      const w2 = wmaAt(closes, i, n);
      vect[i] = (Number.isFinite(w1) && Number.isFinite(w2)) ? (2 * w1 - w2) : NaN;
    }
    return maOnArray(vect, p, method || "SMA");
  }

  function buildLinePoints(bars, values) {
    const pts = new Array(bars.length);
    for (let i = 0; i < bars.length; i++) {
      pts[i] = { time: bars[i].time, value: Number.isFinite(values[i]) ? values[i] : null };
    }
    return pts;
  }

  // -----------------------------
  // Toggles
  // -----------------------------
  function applyToggles() {
    safeRun("applyToggles", () => {
      const emaChecked =
        $("toggleEMA")?.checked ??
        $("emaToggle")?.checked ??
        $("tgEMA")?.checked ??
        $("emaCheck")?.checked;

      const auxChecked =
        $("toggleAUX")?.checked ??
        $("auxToggle")?.checked ??
        $("tgAux")?.checked ??
        $("auxCheck")?.checked;

      if (typeof emaChecked === "boolean") showEMA = emaChecked;
      if (typeof auxChecked === "boolean") showAUX = auxChecked;

      if (emaSeries) emaSeries.applyOptions({ visible: !!showEMA });
      if (auxSeries) auxSeries.applyOptions({ visible: !!showAUX });
    });
  }

  // -----------------------------
  // Snapshot publish (v1 schema + legacy)
  // -----------------------------
  function publishSnapshot(snapshotV1) {
    safeRun("publishSnapshot", () => {
      const frozen = Object.freeze(snapshotV1);
      window.__DARRIUS_CHART_STATE__ = frozen;
      try { window.dispatchEvent(new CustomEvent("darrius:chartUpdated", { detail: frozen })); } catch (_) {}
    });
  }

  function computeTrend(emaVals) {
    const len = emaVals.length;
    if (len < 5) return { emaSlope: null, emaRegime: "NEUTRAL", emaColor: "NEUTRAL" };
    const step = Math.min(10, len - 1);
    const eNow = emaVals[len - 1];
    const ePrev = emaVals[len - 1 - step];
    if (!Number.isFinite(eNow) || !Number.isFinite(ePrev)) return { emaSlope: null, emaRegime: "NEUTRAL", emaColor: "NEUTRAL" };
    const emaSlope = (eNow - ePrev) / step;
    const emaRegime = emaSlope > 0 ? "UP" : emaSlope < 0 ? "DOWN" : "FLAT";
    const emaColor = emaRegime === "UP" ? "GREEN" : emaRegime === "DOWN" ? "RED" : "NEUTRAL";
    return { emaSlope, emaRegime, emaColor };
  }

  // -----------------------------
  // Core load
  // -----------------------------
  async function load() {
    if (!chart || !candleSeries) return;

    const sym = getUiSymbol();
    const tf = getUiTf();

    const built = buildAggUrl(sym, tf);
    const urlUsed = built.url;
    DIAG.lastBarsUrl = urlUsed;

    window.__LAST_AGG_URL__ = urlUsed;
    window.__LAST_AGG_ERR__ = "";
    window.__LAST_AGG_HTTP__ = null;
    window.__LAST_AGG_TEXT_HEAD__ = "";

    writeMutant(`Darrius Mutant\nLoading...\n${sym} ${tf}`);

    let payload;
    try {
      payload = await fetchJson(urlUsed);
    } catch (e) {
      window.__LAST_AGG_ERR__ = String(e?.message || e);
      writeMutant(`Darrius Mutant\nAGG ERROR: ${window.__LAST_AGG_ERR__}\nHTTP: ${window.__LAST_AGG_HTTP__}`);
      throw e;
    }

    const bars = normalizeBars(payload);
    if (!bars.length) {
      window.__LAST_AGG_ERR__ = "bars empty after normalization";
      writeMutant(`Darrius Mutant\nAGG ERROR: bars empty`);
      throw new Error("bars empty after normalization");
    }

    // main draw
    const closes = bars.map(b => b.close);
    const emaVals = ema(closes, EMA_PERIOD);
    const auxVals = computeAuxByYourAlgo(closes, AUX_PERIOD, AUX_METHOD);

    candleSeries.setData(bars);
    const emaPts = buildLinePoints(bars, emaVals);
    const auxPts = buildLinePoints(bars, auxVals);
    emaSeries.setData(emaPts);
    auxSeries.setData(auxPts);

    applyToggles();

    // optional sigs
    const sigs = await fetchOptionalSignals(sym, tf);
    DIAG.lastSigCount = sigs.length;
    window.__LAST_SIGS__ = sigs;

    // rich signals with anchor price (for overlay)
    const barByTime = new Map();
    for (const b of bars) barByTime.set(b.time, b);

    const richSignals = (sigs || [])
      .map((s, idx) => {
        const b = barByTime.get(s.time);
        if (!b) return null;
        const side = s.side;
        const anchor =
          (side === "B" || side === "eB") ? b.low :
          (side === "S" || side === "eS") ? b.high :
          b.close;
        const price = Number(anchor);
        if (!Number.isFinite(price)) return null;
        return { time: s.time, side, price, i: idx, reason: s.reason || null, strength: s.strength ?? null };
      })
      .filter(Boolean);

    // trend summary
    const trend = computeTrend(emaVals);

    const meta = {
      symbol: String(sym).trim().toUpperCase(),
      timeframe: String(tf).trim(),
      bars: bars.length,
      source: String(window.__DATA_SOURCE_NAME__ || window.__DARRIUS_PROVIDER__ || "TwelveData").trim(),
      dataMode: String(window.__DATA_MODE__ || "market").trim(),
      delayedMinutes: Number.isFinite(Number(window.__DELAYED_MINUTES__)) ? Number(window.__DELAYED_MINUTES__) : 0,
      emaPeriod: EMA_PERIOD,
      auxPeriod: AUX_PERIOD,
      confirmWindow: CONFIRM_WINDOW,
      urlUsed,
    };

    // snapshot_v1 (what market.pulse.js expects)
    const snapshotV1 = {
      version: "snapshot_v1",
      ts: Date.now(),
      meta,
      candles: bars,
      ema: emaPts,
      aux: auxPts,
      signals: richSignals,     // ✅ key for overlay/panels
      trend,
      risk: { entry: null, stop: null, targets: null, confidence: null, winrate: null },

      // legacy flat fields (compat)
      apiBase: API_BASE,
      urlUsed,
      symbol: meta.symbol,
      tf: meta.timeframe,
      barsCount: bars.length,
      bars,
      emaVals: emaVals,
      auxVals: auxVals,
      sigs: sigs,
      lastClose: bars[bars.length - 1].close,
    };

    // publish + expose getter
    publishSnapshot(snapshotV1);

    safeRun("exposeGetter", () => {
      window.DarriusChart = window.DarriusChart || {};
      window.DarriusChart.getSnapshot = () => window.__DARRIUS_CHART_STATE__ || null;
      if (typeof window.getChartSnapshot !== "function") window.getChartSnapshot = window.DarriusChart.getSnapshot;
    });

    writeMutant(`Darrius Mutant\nOK: ${meta.symbol} ${meta.timeframe}\nBars: ${bars.length}\nLast: ${snapshotV1.lastClose}`);

    safeRun("fitContent", () => chart.timeScale().fitContent());
    return { urlUsed, bars: bars.length, sigs: sigs.length };
  }

  // -----------------------------
  // Init + coordinate bridge
  // -----------------------------
  function init(opts) {
    opts = opts || {};
    const containerId = opts.containerId || "chart";
    containerEl = $(containerId) || qs("#chart") || qs(".chart-container");
    if (!containerEl) throw new Error("Chart container missing");
    if (!window.LightweightCharts) throw new Error("LightweightCharts missing");

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

    candleSeries = chart.addCandlestickSeries({
      upColor: COLOR_UP,
      downColor: COLOR_DN,
      wickUpColor: COLOR_UP,
      wickDownColor: COLOR_DN,
      borderVisible: false,
    });

    emaSeries = chart.addLineSeries({
      color: COLOR_EMA,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    auxSeries = chart.addLineSeries({
      color: COLOR_AUX,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // coordinate bridge for market.pulse overlay
    safeRun("bridgeExpose", () => {
      window.DarriusChart = window.DarriusChart || {};
      window.DarriusChart.timeToX = (t) => safeRun("timeToX", () => chart?.timeScale()?.timeToCoordinate(t));
      window.DarriusChart.priceToY = (p) => safeRun("priceToY", () => candleSeries?.priceToCoordinate(p));
      window.DarriusChart.__hostId = containerId || "chart";
      if (typeof window.DarriusChart.getSnapshot !== "function") {
        window.DarriusChart.getSnapshot = () => window.__DARRIUS_CHART_STATE__ || null;
      }
    });

    // resize
    const resize = () => safeRun("resize", () => {
      const r = containerEl.getBoundingClientRect();
      chart.applyOptions({
        width: Math.max(1, Math.floor(r.width)),
        height: Math.max(1, Math.floor(r.height)),
      });
    });

    safeRun("observeResize", () => {
      try { new ResizeObserver(resize).observe(containerEl); }
      catch (_) { window.addEventListener("resize", resize); }
    });
    resize();

    // toggles
    $("toggleEMA")?.addEventListener("change", applyToggles);
    $("emaToggle")?.addEventListener("change", applyToggles);
    $("tgEMA")?.addEventListener("change", applyToggles);
    $("emaCheck")?.addEventListener("change", applyToggles);

    $("toggleAUX")?.addEventListener("change", applyToggles);
    $("auxToggle")?.addEventListener("change", applyToggles);
    $("tgAux")?.addEventListener("change", applyToggles);
    $("auxCheck")?.addEventListener("change", applyToggles);

    if (opts.autoLoad !== false) {
      load().catch((e) => {
        DIAG.chartError = { message: String(e?.message || e), stack: String(e?.stack || "") };
      });
    }
  }

  function getSnapshot() {
    try {
      if (window.DarriusChart && typeof window.DarriusChart.getSnapshot === "function") return window.DarriusChart.getSnapshot();
      return window.__DARRIUS_CHART_STATE__ || null;
    } catch (_) {
      return null;
    }
  }

  window.ChartCore = { init, load, applyToggles, getSnapshot };
})();
