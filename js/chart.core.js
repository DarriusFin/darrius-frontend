/* =========================================================================
 * DarriusAI - chart.core.js (FROZEN MAIN CHART) v2026.01.23-EBES-TRENDLOCK
 *
 * Role:
 *  - Render main chart (candles + EMA + AUX + signals)
 *  - Fetch OHLCV via backend proxy (Massive/Polygon aggregates)
 *  - Output a read-only snapshot to window.__DARRIUS_CHART_STATE__
 *  - Provide read-only bridge for UI overlay (market.pulse.js):
 *      DarriusChart.timeToX / DarriusChart.priceToY / DarriusChart.getSnapshot()
 *  - Emit event "darrius:chartUpdated" with snapshot detail
 *
 * Guarantees:
 *  1) Main chart render is highest priority and will not be broken by UI
 *  2) Non-critical parts (snapshot/event/markers) are wrapped in no-throw safe zones
 *  3) No billing/subscription code touched
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

  // Verified endpoint:
  // /api/data/stocks/aggregates?ticker=...&multiplier=...&timespan=...&from=...&to=...
  const MASSIVE_AGGS_PATH = "/api/data/stocks/aggregates";

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

  // -----------------------------
  // Preset 2 params
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

  // tf -> multiplier/timespan + a reasonable history window
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
      return t;
    }
    if (typeof t === "string") {
      const ms = Date.parse(t);
      if (!Number.isFinite(ms)) return null;
      return Math.floor(ms / 1000);
    }
    if (typeof t === "object" && t.year && t.month && t.day) return t; // business day
    return null;
  }

  function normalizeBars(payload) {
    const raw =
      Array.isArray(payload) ? payload :
      Array.isArray(payload?.results) ? payload.results : // Polygon/Massive-like
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
        const time = toUnixSec(s.time ?? s.t ?? s.timestamp ?? s.ts ?? s.date);
        const sideRaw = String(s.side ?? s.type ?? s.action ?? s.text ?? "").trim();
        const sideUp = sideRaw.toUpperCase();

        // support eB/eS if backend ever sends
        let side2 = "";
        if (sideRaw === "eB" || sideUp === "EB") side2 = "eB";
        else if (sideRaw === "eS" || sideUp === "ES") side2 = "eS";
        else if (sideUp.includes("BUY")) side2 = "B";
        else if (sideUp.includes("SELL")) side2 = "S";
        else if (sideUp === "B" || sideUp === "S") side2 = sideUp;

        if (!time || !side2) return null;
        return { time, side: side2 };
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

  // Prefer Massive aggregates endpoint.
  async function fetchBarsPack(sym, tf) {
    const apiBase = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");

    // tf -> multiplier/timespan + range
    const cfg = tfToAggParams(tf);
    const { from, to } = rangeByDaysBack(cfg.daysBack);

    // build URL
    const url = new URL(apiBase + MASSIVE_AGGS_PATH);
    url.searchParams.set("ticker", String(sym || "AAPL").trim().toUpperCase());
    url.searchParams.set("multiplier", String(cfg.multiplier));
    url.searchParams.set("timespan", String(cfg.timespan));
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);

    const urlStr = url.toString();
    DIAG.lastBarsUrl = urlStr;

    // fetch + normalize
    const payload = await fetchJson(urlStr);
    const bars = normalizeBars(payload);
    if (bars.length) return { payload, bars, urlUsed: urlStr, aggCfg: cfg, range: { from, to } };

    // fallback candidates (optional)
    let lastErr = new Error(`Aggs returned empty. ticker=${sym} tf=${tf} from=${from} to=${to}`);
    const q = `symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;

    for (const p of BARS_PATH_CANDIDATES) {
      const u = `${apiBase}${p}?${q}`;
      try {
        const pl = await fetchJson(u);
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

  function computeTrendFromAux(auxVals) {
    const trend = new Array(auxVals.length).fill(0);
    let last = 0;
    for (let i = 1; i < auxVals.length; i++) {
      const a0 = auxVals[i - 1];
      const a1 = auxVals[i];
      if (!Number.isFinite(a0) || !Number.isFinite(a1)) { trend[i] = last; continue; }
      if (a1 > a0) last = 1;
      else if (a1 < a0) last = -1;
      trend[i] = last;
    }
    trend[0] = trend[1] || 0;
    return trend;
  }

  // Cross + confirm (legacy fallback). Returns unique {time, side}
  function computeSignalsCrossPlusConfirm(bars, emaPts, auxPts, confirmWindow) {
    const n = bars.length;
    if (n < 5) return [];

    const emaV = emaPts.map(p => p.value);
    const auxV = auxPts.map(p => p.value);
    const trend = computeTrendFromAux(auxV);

    const cw = Math.max(0, Math.floor(confirmWindow ?? 3));
    const sigs = [];
    const used = new Set();

    function addSig(i, side) {
      const t = bars[i].time;
      const k = `${t}:${side}`;
      if (used.has(k)) return;
      used.add(k);
      sigs.push({ time: t, side });
    }

    function findConfirmIndex(startIdx, wantTrend) {
      // wantTrend: +1 confirm up, -1 confirm down
      for (let j = startIdx; j <= Math.min(n - 1, startIdx + cw); j++) {
        const prev = trend[j - 1];
        const curr = trend[j];
        if (wantTrend > 0) {
          if (prev <= 0 && curr > 0) return j;
        } else {
          if (prev >= 0 && curr < 0) return j;
        }
      }
      return -1;
    }

    for (let i = 1; i < n; i++) {
      const e0 = emaV[i - 1], e1 = emaV[i];
      const a0 = auxV[i - 1], a1 = auxV[i];
      if (![e0, e1, a0, a1].every(Number.isFinite)) continue;

      const crossUp = (e0 <= a0 && e1 > a1);
      const crossDn = (e0 >= a0 && e1 < a1);

      if (crossUp) {
        const k = findConfirmIndex(i, +1);
        if (k >= 0) addSig(k, "B");
      } else if (crossDn) {
        const k = findConfirmIndex(i, -1);
        if (k >= 0) addSig(k, "S");
      }
    }

    sigs.sort((x, y) => (x.time > y.time ? 1 : x.time < y.time ? -1 : 0));
    return sigs;
  }

  // Early + Confirm with Trend-Lock + Dead-zone
  // Output sides: 'eB','eS','B','S' (unique by time+side)
  function computeSignalsEarlyConfirmTrendLock(bars, emaPts, auxPts, confirmWindow) {
    const n = bars.length;
    if (n < 8) return [];

    const emaV = emaPts.map(p => p.value);
    const auxV = auxPts.map(p => p.value);
    const auxTrend = computeTrendFromAux(auxV);

    const cw = Math.max(0, Math.floor(confirmWindow ?? 3));
    const sigs = [];
    const used = new Set();

    // ---- knobs (stable defaults) ----
    const DEADZONE_K = 0.00018;     // 0.018% of price as dead-zone baseline
    const DEADZONE_MIN = 1e-6;
    const COOLDOWN_BARS = Math.max(2, cw);   // avoid spam

    let lastSigIdx = -99999;

    // Trend lock:
    //  0 = unlocked, +1 = locked UP, -1 = locked DOWN
    let lock = 0;

    function addSig(i, side, reason) {
      const t = bars[i].time;
      const k = `${t}:${side}`;
      if (used.has(k)) return;
      used.add(k);
      sigs.push({ time: t, side, i, reason: reason || null });
      lastSigIdx = i;
    }

    function deadZoneOk(i) {
      const e = emaV[i], a = auxV[i];
      if (![e, a].every(Number.isFinite)) return false;
      const base = Math.max(DEADZONE_MIN, Math.abs(e));
      const eps = Math.max(DEADZONE_MIN, base * DEADZONE_K);
      return Math.abs(e - a) >= eps;
    }

    function findConfirmIndex(startIdx, wantTrend) {
      // wantTrend: +1 confirm up, -1 confirm down
      for (let j = startIdx; j <= Math.min(n - 1, startIdx + cw); j++) {
        const prev = auxTrend[j - 1];
        const curr = auxTrend[j];
        if (wantTrend > 0) {
          if (prev <= 0 && curr > 0) return j;
        } else {
          if (prev >= 0 && curr < 0) return j;
        }
      }
      return -1;
    }

    function maybeUnlock(i) {
      // unlock only when aux trend has flipped and stayed for 2 bars
      if (lock === 1) {
        if (auxTrend[i] < 0 && auxTrend[i - 1] < 0) lock = 0;
      } else if (lock === -1) {
        if (auxTrend[i] > 0 && auxTrend[i - 1] > 0) lock = 0;
      }
    }

    for (let i = 2; i < n; i++) {
      maybeUnlock(i);

      const e0 = emaV[i - 1], e1 = emaV[i];
      const a0 = auxV[i - 1], a1 = auxV[i];
      if (![e0, e1, a0, a1].every(Number.isFinite)) continue;

      // cooldown
      if (i - lastSigIdx < COOLDOWN_BARS) continue;

      // dead-zone filter (ignore tiny wiggles)
      if (!deadZoneOk(i) || !deadZoneOk(i - 1)) continue;

      const crossUp = (e0 <= a0 && e1 > a1);
      const crossDn = (e0 >= a0 && e1 < a1);

      if (crossUp) {
        if (lock === -1) continue;            // locked down => ignore
        addSig(i, "eB", "crossUp");           // EARLY appears immediately (earlier than confirm)
        const k = findConfirmIndex(i, +1);
        if (k >= 0) {
          addSig(k, "B", "confirmUp");
          lock = 1;                           // lock up after confirm
        }
      } else if (crossDn) {
        if (lock === 1) continue;             // locked up => ignore
        addSig(i, "eS", "crossDn");
        const k = findConfirmIndex(i, -1);
        if (k >= 0) {
          addSig(k, "S", "confirmDn");
          lock = -1;                          // lock down after confirm
        }
      }
    }

    sigs.sort((x, y) => (x.time > y.time ? 1 : x.time < y.time ? -1 : 0));
    return sigs;
  }

  // Merge confirmed (B/S) from backend with locally computed early (eB/eS).
  // This guarantees eB/eS exists even when backend only gives confirmed.
  function mergeConfirmedWithEarly(confirmedSigs, earlyAllSigs) {
    const conf = Array.isArray(confirmedSigs) ? confirmedSigs : [];
    const early = Array.isArray(earlyAllSigs) ? earlyAllSigs : [];

    const out = [];
    const used = new Set();

    function pushSig(s) {
      if (!s || s.time == null || !s.side) return;
      const k = `${s.time}:${s.side}`;
      if (used.has(k)) return;
      used.add(k);
      out.push({ time: s.time, side: s.side, i: s.i, reason: s.reason, strength: s.strength });
    }

    // 1) push early (eB/eS) first (earlier)
    for (const s of early) {
      if (s.side === "eB" || s.side === "eS") pushSig(s);
    }

    // 2) push confirmed (B/S) from backend/endpoints (authoritative)
    for (const s of conf) {
      if (s.side === "B" || s.side === "S") pushSig(s);
    }

    // 3) if confirmed list was empty, keep local confirmed too
    if (!conf.length) {
      for (const s of early) {
        if (s.side === "B" || s.side === "S") pushSig(s);
      }
    }

    out.sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));
    return out;
  }

  // series markers (small). Overlay uses big markers; we keep small empty when overlay enabled.
  function applyMarkers(sigs) {
    safeRun("applyMarkers", () => {
      if (!candleSeries) return;

      if (window.__OVERLAY_BIG_SIGS__ === true) {
        candleSeries.setMarkers([]);
        return;
      }

      // only confirmed B/S for small markers
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
  // Data mode / source labels (for strong UI hint)
  // -----------------------------
  function resolveDataMeta(tf) {
    // Your UI has: Demo(Local) / Market delayed (Massive)
    // We read a few globals if you set them in index.html; otherwise we infer.
    const dataMode = String(window.__DATA_MODE__ || window.__DATA_SOURCE__ || "").toLowerCase();
    const source =
      String(window.__DATA_SOURCE_NAME__ || window.__DATA_PROVIDER__ || window.__DATA_SOURCE__ || "").trim() ||
      (dataMode.includes("demo") ? "Local" : "Massive");

    // delayed minutes: default 15 when using market delayed minute data
    let delayedMinutes = Number(window.__DELAYED_MINUTES__);
    if (!Number.isFinite(delayedMinutes)) {
      delayedMinutes = 0;
      const t = String(tf || "").toLowerCase();
      // if you are on Massive Starter delayed feeds, keep it 15
      if (!dataMode.includes("demo")) delayedMinutes = 15;
      if (t === "1d" || t === "1w" || t === "1m") delayedMinutes = !dataMode.includes("demo") ? 15 : 0;
    }

    return {
      dataMode: dataMode || (source.toLowerCase().includes("local") ? "demo" : "market"),
      source,
      delayedMinutes: Math.max(0, Math.floor(delayedMinutes)),
    };
  }

  // -----------------------------
  // Core load (MAIN FIRST)
  // -----------------------------
  async function load() {
    if (!chart || !candleSeries) return;

    const sym = getUiSymbol();
    const tf = getUiTf();
    const metaDS = resolveDataMeta(tf);

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
    DIAG.lastBarsUrl = urlUsed;

    if (!bars.length) throw new Error("bars empty after normalization");

    // -------- MAIN CHART: never let UI break this --------
    const closes = bars.map((b) => b.close);
    const emaVals = ema(closes, EMA_PERIOD);
    const auxVals = computeAuxByYourAlgo(closes, AUX_PERIOD, AUX_METHOD);

    const coloredBars = colorCandlesByEMATrend(bars, emaVals);
    candleSeries.setData(coloredBars);

    const emaPts = buildLinePoints(bars, emaVals);
    const auxPts = buildLinePoints(bars, auxVals);
    emaSeries.setData(emaPts);
    auxSeries.setData(auxPts);

    // Signals:
    // Confirmed priority:
    //  1) payload carries confirmed signals
    //  2) optional signals endpoints
    //  3) compute local (early+confirm trendlock)
    //
    // Additionally:
    //  - We ALWAYS compute local early signals (eB/eS) and merge, so eB/eS is always present and earlier.
    let confirmed = normalizeSignals(payload).filter(s => s.side === "B" || s.side === "S");
    if (!confirmed.length) confirmed = (await fetchOptionalSignals(sym, tf)).filter(s => s.side === "B" || s.side === "S");

    // local early+confirm (trendlock) – ensures eB/eS appear earlier and are stable
    const localAll = computeSignalsEarlyConfirmTrendLock(bars, emaPts, auxPts, CONFIRM_WINDOW);

    // If confirmed still empty (no backend), keep local confirmed too
    const sigs = mergeConfirmedWithEarly(confirmed, localAll);

    DIAG.lastSigCount = sigs.length;

    applyMarkers(sigs);
    safeRun("fitContent", () => chart.timeScale().fitContent());

    safeRun("topText", () => {
      const last = bars[bars.length - 1];
      if ($("symText")) $("symText").textContent = sym;
      if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);
      if ($("hintText")) $("hintText").textContent =
        `Loaded · ${metaDS.dataMode === "demo" ? "Demo" : "Market"} · TF=${tf} · bars=${bars.length} · sigs=${sigs.length}`;
    });

    // ---- snapshot for market.pulse.js ----
    // Keep 2 compatible forms:
    //   A) window.__DARRIUS_CHART_STATE__ (flat)
    //   B) DarriusChart.getSnapshot() schema (meta/candles/ema/aux/signals)
    safeRun("setSnapshotForUI", () => {
      try {
        window.DarriusChart = window.DarriusChart || {};

        // bar map for signal anchor (LOW/HIGH) + fallback CLOSE
        const barByTime = new Map();
        for (const b of bars) barByTime.set(b.time, b);

        // Build rich signals array with anchor price for overlay
        const richSignals = (Array.isArray(sigs) ? sigs : [])
          .map((s, idx) => {
            const t = s.time ?? null;
            const sideRaw = String(s.side || "").trim();
            const side =
              (sideRaw === "eB" || sideRaw === "eS" || sideRaw === "B" || sideRaw === "S")
                ? sideRaw
                : ((String(sideRaw).toUpperCase() === "S") ? "S" : "B");

            const b = barByTime.get(t);
            if (!b) return null;

            // Anchor rule (THIS fixes B above / S below):
            //  - B/eB => candle LOW  (below wick)
            //  - S/eS => candle HIGH (above wick)
            const anchor =
              (side === "B" || side === "eB") ? Number(b.low) :
              (side === "S" || side === "eS") ? Number(b.high) :
              Number(b.close);

            const price = Number.isFinite(anchor) ? anchor : Number(b.close);

            return {
              time: t,
              price: Number.isFinite(price) ? price : null,
              side,
              i: (typeof s.i === "number" ? s.i : idx),
              reason: s.reason || null,
              strength: (typeof s.strength === "number" ? s.strength : null),
            };
          })
          .filter((x) => x && x.time != null && x.price != null);

        // trend quick summary
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

        const snapMeta = {
          symbol: sym || null,
          timeframe: tf || null,
          bars: Array.isArray(bars) ? bars.length : 0,
          source: metaDS.source || "Massive",
          dataMode: metaDS.dataMode || "market",
          delayedMinutes: metaDS.delayedMinutes ?? 0,
          emaPeriod: EMA_PERIOD,
          auxPeriod: AUX_PERIOD,
          confirmWindow: CONFIRM_WINDOW,
          urlUsed: urlUsed || null,
        };

        const snapObj = {
          version: "snapshot_v1",
          ts: Date.now(),
          meta: snapMeta,
          candles: Array.isArray(bars) ? bars : [],
          ema: Array.isArray(emaPts) ? emaPts : [],
          aux: Array.isArray(auxPts) ? auxPts : [],
          signals: richSignals,
          trend: { emaSlope, emaRegime, emaColor, flipCount: null },
          risk: { entry: null, stop: null, targets: null, confidence: null, winrate: null },
        };

        // attach read-only getter for UI
        window.DarriusChart.getSnapshot = () => {
          try {
            return {
              version: snapObj.version,
              ts: snapObj.ts,
              meta: Object.assign({}, snapObj.meta),
              candles: (snapObj.candles || []).slice(),
              ema: (snapObj.ema || []).slice(),
              aux: (snapObj.aux || []).slice(),
              signals: (snapObj.signals || []).slice(),
              trend: Object.assign({}, snapObj.trend),
              risk: Object.assign({}, snapObj.risk),
            };
          } catch (_) {
            return null;
          }
        };

        // also keep compatibility with your older hook names
        if (typeof window.getChartSnapshot !== "function") {
          window.getChartSnapshot = window.DarriusChart.getSnapshot;
        }

        // Provide __hostId for overlay host resolution
        window.DarriusChart.__hostId = window.DarriusChart.__hostId || "chart";
      } catch (_) {}
    });

    // ---- publish flat snapshot (what you are checking in console) ----
    const N = Math.min(600, bars.length);
    const start = bars.length - N;

    const flatSnapshot = {
      version: "2026.01.23-EBES-TRENDLOCK",
      ts: Date.now(),
      apiBase: DEFAULT_API_BASE,
      urlUsed: urlUsed || null,
      symbol: sym,
      tf,
      dataMode: metaDS.dataMode,
      source: metaDS.source,
      delayedMinutes: metaDS.delayedMinutes,
      params: { EMA_PERIOD, AUX_PERIOD, AUX_METHOD, CONFIRM_WINDOW },
      barsCount: bars.length,
      bars: bars.slice(start),
      ema: emaVals.slice(start),
      aux: auxVals.slice(start),
      // provide BOTH names for UI:
      // (NOTE: here "signals/sigs" are still time+side; overlay uses DarriusChart.getSnapshot().signals with anchor price)
      sigs: (Array.isArray(sigs) ? sigs.slice(Math.max(0, sigs.length - 300)) : []),
      signals: (Array.isArray(sigs) ? sigs.slice(Math.max(0, sigs.length - 300)) : []),
      lastClose: bars[bars.length - 1].close,
    };

    publishSnapshot(flatSnapshot);

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

    // -----------------------------
    // Read-only coordinate bridge (for market.pulse.js overlay)
    // -----------------------------
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

  // Optional: allow UI to read snapshot via ChartCore too (extra fallback)
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
