/* =========================================================================
 * DarriusAI - chart.core.js (SERVER-SIGS-CLEAN, NO SECRETS)
 * Build: 2026-02-02 vNEXT (diagnostics + robust payload extract)
 *
 * Role:
 *  - Render main chart (candles + optional EMA/AUX if backend provides series)
 *  - Fetch OHLCV via backend proxy
 *  - Fetch signals via backend (/api/market/sigs) ONLY
 *  - Output snapshot to window.__DARRIUS_CHART_STATE__
 *  - Provide bridge for overlay: DarriusChart.timeToX / priceToY / getSnapshot
 *
 * Safety:
 *  - Never touches billing/subscription logic
 * ========================================================================= */

console.log("=== chart.core.js ACTIVE BUILD: 2026-02-02 vNEXT (NO-SECRETS) ===");
window.__CHART_CORE_ACTIVE__ = "2026-02-02 vNEXT (NO-SECRETS)";

(() => {
  "use strict";

  // -----------------------------
  // Diagnostics (what you were checking in console)
  // -----------------------------
  window.__LAST_AGG_URL__ = undefined;
  window.__LAST_AGG_HTTP__ = undefined;
  window.__LAST_AGG_TEXT_HEAD__ = undefined;
  window.__LAST_AGG_ERR__ = undefined;
  window.__LAST_AGG__ = undefined;
  window.__LAST_SIGS__ = undefined;

  // -----------------------------
  // Config
  // -----------------------------
  const POLL_INTERVAL = 15000;

  const API_BASE = String(
    window.__DARRIUS_API_BASE__ ||
    window.DARRIUS_API_BASE ||
    window._API_BASE_ ||
    window.API_BASE ||
    "https://darrius-api.onrender.com"
  ).replace(/\/+$/, "");

  const API_AGG  = `${API_BASE}/api/data/stocks/aggregates`;
  const API_SIGS = `${API_BASE}/api/market/sigs`;

  // -----------------------------
  // Runtime state
  // -----------------------------
  const R = (window.__DARRIUS_CHART_RUNTIME__ = window.__DARRIUS_CHART_RUNTIME__ || {});
  if (!R.__ERR_HOOKED__) {
    R.__ERR_HOOKED__ = true;
    window.addEventListener("error", (e) => console.log("[window.onerror]", e.message));
    window.addEventListener("unhandledrejection", (e) => console.log("[unhandledrejection]", e.reason));
  }

  // -----------------------------
  // Helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);

  function findChartContainer() {
    return (
      document.querySelector("#chart") ||
      document.querySelector(".chart-container") ||
      document.querySelector(".tv-lightweight-chart") ||
      document.querySelector(".tv-chart") ||
      document.querySelector("[data-chart]")
    );
  }

  function ensureSize(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) el.style.width = "100%";
    if (r.height === 0) el.style.minHeight = "420px";
    return el.getBoundingClientRect();
  }

  function normalizeTimeToSec(t) {
    if (t == null) return null;

    // number: seconds or ms
    if (typeof t === "number") {
      if (t > 10_000_000_000) return Math.floor(t / 1000);
      return Math.floor(t);
    }

    // string: ISO time (TwelveData datetime)
    if (typeof t === "string") {
      const ms = Date.parse(t);
      if (!Number.isFinite(ms)) return null;
      return Math.floor(ms / 1000);
    }

    return null;
  }

  // Extract array rows from many payload schemas
  function extractRows(payload) {
    if (!payload) return [];

    // common direct
    const direct = [
      payload.results,
      payload.candles,
      payload.bars,
      payload.data,
      payload.values,            // TwelveData
    ];
    for (const x of direct) if (Array.isArray(x) && x.length) return x;

    // nested
    const nested = [
      payload.data?.results,
      payload.data?.candles,
      payload.data?.bars,
      payload.data?.values,      // TwelveData nested
      payload.payload?.results,
      payload.payload?.candles,
      payload.payload?.bars,
      payload.payload?.values,
    ];
    for (const x of nested) if (Array.isArray(x) && x.length) return x;

    // last resort: scan first-level keys for array containing OHLC-like objects
    for (const k of Object.keys(payload)) {
      const v = payload[k];
      if (Array.isArray(v) && v.length && typeof v[0] === "object") {
        const r0 = v[0] || {};
        const hasO = ("o" in r0) || ("open" in r0);
        const hasC = ("c" in r0) || ("close" in r0);
        if (hasO && hasC) return v;
      }
    }

    return [];
  }

  function normalizeCandles(rows) {
    const candles = [];

    for (const r of rows) {
      // Polygon/Massive: t,o,h,l,c
      // TwelveData: datetime, open, high, low, close (often strings)
      const tRaw =
        r.t ?? r.time ?? r.timestamp ?? r.ts ?? r.date ??
        r.datetime ?? r.dateTime ?? r.DateTime ?? r.Datetime;

      const time = normalizeTimeToSec(tRaw);
      if (!time) continue;

      const o = Number(r.o ?? r.open ?? r.Open);
      const h = Number(r.h ?? r.high ?? r.High);
      const l = Number(r.l ?? r.low  ?? r.Low);
      const c = Number(r.c ?? r.close ?? r.Close);

      if (![o, h, l, c].every(Number.isFinite)) continue;

      candles.push({ time, open: o, high: h, low: l, close: c });
    }

    candles.sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));

    // de-dupe by time
    const out = [];
    let lastT = null;
    for (const b of candles) {
      if (b.time === lastT) continue;
      lastT = b.time;
      out.push(b);
    }
    return out;
  }

  // Optional lines if backend provides them
  function normalizeLine(rows, keyCandidates) {
    const pts = [];
    for (const r of rows) {
      const tRaw =
        r.t ?? r.time ?? r.timestamp ?? r.ts ?? r.date ??
        r.datetime ?? r.dateTime ?? r.DateTime ?? r.Datetime;

      const time = normalizeTimeToSec(tRaw);
      if (!time) continue;

      let v = null;
      for (const k of keyCandidates) {
        if (typeof r[k] === "number") { v = r[k]; break; }
        if (r[k] != null && Number.isFinite(Number(r[k]))) { v = Number(r[k]); break; }
      }
      if (!Number.isFinite(v)) continue;
      pts.push({ time, value: v });
    }
    pts.sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));
    return pts;
  }

  async function fetchText(url) {
    window.__LAST_AGG_URL__ = url;
    window.__LAST_AGG_ERR__ = undefined;

    let res, text;
    try {
      res = await fetch(url, { cache: "no-store" });
      text = await res.text();
    } catch (e) {
      window.__LAST_AGG_ERR__ = String(e?.message || e);
      throw e;
    }

    window.__LAST_AGG_HTTP__ = res.status;
    window.__LAST_AGG_TEXT_HEAD__ = (text || "").slice(0, 200);

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.body = text;
      window.__LAST_AGG_ERR__ = `${err.message}`;
      throw err;
    }

    return text;
  }

  async function fetchJSON(url, isAgg = false) {
    const text = await fetchText(url);
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}

    if (!json) {
      const err = new Error("JSON parse failed");
      window.__LAST_AGG_ERR__ = err.message;
      throw err;
    }

    if (isAgg) window.__LAST_AGG__ = json;
    return json;
  }

  // ---- timeframe -> multiplier/timespan + range (same as your 1/23 logic) ----
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

  // -----------------------------
  // Chart init
  // -----------------------------
  function canInitNow() {
    return !!(window.LightweightCharts && typeof window.LightweightCharts.createChart === "function");
  }

  function initChart() {
    const container = findChartContainer();
    if (!container) { console.error("[chart.core] #chart container NOT FOUND"); return false; }
    if (!canInitNow()) { console.error("[chart.core] LightweightCharts NOT READY"); return false; }

    const rect = ensureSize(container);
    console.log("[chart.core] init container:", { w: rect.width, h: rect.height, id: container.id, cls: container.className });

    try { if (R.chart && R.chart.remove) R.chart.remove(); } catch (_) {}

    const chart = window.LightweightCharts.createChart(container, {
      layout: { background: { color: "#0b1220" }, textColor: "#cfd8dc" },
      grid: { vertLines: { color: "#1f2a38" }, horzLines: { color: "#1f2a38" } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: "#263238" },
      crosshair: { mode: window.LightweightCharts.CrosshairMode.Normal },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      borderVisible: false,
    });

    const emaSeries = chart.addLineSeries({ color: "#fdd835", lineWidth: 2, visible: true });
    const auxSeries = chart.addLineSeries({ color: "#ffffff", lineWidth: 2, visible: true });

    R.chart = chart;
    R.candleSeries = candleSeries;
    R.emaSeries = emaSeries;
    R.auxSeries = auxSeries;

    // bridge for overlay
    window.DarriusChart = window.DarriusChart || {};
    window.DarriusChart.timeToX = (t) => { try { return chart.timeScale().timeToCoordinate(t); } catch (_) { return null; } };
    window.DarriusChart.priceToY = (p) => { try { return candleSeries.priceToCoordinate(p); } catch (_) { return null; } };
    window.DarriusChart.getSnapshot = () => { try { return window.__DARRIUS_CHART_STATE__ || null; } catch (_) { return null; } };

    window.addEventListener("resize", () => {
      try {
        const rr = container.getBoundingClientRect();
        chart.applyOptions({ width: rr.width, height: rr.height });
      } catch (_) {}
    });

    console.log("[chart.core] chart init OK");
    return true;
  }

  // -----------------------------
  // Update series + publish snapshot
  // -----------------------------
  function applyToggles() {
    try {
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

      if (typeof emaChecked === "boolean") R.emaSeries?.applyOptions({ visible: !!emaChecked });
      if (typeof auxChecked === "boolean") R.auxSeries?.applyOptions({ visible: !!auxChecked });
    } catch (_) {}
  }

  function publishSnapshot(snap) {
    try {
      const frozen = Object.freeze(snap);
      window.__DARRIUS_CHART_STATE__ = frozen;
      window.dispatchEvent(new CustomEvent("darrius:chartUpdated", { detail: frozen }));
    } catch (_) {}
  }

  function updateFromAggPayload(payload, meta) {
    const rows = extractRows(payload);
    const candles = normalizeCandles(rows);

    if (!candles.length) {
      console.error("[chart.core] Error: bars empty after normalization");
      throw new Error("bars empty after normalization");
    }

    // Optional: if backend provides ema/aux fields per row
    const emaPts = normalizeLine(rows, ["ema_fast", "ema", "ema14", "EMA"]);
    const auxPts = normalizeLine(rows, ["aux", "aux40", "AUX"]);

    // Render
    try { R.candleSeries.setData(candles); } catch (e) { console.error("[chart.core] setData candles error", e); }

    try { if (emaPts.length) R.emaSeries.setData(emaPts); else R.emaSeries.setData([]); } catch (_) {}
    try { if (auxPts.length) R.auxSeries.setData(auxPts); else R.auxSeries.setData([]); } catch (_) {}

    try { R.chart.timeScale().fitContent(); } catch (_) {}

    applyToggles();

    const snap = {
      version: "2026-02-02-vNEXT-no-secrets",
      ts: Date.now(),
      meta: meta || {},
      candles,
      ema: emaPts,
      aux: auxPts,
      signals: Array.isArray(window.__LAST_SIGS__) ? window.__LAST_SIGS__ : [],
      lastBar: candles[candles.length - 1],
      count: candles.length,
      urlUsed: window.__LAST_AGG_URL__ || null,
    };

    publishSnapshot(snap);
  }

  // -----------------------------
  // Poll
  // -----------------------------
  async function pollOnce() {
    const symbol = (window.__CURRENT_SYMBOL__ || window.__UI_SYMBOL__ || "BTCUSDT").toString().trim();
    const tf     = (window.__CURRENT_TIMEFRAME__ || window.__UI_TIMEFRAME__ || "1d").toString().trim();

    // Build aggregate URL in the most compatible way (ticker/multiplier/timespan/from/to)
    const cfg = tfToAggParams(tf);
    const { from, to } = rangeByDaysBack(cfg.daysBack);

    // IMPORTANT: backend might accept ticker= (old) or symbol= (new). We try ticker first.
    const url1 = new URL(API_AGG);
    url1.searchParams.set("ticker", symbol.toUpperCase());
    url1.searchParams.set("multiplier", String(cfg.multiplier));
    url1.searchParams.set("timespan", String(cfg.timespan));
    url1.searchParams.set("from", from);
    url1.searchParams.set("to", to);

    let aggPayload = null;
    try {
      aggPayload = await fetchJSON(url1.toString(), true);
    } catch (e1) {
      // fallback: symbol/timeframe
      const url2 = new URL(API_AGG);
      url2.searchParams.set("symbol", symbol);
      url2.searchParams.set("timeframe", tf);
      aggPayload = await fetchJSON(url2.toString(), true);
    }

    // signals: best-effort only
    try {
      const uS = new URL(API_SIGS);
      uS.searchParams.set("symbol", symbol);
      uS.searchParams.set("tf", tf);
      uS.searchParams.set("timeframe", tf);
      window.__LAST_SIGS__ = await fetchJSON(uS.toString(), false);
    } catch (_) {
      // keep silent
    }

    updateFromAggPayload(aggPayload, { symbol, tf, provider: "auto", apiBase: API_BASE });
  }

  function startPolling() {
    if (R.pollingTimer) return;
    pollOnce().catch((e) => console.error("[chart.core] pollOnce error", e));
    R.pollingTimer = setInterval(() => {
      pollOnce().catch((e) => console.error("[chart.core] poll tick error", e));
    }, POLL_INTERVAL);
  }

  // -----------------------------
  // Boot loop
  // -----------------------------
  let tries = 0;
  const t = setInterval(() => {
    tries += 1;

    if (!R.candleSeries) initChart();

    if (R.candleSeries) startPolling();

    if (R.candleSeries || tries > 200) clearInterval(t);
  }, 50);

})();
