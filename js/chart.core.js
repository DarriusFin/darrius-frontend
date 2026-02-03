/* =========================================================================
 * DarriusAI - chart.core.js (HARDENED / NO-SECRETS) v2026.02.03
 *
 * What this file guarantees:
 *  1) MAIN CHART MUST NEVER BREAK (even if backend returns empty payload)
 *  2) OHLCV is fetched ONLY via backend proxy (/api/data/stocks/aggregates)
 *  3) Signals are fetched ONLY via backend (/api/market/sigs etc.) best-effort
 *  4) Publishes stable snapshot to window.__DARRIUS_CHART_STATE__
 *  5) NO secret core algorithm is placed here
 *
 * Exports:
 *  - window.ChartCore.init({containerId, autoLoad, pollMs})
 *  - window.ChartCore.load()
 *  - window.ChartCore.getSnapshot()
 *
 * Diagnostics:
 *  - window.__DARRIUS_DIAG__
 *  - window.__LAST_AGG_URL__, window.__LAST_AGG__, window.__LAST_AGG_ERR__
 *  - window.__LAST_SIG_URL__, window.__LAST_SIG__, window.__LAST_SIG_ERR__
 *  - window.__DARRIUS_CHART_STATE__
 * ========================================================================= */

(() => {
  "use strict";

  // -----------------------------
  // Global DIAG (never throw)
  // -----------------------------
  const DIAG = (window.__DARRIUS_DIAG__ = window.__DARRIUS_DIAG__ || {
    lastError: null,
    chartError: null,
    lastAggUrl: null,
    lastSigUrl: null,
    lastBarsCount: null,
    lastSigsCount: null,
    lastBarsSource: null, // "backend" | "lastGood" | "demo"
    backendShape: null,
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
  // Non-secret periods
  // -----------------------------
  const EMA_PERIOD = 14;
  const AUX_PERIOD = 40; // placeholder SMA only (NO-SECRETS)

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
  let _inFlight = false;

  // -----------------------------
  // UI readers (best-effort)
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
  // Fetch helper
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
    } catch {
      const err = new Error("Invalid JSON");
      err.body = text;
      throw err;
    }
  }

  // -----------------------------
  // TF -> agg params
  // -----------------------------
  function tfToAggParams(tf) {
    const m = String(tf || "1d").trim();
    const map = {
      "5m":  { multiplier: 5,   timespan: "minute", daysBack: 20  },
      "15m": { multiplier: 15,  timespan: "minute", daysBack: 35  },
      "30m": { multiplier: 30,  timespan: "minute", daysBack: 60  },
      "1h":  { multiplier: 60,  timespan: "minute", daysBack: 90  },
      "4h":  { multiplier: 240, timespan: "minute", daysBack: 180 },
      "1d":  { multiplier: 1,   timespan: "day",    daysBack: 700 },
      "1w":  { multiplier: 1,   timespan: "week",   daysBack: 1800},
      "1M":  { multiplier: 1,   timespan: "month",  daysBack: 3600},
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
    const from = new Date(Date.now() - daysBack * 86400 * 1000);
    return { from: toYMD(from), to: toYMD(to) };
  }

  // -----------------------------
  // Time parsing (supports numeric string)
  // -----------------------------
  function toUnixSec(t) {
    if (t == null) return null;

    // business day object
    if (typeof t === "object" && t.year && t.month && t.day) {
      const ms = Date.UTC(t.year, t.month - 1, t.day);
      return Math.floor(ms / 1000);
    }

    // number: sec or ms
    if (typeof t === "number" && Number.isFinite(t)) {
      return (t > 2e10) ? Math.floor(t / 1000) : Math.floor(t);
    }

    // string: numeric ts or datetime
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
  // Deep array finder (for weird backend wrappers)
  // Looks for an array that contains objects with OHLC/time-like keys.
  // -----------------------------
  function looksLikeBarObj(o) {
    if (!o || typeof o !== "object") return false;
    const hasTime = ("t" in o) || ("time" in o) || ("datetime" in o) || ("date" in o) || ("timestamp" in o) || ("ts" in o);
    const hasOHLC =
      ("o" in o && "h" in o && "l" in o && "c" in o) ||
      ("open" in o && "high" in o && "low" in o && "close" in o);
    return !!(hasTime && hasOHLC);
  }

  function findBarsArray(payload) {
    // common fast paths
    const fast =
      (Array.isArray(payload) && payload) ||
      (Array.isArray(payload?.results) && payload.results) ||
      (Array.isArray(payload?.bars) && payload.bars) ||
      (Array.isArray(payload?.data?.results) && payload.data.results) ||
      (Array.isArray(payload?.data?.bars) && payload.data.bars) ||
      (Array.isArray(payload?.values) && payload.values) ||
      (Array.isArray(payload?.data?.values) && payload.data.values) ||
      (Array.isArray(payload?.data?.data?.values) && payload.data.data.values);

    if (fast && fast.length && looksLikeBarObj(fast[0])) return fast;

    // BFS search (depth-limited)
    const seen = new Set();
    const q = [{ v: payload, depth: 0 }];
    while (q.length) {
      const { v, depth } = q.shift();
      if (!v || typeof v !== "object") continue;
      if (seen.has(v)) continue;
      seen.add(v);
      if (depth > 4) continue;

      if (Array.isArray(v) && v.length && looksLikeBarObj(v[0])) return v;

      const keys = Object.keys(v);
      for (const k of keys) {
        const child = v[k];
        if (child && typeof child === "object") q.push({ v: child, depth: depth + 1 });
      }
    }
    return [];
  }

  // -----------------------------
  // Normalize bars (supports many schemas)
  // -----------------------------
  function normalizeBars(payload) {
    const raw = findBarsArray(payload) || [];

    const bars = (raw || [])
      .map((b) => {
        const tRaw =
          b?.time ?? b?.t ?? b?.timestamp ?? b?.ts ?? b?.date ?? b?.datetime ?? b?.datetime_utc ??
          b?.candleTime ?? b?.start ?? b?.end;

        const time = toUnixSec(tRaw);

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

  // -----------------------------
  // Signals normalize (supports many wrappers)
  // -----------------------------
  function normalizeSignals(payload) {
    const raw =
      (Array.isArray(payload) ? payload : null) ||
      payload?.sigs ||
      payload?.signals ||
      payload?.data?.sigs ||
      payload?.data?.signals ||
      payload?.data?.data?.sigs ||
      payload?.data?.data?.signals ||
      [];

    if (!Array.isArray(raw)) return [];

    const out = raw
      .map((s) => {
        const tRaw = s?.time ?? s?.t ?? s?.timestamp ?? s?.ts ?? s?.date ?? s?.datetime;
        const time = toUnixSec(tRaw);

        const sideRaw = String(s?.side ?? s?.type ?? s?.action ?? s?.signal ?? s?.text ?? "").trim();
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
  // Non-secret math (EMA/SMA)
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

  // Anchor signal price to bar if missing
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

      // If you only want big overlay, keep small markers off
      if (window.__OVERLAY_BIG_SIGS__ === true) {
        candleSeries.setMarkers([]);
        return;
      }

      const arr = (Array.isArray(sigs) ? sigs : []).filter(s => s && (s.side === "B" || s.side === "S" || s.side === "eB" || s.side === "eS"));

      candleSeries.setMarkers(
        arr.map((s) => {
          const isBuy = (s.side === "B" || s.side === "eB");
          return {
            time: s.time,
            position: isBuy ? "belowBar" : "aboveBar",
            color: isBuy ? "#FFD400" : "#FF5A5A",
            shape: isBuy ? "arrowUp" : "arrowDown",
            text: s.side,
          };
        })
      );
    });
  }

  // -----------------------------
  // Snapshot publish
  // -----------------------------
  function publishSnapshot(flat) {
    safeRun("publishSnapshot", () => {
      const frozen = Object.freeze(flat);
      window.__DARRIUS_CHART_STATE__ = frozen;
      try {
        window.dispatchEvent(new CustomEvent("darrius:chartUpdated", { detail: frozen }));
      } catch {}
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
          };
        } catch {
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
  // Last-good cache (kills "Loading forever")
  // -----------------------------
  function cacheKey(sym, tf) {
    return `DARRIUS_LASTGOOD_BARS::${String(sym)}::${String(tf)}`;
  }

  function saveLastGood(sym, tf, bars) {
    safeRun("saveLastGood", () => {
      if (!Array.isArray(bars) || !bars.length) return;
      const key = cacheKey(sym, tf);
      const payload = {
        ts: Date.now(),
        sym: String(sym),
        tf: String(tf),
        bars: bars.slice(-800),
      };
      localStorage.setItem(key, JSON.stringify(payload));
    });
  }

  function loadLastGood(sym, tf) {
    return safeRun("loadLastGood", () => {
      const key = cacheKey(sym, tf);
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !Array.isArray(obj.bars) || !obj.bars.length) return null;
      return obj.bars;
    });
  }

  // Optional: demo fallback (only if you allow)
  function genDemoBars(days = 200) {
    const now = Math.floor(Date.now() / 1000);
    let price = 100;
    const out = [];
    for (let i = days; i >= 0; i--) {
      const t = now - i * 86400;
      const drift = (Math.sin(i / 17) * 0.6) + (Math.random() - 0.5) * 1.2;
      const o = price;
      const c = Math.max(1, price + drift);
      const h = Math.max(o, c) + Math.random() * 1.0;
      const l = Math.min(o, c) - Math.random() * 1.0;
      price = c;
      out.push({ time: t, open: o, high: h, low: l, close: c, volume: Math.floor(100000 + Math.random() * 300000) });
    }
    return out;
  }

  // -----------------------------
  // Fetch bars
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

    // record backend shape to DIAG (what keys exist)
    DIAG.backendShape = safeRun("shape", () => ({
      keys: Object.keys(payload || {}),
      hasResults: Array.isArray(payload?.results),
      hasDataResults: Array.isArray(payload?.data?.results),
      hasValues: Array.isArray(payload?.values),
      hasDataValues: Array.isArray(payload?.data?.values),
      resultsCount: payload?.resultsCount,
      status: payload?.status,
    }));

    const bars = normalizeBars(payload);
    return { payload, bars, urlUsed: urlStr };
  }

  // -----------------------------
  // Fetch signals (best-effort)
  // -----------------------------
  function buildSigQueryPairs(sym, tf) {
    const s = encodeURIComponent(sym);
    const t = encodeURIComponent(tf);
    return [
      `symbol=${s}&tf=${t}`,
      `ticker=${s}&tf=${t}`,
      `symbol=${s}&timeframe=${t}`,
      `ticker=${s}&timeframe=${t}`,
    ];
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
    return lastErr ? [] : [];
  }

  // -----------------------------
  // Main load (hardened)
  // -----------------------------
  async function loadOnce() {
    if (!chart || !candleSeries) return;

    const sym = getUiSymbol();
    const tf  = getUiTf();

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
      window.__LAST_AGG_ERR__ = undefined;
    } catch (e) {
      window.__LAST_AGG_ERR__ = {
        message: String(e?.message || e),
        status: e?.status,
        body: String(e?.body || ""),
      };
    }

    // HARDENED: if backend returns no bars, try last-good cache
    let barsSource = "backend";
    if (!Array.isArray(bars) || !bars.length) {
      const lastGood = loadLastGood(sym, tf);
      if (Array.isArray(lastGood) && lastGood.length) {
        bars = lastGood;
        barsSource = "lastGood";
      } else if (window.__ALLOW_DEMO_FALLBACK__ === true) {
        bars = genDemoBars(260);
        barsSource = "demo";
      }
    }

    if (!Array.isArray(bars) || !bars.length) {
      // still empty: do NOT crash; keep screen informative
      const msg = "No bars from backend (payload has no array). Check backend /aggregates response.";
      DIAG.chartError = { message: msg, stack: "" };
      safeRun("hintFail", () => {
        if ($("hintText")) $("hintText").textContent = "加载失败：后端未返回蜡烛数组（仅元信息）";
      });
      // publish minimal snapshot so UI can stop waiting
      const flat = {
        version: "2026.02.03-HARDENED-NO-SECRETS",
        ts: Date.now(),
        apiBase: API_BASE,
        urlUsed: urlUsed || window.__LAST_AGG_URL__ || null,
        symbol: sym,
        tf,
        barsCount: 0,
        bars: [],
        sigsCount: 0,
        sigs: [],
        signals: [],
        error: msg,
        backendShape: DIAG.backendShape || null,
      };
      DIAG.lastBarsCount = 0;
      DIAG.lastSigsCount = 0;
      DIAG.lastBarsSource = "none";
      publishSnapshot(flat);
      return flat;
    }

    // We have bars -> draw main chart (never blocked by signals)
    DIAG.lastBarsSource = barsSource;

    candleSeries.setData(bars);

    const closes = bars.map(b => b.close);
    const emaVals = ema(closes, EMA_PERIOD);
    const emaPts  = buildLinePoints(bars, emaVals);
    emaSeries.setData(emaPts);

    const auxVals = sma(closes, AUX_PERIOD);
    const auxPts  = buildLinePoints(bars, auxVals);
    auxSeries.setData(auxPts);

    // volume optional
    safeRun("volume", () => {
      if (!volumeSeries) return;
      const vol = bars
        .filter(b => Number.isFinite(b.volume))
        .map(b => ({ time: b.time, value: b.volume }));
      if (vol.length) volumeSeries.setData(vol);
    });

    // Save last-good bars (so next time backend empty won't kill UI)
    saveLastGood(sym, tf, bars);

    // Signals best-effort: 1) from agg payload 2) from sigs endpoint
    let sigs = normalizeSignals(payload || {});
    if (!sigs.length) {
      const fetched = await fetchSignalsBestEffort(sym, tf);
      if (fetched.length) sigs = fetched;
    }
    const richSignals = enrichSignalsWithPrice(bars, sigs);

    // Apply markers (small)
    applyMarkers(richSignals);

    safeRun("fitContent", () => chart.timeScale().fitContent());

    // Top text
    safeRun("topText", () => {
      const last = bars[bars.length - 1];
      if ($("symText")) $("symText").textContent = sym;
      if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

      if ($("hintText")) {
        const sigTag = richSignals.length ? `sigs=${richSignals.length}` : "sigs=0";
        $("hintText").textContent =
          `Loaded · bars=${bars.length} · ${sigTag} · source=${barsSource}`;
      }
    });

    // Snapshot for UI overlay
    const snapObj = {
      version: "snapshot_hardened_no_secrets",
      ts: Date.now(),
      meta: {
        symbol: sym,
        timeframe: tf,
        bars: bars.length,
        urlUsed: urlUsed || null,
        barsSource,
        emaPeriod: EMA_PERIOD,
        auxPeriod: AUX_PERIOD,
      },
      candles: bars,
      ema: emaPts,
      aux: auxPts,
      signals: richSignals,
    };
    setGetSnapshotObject(snapObj);

    const flat = {
      version: "2026.02.03-HARDENED-NO-SECRETS",
      ts: Date.now(),
      apiBase: API_BASE,
      urlUsed: urlUsed || window.__LAST_AGG_URL__ || null,
      symbol: sym,
      tf,
      barsSource,
      barsCount: bars.length,
      bars: bars.slice(-800),
      sigsCount: richSignals.length,
      sigs: richSignals.slice(-500),
      signals: richSignals.slice(-500),
      lastClose: bars[bars.length - 1].close,
      backendShape: DIAG.backendShape || null,
    };

    DIAG.lastBarsCount = bars.length;
    DIAG.lastSigsCount = richSignals.length;

    publishSnapshot(flat);
    applyToggles();
    return flat;
  }

  async function load() {
    if (_inFlight) return;
    _inFlight = true;
    try { return await loadOnce(); }
    finally { _inFlight = false; }
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
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
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

    volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    // Bridge for overlay
    safeRun("bridgeExpose", () => {
      window.DarriusChart = window.DarriusChart || {};
      window.DarriusChart.timeToX = (t) => safeRun("timeToX", () => chart.timeScale().timeToCoordinate(t));
      window.DarriusChart.priceToY = (p) => safeRun("priceToY", () => candleSeries.priceToCoordinate(p));
      window.DarriusChart.__hostId = containerId || "chart";
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
      catch { window.addEventListener("resize", resize); }
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

    if (opts.autoLoad !== false) {
      load().catch((e) => {
        DIAG.chartError = { message: String(e?.message || e), stack: String(e?.stack || "") };
      });
    }

    if (opts.pollMs) startPolling(opts.pollMs);
  }

  function getSnapshot() {
    try {
      if (window.DarriusChart && typeof window.DarriusChart.getSnapshot === "function") {
        return window.DarriusChart.getSnapshot();
      }
      return window.__DARRIUS_CHART_STATE__ || null;
    } catch { return null; }
  }

  window.ChartCore = { init, load, applyToggles, getSnapshot, startPolling, stopPolling };
})();
