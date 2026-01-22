/* =========================================================================
 * DarriusAI - chart.core.js (FROZEN MAIN CHART) v2026.01.22-DATAMODE-STABLE
 *
 * Role:
 *  - Render main chart (candles + EMA + AUX + signals)
 *  - Fetch OHLCV via backend proxy (Massive/Polygon aggregates)
 *  - Output a read-only snapshot to:
 *      window.__DARRIUS_CHART_STATE__  (canonical)
 *      window.__IH_SNAPSHOT__         (compat)
 *      window.__CHART_SNAPSHOT__      (compat)
 *  - Provide read-only coordinate bridge for overlays:
 *      window.DarriusChart.timeToX / priceToY
 *      window.DarriusChart.getSnapshot()
 *
 * Preset 2:
 *  - EMA 14
 *  - AUX 40 (HMA-like)
 *  - confirm window 3
 *  - Candles colored by EMA slope
 *
 * Guarantees:
 *  1) Main chart render is highest priority and will not be broken by UI
 *  2) Non-critical parts (snapshot/event/markers) are wrapped in no-throw safe zones
 *  3) No billing/subscription/payments code touched
 * ========================================================================= */

(() => {
  "use strict";

  // -----------------------------
  // Global diagnostic (never throw)
  // -----------------------------
  const DIAG = (window.__DARRIUS_DIAG__ = window.__DARRIUS_DIAG__ || {
    lastError: null,
    chartError: null,
    lastUrl: null,
    lastBars: 0,
    lastSigs: 0,
    timeMode: null,
  });

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

  // -----------------------------
  // Config
  // -----------------------------
  const DEFAULT_API_BASE =
    (window.DARRIUS_API_BASE && String(window.DARRIUS_API_BASE)) ||
    (window._API_BASE_ && String(window._API_BASE_)) ||
    (window.API_BASE && String(window.API_BASE)) ||
    "https://darrius-api.onrender.com";

  // Backward compat candidates (optional fallback)
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

  const SIGS_PATH_CANDIDATES = [
    "/api/market/sigs",
    "/api/market/signals",
    "/api/sigs",
    "/api/signals",
    "/sigs",
    "/signals",
  ];

  // Preferred endpoint:
  // /api/data/stocks/aggregates?ticker=...&multiplier=...&timespan=...&from=...&to=...
  const MASSIVE_AGGS_PATH = "/api/data/stocks/aggregates";

  // -----------------------------
  // Preset 2 params
  // -----------------------------
  const EMA_PERIOD = 14;
  const AUX_PERIOD = 40;
  const AUX_METHOD = "SMA";
  const CONFIRM_WINDOW = 3;

  // De-chatter (fix: trend mid-cross spam)
  const MIN_BARS_BETWEEN_SIGNALS = 6;     // lockout bars after emitting a signal
  const MIN_SEPARATION_RATIO = 0.00025;   // min |EMA-AUX| / price for a valid cross
  const REQUIRE_AUX_SLOPE_CONFIRM = true; // confirm needs AUX slope flip in window

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

  // track candle time mode for coordinate bridge
  // 'utc' -> UTCTimestamp seconds
  // 'businessDay' -> {year,month,day}
  let __timeMode = "utc";

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

  // -----------------------------
  // Fetch helpers
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

  function isBusinessDay(t) {
    return !!(t && typeof t === "object" && t.year && t.month && t.day);
  }

  function toUnixSec(t) {
    if (t == null) return null;
    if (typeof t === "number" && Number.isFinite(t)) {
      if (t > 2e10) return Math.floor(t / 1000); // ms -> s
      return t; // assume already seconds
    }
    if (typeof t === "string") {
      const ms = Date.parse(t);
      if (!Number.isFinite(ms)) return null;
      return Math.floor(ms / 1000);
    }
    if (isBusinessDay(t)) {
      const ms = Date.UTC(t.year, (t.month || 1) - 1, t.day || 1, 0, 0, 0);
      return Math.floor(ms / 1000);
    }
    return null;
  }

  function toBusinessDayFromUnixSec(sec) {
    const ms = sec * 1000;
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return null;
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }

  function normalizeBars(payload) {
    const raw =
      Array.isArray(payload) ? payload :
      Array.isArray(payload?.results) ? payload.results :      // Polygon aggregates
      Array.isArray(payload?.bars) ? payload.bars :
      Array.isArray(payload?.ohlcv) ? payload.ohlcv :
      Array.isArray(payload?.data) ? payload.data :
      [];

    const bars = (raw || [])
      .map((b) => {
        const time = toUnixSec(b.time ?? b.t ?? b.timestamp ?? b.ts ?? b.date);
        const open = Number(b.open ?? b.o ?? b.Open);
        const high = Number(b.high ?? b.h ?? b.High);
        const low  = Number(b.low  ?? b.l ?? b.Low);
        const close= Number(b.close?? b.c ?? b.Close);
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
        const side = String(s.side ?? s.type ?? s.action ?? s.text ?? "").toUpperCase();
        const ss = (side.includes("BUY") ? "B" : side.includes("SELL") ? "S" : side);
        if (!time || (ss !== "B" && ss !== "S")) return null;
        return { time, side: ss, price: Number.isFinite(Number(s.price)) ? Number(s.price) : null };
      })
      .filter(Boolean)
      .sort((x, y) => (x.time > y.time ? 1 : x.time < y.time ? -1 : 0));
  }

  async function fetchBarsPack(sym, tf) {
    const apiBase = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");

    const cfg = tfToAggParams(tf);
    const { from, to } = rangeByDaysBack(cfg.daysBack);

    const url = new URL(apiBase + MASSIVE_AGGS_PATH);
    url.searchParams.set("ticker", String(sym || "AAPL").trim().toUpperCase());
    url.searchParams.set("multiplier", String(cfg.multiplier));
    url.searchParams.set("timespan", String(cfg.timespan));
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);

    const payload = await fetchJson(url.toString());
    const bars = normalizeBars(payload);

    if (bars.length) return { payload, bars, urlUsed: url.toString() };

    // fallback (optional)
    let lastErr = new Error(`Aggs returned empty. ticker=${sym} tf=${tf} from=${from} to=${to}`);
    const q = `symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;

    for (const p of BARS_PATH_CANDIDATES) {
      const u = `${apiBase}${p}?${q}`;
      try {
        const pl = await fetchJson(u);
        const bs = normalizeBars(pl);
        if (bs.length) return { payload: pl, bars: bs, urlUsed: u };
        lastErr = new Error(`bars empty from ${u}`);
      } catch (e) {
        lastErr = e;
      }
    }

    throw new Error(`All bars endpoints failed. Last error: ${lastErr?.message || lastErr}`);
  }

  async function fetchOptionalSignals(sym, tf) {
    const apiBase = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");
    const q = `symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;
    for (const p of SIGS_PATH_CANDIDATES) {
      const url = `${apiBase}${p}?${q}`;
      try {
        const payload = await fetchJson(url);
        const sigs = normalizeSignals(payload);
        if (sigs.length) return sigs;
      } catch (_) {}
    }
    return [];
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

  function buildLinePoints(bars, values) {
    const pts = new Array(bars.length);
    for (let i = 0; i < bars.length; i++) {
      pts[i] = { time: bars[i].time, value: Number.isFinite(values[i]) ? values[i] : null };
    }
    return pts;
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

  function computeAuxSlope(auxV, i) {
    if (i <= 0) return 0;
    const a0 = auxV[i - 1], a1 = auxV[i];
    if (!Number.isFinite(a0) || !Number.isFinite(a1)) return 0;
    if (a1 > a0) return 1;
    if (a1 < a0) return -1;
    return 0;
  }

  // Fix: avoid mid-trend EMA/AUX repeated crossings producing spam signals
  function computeSignalsCrossPlusConfirm(bars, emaPts, auxPts, confirmWindow) {
    const n = bars.length;
    if (n < 10) return [];

    const emaV = emaPts.map(p => p.value);
    const auxV = auxPts.map(p => p.value);

    const cw = Math.max(1, Math.floor(confirmWindow ?? 3));
    const sigs = [];
    const used = new Set();

    let lastSigIndex = -999999;
    let lastSigSide = null;

    function addSig(i, side) {
      const t = bars[i].time;
      const key = `${t}:${side}`;
      if (used.has(key)) return;
      used.add(key);
      sigs.push({ time: t, side, i });
      lastSigIndex = i;
      lastSigSide = side;
    }

    function separationOk(i) {
      const e = emaV[i], a = auxV[i];
      const px = bars[i]?.close;
      if (![e, a, px].every(Number.isFinite)) return false;
      const sep = Math.abs(e - a);
      return (sep / Math.max(1e-9, Math.abs(px))) >= MIN_SEPARATION_RATIO;
    }

    function findConfirmIndex(startIdx, wantSlopeSign) {
      // confirm by AUX slope flip (preferred) or by staying consistent for cw bars
      let seen = 0;
      for (let j = startIdx; j <= Math.min(n - 1, startIdx + cw); j++) {
        const s = computeAuxSlope(auxV, j);
        if (REQUIRE_AUX_SLOPE_CONFIRM) {
          if (wantSlopeSign > 0 && s > 0) return j;
          if (wantSlopeSign < 0 && s < 0) return j;
        } else {
          if (wantSlopeSign > 0 && s >= 0) seen++;
          if (wantSlopeSign < 0 && s <= 0) seen++;
          if (seen >= Math.max(1, Math.floor(cw * 0.6))) return j;
        }
      }
      return -1;
    }

    for (let i = 1; i < n; i++) {
      // lockout
      if ((i - lastSigIndex) < MIN_BARS_BETWEEN_SIGNALS) continue;

      const e0 = emaV[i - 1], e1 = emaV[i];
      const a0 = auxV[i - 1], a1 = auxV[i];
      if (![e0, e1, a0, a1].every(Number.isFinite)) continue;

      // raw cross
      const crossUp = (e0 <= a0 && e1 > a1);
      const crossDn = (e0 >= a0 && e1 < a1);

      if (crossUp) {
        if (!separationOk(i)) continue;
        if (lastSigSide === "B") continue; // avoid B->B
        const k = findConfirmIndex(i, +1);
        if (k >= 0) addSig(k, "B");
      } else if (crossDn) {
        if (!separationOk(i)) continue;
        if (lastSigSide === "S") continue; // avoid S->S
        const k = findConfirmIndex(i, -1);
        if (k >= 0) addSig(k, "S");
      }
    }

    sigs.sort((x, y) => (x.time > y.time ? 1 : x.time < y.time ? -1 : 0));
    return sigs;
  }

  function applyMarkers(sigs) {
    safeRun("applyMarkers", () => {
      if (!candleSeries) return;

      // If overlay is enabled, keep series markers empty.
      if (window.__OVERLAY_BIG_SIGS__ === true) { candleSeries.setMarkers([]); return; }

      const arr = Array.isArray(sigs) ? sigs : [];
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
  // Snapshot output (read-only)
  // -----------------------------
  function publishSnapshot(snapshot) {
    safeRun("publishSnapshot", () => {
      const s = Object.freeze(snapshot);

      // canonical
      window.__DARRIUS_CHART_STATE__ = s;

      // compat aliases (so UI won't break if it expects other names)
      window.__IH_SNAPSHOT__ = s;
      window.__CHART_SNAPSHOT__ = s;

      // event
      try {
        window.dispatchEvent(new CustomEvent("darrius:chartUpdated", { detail: s }));
      } catch (_) {}
    });
  }

  // -----------------------------
  // Toggles
  // -----------------------------
  function applyToggles() {
    safeRun("applyToggles", () => {
      const emaChecked = $("toggleEMA")?.checked ?? $("emaToggle")?.checked ?? $("tgEMA")?.checked ?? $("emaCheck")?.checked;
      const auxChecked = $("toggleAUX")?.checked ?? $("auxToggle")?.checked ?? $("tgAux")?.checked ?? $("auxCheck")?.checked;

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
      throw e;
    }

    const { payload, bars, urlUsed } = pack;
    if (!bars.length) throw new Error("bars empty after normalization");

    DIAG.lastUrl = urlUsed;
    DIAG.lastBars = bars.length;

    // -------- MAIN CHART --------
    const closes = bars.map(b => b.close);
    const emaVals = ema(closes, EMA_PERIOD);
    const auxVals = computeAuxByYourAlgo(closes, AUX_PERIOD, AUX_METHOD);

    const coloredBars = colorCandlesByEMATrend(bars, emaVals);
    candleSeries.setData(coloredBars);

    const emaPts = buildLinePoints(bars, emaVals);
    const auxPts = buildLinePoints(bars, auxVals);
    emaSeries.setData(emaPts);
    auxSeries.setData(auxPts);

    // signals: try payload then optional endpoints then compute fallback
    let sigs = normalizeSignals(payload);
    if (!sigs.length) sigs = await fetchOptionalSignals(sym, tf);
    if (!sigs.length) sigs = computeSignalsCrossPlusConfirm(bars, emaPts, auxPts, CONFIRM_WINDOW);

    DIAG.lastSigs = sigs.length;

    applyMarkers(sigs);

    safeRun("fitContent", () => chart.timeScale().fitContent());

    safeRun("topText", () => {
      const last = bars[bars.length - 1];
      if ($("symText")) $("symText").textContent = sym;
      if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);
      if ($("hintText")) $("hintText").textContent = `Loaded · TF=${tf} · bars=${bars.length} · sigs=${sigs.length}`;
    });

    // ===== Coordinate bridge time mode =====
    __timeMode = "utc"; // bars.time is unix seconds by normalization
    DIAG.timeMode = __timeMode;

    // ===== Snapshot Export (for market.pulse.js) =====
    safeRun("setSnapshotForUI", () => {
      try {
        // closeByTime for signal price fill
        const closeByTime = new Map();
        for (const b of bars) closeByTime.set(b.time, b.close);

        const snapSignals = (Array.isArray(sigs) ? sigs : [])
          .slice(Math.max(0, sigs.length - 200))
          .map((s, idx) => {
            const t = s.time ?? null;
            const side = (String(s.side || "").toUpperCase() === "S") ? "S" : "B";
            const price = Number.isFinite(s.price) ? s.price : (closeByTime.get(t) ?? null);
            return {
              time: t,
              price: Number.isFinite(price) ? price : null,
              side,
              i: (typeof s.i === "number" ? s.i : idx),
              reason: s.reason || s.note || null,
              strength: (typeof s.strength === "number" ? s.strength : null),
            };
          })
          .filter(x => x.time != null && x.price != null);

        const snapMeta = {
          symbol: sym || null,
          timeframe: tf || null,
          bars: bars.length,
          source: (window.__DATA_SOURCE__ || "market"),
          dataMode: (window.__DATA_MODE__ || "Delayed"),
          delayedMinutes: (typeof window.__DELAYED_MINUTES__ === "number" ? window.__DELAYED_MINUTES__ : 15),
          emaPeriod: EMA_PERIOD,
          auxPeriod: AUX_PERIOD,
          confirmWindow: CONFIRM_WINDOW,
          urlUsed: urlUsed || null,
        };

        // trend summary (EMA slope)
        const n = Math.min(10, emaVals.length - 1);
        let emaSlope = null;
        let emaRegime = null;
        let emaColor = null;

        if (n >= 2) {
          const eNow = emaVals[emaVals.length - 1];
          const ePrev = emaVals[emaVals.length - 1 - n];
          if (Number.isFinite(eNow) && Number.isFinite(ePrev)) {
            emaSlope = (eNow - ePrev) / n;
            if (emaSlope > 0) emaRegime = "UP";
            else if (emaSlope < 0) emaRegime = "DOWN";
            else emaRegime = "FLAT";
          }
        }
        if (emaRegime === "UP") emaColor = "GREEN";
        else if (emaRegime === "DOWN") emaColor = "RED";
        else emaColor = "NEUTRAL";

        const snapTrend = { emaSlope, emaRegime, emaColor, flipCount: null };
        const snapRisk = { entry: null, stop: null, targets: null, confidence: null, winrate: null };

        window.DarriusChart = window.DarriusChart || {};
        if (typeof window.DarriusChart.__setSnapshot === "function") {
          window.DarriusChart.__setSnapshot({
            meta: snapMeta,
            candles: bars,
            ema: emaPts,
            aux: auxPts,
            signals: snapSignals,
            trend: snapTrend,
            risk: snapRisk,
          });
        }
      } catch (_) {}
    });

    // -------- SNAPSHOT OUTPUT (consumer only) --------
    const N = Math.min(400, bars.length);
    const start = bars.length - N;

    const snapshot = {
      version: "2026.01.22-DATAMODE-STABLE",
      ts: Date.now(),
      apiBase: DEFAULT_API_BASE,
      urlUsed,
      symbol: sym,
      tf,
      timeMode: __timeMode,
      params: {
        EMA_PERIOD, AUX_PERIOD, AUX_METHOD, CONFIRM_WINDOW,
        MIN_BARS_BETWEEN_SIGNALS,
        MIN_SEPARATION_RATIO,
        REQUIRE_AUX_SLOPE_CONFIRM
      },
      barsCount: bars.length,
      bars: bars.slice(start),
      ema: emaVals.slice(start),
      aux: auxVals.slice(start),
      sigs: (Array.isArray(sigs) ? sigs : []).slice(Math.max(0, sigs.length - 200)),
      lastClose: bars[bars.length - 1].close,
      dataSource: (window.__DATA_SOURCE__ || "market"),
      dataMode: (window.__DATA_MODE__ || "Delayed"),
      delayedMinutes: (typeof window.__DELAYED_MINUTES__ === "number" ? window.__DELAYED_MINUTES__ : 15),
    };

    publishSnapshot(snapshot);
    applyToggles();

    return { urlUsed, bars: bars.length, sigs: (sigs || []).length };
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

    // -----------------------------
    // Read-only coordinate bridge (for market.pulse.js overlay)
    // -----------------------------
    safeRun("bridgeExpose", () => {
      window.DarriusChart = window.DarriusChart || {};

      // expose host id
      window.DarriusChart.__hostId = containerId || "chart";

      // expose time mode
      window.DarriusChart.__timeMode = () => __timeMode;

      // timeToX accepts:
      //  - unix seconds number
      //  - businessDay object {year,month,day}
      // It converts to current chart mode safely.
      window.DarriusChart.timeToX = (t) => safeRun("timeToX", () => {
        if (!chart || !chart.timeScale) return null;

        // chart uses utc seconds in this build
        if (__timeMode === "utc") {
          const sec = toUnixSec(t);
          if (sec == null) return null;
          return chart.timeScale().timeToCoordinate(sec);
        }

        // if someday you switch to businessDay candles, support it too
        if (__timeMode === "businessDay") {
          if (isBusinessDay(t)) return chart.timeScale().timeToCoordinate(t);
          const sec = toUnixSec(t);
          if (sec == null) return null;
          const bd = toBusinessDayFromUnixSec(sec);
          if (!bd) return null;
          return chart.timeScale().timeToCoordinate(bd);
        }

        return null;
      });

      window.DarriusChart.priceToY = (p) => safeRun("priceToY", () => {
        if (!candleSeries || !candleSeries.priceToCoordinate) return null;
        const n = Number(p);
        if (!Number.isFinite(n)) return null;
        return candleSeries.priceToCoordinate(n);
      });
    });

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

    // Accept various checkbox ids
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

  // public API
  window.ChartCore = { init, load, applyToggles };
})();

/* =========================
 * Snapshot Export (READ-ONLY)
 * - UI层（market.pulse.js）只读这里
 * - 不允许 UI 层反向修改主图内部
 * ========================= */

(function () {
  "use strict";

  const __SNAPSHOT = {
    version: "snapshot_v1",
    ts: 0,

    meta: {
      symbol: null,
      timeframe: null,
      bars: 0,
      source: "demo",
      dataMode: "Demo",
      delayedMinutes: 0,
      emaPeriod: null,
      auxPeriod: null,
      confirmWindow: null,
      urlUsed: null,
    },

    candles: [],     // [{time, open, high, low, close}]
    ema: [],         // [{time, value}]
    aux: [],         // [{time, value}]
    signals: [],     // [{time, price, side:'B'|'S', i, reason?, strength?}]

    trend: {
      emaSlope: null,
      emaRegime: null,
      emaColor: null,
      flipCount: null,
    },

    risk: {
      entry: null,
      stop: null,
      targets: null,
      confidence: null,
      winrate: null,
    },
  };

  function __setSnapshot(patch) {
    try {
      if (!patch || typeof patch !== "object") return;

      __SNAPSHOT.ts = Date.now();

      if (patch.meta) {
        __SNAPSHOT.meta = Object.assign({}, __SNAPSHOT.meta, patch.meta);
      }
      if (Array.isArray(patch.candles)) __SNAPSHOT.candles = patch.candles.slice();
      if (Array.isArray(patch.ema))     __SNAPSHOT.ema     = patch.ema.slice();
      if (Array.isArray(patch.aux))     __SNAPSHOT.aux     = patch.aux.slice();
      if (Array.isArray(patch.signals)) __SNAPSHOT.signals = patch.signals.slice();

      if (patch.trend) {
        __SNAPSHOT.trend = Object.assign({}, __SNAPSHOT.trend, patch.trend);
      }
      if (patch.risk) {
        __SNAPSHOT.risk = Object.assign({}, __SNAPSHOT.risk, patch.risk);
      }
    } catch (_) {}
  }

  function __getSnapshot() {
    try {
      return {
        version: __SNAPSHOT.version,
        ts: __SNAPSHOT.ts,
        meta: Object.assign({}, __SNAPSHOT.meta),
        candles: (__SNAPSHOT.candles || []).slice(),
        ema: (__SNAPSHOT.ema || []).slice(),
        aux: (__SNAPSHOT.aux || []).slice(),
        signals: (__SNAPSHOT.signals || []).slice(),
        trend: Object.assign({}, __SNAPSHOT.trend),
        risk: Object.assign({}, __SNAPSHOT.risk),
      };
    } catch (e) {
      return null;
    }
  }

  window.DarriusChart = window.DarriusChart || {};
  window.DarriusChart.getSnapshot = __getSnapshot;
  window.DarriusChart.__setSnapshot = __setSnapshot;

  if (typeof window.getChartSnapshot !== "function") {
    window.getChartSnapshot = __getSnapshot;
  }
})();
