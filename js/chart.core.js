/* =========================================================================
 * DarriusAI - chart.core.js (VNEXT / NO-SECRETS) v2026.02.03-HARDENED
 *
 * HARDENED fixes:
 *  - normalizeBars(): supports many payload schemas + strong time parsing
 *  - fetchJson(): tolerant JSON parse (strip non-json prefix/suffix)
 *  - Never let empty bars kill the whole UI forever: still publish snapshot + hint
 *  - Always render B/S/eB/eS markers (small markers) to ensure "signals come back"
 *  - Disable volume histogram by default (to avoid "many columns" confusion)
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
    try { return fn(); }
    catch (e) {
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

  // Your backend proxy endpoint
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
  const COLOR_UP  = "#2BE2A6";
  const COLOR_DN  = "#FF5A5A";
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
  // Fetch helpers (HARDENED JSON)
  // -----------------------------
  function parseJsonLoose(text) {
  const s = String(text ?? "").trim();

  // 1) Fast path
  try { return JSON.parse(s); } catch (_) {}

  // 2) If multiple JSON objects are concatenated, parse from the end.
  //    Try to parse substrings that start at each "{" (from right to left).
  const starts = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 123 /* { */ || ch === 91 /* [ */) starts.push(i);
  }
  for (let k = starts.length - 1; k >= 0; k--) {
    const i = starts[k];
    const sub = s.slice(i);
    try {
      return JSON.parse(sub);
    } catch (_) {
      // keep trying earlier start
    }
  }

  // 3) Fallback: cut between first opener and last closer, then try again.
  const firstObj = s.indexOf("{");
  const firstArr = s.indexOf("[");
  let start = -1;
  if (firstObj >= 0 && firstArr >= 0) start = Math.min(firstObj, firstArr);
  else start = Math.max(firstObj, firstArr);

  const lastObj = s.lastIndexOf("}");
  const lastArr = s.lastIndexOf("]");
  const end = Math.max(lastObj, lastArr);

  if (start >= 0 && end > start) {
    const cut = s.slice(start, end + 1);
    return JSON.parse(cut);
  }

  throw new Error("Invalid JSON");
}

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
      return parseJsonLoose(text);
    } catch (e) {
      const err = new Error("Invalid JSON");
      err.body = text;
      throw err;
    }
  }

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
    const y  = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${da}`;
  }

  function rangeByDaysBack(daysBack) {
    const to = new Date();
    const from = new Date(Date.now() - daysBack * 24 * 3600 * 1000);
    return { from: toYMD(from), to: toYMD(to) };
  }

  // -----------------------------
  // Time parsing (HARDENED)
  // -----------------------------
  function toUnixSecAny(t) {
    if (t == null) return null;

    // Business day object (year/month/day)
    if (typeof t === "object" && t.year && t.month && t.day) {
      const ms = Date.UTC(t.year, t.month - 1, t.day);
      return Math.floor(ms / 1000);
    }

    // number: sec or ms
    if (typeof t === "number" && Number.isFinite(t)) {
      return (t > 2e10) ? Math.floor(t / 1000) : Math.floor(t);
    }

    // numeric string or date string
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

    return null;
  }

  // -----------------------------
  // Normalizers (HARDENED)
  // -----------------------------
  function normalizeBars(payload) {
    // Compatible schemas:
    // - payload.results
    // - payload.bars
    // - payload.data.results
    // - payload.data.bars
    // - payload.values
    // - payload.data.values
    // - payload.data.data.values
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

    const bars = (raw || [])
      .map((b) => {
        const tRaw =
          b?.time ?? b?.t ?? b?.timestamp ?? b?.ts ??
          b?.date ?? b?.datetime ?? b?.datetime_utc ??
          b?.candleTime ?? b?.start ?? b?.end;

        const time = toUnixSecAny(tRaw);

        const open  = Number(b?.open  ?? b?.o ?? b?.Open);
        const high  = Number(b?.high  ?? b?.h ?? b?.High);
        const low   = Number(b?.low   ?? b?.l ?? b?.Low);
        const close = Number(b?.close ?? b?.c ?? b?.Close);

        const volume = Number(b?.volume ?? b?.v ?? b?.Volume);

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
    // Accept:
    // - payload.signals / payload.sigs
    // - payload.data.signals / payload.data.sigs
    // - payload.result.signals (rare)
    const raw =
      payload?.signals ||
      payload?.sigs ||
      payload?.data?.signals ||
      payload?.data?.sigs ||
      payload?.result?.signals ||
      payload?.result?.sigs ||
      [];

    if (!Array.isArray(raw)) return [];

    const out = raw
      .map((s) => {
        const tRaw = s?.time ?? s?.t ?? s?.timestamp ?? s?.ts ?? s?.date ?? s?.datetime;
        const time = toUnixSecAny(tRaw);

        const sideRaw = String(s?.side ?? s?.type ?? s?.action ?? s?.text ?? "").trim();
        const U = sideRaw.toUpperCase();

        let side = "";
        if (sideRaw === "eB" || U === "EB") side = "eB";
        else if (sideRaw === "eS" || U === "ES") side = "eS";
        else if (U === "B" || U.includes("BUY")) side = "B";
        else if (U === "S" || U.includes("SELL")) side = "S";

        if (!time || !side) return null;

        const price = Number(s?.price ?? s?.p);
        return {
          time,
          side,
          price: Number.isFinite(price) ? price : null,
          strength: (typeof s?.strength === "number" ? s.strength : null),
          reason: s?.reason ? String(s.reason) : null,
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
      const val = Number.isFinite(values[i]) ? values[i] : null;
      pts[i] = { time: bars[i].time, value: val };
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
  // Markers (FORCE ON to bring signals back)
  // -----------------------------
  function applyMarkers(sigs) {
    safeRun("applyMarkers", () => {
      if (!candleSeries) return;

      const arr = (Array.isArray(sigs) ? sigs : []).filter(s => s && (s.side === "B" || s.side === "S" || s.side === "eB" || s.side === "eS"));

      candleSeries.setMarkers(arr.map((s) => {
        const isBuy = (s.side === "B" || s.side === "eB");
        const isEarly = (s.side === "eB" || s.side === "eS");

        return {
          time: s.time,
          position: isBuy ? "belowBar" : "aboveBar",
          color: isBuy ? "#FFD400" : "#FF5A5A",
          shape: isBuy ? "arrowUp" : "arrowDown",
          text: isEarly ? s.side : s.side, // show eB/eS explicitly
        };
      }));
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

    const provider =
      String(aggPayload?.provider || aggPayload?.source || aggPayload?.data_source || "").trim();

    const source =
      provider ||
      String(window.__DATA_SOURCE_NAME__ || window.__DATA_PROVIDER__ || window.__DATA_SOURCE__ || "").trim() ||
      (dataMode.includes("demo") ? "Local" : "Backend-Proxy");

    let delayedMinutes = Number.isFinite(delayedMinutesRaw) ? delayedMinutesRaw : 0;
    if (!Number.isFinite(delayedMinutesRaw)) {
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
    return { payload, bars, urlUsed: urlStr };
  }

  function buildSigQueryPairs(sym, tf) {
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

    if (lastErr) return [];
    return [];
  }

  // -----------------------------
  // Main load
  // -----------------------------
  async function loadOnce() {
    if (!chart || !candleSeries) return;

    const sym = getUiSymbol();
    const tf = getUiTf();

    window.__CURRENT_SYMBOL__ = sym;
    window.__CURRENT_TIMEFRAME__ = tf;

    safeRun("hintLoading", () => {
      if ($("hintText")) $("hintText").textContent = "Loading...";
    });

    let payload = null;
    let bars = [];
    let urlUsed = null;

    try {
      const pack = await fetchBars(sym, tf);
      payload = pack.payload;
      bars = pack.bars;
      urlUsed = pack.urlUsed;
    } catch (e) {
      window.__LAST_AGG_ERR__ = {
        message: String(e?.message || e),
        status: e?.status,
        body: String(e?.body || ""),
      };

      // Still publish a minimal snapshot so UI doesn't "die waiting"
      const flatFail = {
        version: "2026.02.03-HARDENED",
        ts: Date.now(),
        apiBase: API_BASE,
        urlUsed: window.__LAST_AGG_URL__ || null,
        symbol: sym,
        tf,
        barsCount: 0,
        sigsCount: 0,
        sigs: [],
        signals: [],
        trend: { emaSlope: null, emaRegime: "NEUTRAL", emaColor: "NEUTRAL", flipCount: null },
        risk: { entry: null, stop: null, targets: null, confidence: null, winrate: null },
        error: { stage: "fetchBars", message: String(e?.message || e) },
      };
      publishSnapshot(flatFail);

      safeRun("hintFail", () => {
        if ($("hintText")) $("hintText").textContent = `加载失败：${e.message || e}`;
      });
      throw e;
    }

    // Meta (data source)
    const metaDS = resolveDataMeta(tf, payload);

    // If bars empty: do NOT crash forever. Show hint + publish snapshot.
    if (!bars.length) {
      const msg = `无K线数据（bars=0）。可能原因：${sym} 不属于 stocks aggregates（如 BTCUSDT），或日期范围/后端数据源不匹配。`;
      DIAG.chartError = { message: msg, stack: "" };

      safeRun("hintEmptyBars", () => {
        if ($("hintText")) $("hintText").textContent = msg;
      });

      const flatEmpty = {
        version: "2026.02.03-HARDENED",
        ts: Date.now(),
        apiBase: API_BASE,
        urlUsed: urlUsed || null,
        symbol: sym,
        tf,
        dataMode: metaDS.dataMode,
        source: metaDS.source,
        delayedMinutes: metaDS.delayedMinutes,
        barsCount: 0,
        bars: [],
        sigsCount: 0,
        sigs: [],
        signals: [],
        trend: { emaSlope: null, emaRegime: "NEUTRAL", emaColor: "NEUTRAL", flipCount: null },
        risk: { entry: null, stop: null, targets: null, confidence: null, winrate: null },
      };
      publishSnapshot(flatEmpty);
      DIAG.lastBarsCount = 0;
      DIAG.lastSigsCount = 0;
      return { bars: 0, sigs: 0, urlUsed };
    }

    // MAIN series data
    candleSeries.setData(bars);

    // EMA
    const closes = bars.map(b => b.close);
    const emaVals = ema(closes, EMA_PERIOD);
    const emaPts  = buildLinePoints(bars, emaVals);
    emaSeries.setData(emaPts);

    // AUX: backend aux if exists, else SMA placeholder
    if (Array.isArray(payload?.aux)) {
      if (payload.aux.length && typeof payload.aux[0] === "object") {
        auxSeries.setData(payload.aux);
      } else {
        const auxVals = payload.aux.map(Number);
        auxSeries.setData(buildLinePoints(bars, auxVals));
      }
    } else {
      const auxVals = sma(closes, AUX_PERIOD);
      auxSeries.setData(buildLinePoints(bars, auxVals));
    }

    // Volume: OFF by default (avoid "many columns")
    const WANT_VOLUME = (window.__SHOW_VOLUME__ === true);
    safeRun("volume", () => {
      if (!volumeSeries) return;
      volumeSeries.applyOptions({ visible: !!WANT_VOLUME });
      if (!WANT_VOLUME) return;

      const vol = bars
        .filter(b => Number.isFinite(b.volume))
        .map(b => ({ time: b.time, value: b.volume }));
      if (vol.length) volumeSeries.setData(vol);
    });

    // Signals
    let sigs = normalizeSignals(payload);
    if (!sigs.length) {
      const fetched = await fetchSignalsBestEffort(sym, tf);
      if (fetched.length) sigs = fetched;
    }

    const richSignals = enrichSignalsWithPrice(bars, sigs);

    // Force markers ON
    applyMarkers(richSignals);

    // Fit chart
    safeRun("fitContent", () => chart.timeScale().fitContent());

    // Trend summary
    const t = computeTrend(emaVals);
    const trend = {
      emaSlope: t.emaSlope,
      emaRegime: t.emaRegime,
      emaColor: t.emaRegime === "UP" ? "GREEN" : t.emaRegime === "DOWN" ? "RED" : "NEUTRAL",
      flipCount: null,
    };

    const risk = { entry: null, stop: null, targets: null, confidence: null, winrate: null };

    // Top text
    safeRun("topText", () => {
      const last = bars[bars.length - 1];
      if ($("symText")) $("symText").textContent = sym;
      if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);
      if ($("hintText")) {
        $("hintText").textContent =
          `Loaded · bars=${bars.length} · sigs=${richSignals.length} · source=${metaDS.source}`;
      }
    });

    // Snapshot object for DarriusChart.getSnapshot()
    const snapObj = {
      version: "snapshot_hardened_no_secrets",
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
      aux: [], // not needed by UI directly
      signals: richSignals,
      trend,
      risk,
    };
    setGetSnapshotObject(snapObj);

    // Flat snapshot
    const flat = {
      version: "2026.02.03-HARDENED",
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
    if (_pollInFlight) return;
    _pollInFlight = true;
    try { return await loadOnce(); }
    finally { _pollInFlight = false; }
  }

  // -----------------------------
  // Polling
  // -----------------------------
  function startPolling(intervalMs) {
    stopPolling();
    const ms = Math.max(5000, Number(intervalMs || 15000));
    _pollTimer = setInterval(() => { load().catch(() => {}); }, ms);
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

    // volume series exists but default hidden
    volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
      scaleMargins: { top: 0.82, bottom: 0 },
    });
    volumeSeries.applyOptions({ visible: false });

    // Coordinate bridge (for overlay)
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
      try { new ResizeObserver(resize).observe(containerEl); }
      catch (_) { window.addEventListener("resize", resize); }
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

    // Optional polling
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

  window.ChartCore = { init, load, applyToggles, getSnapshot, startPolling, stopPolling };
})();
