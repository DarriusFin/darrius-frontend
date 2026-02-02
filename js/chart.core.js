/* =========================================================================
 * DarriusAI - chart.core.js (FROZEN MAIN CHART) v2026.02.02-SERVER-SIGS-CLEAN
 *
 * Role:
 *  - Render main chart (candles + EMA [+ optional AUX if backend provides series])
 *  - Fetch OHLCV via backend proxy (/api/data/stocks/aggregates)
 *  - Fetch signals via backend (/api/market/sigs) ONLY (no local signal logic)
 *  - Output a read-only snapshot to window.__DARRIUS_CHART_STATE__
 *  - Provide read-only bridge for UI overlay (market.pulse.js):
 *      DarriusChart.timeToX / DarriusChart.priceToY / DarriusChart.getSnapshot()
 *  - Emit event "darrius:chartUpdated" with snapshot detail
 *
 * Guarantees:
 *  1) Main chart render is highest priority and will not be broken by UI
 *  2) Non-critical parts (snapshot/event/markers) are wrapped in no-throw safe zones
 *  3) No billing/subscription code touched
 *  4) Secrets moved out: NO local signals compute, NO local AUX core algo
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
  // Keep as "display params" only.
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
        // Even if sigs is empty, still return params/provider for UI/snapshot.
        return { sigs, params, provider, raw: payload, urlUsed: url };
      } catch (e) {
        lastErr = e;
      }
    }

    // Do NOT compute locally (secrets moved out). Just return empty.
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

  // -----------------------------
  // series markers (small). Overlay uses big markers; we keep small empty when overlay enabled.
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
  // Data mode / source labels (for strong UI hint)
  // -----------------------------
  function resolveDataMeta(tf) {
    const dataMode = String(window.__DATA_MODE__ || window.__DATA_SOURCE__ || "").toLowerCase();
    const source =
      String(window.__DATA_SOURCE_NAME__ || window.__DATA_PROVIDER__ || window.__DATA_SOURCE__ || "").trim() ||
      (dataMode.includes("demo") ? "Local" : "Massive");

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
  // OPTIONAL: attempt to read backend-provided AUX series (future-proof)
  // If backend sends: payload.indicators.aux = [{time,value},...]
  // or payload.aux = [{time,value},...]
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

    // de-dupe by time
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

    // -------- MAIN CHART --------
    const closes = bars.map((b) => b.close);

    // EMA is non-secret display element; keep it for visuals.
    const emaPeriod = Number(window.__EMA_PERIOD__ ?? DEFAULT_PARAMS.EMA_PERIOD) || DEFAULT_PARAMS.EMA_PERIOD;
    const emaVals = ema(closes, emaPeriod);

    const coloredBars = colorCandlesByEMATrend(bars, emaVals);
    candleSeries.setData(coloredBars);

    const emaPts = buildLinePoints(bars, emaVals);
    emaSeries.setData(emaPts);

    // AUX line: DO NOT compute locally (secret removed).
    // If backend provides aux series in bars payload or signals payload later, we render it.
    // For now, default to empty series (no crash).
    let auxPts = null;
    safeRun("auxFromBarsPayload", () => {
      auxPts = normalizeLineSeries(payload, ["indicators.aux", "aux", "data.aux", "data.indicators.aux"]);
    });
    if (!auxPts) {
      // empty aux points aligned to bars (all null) to keep UI stable
      auxPts = bars.map((b) => ({ time: b.time, value: null }));
    }
    auxSeries.setData(auxPts);

    // -------- SIGNALS (Backend authoritative) --------
    const sigPack = await fetchSignalsFromBackend(sym, tf);
    const sigs = Array.isArray(sigPack?.sigs) ? sigPack.sigs : [];
    const sigParams =
      (sigPack?.params && typeof sigPack.params === "object") ? sigPack.params : null;
    const sigProvider = sigPack?.provider || null;

    DIAG.lastSigCount = sigs.length;

    applyMarkers(sigs);
    safeRun("fitContent", () => chart.timeScale().fitContent());

    safeRun("topText", () => {
      const last = bars[bars.length - 1];
      if ($("symText")) $("symText").textContent = sym;
      if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

      const sigNote = sigPack?.urlUsed ? `sigs=API` : `sigs=none`;
      const errNote = sigPack?.error ? ` · sigErr=${sigPack.error}` : "";
      if ($("hintText")) $("hintText").textContent =
        `Loaded · ${metaDS.dataMode === "demo" ? "Demo" : "Market"} · TF=${tf} · bars=${bars.length} · sigs=${sigs.length} · ${sigNote}${errNote}`;
    });

    // ---- snapshot for market.pulse.js ----
    safeRun("setSnapshotForUI", () => {
      try {
        window.DarriusChart = window.DarriusChart || {};

        const barByTime = new Map();
        for (const b of bars) barByTime.set(b.time, b);

        // Rich signals with anchor price (fixes B below / S above)
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
        const snapMeta = {
          symbol: sym || null,
          timeframe: tf || null,
          bars: Array.isArray(bars) ? bars.length : 0,
          source: metaDS.source || "Massive",
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
          trend: { emaSlope: null, emaRegime: null, emaColor: null, flipCount: null },
          risk: { entry: null, stop: null, targets: null, confidence: null, winrate: null },
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
      version: "2026.02.02-SERVER-SIGS-CLEAN",
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
      // auxValues intentionally not computed locally (secret removed)
      aux: null,
      sigs: (Array.isArray(sigs) ? sigs.slice(Math.max(0, sigs.length - 300)) : []),
      signals: (Array.isArray(sigs) ? sigs.slice(Math.max(0, sigs.length - 300)) : []),
      lastClose: bars[bars.length - 1].close,
      diag: {
        lastBarsUrl: DIAG.lastBarsUrl || null,
        lastSigsUrl: DIAG.lastSigsUrl || null,
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
