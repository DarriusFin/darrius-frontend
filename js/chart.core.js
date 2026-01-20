/* =========================================================================
 * DarriusAI - chart.core.js (FROZEN MAIN CHART) v2026.01.19-PRESET2-SNAPSHOT
 *
 * Role:
 *  - Render main chart (candles + EMA + AUX + signals)
 *  - Output a read-only snapshot to window.__DARRIUS_CHART_STATE__
 *  - Emit event "darrius:chartUpdated" with snapshot detail
 *
 * Preset 2:
 *  - EMA 14
 *  - AUX 40 (HMA-like)
 *  - confirm window 3
 *  - Candles colored by EMA trend (EMA slope)
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
  });

  function safeRun(tag, fn) {
    try {
      return fn();
    } catch (e) {
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
    return (v || "TSLA").trim();
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

  function toUnixTime(t) {
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
      Array.isArray(payload?.bars) ? payload.bars :
      Array.isArray(payload?.ohlcv) ? payload.ohlcv :
      Array.isArray(payload?.data) ? payload.data :
      [];

    const bars = (raw || [])
      .map((b) => {
        const time = toUnixTime(b.time ?? b.t ?? b.timestamp ?? b.ts ?? b.date);
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
        const time = toUnixTime(s.time ?? s.t ?? s.timestamp ?? s.ts ?? s.date);
        const side = String(s.side ?? s.type ?? s.action ?? "").toUpperCase();
        if (!time || (side !== "B" && side !== "S")) return null;
        return { time, side };
      })
      .filter(Boolean)
      .sort((x, y) => (x.time > y.time ? 1 : x.time < y.time ? -1 : 0));
  }

  async function fetchBarsPack(sym, tf) {
    const apiBase = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");
    const q = `symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;

    let lastErr = null;
    for (const p of BARS_PATH_CANDIDATES) {
      const url = `${apiBase}${p}?${q}`;
      try {
        const payload = await fetchJson(url);
        const bars = normalizeBars(payload);
        if (bars.length) return { payload, bars, urlUsed: url };
        lastErr = new Error(`bars empty from ${url}`);
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
        return normalizeSignals(payload);
      } catch (_) {}
    }
    return [];
  }

  // -----------------------------
  // Math
  // -----------------------------
  const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

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
      const t = bars[i].time;
      const v = values[i];
      pts[i] = { time: t, value: Number.isFinite(v) ? v : null };
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

  function computeSignalsCrossPlusInflection(bars, emaPts, auxPts, confirmWindow) {
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
      const key = `${t}:${side}`;
      if (used.has(key)) return;
      used.add(key);
      sigs.push({ time: t, side });
    }

    function findConfirmIndex(startIdx, wantTrend) {
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

  function applyMarkers(sigs) {
    safeRun("applyMarkers", () => {
      if (!candleSeries) return;

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
      // Freeze shallowly (consumer should treat as read-only)
      const s = Object.freeze(snapshot);

      // global
      window.__DARRIUS_CHART_STATE__ = s;

      // event
      try {
        window.dispatchEvent(new CustomEvent("darrius:chartUpdated", { detail: s }));
      } catch (_) {
        // very old browsers: ignore
      }
    });
  }

  // -----------------------------
  // Toggles
  // -----------------------------
  function applyToggles() {
    safeRun("applyToggles", () => {
      const emaChecked = $("toggleEMA")?.checked ?? $("emaToggle")?.checked ?? $("emaCheck")?.checked;
      const auxChecked = $("toggleAUX")?.checked ?? $("auxToggle")?.checked ?? $("auxCheck")?.checked;

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

    // -------- MAIN CHART: never let UI break this --------
    const closes = bars.map(b => b.close);
    const emaVals = ema(closes, EMA_PERIOD);
    const auxVals = computeAuxByYourAlgo(closes, AUX_PERIOD, AUX_METHOD);

    const coloredBars = colorCandlesByEMATrend(bars, emaVals);
    candleSeries.setData(coloredBars);

    const emaPts = buildLinePoints(bars, emaVals);
    const auxPts = buildLinePoints(bars, auxVals);
    emaSeries.setData(emaPts);
    auxSeries.setData(auxPts);

    // signals
    let sigs = normalizeSignals(payload);
    if (!sigs.length) sigs = await fetchOptionalSignals(sym, tf);
    if (!sigs.length) sigs = computeSignalsCrossPlusInflection(bars, emaPts, auxPts, CONFIRM_WINDOW);

    applyMarkers(sigs);

    safeRun("fitContent", () => chart.timeScale().fitContent());

    safeRun("topText", () => {
      const last = bars[bars.length - 1];
      if ($("symText")) $("symText").textContent = sym;
      if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);
      if ($("hintText")) $("hintText").textContent = `Loaded · TF=${tf} · bars=${bars.length} · sigs=${sigs.length}`;
    });

    // ===== Snapshot: export for market.pulse.js (READ-ONLY) =====
    safeRun("setSnapshotForUI", () => {
      try {
        const snapMeta = {
          symbol: sym || null,
          timeframe: tf || null,
          bars: Array.isArray(bars) ? bars.length : 0,
          source: (window.__DATA_SOURCE__ || "demo"),
          emaPeriod: EMA_PERIOD || 14,
          auxPeriod: AUX_PERIOD || 40,
          confirmWindow: CONFIRM_WINDOW || 3,
        };

        // 注意：你的 sigs 只有 {time, side}，没有 price
        // 这里用“该 time 对应的 close”补齐 price（用于 overlay 定位）
        const closeByTime = new Map();
        for (const b of bars) closeByTime.set(b.time, b.close);

        const snapSignals = (Array.isArray(sigs) ? sigs : [])
          .map((s, idx) => {
            const t = s.time ?? s.t ?? null;
            const sideRaw = (s.side || s.type || s.signal || "").toString().toUpperCase();
            const side = (sideRaw === "S" ? "S" : "B");
            const price = Number.isFinite(s.price) ? s.price : closeByTime.get(t);
            return {
              time: t,
              price: Number.isFinite(price) ? price : null,
              side,
              i: (typeof s.i === "number" ? s.i : (typeof s.index === "number" ? s.index : idx)),
              reason: s.reason || s.note || null,
              strength: (typeof s.strength === "number" ? s.strength : null),
            };
          })
          .filter(x => x.time != null && x.price != null);

        // 趋势信息：你主图是按 EMA slope 给蜡烛底色
        // 这里给出一个“最近 10 根”的 slope 估计 + regime
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

        const snapTrend = {
          emaSlope,
          emaRegime,   // 'UP'|'DOWN'|'FLAT'
          emaColor,    // 'GREEN'|'RED'|'NEUTRAL'
          flipCount: null,
        };

        // 风险信息：你当前 chart.core.js 没有 risk 计算，先留空
        const snapRisk = {
          entry: null,
          stop: null,
          targets: null,
          confidence: null,
          winrate: null,
        };

        if (window.DarriusChart && typeof window.DarriusChart.__setSnapshot === "function") {
          window.DarriusChart.__setSnapshot({
            meta: snapMeta,
            candles: Array.isArray(bars) ? bars : [],
            // 这里“对齐你的 market.pulse.js”：它期望 ema/aux 是数组
            // 你现在 snapshot export IIFE 里注释写的是 [{time,value}]
            // 但 market.pulse.js 多半兼容 number[]；为了稳，给两份都行：
            ema: Array.isArray(emaPts) ? emaPts : [],
            aux: Array.isArray(auxPts) ? auxPts : [],
            signals: snapSignals,
            trend: snapTrend,
            risk: snapRisk,
          });
        }
      } catch (e) {
        // 永不影响主图
      }
    });

    // -------- SNAPSHOT OUTPUT (consumer only) --------
    // Keep snapshot compact but sufficient. We expose last N arrays for MP usage.
    const N = Math.min(200, bars.length);
    const start = bars.length - N;

    const snapshot = {
      version: "2026.01.19-PRESET2",
      ts: Date.now(),
      apiBase: DEFAULT_API_BASE,
      urlUsed,
      symbol: sym,
      tf,
      params: { EMA_PERIOD, AUX_PERIOD, AUX_METHOD, CONFIRM_WINDOW },
      barsCount: bars.length,
      // last N bars for derived computations
      bars: bars.slice(start),
      ema: emaVals.slice(start),
      aux: auxVals.slice(start),
      // all signals (or last 100)
      sigs: sigs.slice(Math.max(0, sigs.length - 200)),
      // helpful last price
      lastClose: bars[bars.length - 1].close,
    };

    publishSnapshot(snapshot);

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
    // - DO NOT expose chart object to UI layer
    // - Only expose time->x and price->y mapping (safe, read-only)
    // - Also expose __hostId so overlay knows the real chart container
    // -----------------------------
    safeRun("bridgeExpose", () => {
      window.DarriusChart = window.DarriusChart || {};

      // time -> x(px)
      window.DarriusChart.timeToX = (t) => safeRun("timeToX", () => {
        if (!chart || !chart.timeScale) return null;
        return chart.timeScale().timeToCoordinate(t);
      });

      // price -> y(px)
      window.DarriusChart.priceToY = (p) => safeRun("priceToY", () => {
        if (!candleSeries || !candleSeries.priceToCoordinate) return null;
        return candleSeries.priceToCoordinate(p);
      });

      // optional: tell UI which host is the real chart container
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
      try {
        new ResizeObserver(resize).observe(containerEl);
      } catch (_) {
        window.addEventListener("resize", resize);
      }
    });
    resize();

    $("toggleEMA")?.addEventListener("change", applyToggles);
    $("emaToggle")?.addEventListener("change", applyToggles);
    $("emaCheck")?.addEventListener("change", applyToggles);

    $("toggleAUX")?.addEventListener("change", applyToggles);
    $("auxToggle")?.addEventListener("change", applyToggles);
    $("auxCheck")?.addEventListener("change", applyToggles);

    if (opts.autoLoad !== false) load().catch((e) => {
      DIAG.chartError = { message: String(e?.message || e), stack: String(e?.stack || "") };
    });
  }

  window.ChartCore = { init, load, applyToggles };
})();

/* =========================
 * Snapshot Export (READ-ONLY)
 * - UI层（market.pulse.js）只读这里
 * - 不允许 UI 层反向修改主图内部
 * ========================= */

(function () {
  "use strict";

  // 1) 单例快照容器（只存“最新一次计算/渲染后的结果”）
  const __SNAPSHOT = {
    version: "snapshot_v1",
    ts: 0,

    meta: {
      symbol: null,
      timeframe: null,
      bars: 0,
      source: "demo",
      emaPeriod: null,
      auxPeriod: null,
      confirmWindow: null,
    },

    // 主序列（用于 UI 派生：market pulse、risk、overlay）
    candles: [],     // [{time, open, high, low, close}]
    ema: [],         // [{time, value}]
    aux: [],         // [{time, value}]  (或你用于“稳定度/平滑度”的那条线)

    // 信号（用于：Market Pulse 的 bias + B/S overlay）
    // 统一：只给“有效信号”（confirm-window 成立后的）
    signals: [],     // [{time, price, side:'B'|'S', i, reason?, strength?}]

    // 趋势底色（为了 rule-1 强一致：Market Pulse 不得逆趋势）
    // 统一：由主图已经算出来的趋势结果写入；没有就留 null
    trend: {
      emaSlope: null,        // 最近一段 EMA 的 slope（>0 up, <0 down）
      emaRegime: null,       // 'UP'|'DOWN'|'FLAT'|null
      emaColor: null,        // 'GREEN'|'RED'|'NEUTRAL'|null  （对应你蜡烛底色）
      flipCount: null,       // EMA regime 在最近N根内反转次数（用于稳定度）
    },

    // 风险助手（由 chart.core.js 内部既有逻辑写入；没有就留 null）
    risk: {
      entry: null,     // number
      stop: null,      // number
      targets: null,   // string 或 number[]（推荐 string 给 UI 直接显示）
      confidence: null,// 0~100
      winrate: null,   // 0~100（如果你有回测/估计）
    },
  };

  // 2) 写快照：供 chart.core.js 内部在“每次加载/重算/重绘后”调用
  //    注意：只拷贝必要字段，避免把巨大对象/series引用泄漏出去
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
    } catch (e) {
      // 永不抛错：不允许快照导出影响主图
    }
  }

  // 3) 读快照：market.pulse.js 会调用这个
  function __getSnapshot() {
    try {
      // 返回一个“只读副本”（浅拷贝 + 数组拷贝）
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

  // 4) 暴露给 UI 层：两种入口都给（与你 market.pulse.js 的多重 fallback 对齐）
  window.DarriusChart = window.DarriusChart || {};
  window.DarriusChart.getSnapshot = __getSnapshot;

  // 兼容另一种命名（你 market.pulse.js 也会尝试这个）
  if (typeof window.getChartSnapshot !== "function") {
    window.getChartSnapshot = __getSnapshot;
  }

  // 5) 提供给 chart.core.js 内部调用（不暴露到 UI 层也行；但暴露给自己更方便）
  window.DarriusChart.__setSnapshot = __setSnapshot;
})();
