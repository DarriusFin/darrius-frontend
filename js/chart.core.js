/* =========================================================================
 * DarriusAI - chart.core.js (FROZEN MAIN CHART) v2026.02.02-FINAL-AGG-SIGS-DIAG
 *
 * Role:
 *  - Render main chart (candles + EMA [+ AUX if enabled])
 *  - Fetch OHLCV via backend proxy (aggregates)
 *  - Fetch signals via backend (/api/market/sigs) optional
 *  - Output read-only snapshot to window.__DARRIUS_CHART_STATE__
 *  - Provide read-only bridge for UI overlay (market.pulse.js):
 *      DarriusChart.timeToX / DarriusChart.priceToY / DarriusChart.getSnapshot()
 *  - Emit event "darrius:chartUpdated" with snapshot detail
 *
 * Guarantees:
 *  1) Main chart render is highest priority and will not be broken by UI
 *  2) Non-critical parts (snapshot/event/markers) are wrapped in no-throw safe zones
 *  3) No billing/subscription logic touched
 * ========================================================================= */

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

  // Split AGG and SIGS diagnostics (DO NOT overwrite each other)
  window.__LAST_AGG_URL__ = window.__LAST_AGG_URL__ || undefined;
  window.__LAST_AGG_HTTP__ = window.__LAST_AGG_HTTP__ || undefined;
  window.__LAST_AGG_TEXT_HEAD__ = window.__LAST_AGG_TEXT_HEAD__ || undefined;
  window.__LAST_AGG_ERR__ = window.__LAST_AGG_ERR__ || undefined;
  window.__LAST_AGG__ = window.__LAST_AGG__ || undefined;

  window.__LAST_SIGS_URL__ = window.__LAST_SIGS_URL__ || undefined;
  window.__LAST_SIGS_HTTP__ = window.__LAST_SIGS_HTTP__ || undefined;
  window.__LAST_SIGS_TEXT_HEAD__ = window.__LAST_SIGS_TEXT_HEAD__ || undefined;
  window.__LAST_SIGS_ERR__ = window.__LAST_SIGS_ERR__ || undefined;
  window.__LAST_SIGS__ = window.__LAST_SIGS__ || undefined;

  // Mark chart core active for quick console check
  window.__CHART_CORE_ACTIVE__ = "2026-02-02 FINAL (AGG/SIGS DIAG)";

  function safeRun(tag, fn) {
    try {
      return fn();
    } catch (e) {
      DIAG.lastError = {
        tag,
        message: String(e?.message || e),
        stack: String(e?.stack || ""),
      };
      return undefined;
    }
  }

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);
  const qs = (sel) => document.querySelector(sel);

  // -----------------------------
  // Config
  // -----------------------------
  const DEFAULT_API_BASE =
    (window.DARRIUS_API_BASE && String(window.DARRIUS_API_BASE)) ||
    (window._API_BASE_ && String(window._API_BASE_)) ||
    (window.API_BASE && String(window.API_BASE)) ||
    "https://darrius-api.onrender.com";

  // Main aggregates path (your backend proxy)
  const STOCKS_AGGS_PATH = "/api/data/stocks/aggregates";
  // Optional crypto aggregates path (only if your backend supports)
  const CRYPTO_AGGS_PATH = "/api/data/crypto/aggregates";

  // Optional backward compat fallback endpoints (if you had them)
  const BARS_PATH_CANDIDATES = [
    "/api/market/bars",
    "/api/bars",
    "/bars",
    "/api/ohlcv",
    "/ohlcv",
    "/api/ohlc",
    "/ohlc",
    "/api/market/ohlcv",
    "/market/ohlcv",
    "/api/market/ohlc",
    "/market/ohlc",
  ];

  // Signals (optional)
  const SIGS_PATH = "/api/market/sigs";

  // -----------------------------
  // Parameters (internal)
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
  const COLOR_UP_WICK = "#2BE2A6";
  const COLOR_DN_WICK = "#FF5A5A";

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
    return (v || "AAPL").trim();
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

  // Try to read provider from page (optional)
  function getUiProvider() {
    // You may set these globals from index.html/control panel
    const p =
      window.__DATA_PROVIDER__ ||
      window.__DATA_SOURCE_PROVIDER__ ||
      window.__DATA_SOURCE__ ||
      window.__DATA_SOURCE_NAME__ ||
      window.__DATA_PROVIDER_NAME__;
    if (!p) return "auto";
    const s = String(p).trim().toLowerCase();
    if (!s) return "auto";
    // normalize a bit
    if (s.includes("twelve")) return "twelve";
    if (s.includes("polygon")) return "polygon";
    if (s.includes("massive")) return "massive";
    return "auto";
  }

  function isProbablyCryptoSymbol(sym) {
    const s = String(sym || "").trim().toUpperCase();
    // Heuristic: BTCUSDT, ETHUSDT, BTC-USD, BTCUSD, X:BTCUSD etc.
    if (s.includes("USDT") || s.includes("-USD") || s.includes("BTC") || s.includes("ETH")) {
      // avoid false positives like "BETHESDA" - keep it minimal
      if (s === "AAPL" || s === "SPY" || s === "TSLA") return false;
      // if it contains ':' it's often Polygon crypto like X:BTCUSD
      return true;
    }
    return false;
  }

  // -----------------------------
  // Fetch helpers (AGG/SIGS separated)
  // -----------------------------
  async function fetchText(url, tag = "AGG") {
    const isAgg = (tag === "AGG");

    if (isAgg) {
      window.__LAST_AGG_URL__ = url;
      window.__LAST_AGG_ERR__ = undefined;
    } else {
      window.__LAST_SIGS_URL__ = url;
      window.__LAST_SIGS_ERR__ = undefined;
    }

    let res, text;
    try {
      res = await fetch(url, { method: "GET", cache: "no-store", credentials: "omit" });
      text = await res.text();
    } catch (e) {
      const msg = String(e?.message || e);
      if (isAgg) window.__LAST_AGG_ERR__ = msg;
      else window.__LAST_SIGS_ERR__ = msg;
      throw e;
    }

    if (isAgg) {
      window.__LAST_AGG_HTTP__ = res.status;
      window.__LAST_AGG_TEXT_HEAD__ = (text || "").slice(0, 300);
    } else {
      window.__LAST_SIGS_HTTP__ = res.status;
      window.__LAST_SIGS_TEXT_HEAD__ = (text || "").slice(0, 300);
    }

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.body = text;
      if (isAgg) window.__LAST_AGG_ERR__ = err.message;
      else window.__LAST_SIGS_ERR__ = err.message;
      throw err;
    }

    return text;
  }

  async function fetchJSON(url, tag = "AGG") {
    const text = await fetchText(url, tag);

    let json = null;
    try { json = JSON.parse(text); } catch (_) {}

    if (!json) {
      const err = new Error("JSON parse failed");
      if (tag === "AGG") window.__LAST_AGG_ERR__ = err.message;
      else window.__LAST_SIGS_ERR__ = err.message;
      throw err;
    }

    if (tag === "AGG") window.__LAST_AGG__ = json;
    return json;
  }

  // -----------------------------
  // tf -> multiplier/timespan + history window
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

  function toUnixSec(t) {
    if (t == null) return null;

    if (typeof t === "number") {
      // ms -> s
      if (t > 2e10) return Math.floor(t / 1000);
      // already sec
      return t;
    }

    if (typeof t === "string") {
      const s = t.trim();
      // Twelve Data often uses "YYYY-MM-DD HH:mm:ss"
      // Replace space with 'T' to improve parse robustness
      const normalized = s.includes("T") ? s : s.replace(" ", "T");
      const ms = Date.parse(normalized);
      if (!Number.isFinite(ms)) return null;
      return Math.floor(ms / 1000);
    }

    // LightweightCharts business day object support
    if (typeof t === "object" && t.year && t.month && t.day) return t;

    return null;
  }

  // -----------------------------
  // Normalizers (Bars / Signals)
  // -----------------------------

function normalizeBars(payload) {
  // 兼容多种 schema（Twelve Data / Polygon / Massive / 自建后端包裹）
  // 支持路径：
  // - payload.results
  // - payload.bars
  // - payload.data.results
  // - payload.data.bars
  // - payload.values
  // - payload.data.values
  // - payload.data.data.values（有些后端会双层包裹）
  const raw =
    Array.isArray(payload) ? payload :
    Array.isArray(payload?.results) ? payload.results :
    Array.isArray(payload?.bars) ? payload.bars :
    Array.isArray(payload?.data?.results) ? payload.data.results :
    Array.isArray(payload?.data?.bars) ? payload.data.bars :
    Array.isArray(payload?.values) ? payload.values :
    Array.isArray(payload?.data?.values) ? payload.data.values :
    Array.isArray(payload?.data?.data?.values) ? payload.data.data.values :
    [];

  // 时间解析：支持
  // - 秒/毫秒 number
  // - "1700000000" / "1700000000000" 这种数字字符串
  // - "2026-02-01 00:00:00" / ISO string
  function toUnixSecAny(t) {
    if (t == null) return null;

    // number
    if (typeof t === "number" && Number.isFinite(t)) {
      return (t > 2e10) ? Math.floor(t / 1000) : Math.floor(t);
    }

    // numeric string
    if (typeof t === "string") {
      const s = t.trim();
      if (/^\d+$/.test(s)) {
        const n = Number(s);
        if (!Number.isFinite(n)) return null;
        return (n > 2e10) ? Math.floor(n / 1000) : Math.floor(n);
      }
      const ms = Date.parse(s);
      if (Number.isFinite(ms)) return Math.floor(ms / 1000);
      return null;
    }

    // business day object (LightweightCharts supports {year,month,day})
    if (typeof t === "object" && t.year && t.month && t.day) return t;

    return null;
  }

  const bars = (raw || [])
    .map((b) => {
      // time字段兜底：t / time / timestamp / ts / date / datetime / candleTime
      const tRaw =
        b?.time ?? b?.t ?? b?.timestamp ?? b?.ts ?? b?.date ?? b?.datetime ?? b?.candleTime ?? b?.start ?? b?.end;

      const time = toUnixSecAny(tRaw);

      // OHLC 兜底：支持 Polygon/Massive 的 o/h/l/c，也支持 TwelveData 的 open/high/low/close（通常为字符串）
      const open  = Number(b?.open  ?? b?.o ?? b?.Open);
      const high  = Number(b?.high  ?? b?.h ?? b?.High);
      const low   = Number(b?.low   ?? b?.l ?? b?.Low);
      const close = Number(b?.close ?? b?.c ?? b?.Close);

      if (!time) return null;
      if (![open, high, low, close].every(Number.isFinite)) return null;

      return { time, open, high, low, close };
    })
    .filter(Boolean);

  // 排序 + 去重
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
      payload?.data ||
      [];

    if (!Array.isArray(raw)) return [];

    const out = raw
      .map((s) => {
        const time = toUnixSec(s.time ?? s.t ?? s.timestamp ?? s.ts ?? s.date);
        const sideRaw = String(s.side ?? s.type ?? s.action ?? s.text ?? "").trim();
        const sideUp = sideRaw.toUpperCase();

        let side = "";
        if (sideRaw === "eB" || sideUp === "EB") side = "eB";
        else if (sideRaw === "eS" || sideUp === "ES") side = "eS";
        else if (sideUp.includes("BUY")) side = "B";
        else if (sideUp.includes("SELL")) side = "S";
        else if (sideUp === "B" || sideUp === "S") side = sideUp;

        if (!time || !side) return null;
        return { time, side };
      })
      .filter(Boolean)
      .sort((x, y) => (x.time > y.time ? 1 : x.time < y.time ? -1 : 0));

    // de-dupe by (time, side)
    const used = new Set();
    const dedup = [];
    for (const s of out) {
      const k = `${s.time}:${s.side}`;
      if (used.has(k)) continue;
      used.add(k);
      dedup.push(s);
    }
    return dedup;
  }

  // -----------------------------
  // Prefer aggregates endpoint(s)
  // -----------------------------
  async function fetchBarsPack(sym, tf) {
    const apiBase = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");
    const cfg = tfToAggParams(tf);
    const { from, to } = rangeByDaysBack(cfg.daysBack);

    const symbol = String(sym || "AAPL").trim().toUpperCase();
    const provider = getUiProvider(); // "auto" | "twelve" | ...

    // build URL helper
    function makeAggUrl(path) {
      const url = new URL(apiBase + path);
      url.searchParams.set("ticker", symbol);
      url.searchParams.set("multiplier", String(cfg.multiplier));
      url.searchParams.set("timespan", String(cfg.timespan));
      url.searchParams.set("from", from);
      url.searchParams.set("to", to);
      // optional provider hint (if your backend supports)
      url.searchParams.set("provider", provider || "auto");
      return url.toString();
    }

    // Strategy:
    // 1) If symbol looks crypto, try CRYPTO_AGGS_PATH first (optional)
    // 2) Always try STOCKS_AGGS_PATH
    // 3) Fallback candidates (older endpoints)
    let lastErr = null;

    const tryUrls = [];
    if (isProbablyCryptoSymbol(symbol)) tryUrls.push(makeAggUrl(CRYPTO_AGGS_PATH));
    tryUrls.push(makeAggUrl(STOCKS_AGGS_PATH));

    for (const urlStr of tryUrls) {
      try {
        DIAG.lastBarsUrl = urlStr;
        const payload = await fetchJSON(urlStr, "AGG");
        const bars = normalizeBars(payload);
        if (bars.length) {
          return { payload, bars, urlUsed: urlStr, aggCfg: cfg, range: { from, to } };
        }
        lastErr = new Error(`Aggs returned empty results (normalized=0) from ${urlStr}`);
      } catch (e) {
        lastErr = e;
      }
    }

    // Optional fallback endpoints
    const q = `symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}&provider=${encodeURIComponent(provider || "auto")}`;
    for (const p of BARS_PATH_CANDIDATES) {
      const u = `${apiBase}${p}?${q}`;
      try {
        DIAG.lastBarsUrl = u;
        const pl = await fetchJSON(u, "AGG");
        const bs = normalizeBars(pl);
        if (bs.length) return { payload: pl, bars: bs, urlUsed: u, aggCfg: cfg, range: { from, to } };
        lastErr = new Error(`bars empty from ${u}`);
      } catch (e) {
        lastErr = e;
      }
    }

    throw new Error(`All bars endpoints failed. Last error: ${lastErr?.message || lastErr}`);
  }

  async function fetchOptionalSignals(sym, tf) {
    const apiBase = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");
    const provider = getUiProvider();

    const url = new URL(apiBase + SIGS_PATH);
    url.searchParams.set("symbol", String(sym || "").trim());
    url.searchParams.set("tf", String(tf || "").trim());
    url.searchParams.set("provider", provider || "auto");

    try {
      const payload = await fetchJSON(url.toString(), "SIGS");
      window.__LAST_SIGS__ = payload;
      const sigs = normalizeSignals(payload);
      return sigs;
    } catch (_) {
      return [];
    }
  }

  // -----------------------------
  // Math
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

  function colorCandlesByEMATrend(bars, emaVals) {
    const out = new Array(bars.length);
    let lastSlope = 0;

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const e0 = emaVals[i - 1];
      const e1 = emaVals[i];
      let slope = 0;

      if (i >= 1 && Number.isFinite(e0) && Number.isFinite(e1)) {
        slope = e1 - e0;
        if (slope !== 0) lastSlope = slope;
        else slope = lastSlope;
      }

      const isUp = slope > 0;
      const isDn = slope < 0;
      const fallbackUp = (b.close >= b.open);
      const useUp = isUp ? true : isDn ? false : fallbackUp;

      out[i] = {
        ...b,
        color: useUp ? COLOR_UP : COLOR_DN,
        wickColor: useUp ? COLOR_UP_WICK : COLOR_DN_WICK,
        borderColor: useUp ? COLOR_UP : COLOR_DN,
      };
    }
    return out;
  }

  // -----------------------------
  // Markers (small). Overlay uses big markers.
  // -----------------------------
  function applyMarkers(sigs) {
    safeRun("applyMarkers", () => {
      if (!candleSeries) return;

      if (window.__OVERLAY_BIG_SIGS__ === true) {
        candleSeries.setMarkers([]);
        return;
      }

      const arr = (Array.isArray(sigs) ? sigs : []).filter(s => s && (s.side === "B" || s.side === "S"));

      candleSeries.setMarkers(
        arr.map((s) => ({
          time: s.time,
          position: s.side === "B" ? "belowBar" : "aboveBar",
          color: s.side === "B" ? "#FFD400" : "#FF5A5A",
          shape: s.side === "B" ? "arrowUp" : "arrowDown",
          text: s.side,
        }))
      );
    });
  }

  // -----------------------------
  // Snapshot output (read-only)
  // -----------------------------
  function publishSnapshot(snapshot) {
    safeRun("publishSnapshot", () => {
      const frozen = Object.freeze(snapshot);
      window.__DARRIUS_CHART_STATE__ = frozen;

      try {
        window.dispatchEvent(new CustomEvent("darrius:chartUpdated", { detail: frozen }));
      } catch (_) {}
    });
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
  // Core load (MAIN FIRST)
  // -----------------------------
  async function load() {
    if (!chart || !candleSeries) return;

    const sym = getUiSymbol();
    const tf = getUiTf();
    const provider = getUiProvider();

    safeRun("hintLoading", () => {
      if ($("hintText")) $("hintText").textContent = "Loading...";
    });

    let pack;
    try {
      pack = await fetchBarsPack(sym, tf);
    } catch (e) {
      safeRun("hintFail", () => {
        if ($("hintText")) $("hintText").textContent = `加载失败：${e.message || e}`;
      });

      // publish an error snapshot so UI doesn't stay undefined
      publishSnapshot({
        version: "2026.02.02-FINAL-AGG-SIGS-DIAG",
        ts: Date.now(),
        symbol: sym,
        tf,
        provider,
        error: String(e?.message || e),
        urlUsed: window.__LAST_AGG_URL__ || null,
      });

      throw e;
    }

    const { payload, bars, urlUsed } = pack;
    DIAG.lastBarsUrl = urlUsed;

    if (!bars.length) {
      const err = new Error("bars empty after normalization");
      window.__LAST_AGG_ERR__ = err.message;

      publishSnapshot({
        version: "2026.02.02-FINAL-AGG-SIGS-DIAG",
        ts: Date.now(),
        symbol: sym,
        tf,
        provider,
        error: err.message,
        urlUsed,
        rawKeys: payload ? Object.keys(payload) : null,
      });

      throw err;
    }

    // -------- MAIN CHART --------
    const closes = bars.map((b) => b.close);
    const emaVals = ema(closes, EMA_PERIOD);
    const auxVals = computeAuxByYourAlgo(closes, AUX_PERIOD, AUX_METHOD);

    const coloredBars = colorCandlesByEMATrend(bars, emaVals);
    candleSeries.setData(coloredBars);

    const emaPts = buildLinePoints(bars, emaVals);
    const auxPts = buildLinePoints(bars, auxVals);
    if (emaSeries) emaSeries.setData(emaPts);
    if (auxSeries) auxSeries.setData(auxPts);

    // Signals (optional, non-blocking)
    let sigs = [];
    safeRun("signalsFetch", async () => {
      const s = await fetchOptionalSignals(sym, tf);
      sigs = Array.isArray(s) ? s : [];
      DIAG.lastSigCount = sigs.length;
      applyMarkers(sigs);
    });

    safeRun("fitContent", () => chart.timeScale().fitContent());

    safeRun("topText", () => {
      const last = bars[bars.length - 1];
      if ($("symText")) $("symText").textContent = sym;
      if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);
      if ($("hintText")) {
        const rawLen =
          Array.isArray(payload?.results) ? payload.results.length :
          Array.isArray(payload?.values) ? payload.values.length :
          Array.isArray(payload?.data?.results) ? payload.data.results.length :
          Array.isArray(payload?.data?.values) ? payload.data.values.length :
          null;

        $("hintText").textContent =
          `Loaded · provider=${provider} · TF=${tf} · bars=${bars.length}` +
          (rawLen != null ? ` · raw=${rawLen}` : "") +
          (sigs?.length ? ` · sigs=${sigs.length}` : "");
      }
    });

    // Snapshot for UI overlay
    safeRun("snapshot", () => {
      window.DarriusChart = window.DarriusChart || {};

      const snap = {
        version: "2026.02.02-FINAL-AGG-SIGS-DIAG",
        ts: Date.now(),
        apiBase: DEFAULT_API_BASE,
        urlUsed: urlUsed || null,
        symbol: sym,
        tf,
        provider,
        barsCount: bars.length,
        bars: bars.slice(Math.max(0, bars.length - 600)),
        ema: emaVals.slice(Math.max(0, bars.length - 600)),
        aux: auxVals.slice(Math.max(0, bars.length - 600)),
        sigs: (Array.isArray(sigs) ? sigs.slice(Math.max(0, sigs.length - 300)) : []),
        signals: (Array.isArray(sigs) ? sigs.slice(Math.max(0, sigs.length - 300)) : []),
        lastClose: bars[bars.length - 1].close,
      };

      window.DarriusChart.getSnapshot = () => {
        try { return JSON.parse(JSON.stringify(snap)); } catch (_) { return snap; }
      };

      publishSnapshot(snap);
    });

    applyToggles();
    return { urlUsed, bars: bars.length, sigs: sigs.length };
  }

  // -----------------------------
  // Init
  // -----------------------------
  function init(opts) {
    opts = opts || {};
    const containerId = opts.containerId || "chart";

    containerEl = $(containerId);
    if (!containerEl) throw new Error("Chart container missing: #" + containerId);
    if (!window.LightweightCharts) throw new Error("LightweightCharts missing");
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

    candleSeries = chart.addCandlestickSeries({
      upColor: COLOR_UP,
      downColor: COLOR_DN,
      wickUpColor: COLOR_UP_WICK,
      wickDownColor: COLOR_DN_WICK,
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

    // Read-only coordinate bridge (for market.pulse.js overlay)
    safeRun("bridgeExpose", () => {
      window.DarriusChart = window.DarriusChart || {};

      window.DarriusChart.timeToX = (t) =>
        safeRun("timeToX", () => {
          if (!chart || !chart.timeScale) return null;
          return chart.timeScale().timeToCoordinate(t);
        });

      window.DarriusChart.priceToY = (p) =>
        safeRun("priceToY", () => {
          if (!candleSeries || !candleSeries.priceToCoordinate) return null;
          return candleSeries.priceToCoordinate(p);
        });

      window.DarriusChart.__hostId = containerId || "chart";
    });

    const resize = () =>
      safeRun("resize", () => {
        const r = containerEl.getBoundingClientRect();
        chart.applyOptions({
          width: Math.max(1, Math.floor(r.width)),
          height: Math.max(1, Math.floor(r.height)),
        });
      });

    safeRun("observeResize", () => {
      try {
        new ResizeObserver(resize).observe(containerEl);
      } catch (_) {
        window.addEventListener("resize", resize);
      }
    });
    resize();

    // Toggles
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
      if (window.DarriusChart && typeof window.DarriusChart.getSnapshot === "function") {
        return window.DarriusChart.getSnapshot();
      }
      return window.__DARRIUS_CHART_STATE__ || null;
    } catch (_) {
      return null;
    }
  }

  window.ChartCore = { init, load, applyToggles, getSnapshot };
})();
