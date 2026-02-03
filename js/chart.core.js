/* =========================================================================
 * DarriusAI - chart.core.js (VNEXT / NO-SECRETS) v2026.02.02
 *
 * Goals:
 *  - MAIN CHART MUST NEVER BREAK
 *  - Fetch OHLCV via backend proxy (aggregates)
 *  - Fetch signals via backend (/api/market/sigs) best-effort
 *  - Publish stable snapshot for UI overlay (market.pulse.js)
 *  - NO core-secret algorithm here:
 *      * EMA is OK
 *      * AUX: use backend-provided series if available; otherwise use simple SMA placeholder
 *
 * Exports:
 *  - window.ChartCore.init({containerId, autoLoad})
 *  - window.ChartCore.load()
 *  - window.ChartCore.getSnapshot()
 *
 * Diagnostics:
 *  - window.__LAST_AGG_URL__, window.__LAST_AGG__, window.__LAST_AGG_ERR__
 *  - window.__LAST_SIG_URL__, window.__LAST_SIG__, window.__LAST_SIG_ERR__
 *  - window.__DARRIUS_CHART_STATE__ (flat snapshot)
 * ========================================================================= */

(() => {
  "use strict";

  // -----------------------------
  // Global diagnostic (never throw)
  // -----------------------------
  const DIAG = (window.__DARRIUS_DIAG__ = window.__DARRIUS_DIAG__ || {
    lastError: null,
    chartError: null,
    lastAggUrl: null,
    lastSigUrl: null,
    lastBarsCount: null,
    lastSigsCount: null,
  });

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

  const API_BASE = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");

  // Aggregates endpoint (your backend proxy)
  const AGGS_PATH = "/api/data/stocks/aggregates";

  // Signals endpoints (best-effort candidates)
  const SIGS_PATHS = [
    "/api/market/sigs",
    "/api/market/signals",
    "/api/sigs",
    "/api/signals",
    "/sigs",
    "/signals",
  ];

  // -----------------------------
  // Periods (non-secret)
  // -----------------------------
  const EMA_PERIOD = 14;
  const AUX_PERIOD = 40; // placeholder SMA if backend does not provide AUX
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
  let volumeSeries = null;

  let showEMA = true;
  let showAUX = true;

  let _pollTimer = null;
  let _pollInFlight = false;

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
    return (v || "AAPL").trim().toUpperCase();
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
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      err.body = text;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      const err = new Error("Invalid JSON");
      err.body = text;
      throw err;
    }
  }

  function tfToAggParams(tf) {
    const m = String(tf || "1d").trim();
    const map = {
      "5m": { multiplier: 5, timespan: "minute", daysBack: 20 },
      "15m": { multiplier: 15, timespan: "minute", daysBack: 35 },
      "30m": { multiplier: 30, timespan: "minute", daysBack: 60 },
      "1h": { multiplier: 60, timespan: "minute", daysBack: 90 },
      "4h": { multiplier: 240, timespan: "minute", daysBack: 180 },
      "1d": { multiplier: 1, timespan: "day", daysBack: 700 },
      "1w": { multiplier: 1, timespan: "week", daysBack: 1800 },
      "1M": { multiplier: 1, timespan: "month", daysBack: 3600 },
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
    const from = new Date(Date.now() - daysBack * 24 * 3600 * 1000);
    return { from: toYMD(from), to: toYMD(to) };
  }

  // time -> unix seconds (auto ms/sec, string datetime, business-day object)
  function toUnixSec(t) {
    if (t == null) return null;

    // LightweightCharts supports business day object, but our bars use unix sec.
    if (typeof t === "object" && t.year && t.month && t.day) {
      // Convert business day to unix sec at 00:00 UTC
      const ms = Date.UTC(t.year, t.month - 1, t.day);
      return Math.floor(ms / 1000);
    }

    if (typeof t === "number") {
      // if looks like ms, convert
      if (t > 2e10) return Math.floor(t / 1000);
      return Math.floor(t);
    }

    if (typeof t === "string") {
      const ms = Date.parse(t);
      if (!Number.isFinite(ms)) return null;
      return Math.floor(ms / 1000);
    }

    return null;
  }

  // Accept many schemas:
  // - Polygon/Massive: { results:[{t,o,h,l,c,v}] }
  // - Generic: { bars:[...] } / { data:[...] }
  // - Twelve Data: { values:[{datetime,open,high,low,close,volume}] } or { data:{values:[...]}}
  // Also accept direct array.
  function normalizeBars(payload) {
    const raw =
      Array.isArray(payload) ? payload :
      Array.isArray(payload?.results) ? payload.results :
      Array.isArray(payload?.bars) ? payload.bars :
      Array.isArray(payload?.data) ? payload.data :
      Array.isArray(payload?.values) ? payload.values :
      Array.isArray(payload?.data?.values) ? payload.data.values :
      [];

    const bars = (raw || [])
      .map((b) => {
        // time fields
        const tRaw =
          b.time ?? b.t ?? b.timestamp ?? b.ts ?? b.date ?? b.datetime ?? b?.datetime_utc ?? b?.start;
        const time = toUnixSec(tRaw);

        // OHLC fields (support numeric & string)
        const open = Number(b.open ?? b.o ?? b.Open);
        const high = Number(b.high ?? b.h ?? b.High);
        const low  = Number(b.low  ?? b.l ?? b.Low);
        const close= Number(b.close?? b.c ?? b.Close);

        // volume optional
        const volume = Number(b.volume ?? b.v ?? b.Volume);

        if (!time) return null;
        if (![open, high, low, close].every(Number.isFinite)) return null;

        const out = { time, open, high, low, close };
        if (Number.isFinite(volume)) out.volume = volume;
        return out;
      })
      .filter(Boolean);

    bars.sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));

    // de-dupe by time
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

    const out = raw
      .map((s) => {
        const tRaw = s.time ?? s.t ?? s.timestamp ?? s.ts ?? s.date ?? s.datetime;
        const time = toUnixSec(tRaw);

        const sideRaw = String(s.side ?? s.type ?? s.action ?? s.text ?? "").trim();
        const U = sideRaw.toUpperCase();

        let side = "";
        if (sideRaw === "eB" || U === "EB") side = "eB";
        else if (sideRaw === "eS" || U === "ES") side = "eS";
        else if (U === "B" || U.includes("BUY")) side = "B";
        else if (U === "S" || U.includes("SELL")) side = "S";

        if (!time || !side) return null;

        // optional price
        const price = Number(s.price ?? s.p);
        return {
          time,
          side,
          price: Number.isFinite(price) ? price : null,
          strength: (typeof s.strength === "number" ? s.strength : null),
          reason: s.reason ? String(s.reason) : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));

    // de-dupe by time+side
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
  // Non-secret math
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

  function sma(values, period) {
    const p = Math.max(1, Math.floor(period || 1));
    const out = new Array(values.length).fill(NaN);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) { out[i] = NaN; continue; }
      sum += v;
      if (i >= p) sum -= values[i - p];
      if (i >= p - 1) out[i] = sum / p;
    }
    return out;
  }

  function buildLinePoints(bars, values) {
    const pts = new Array(bars.length);
    for (let i = 0; i < bars.length; i++) {
      pts[i] = { time: bars[i].time, value: Number.isFinite(values[i]) ? values[i] : null };
    }
    return pts;
  }

  function computeTrend(emaVals) {
    const n = Math.min(10, emaVals.length - 1);
    if (n < 2) return { emaSlope: null, emaRegime: "NEUTRAL" };
    const eNow = emaVals[emaVals.length - 1];
    const ePrev = emaVals[emaVals.length - 1 - n];
    if (!Number.isFinite(eNow) || !Number.isFinite(ePrev)) return { emaSlope: null, emaRegime: "NEUTRAL" };
    const emaSlope = (eNow - ePrev) / n;
    const emaRegime = emaSlope > 0 ? "UP" : emaSlope < 0 ? "DOWN" : "FLAT";
    return { emaSlope, emaRegime };
  }

  // Add anchor price if missing:
  // - B/eB anchor to LOW
  // - S/eS anchor to HIGH
  function enrichSignalsWithPrice(bars, sigs) {
    const map = new Map();
    for (const b of bars) map.set(b.time, b);
    return (Array.isArray(sigs) ? sigs : [])
      .map((s) => {
        const b = map.get(s.time);
        if (!b) return null;
        if (Number.isFinite(s.price)) return s;
        const side = s.side;
        const anchor =
          (side === "B" || side === "eB") ? b.low :
          (side === "S" || side === "eS") ? b.high :
          b.close;
        return Object.assign({}, s, { price: Number(anchor) });
      })
      .filter(Boolean);
  }

  // -----------------------------
  // Markers (small). Big overlay is in market.pulse.js
  // -----------------------------
  function applyMarkers(sigs) {
    safeRun("applyMarkers", () => {
      if (!candleSeries) return;

      // If you want only big overlay, keep small markers off:
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
  // Snapshot publish (flat + getSnapshot)
  // -----------------------------
  function publishSnapshot(snap) {
    safeRun("publishSnapshot", () => {
      const frozen = Object.freeze(snap);
      window.__DARRIUS_CHART_STATE__ = frozen;

      try {
        window.dispatchEvent(new CustomEvent("darrius:chartUpdated", { detail: frozen }));
      } catch (_) {}
    });
  }

  function setGetSnapshotObject(obj) {
    safeRun("setGetSnapshotObject", () => {
      window.DarriusChart = window.DarriusChart || {};
      window.DarriusChart.getSnapshot = () => {
        try {
          // return a copy so UI cannot mutate core state
          return {
            version: obj.version,
            ts: obj.ts,
            meta: Object.assign({}, obj.meta),
            candles: (obj.candles || []).slice(),
            ema: (obj.ema || []).slice(),
            aux: (obj.aux || []).slice(),
            signals: (obj.signals || []).slice(),
            trend: Object.assign({}, obj.trend),
            risk: Object.assign({}, obj.risk),
          };
        } catch (_) {
          return null;
        }
      };

      if (typeof window.getChartSnapshot !== "function") {
        window.getChartSnapshot = window.DarriusChart.getSnapshot;
      }
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
  // Data meta (for UI labels)
  // -----------------------------
  function resolveDataMeta(tf, aggPayload) {
    const dataMode = String(window.__DATA_MODE__ || window.__DATA_SOURCE__ || "").toLowerCase();
    const delayedMinutesRaw = Number(window.__DELAYED_MINUTES__);

    // Try read provider from payload if backend includes it
    const provider =
      String(aggPayload?.provider || aggPayload?.source || aggPayload?.data_source || "").trim();

    const source =
      provider ||
      String(window.__DATA_SOURCE_NAME__ || window.__DATA_PROVIDER__ || window.__DATA_SOURCE__ || "").trim() ||
      (dataMode.includes("demo") ? "Local" : "Backend-Proxy");

    let delayedMinutes = Number.isFinite(delayedMinutesRaw) ? delayedMinutesRaw : 0;
    if (!Number.isFinite(delayedMinutesRaw)) {
      // reasonable default: if not demo, assume delayed (15) unless you override
      delayedMinutes = dataMode.includes("demo") ? 0 : 15;
      const t = String(tf || "").toLowerCase();
      if (t === "1d" || t === "1w" || t === "1m") delayedMinutes = dataMode.includes("demo") ? 0 : 15;
    }

    return {
      dataMode: dataMode || (source.toLowerCase().includes("local") ? "demo" : "market"),
      source,
      delayedMinutes: Math.max(0, Math.floor(delayedMinutes)),
    };
  }

  // -----------------------------
  // Core fetch
  // -----------------------------
  async function fetchBars(sym, tf) {
    const cfg = tfToAggParams(tf);
    const { from, to } = rangeByDaysBack(cfg.daysBack);

    const url = new URL(API_BASE + AGGS_PATH);
    url.searchParams.set("ticker", String(sym || "AAPL").trim().toUpperCase());
    url.searchParams.set("multiplier", String(cfg.multiplier));
    url.searchParams.set("timespan", String(cfg.timespan));
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);

    const urlStr = url.toString();
    window.__LAST_AGG_URL__ = urlStr;
    DIAG.lastAggUrl = urlStr;

    const payload = await fetchJson(urlStr);
    window.__LAST_AGG__ = payload;

    const bars = normalizeBars(payload);
    return { payload, bars, urlUsed: urlStr, aggCfg: cfg, range: { from, to } };
  }

  function buildSigQueryPairs(sym, tf) {
    // Some backends expect {symbol,tf}, some expect {ticker,timeframe}
    const pairs = [];

    const s = encodeURIComponent(sym);
    const t = encodeURIComponent(tf);

    pairs.push(`symbol=${s}&tf=${t}`);
    pairs.push(`ticker=${s}&tf=${t}`);
    pairs.push(`symbol=${s}&timeframe=${t}`);
    pairs.push(`ticker=${s}&timeframe=${t}`);

    return pairs;
  }

  async function fetchSignalsBestEffort(sym, tf) {
    const pairs = buildSigQueryPairs(sym, tf);

    let lastErr = null;

    for (const path of SIGS_PATHS) {
      for (const q of pairs) {
        const url = `${API_BASE}${path}?${q}`;
        try {
          window.__LAST_SIG_URL__ = url;
          DIAG.lastSigUrl = url;

          const payload = await fetchJson(url);
          window.__LAST_SIG__ = payload;

          const sigs = normalizeSignals(payload);
          if (sigs.length) return sigs;
        } catch (e) {
          lastErr = e;
          window.__LAST_SIG_ERR__ = {
            message: String(e?.message || e),
            status: e?.status,
            body: String(e?.body || ""),
            url,
          };
        }
      }
    }

    if (lastErr) {
      // keep best-effort fail as non-fatal
      return [];
    }
    return [];
  }

  // -----------------------------
  // Main load (never let UI break this)
  // -----------------------------
  async function loadOnce() {
    if (!chart || !candleSeries) return;

    const sym = getUiSymbol();
    const tf = getUiTf();

    // Expose current symbol/tf for console debugging
    window.__CURRENT_SYMBOL__ = sym;
    window.__CURRENT_TIMEFRAME__ = tf;

    safeRun("hintLoading", () => {
      if ($("hintText")) $("hintText").textContent = "Loading...";
    });

    let pack;
    try {
      pack = await fetchBars(sym, tf);
    } catch (e) {
      window.__LAST_AGG_ERR__ = {
        message: String(e?.message || e),
        status: e?.status,
        body: String(e?.body || ""),
      };
      safeRun("hintFail", () => {
        if ($("hintText")) $("hintText").textContent = `加载失败：${e.message || e}`;
      });
      throw e;
    }

    const { payload, bars, urlUsed } = pack;

    if (!bars.length) {
      const err = new Error("bars empty after normalization");
      DIAG.chartError = { message: err.message, stack: String(err.stack || "") };
      throw err;
    }

    // Meta (data source)
    const metaDS = resolveDataMeta(tf, payload);

    // MAIN series data
    candleSeries.setData(bars);

    // EMA
    const closes = bars.map(b => b.close);
    const emaVals = ema(closes, EMA_PERIOD);
    const emaPts = buildLinePoints(bars, emaVals);
    emaSeries.setData(emaPts);

    // AUX (NO-SECRETS):
    //  - If backend provides aux series array, use it
    //  - Else use SMA placeholder so UI has something to render
    let auxVals = null;
    if (Array.isArray(payload?.aux)) {
      // expected [{time,value}] or raw values aligned to bars
      if (payload.aux.length && typeof payload.aux[0] === "object") {
        // already points
        auxSeries.setData(payload.aux);
      } else {
        auxVals = payload.aux.map(Number);
        const auxPts = buildLinePoints(bars, auxVals);
        auxSeries.setData(auxPts);
      }
    } else {
      auxVals = sma(closes, AUX_PERIOD);
      const auxPts = buildLinePoints(bars, auxVals);
      auxSeries.setData(auxPts);
    }

    // Volume (optional)
    safeRun("volume", () => {
      if (!volumeSeries) return;
      const vol = bars
        .filter(b => Number.isFinite(b.volume))
        .map(b => ({ time: b.time, value: b.volume }));
      if (vol.length) volumeSeries.setData(vol);
    });

    // Signals:
    // 1) from agg payload (if exists)
    let sigs = normalizeSignals(payload);

    // 2) from /api/market/sigs best-effort (if none)
    if (!sigs.length) {
      const fetched = await fetchSignalsBestEffort(sym, tf);
      if (fetched.length) sigs = fetched;
    }

    // Ensure signals have price anchors for overlay
    const richSignals = enrichSignalsWithPrice(bars, sigs);

    // Apply small markers if enabled
    applyMarkers(richSignals);

    // Fit chart
    safeRun("fitContent", () => chart.timeScale().fitContent());

    // Trend summary (for Market Pulse to stop "Waiting...")
    const t = computeTrend(emaVals);
    const trend = {
      emaSlope: t.emaSlope,
      emaRegime: t.emaRegime,
      emaColor: t.emaRegime === "UP" ? "GREEN" : t.emaRegime === "DOWN" ? "RED" : "NEUTRAL",
      flipCount: null,
    };

    // Risk placeholders (market.pulse.js can show "-" instead of waiting)
    const risk = {
      entry: null,
      stop: null,
      targets: null,
      confidence: null,
      winrate: null,
    };

    // Top text
    safeRun("topText", () => {
      const last = bars[bars.length - 1];
      if ($("symText")) $("symText").textContent = sym;
      if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);
      if ($("hintText")) {
        $("hintText").textContent =
          `Loaded · provider=auto · TF=${tf} · bars=${bars.length} · sigs=${richSignals.length}`;
      }
    });

    // Build snapshot object for DarriusChart.getSnapshot()
    const snapObj = {
      version: "snapshot_vnext_no_secrets",
      ts: Date.now(),
      meta: {
        symbol: sym,
        timeframe: tf,
        bars: bars.length,
        source: metaDS.source,
        dataMode: metaDS.dataMode,
        delayedMinutes: metaDS.delayedMinutes,
        emaPeriod: EMA_PERIOD,
        auxPeriod: AUX_PERIOD,
        confirmWindow: CONFIRM_WINDOW,
        urlUsed: urlUsed || null,
        provider: String(payload?.provider || payload?.source || "") || null,
      },
      candles: bars,
      ema: emaPts,
      aux: (auxSeries ? (auxSeries._data || []) : []), // not reliable across libs, but harmless
      signals: richSignals,
      trend,
      risk,
    };

    setGetSnapshotObject(snapObj);

    // Flat snapshot (what you check in console)
    const flat = {
      version: "2026.02.02-VNEXT-NO-SECRETS",
      ts: Date.now(),
      apiBase: API_BASE,
      urlUsed: urlUsed || null,
      symbol: sym,
      tf,
      dataMode: metaDS.dataMode,
      source: metaDS.source,
      delayedMinutes: metaDS.delayedMinutes,
      barsCount: bars.length,
      bars: bars.slice(Math.max(0, bars.length - 600)),
      sigsCount: richSignals.length,
      sigs: richSignals.slice(Math.max(0, richSignals.length - 400)),
      signals: richSignals.slice(Math.max(0, richSignals.length - 400)),
      trend,
      risk,
      lastClose: bars[bars.length - 1].close,
    };

    DIAG.lastBarsCount = bars.length;
    DIAG.lastSigsCount = richSignals.length;

    publishSnapshot(flat);

    applyToggles();
    return { bars: bars.length, sigs: richSignals.length, urlUsed };
  }

  async function load() {
    // prevent overlapping poll load
    if (_pollInFlight) return;
    _pollInFlight = true;
    try {
      return await loadOnce();
    } finally {
      _pollInFlight = false;
    }
  }

  // -----------------------------
  // Polling
  // -----------------------------
  function startPolling(intervalMs) {
    stopPolling();
    const ms = Math.max(5000, Number(intervalMs || 15000));
    _pollTimer = setInterval(() => {
      load().catch(() => {});
    }, ms);
  }

  function stopPolling() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
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

    // Mark as active (your console uses this)
    window.__CHART_CORE_ACTIVE__ = true;

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

    // volume (optional)
    volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    // Read-only coordinate bridge (for overlay)
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

    // Toggle listeners
    $("toggleEMA")?.addEventListener("change", applyToggles);
    $("emaToggle")?.addEventListener("change", applyToggles);
    $("tgEMA")?.addEventListener("change", applyToggles);
    $("emaCheck")?.addEventListener("change", applyToggles);

    $("toggleAUX")?.addEventListener("change", applyToggles);
    $("auxToggle")?.addEventListener("change", applyToggles);
    $("tgAux")?.addEventListener("change", applyToggles);
    $("auxCheck")?.addEventListener("change", applyToggles);

    // Auto-load
    if (opts.autoLoad !== false) {
      load().catch((e) => {
        DIAG.chartError = { message: String(e?.message || e), stack: String(e?.stack || "") };
      });
    }

    // Optional polling (keep OFF unless you explicitly enable)
    if (opts.pollMs) startPolling(opts.pollMs);
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

  window.ChartCore = {
    init,
    load,
    applyToggles,
    getSnapshot,
    startPolling,
    stopPolling,
  };
})();
