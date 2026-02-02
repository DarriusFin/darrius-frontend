/* =========================================================================
 * DarriusAI - chart.core.js (FROZEN MAIN CHART) v2026.02.02-SERVER-SIGS-CLEAN+PATCHED
 *
 * PATCHED goals (minimal, no billing/payment/UI touched):
 *  - Patch #1: include_ema=1 on signals request (already)
 *  - Patch #2: AUX prefer sigPack.raw.indicators.aux, then bars payload, else null-aligned
 *  - Patch #3: signals nearest-bar time alignment (fix time-key mismatch causing empty/NaN)
 *  - Snapshot: provide safe numeric trend fields to reduce MarketPulse NaN
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
    lastSigsUrl: null,
    lastSigCount: null,
    auxSource: null,         // "sigs" | "bars" | "null"
    lastSigAlignDrop: null,  // number dropped due to no nearby bar
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

  // Signals endpoint candidates (backend authoritative)
  const SIGS_PATH_CANDIDATES = [
    "/api/market/sigs",
    "/api/market/signals",
    "/api/sigs",
    "/api/signals",
    "/sigs",
    "/signals",
  ];

  // -----------------------------
  // Params (UI can display; algo NOT implemented on frontend)
  // -----------------------------
  const DEFAULT_PARAMS = Object.freeze({
    EMA_PERIOD: 14,
    AUX_PERIOD: 40,
    AUX_METHOD: "SMA",
    CONFIRM_WINDOW: 3,
  });

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
      "5m":  { multiplier: 5,   timespan: "minute", daysBack: 20,  stepSec: 5 * 60 },
      "15m": { multiplier: 15,  timespan: "minute", daysBack: 35,  stepSec: 15 * 60 },
      "30m": { multiplier: 30,  timespan: "minute", daysBack: 60,  stepSec: 30 * 60 },
      "1h":  { multiplier: 60,  timespan: "minute", daysBack: 90,  stepSec: 60 * 60 },
      "4h":  { multiplier: 240, timespan: "minute", daysBack: 180, stepSec: 240 * 60 },
      "1d":  { multiplier: 1,   timespan: "day",    daysBack: 700, stepSec: 24 * 3600 },
      "1w":  { multiplier: 1,   timespan: "week",   daysBack: 1800, stepSec: 7 * 24 * 3600 },
      "1M":  { multiplier: 1,   timespan: "month",  daysBack: 3600, stepSec: 30 * 24 * 3600 }, // approx
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
      if (t > 2e10) return Math.floor(t / 1000); // ms -> sec
      return t;
    }
    if (typeof t === "string") {
      const ms = Date.parse(t);
      if (!Number.isFinite(ms)) return null;
      return Math.floor(ms / 1000);
    }
    if (typeof t === "object" && t.year && t.month && t.day) return t; // business day object (do not use here)
    return null;
  }

  function normalizeBars(payload) {
    const raw =
      Array.isArray(payload) ? payload :
      Array.isArray(payload?.results) ? payload.results :
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
    const out = raw
      .map((s) => {
        const time = toUnixSec(s.time ?? s.t ?? s.timestamp ?? s.ts ?? s.date);
        const sideRaw = String(s.side ?? s.type ?? s.action ?? s.text ?? "").trim();
        const sideUp = sideRaw.toUpperCase();

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

    const cfg = tfToAggParams(tf);
    const { from, to } = rangeByDaysBack(cfg.daysBack);

    const url = new URL(apiBase + MASSIVE_AGGS_PATH);
    url.searchParams.set("ticker", String(sym || "AAPL").trim().toUpperCase());
    url.searchParams.set("multiplier", String(cfg.multiplier));
    url.searchParams.set("timespan", String(cfg.timespan));
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);

    const urlStr = url.toString();
    DIAG.lastBarsUrl = urlStr;

    const payload = await fetchJson(urlStr);
    const bars = normalizeBars(payload);
    if (bars.length) return { payload, bars, urlUsed: urlStr, aggCfg: cfg, range: { from, to } };

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

  // Signals are authoritative from backend only.
  async function fetchSignalsFromBackend(sym, tf) {
    const apiBase = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");
    // Patch #1: include_ema=1
    const q = `symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}&include_ema=1`;

    let lastErr = null;
    for (const p of SIGS_PATH_CANDIDATES) {
      const url = `${apiBase}${p}?${q}`;
      try {
        DIAG.lastSigsUrl = url;
        const payload = await fetchJson(url);
        const sigs = normalizeSignals(payload);
        const params =
          payload?.params && typeof payload.params === "object"
            ? payload.params
            : null;
        const provider = payload?.provider ? String(payload.provider) : null;
        return { sigs, params, provider, raw: payload, urlUsed: url };
      } catch (e) {
        lastErr = e;
      }
    }

    return {
      sigs: [],
      params: null,
      provider: null,
      raw: null,
      urlUsed: null,
      error: lastErr ? String(lastErr?.message || lastErr) : "signals_fetch_failed",
    };
  }

  // -----------------------------
  // Math (non-secret: EMA for chart aesthetics / coloring)
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

  function lastFinite(arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const v = arr[i];
      if (Number.isFinite(v)) return v;
    }
    return null;
  }

  // -----------------------------
  // series markers (small)
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
  // Data mode / source labels
  // -----------------------------
  function resolveDataMeta(tf, barsPayload, sigRaw) {
    const dataMode = String(window.__DATA_MODE__ || window.__DATA_SOURCE__ || "").toLowerCase();

    // Prefer explicit window label, else backend hints, else fallback
    const winSource =
      String(window.__DATA_SOURCE_NAME__ || window.__DATA_PROVIDER__ || window.__DATA_SOURCE__ || "").trim();

    const backendSource =
      String(sigRaw?.data_source || sigRaw?.source || sigRaw?.provider || barsPayload?.provider || barsPayload?.source || "").trim();

    const source =
      winSource ||
      backendSource ||
      (dataMode.includes("demo") ? "Local" : "3rd-Party Provider");

    let delayedMinutes = Number(window.__DELAYED_MINUTES__);
    if (!Number.isFinite(delayedMinutes)) {
      delayedMinutes = 0;
      const t = String(tf || "").toLowerCase();
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
  // Normalize optional line series from payload
  // -----------------------------
  function normalizeLineSeries(payload, keyCandidates) {
    const keys = Array.isArray(keyCandidates) ? keyCandidates : [];
    let raw = null;
    for (const k of keys) {
      const v = k.split(".").reduce((acc, kk) => (acc && acc[kk] != null ? acc[kk] : null), payload);
      if (Array.isArray(v)) { raw = v; break; }
    }
    if (!Array.isArray(raw)) return null;

    const pts = raw
      .map((p) => {
        const time = toUnixSec(p.time ?? p.t ?? p.timestamp ?? p.ts ?? p.date);
        const value = Number(p.value ?? p.v ?? p.val);
        if (!time || !Number.isFinite(value)) return null;
        return { time, value };
      })
      .filter(Boolean)
      .sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));

    const out = [];
    let last = null;
    for (const p of pts) {
      if (p.time === last) continue;
      last = p.time;
      out.push(p);
    }
    return out;
  }

  // -----------------------------
  // Patch #3: nearest-bar time alignment
  // -----------------------------
  function buildBarTimeIndex(bars) {
    const times = bars.map(b => b.time);
    return times;
  }

  function nearestTime(timesSorted, t) {
    // timesSorted: ascending numbers
    let lo = 0, hi = timesSorted.length - 1;
    if (hi < 0) return null;
    if (t <= timesSorted[0]) return timesSorted[0];
    if (t >= timesSorted[hi]) return timesSorted[hi];

    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      const v = timesSorted[mid];
      if (v === t) return v;
      if (v < t) lo = mid;
      else hi = mid;
    }
    const a = timesSorted[lo];
    const b = timesSorted[hi];
    return (Math.abs(a - t) <= Math.abs(b - t)) ? a : b;
  }

  function alignSignalsToBars(sigs, bars, tf) {
    const out = [];
    const times = buildBarTimeIndex(bars);
    const cfg = tfToAggParams(tf);
    const step = Number(cfg?.stepSec) || 86400;
    // accept within 60% of a bar step (handles provider timestamp rounding)
    const maxDiff = Math.max(1, Math.floor(step * 0.6));

    let dropped = 0;
    for (const s of (Array.isArray(sigs) ? sigs : [])) {
      if (!s || !Number.isFinite(s.time)) continue;
      const nt = nearestTime(times, s.time);
      if (nt == null) { dropped++; continue; }
      if (Math.abs(nt - s.time) > maxDiff) { dropped++; continue; }
      out.push({ time: nt, side: s.side });
    }

    // dedup by aligned time+side
    const used = new Set();
    const dedup = [];
    for (const s of out) {
      const k = `${s.time}:${s.side}`;
      if (used.has(k)) continue;
      used.add(k);
      dedup.push(s);
    }

    DIAG.lastSigAlignDrop = dropped;
    return dedup;
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
    DIAG.lastBarsUrl = urlUsed;

    if (!bars.length) throw new Error("bars empty after normalization");

    // -------- MAIN CHART --------
    const closes = bars.map((b) => b.close);

    const emaPeriod = Number(window.__EMA_PERIOD__ ?? DEFAULT_PARAMS.EMA_PERIOD) || DEFAULT_PARAMS.EMA_PERIOD;
    const emaVals = ema(closes, emaPeriod);

    const coloredBars = colorCandlesByEMATrend(bars, emaVals);
    candleSeries.setData(coloredBars);

    const emaPts = buildLinePoints(bars, emaVals);
    emaSeries.setData(emaPts);

    // -------- SIGNALS (Backend authoritative) --------
    const sigPack = await fetchSignalsFromBackend(sym, tf);
    const sigParams = (sigPack?.params && typeof sigPack.params === "object") ? sigPack.params : null;
    const sigProvider = sigPack?.provider || null;
    const sigRaw = sigPack?.raw || null;

    // Patch #3: align signals to nearest bar time
    const sigsRaw = Array.isArray(sigPack?.sigs) ? sigPack.sigs : [];
    const sigs = alignSignalsToBars(sigsRaw, bars, tf);

    DIAG.lastSigCount = sigs.length;

    // Patch #2: AUX priority: sigPack.raw.indicators.aux -> bars payload -> null-aligned
    let auxPts = null;

    safeRun("auxFromSigsPayload", () => {
      auxPts = normalizeLineSeries(sigRaw, [
        "indicators.aux",
        "data.indicators.aux",
        "aux",
        "data.aux",
      ]);
    });

    if (auxPts && auxPts.length) {
      DIAG.auxSource = "sigs";
    } else {
      auxPts = null;
      safeRun("auxFromBarsPayload", () => {
        auxPts = normalizeLineSeries(payload, [
          "indicators.aux",
          "data.indicators.aux",
          "aux",
          "data.aux",
        ]);
      });
      if (auxPts && auxPts.length) DIAG.auxSource = "bars";
    }

    if (!auxPts || !auxPts.length) {
      DIAG.auxSource = "null";
      auxPts = bars.map((b) => ({ time: b.time, value: null }));
    }

    auxSeries.setData(auxPts);

    applyMarkers(sigs);
    safeRun("fitContent", () => chart.timeScale().fitContent());

    // resolve data meta AFTER we have backend payload hints
    const metaDS = resolveDataMeta(tf, payload, sigRaw);

    safeRun("topText", () => {
      const last = bars[bars.length - 1];
      if ($("symText")) $("symText").textContent = sym;
      if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

      const sigNote = sigPack?.urlUsed ? `sigs=API` : `sigs=none`;
      const errNote = sigPack?.error ? ` · sigErr=${sigPack.error}` : "";
      const auxNote = ` · aux=${DIAG.auxSource || "?"}`;
      const dropNote = (typeof DIAG.lastSigAlignDrop === "number" && DIAG.lastSigAlignDrop > 0)
        ? ` · sigDrop=${DIAG.lastSigAlignDrop}`
        : "";

      if ($("hintText")) $("hintText").textContent =
        `Loaded · ${metaDS.dataMode === "demo" ? "Demo" : "Market"} · TF=${tf} · bars=${bars.length} · sigs=${sigs.length} · ${sigNote}${auxNote}${dropNote}${errNote}`;
    });

    // ---- snapshot for market.pulse.js ----
    safeRun("setSnapshotForUI", () => {
      try {
        window.DarriusChart = window.DarriusChart || {};

        // build bar map
        const barByTime = new Map();
        for (const b of bars) barByTime.set(b.time, b);

        // Rich signals with anchor price (B/eB below, S/eS above)
        const richSignals = (Array.isArray(sigs) ? sigs : [])
          .map((s, idx) => {
            const t = s.time ?? null;
            const side = String(s.side || "").trim();
            if (!t || !side) return null;

            const b = barByTime.get(t);
            if (!b) return null;

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

        // Display params: prefer backend params; fallback to defaults
        const mergedParams = Object.assign({}, DEFAULT_PARAMS, sigParams || {});

        // Provide trend numbers to reduce NaN in Market Pulse
        const lastEma = lastFinite(emaVals);
        const prevEma = (emaVals.length >= 2 && Number.isFinite(emaVals[emaVals.length - 2]))
          ? emaVals[emaVals.length - 2]
          : null;
        const emaSlope = (Number.isFinite(lastEma) && Number.isFinite(prevEma)) ? (lastEma - prevEma) : 0;
        const emaRegime = emaSlope > 0 ? "up" : emaSlope < 0 ? "down" : "flat";

        // Allow backend to override if it provides better info
        const backendTrend = (sigRaw && typeof sigRaw.trend === "object") ? sigRaw.trend : null;

        const snapMeta = {
          symbol: sym || null,
          timeframe: tf || null,
          bars: Array.isArray(bars) ? bars.length : 0,
          source: metaDS.source || "3rd-Party Provider",
          dataMode: metaDS.dataMode || "market",
          delayedMinutes: metaDS.delayedMinutes ?? 0,
          provider: sigProvider || null,
          params: mergedParams,
          urlUsed: urlUsed || null,
          sigsUrlUsed: sigPack?.urlUsed || null,
        };

        const snapObj = {
          version: "snapshot_v2_server_sigs",
          ts: Date.now(),
          meta: snapMeta,
          candles: Array.isArray(bars) ? bars : [],
          ema: Array.isArray(emaPts) ? emaPts : [],
          aux: Array.isArray(auxPts) ? auxPts : [],
          signals: richSignals,

          // IMPORTANT: keep numeric-ish defaults (avoid NaN downstream)
          trend: Object.assign(
            { emaSlope: emaSlope, emaRegime: emaRegime, emaColor: null, flipCount: 0 },
            backendTrend || {}
          ),
          risk: (sigRaw && typeof sigRaw.risk === "object")
            ? Object.assign({ entry: null, stop: null, targets: null, confidence: 0, winrate: 0 }, sigRaw.risk)
            : { entry: null, stop: null, targets: null, confidence: 0, winrate: 0 },
        };

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

        if (typeof window.getChartSnapshot !== "function") {
          window.getChartSnapshot = window.DarriusChart.getSnapshot;
        }

        window.DarriusChart.__hostId = window.DarriusChart.__hostId || "chart";
      } catch (_) {}
    });

    // ---- flat snapshot (console friendly) ----
    const N = Math.min(600, bars.length);
    const start = bars.length - N;

    const flatSnapshot = {
      version: "2026.02.02-SERVER-SIGS-CLEAN+PATCHED",
      ts: Date.now(),
      apiBase: DEFAULT_API_BASE,
      urlUsed: urlUsed || null,
      sigsUrlUsed: sigPack?.urlUsed || null,
      symbol: sym,
      tf,
      dataMode: metaDS.dataMode,
      source: metaDS.source,
      delayedMinutes: metaDS.delayedMinutes,
      provider: sigProvider || null,
      params: Object.assign({}, DEFAULT_PARAMS, sigParams || {}),
      barsCount: bars.length,
      bars: bars.slice(start),
      ema: emaVals.slice(start),
      auxSource: DIAG.auxSource || null,
      sigsAligned: (Array.isArray(sigs) ? sigs.slice(Math.max(0, sigs.length - 300)) : []),
      lastClose: bars[bars.length - 1].close,
      diag: {
        lastBarsUrl: DIAG.lastBarsUrl || null,
        lastSigsUrl: DIAG.lastSigsUrl || null,
        sigAlignDrop: DIAG.lastSigAlignDrop ?? null,
      },
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
