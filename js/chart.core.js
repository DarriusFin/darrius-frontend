/* ============================================================================
 * DarriusAI - chart.core.js (FROZEN MAIN CHART)
 * Role:
 * - Render main chart (candles + EMA + AUX + signals)
 * - Fetch OHLCV via backend proxy (Massive/Polygon aggregates)
 * - Output read-only snapshot to window.__DARRIUS_CHART_STATE__
 * - Emit event "darrius:chartUpdated"
 *
 * Guarantees:
 * 1) Main chart render is highest priority and will not be broken by UI
 * 2) Non-critical parts are wrapped in no-throw safe zones
 * 3) NO billing/subscription/payment code is touched here
 * ========================================================================== */
(() => {
  'use strict';

  // -----------------------------
  // Safe zone
  // -----------------------------
  function safeRun(tag, fn) {
    try { return fn(); } catch (_) { return null; }
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
    (window.__API_BASE__ && String(window.__API_BASE__)) ||
    (window.API_BASE && String(window.API_BASE)) ||
    (window.__API_BASE && String(window.__API_BASE)) ||
    "https://darrius-api.onrender.com";

  // Prefer verified endpoint:
  // /api/data/stocks/aggregates?ticker=...&multiplier=...&timespan=...&from=...&to=...
  const MASSIVE_AGGS_PATH = "/api/data/stocks/aggregates";

  // Keep candidates for backward compat
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

  // Preset params (internal; do not surface in UI text)
  const EMA_PERIOD = 14;
  const AUX_PERIOD = 40;
  const AUX_METHOD = "SMA";
  const CONFIRM_WINDOW = 3;

  // Colors
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

  // DataSource selection (UI-visible), but effective source is gated by subscription.
  const DATA_SOURCE_KEY = "darrius:dataSourceSelected"; // 'demo' | 'market'
  function getSelectedDataSource() {
    const uiSel = ($("dataSourceSelect") && $("dataSourceSelect").value) || "";
    const v = (uiSel || localStorage.getItem(DATA_SOURCE_KEY) || "demo").toLowerCase();
    return (v === "market") ? "market" : "demo";
  }
  function setSelectedDataSource(v) {
    const x = (v === "market") ? "market" : "demo";
    localStorage.setItem(DATA_SOURCE_KEY, x);
    if ($("dataSourceSelect")) $("dataSourceSelect").value = x;
  }

  // IMPORTANT: We DO NOT implement subscription here.
  // We only READ an externally-provided boolean flag if present.
  function isSubscriptionActive() {
    // Supported external flags (you can pick one in your subscription module WITHOUT changing logic here):
    // window.__DARRIUS_SUB_ACTIVE__ = true/false
    // window.DARRIUS_SUB_ACTIVE = true/false
    // window.__ACCESS__?.market === true
    if (window.__DARRIUS_SUB_ACTIVE__ === true) return true;
    if (window.DARRIUS_SUB_ACTIVE === true) return true;
    if (window.__ACCESS__ && window.__ACCESS__.market === true) return true;
    return false;
  }

  function getEffectiveDataSource() {
    const selected = getSelectedDataSource();
    if (!isSubscriptionActive()) return { source: "demo", reason: (selected === "market") ? "no-subscription" : "demo-selected" };
    return { source: selected, reason: (selected === "market") ? "subscribed" : "demo-selected" };
  }

  // Data mode label
  function getDataModeLabel(meta) {
    const eff = getEffectiveDataSource().source;
    if (eff === "demo") return { en: "DEMO", cn: "演示" };
    const mins = meta && Number(meta.delayedMinutes);
    if (Number.isFinite(mins) && mins > 0) return { en: `MARKET · Delayed (${mins}m)`, cn: `市场 · 延迟（${mins}分钟）` };
    return { en: "MARKET · Live", cn: "市场 · 实时" };
  }

  // -----------------------------
  // Time helpers (CRITICAL for B/S accuracy)
  // -----------------------------
  function toUnixSec(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return null;
    // heuristics: ms timestamps are ~13 digits, sec are ~10 digits
    const sec = (n > 1e12) ? (n / 1000) : n;
    return Math.floor(sec);
  }

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
    return String(v || "AAPL").trim().toUpperCase();
  }

  function getUiTf() {
    const el =
      $("tfSelect") ||
      $("timeframe") ||
      $("timeframeSelect") ||
      qs('select[name="timeframe"]') ||
      qs("#tf");
    const v = el && (el.value || el.textContent);
    return String(v || "1d").trim().toLowerCase();
  }

  function tfToAggParams(tf) {
    // tf examples: '1m','5m','15m','1h','4h','1d'
    const t = String(tf || "1d").toLowerCase();
    if (t.endsWith("m")) return { multiplier: Number(t.replace("m", "")) || 5, timespan: "minute", daysBack: 7 };
    if (t.endsWith("h")) return { multiplier: Number(t.replace("h", "")) || 1, timespan: "hour", daysBack: 30 };
    return { multiplier: 1, timespan: "day", daysBack: 365 };
  }

  function rangeByDaysBack(daysBack) {
    const now = new Date();
    const end = new Date(now);
    const start = new Date(now);
    start.setDate(start.getDate() - Math.max(2, Number(daysBack) || 30));
    const iso = (d) => d.toISOString().slice(0, 10);
    return { from: iso(start), to: iso(end) };
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

  function normalizeBars(payload) {
    const arr =
      payload?.bars ||
      payload?.results ||
      payload?.data?.bars ||
      payload?.data?.results ||
      [];
    if (!Array.isArray(arr)) return [];

    // Accept multiple schemas:
    // Polygon-like: { t(ms), o,h,l,c,v }
    // Generic: { time, open, high, low, close, volume }
    const out = [];
    for (const b of arr) {
      const t = toUnixSec(b.time ?? b.t ?? b.timestamp ?? b.ts ?? b.date);
      const o = Number(b.open ?? b.o);
      const h = Number(b.high ?? b.h);
      const l = Number(b.low ?? b.l);
      const c = Number(b.close ?? b.c);
      const v = Number(b.volume ?? b.v ?? 0);
      if (!t || ![o, h, l, c].every(Number.isFinite)) continue;
      out.push({ time: t, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0 });
    }
    out.sort((a, b) => a.time - b.time);
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
    const out = [];
    for (const s of raw) {
      const t = toUnixSec(s.time ?? s.t ?? s.timestamp ?? s.ts ?? s.date);
      const side = String(s.side ?? s.type ?? s.action ?? "").toUpperCase();
      if (!t) continue;
      if (side !== "B" && side !== "S") continue;
      out.push({ time: t, side });
    }
    out.sort((a, b) => a.time - b.time);
    // de-dupe
    const used = new Set();
    return out.filter(x => {
      const k = `${x.time}:${x.side}`;
      if (used.has(k)) return false;
      used.add(k);
      return true;
    });
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
  // Demo bars generator (front-end only; no provider exposure)
  // -----------------------------
  function generateDemoBars(sym, tf) {
    const cfg = tfToAggParams(tf);
    const nowSec = Math.floor(Date.now() / 1000);
    const stepSec =
      (cfg.timespan === "minute") ? (60 * cfg.multiplier) :
      (cfg.timespan === "hour") ? (3600 * cfg.multiplier) :
      (86400 * cfg.multiplier);

    const n = (cfg.timespan === "day") ? 240 : 400;
    const start = nowSec - n * stepSec;

    // deterministic seed from symbol
    let seed = 0;
    for (let i = 0; i < sym.length; i++) seed = (seed * 31 + sym.charCodeAt(i)) >>> 0;
    const rand = () => {
      // xorshift
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >> 17; seed >>>= 0;
      seed ^= seed << 5;  seed >>>= 0;
      return (seed % 10000) / 10000;
    };

    let price = 80 + (rand() * 40);
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = start + i * stepSec;
      const drift = (rand() - 0.5) * 0.8;
      const vol = 0.6 + rand() * 1.4;
      const o = price;
      const c = Math.max(1, o + drift * vol);
      const hi = Math.max(o, c) + rand() * vol;
      const lo = Math.min(o, c) - rand() * vol;
      price = c;
      out.push({ time: t, open: o, high: hi, low: lo, close: c, volume: 0 });
    }
    return out;
  }

  // -----------------------------
  // Fetch pack (bars + payload/meta)
  // -----------------------------
  async function fetchBarsPack(sym, tf) {
    const apiBase = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");
    const cfg = tfToAggParams(tf);
    const { from, to } = rangeByDaysBack(cfg.daysBack);

    const eff = getEffectiveDataSource();
    if (eff.source === "demo") {
      const bars = generateDemoBars(sym, tf);
      return {
        payload: { meta: { dataSource: "demo" } },
        bars,
        urlUsed: "demo://local",
        meta: { dataSource: "demo" }
      };
    }

    // market: use verified endpoint first
    const url = new URL(apiBase + MASSIVE_AGGS_PATH);
    url.searchParams.set("ticker", String(sym || "AAPL").trim().toUpperCase());
    url.searchParams.set("multiplier", String(cfg.multiplier));
    url.searchParams.set("timespan", String(cfg.timespan));
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);

    const payload = await fetchJson(url.toString());
    const bars = normalizeBars(payload);
    if (bars.length) {
      const delayedMinutes =
        Number(payload?.meta?.delayedMinutes ?? payload?.delayedMinutes ?? payload?.meta?.delayMinutes);
      return {
        payload,
        bars,
        urlUsed: url.toString(),
        meta: {
          dataSource: "market",
          delayedMinutes: Number.isFinite(delayedMinutes) ? delayedMinutes : null
        }
      };
    }

    // fallback candidates (optional)
    let lastErr = new Error(`Aggs returned empty. ticker=${sym} tf=${tf} from=${from} to=${to}`);
    const q = `symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;
    for (const p of BARS_PATH_CANDIDATES) {
      const u = `${apiBase}${p}?${q}`;
      try {
        const pl = await fetchJson(u);
        const bs = normalizeBars(pl);
        if (bs.length) return { payload: pl, bars: bs, urlUsed: u, meta: { dataSource: "market" } };
        lastErr = new Error(`bars empty from ${u}`);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
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
      e = (e === null) ? v : (v * k + e * (1 - k));
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

  function computeAuxByYourAlgo(values, period, method) {
    // minimal: SMA (kept compatible)
    const m = String(method || "SMA").toUpperCase();
    const out = new Array(values.length).fill(NaN);
    if (m === "SMA") {
      for (let i = 0; i < values.length; i++) out[i] = smaAt(values, i, period);
      return out;
    }
    // fallback: SMA
    for (let i = 0; i < values.length; i++) out[i] = smaAt(values, i, period);
    return out;
  }

  function buildLinePoints(bars, values) {
    const out = [];
    for (let i = 0; i < bars.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      out.push({ time: bars[i].time, value: v });
    }
    return out;
  }

  function colorCandlesByEmaTrend(bars, emaVals) {
    const out = [];
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const e0 = emaVals[i - 1];
      const e1 = emaVals[i];
      const up = Number.isFinite(e0) && Number.isFinite(e1) ? (e1 >= e0) : true;
      out.push({
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        color: up ? COLOR_UP : COLOR_DN,
        wickColor: up ? COLOR_UP_WICK : COLOR_DN_WICK,
        borderColor: up ? COLOR_UP : COLOR_DN
      });
    }
    return out;
  }

  // -----------------------------
  // Signal computation (Cross + Hysteresis + Confirm)
  // -----------------------------
  function medianAbsDelta(vals, lookback) {
    const n = vals.length;
    const arr = [];
    for (let i = Math.max(1, n - (lookback || 50)); i < n; i++) {
      const a = vals[i - 1], b = vals[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      arr.push(Math.abs(b - a));
    }
    if (!arr.length) return 0;
    arr.sort((x, y) => x - y);
    return arr[Math.floor(arr.length / 2)];
  }

  function computeSignalsCrossStable(bars, emaPts, auxPts, confirmWindow) {
    const n = bars.length;
    if (n < 10) return [];

    const emaV = emaPts.map(p => p.value);
    const auxV = auxPts.map(p => p.value);

    // dynamic band reduces chatter; proportional to recent median move
    const closes = bars.map(b => b.close);
    const m = medianAbsDelta(closes, 80);
    const band = Math.max(0, m * 0.6); // hysteresis band

    const sigs = [];
    const used = new Set();

    const cw = Math.max(1, Math.min(6, Math.floor((confirmWindow || 3))));

    function addSig(i, side) {
      const t = bars[i].time;
      const key = `${t}:${side}`;
      if (used.has(key)) return;
      used.add(key);
      sigs.push({ time: t, side });
    }

    // cross detector with hysteresis:
    // d = ema-aux; require crossing beyond +/-band
    for (let i = 2; i < n; i++) {
      const d0 = emaV[i - 1] - auxV[i - 1];
      const d1 = emaV[i] - auxV[i];
      if (![d0, d1].every(Number.isFinite)) continue;

      const wasBelow = d0 < -band;
      const wasAbove = d0 > band;
      const nowAbove = d1 > band;
      const nowBelow = d1 < -band;

      // candidate cross up: below -> above
      if (wasBelow && nowAbove) {
        // confirm: within cw bars, ema slope stays positive OR close continues higher
        let ok = false;
        for (let j = i; j <= Math.min(n - 1, i + cw); j++) {
          const ePrev = emaV[j - 1], eCur = emaV[j];
          if (Number.isFinite(ePrev) && Number.isFinite(eCur) && eCur > ePrev) { ok = true; break; }
          if (bars[j].close > bars[i].close) { ok = true; break; }
        }
        if (ok) addSig(i, "B");
      }

      // candidate cross down: above -> below
      if (wasAbove && nowBelow) {
        let ok = false;
        for (let j = i; j <= Math.min(n - 1, i + cw); j++) {
          const ePrev = emaV[j - 1], eCur = emaV[j];
          if (Number.isFinite(ePrev) && Number.isFinite(eCur) && eCur < ePrev) { ok = true; break; }
          if (bars[j].close < bars[i].close) { ok = true; break; }
        }
        if (ok) addSig(i, "S");
      }
    }

    sigs.sort((a, b) => a.time - b.time);
    return sigs;
  }

  // -----------------------------
  // Markers
  // -----------------------------
  function applyMarkers(sigs) {
    safeRun("applyMarkers", () => {
      if (!candleSeries) return;

      // If overlay is enabled, keep series markers empty.
      if (window.__OVERLAY_BIG_SIGS__ === true) {
        candleSeries.setMarkers([]);
        return;
      }

      const arr = Array.isArray(sigs) ? sigs : [];
      candleSeries.setMarkers(
        arr.map(s => ({
          time: s.time,
          position: s.side === "B" ? "belowBar" : "aboveBar",
          color: s.side === "B" ? "#2BE2A6" : "#FF5A5A",
          shape: s.side === "B" ? "arrowUp" : "arrowDown",
          text: s.side
        }))
      );
    });
  }

  // -----------------------------
  // Chart init
  // -----------------------------
  function init(opts) {
    opts = opts || {};
    const containerId = opts.containerId || "chart";
    containerEl = $(containerId);
    if (!containerEl) throw new Error("Chart container missing: #" + containerId);
    if (!window.LightweightCharts) throw new Error("LightweightCharts missing");

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

    emaSeries = chart.addLineSeries({ color: COLOR_EMA, lineWidth: 2, visible: true });
    auxSeries = chart.addLineSeries({ color: COLOR_AUX, lineWidth: 2, visible: true });

    hookDataSourceSelect();
    hookToggles();
  }

  function hookToggles() {
    const emaCb = $("toggleEMA");
    const auxCb = $("toggleAUX");
    if (emaCb) emaCb.addEventListener("change", () => { showEMA = !!emaCb.checked; if (emaSeries) emaSeries.applyOptions({ visible: showEMA }); });
    if (auxCb) auxCb.addEventListener("change", () => { showAUX = !!auxCb.checked; if (auxSeries) auxSeries.applyOptions({ visible: showAUX }); });
  }

  function hookDataSourceSelect() {
    const sel = $("dataSourceSelect");
    if (!sel) return;

    // normalize options
    const want = ["demo", "market"];
    safeRun("normalizeSelect", () => {
      const exist = Array.from(sel.options || []).map(o => String(o.value || "").toLowerCase());
      // if select is old (Demo(Local)/Reserved), just map by value text
      for (const opt of Array.from(sel.options || [])) {
        const t = String(opt.textContent || "").toLowerCase();
        const v = String(opt.value || "").toLowerCase();
        if (t.includes("demo")) opt.value = "demo";
        if (t.includes("market") || t.includes("3rd") || t.includes("provider")) opt.value = "market";
        if (v === "") opt.value = (t.includes("demo")) ? "demo" : opt.value;
      }
    });

    // apply saved selection
    setSelectedDataSource(getSelectedDataSource());

    sel.addEventListener("change", () => {
      const v = getSelectedDataSource();
      setSelectedDataSource(v);
      // refresh chart
      load().catch(() => {});
    });
  }

  // -----------------------------
  // Load
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
        if ($("hintText")) $("hintText").textContent = "加载失败: " + (e && e.message ? e.message : String(e));
      });
      throw e;
    }

    const { payload, bars, urlUsed, meta } = pack;
    if (!bars.length) throw new Error("bars empty after normalization");

    // main series
    const closes = bars.map(b => b.close);
    const emaVals = ema(closes, EMA_PERIOD);
    const auxVals = computeAuxByYourAlgo(closes, AUX_PERIOD, AUX_METHOD);

    const coloredBars = colorCandlesByEmaTrend(bars, emaVals);
    candleSeries.setData(coloredBars);

    const emaPts = buildLinePoints(bars, emaVals);
    const auxPts = buildLinePoints(bars, auxVals);
    emaSeries.setData(emaPts);
    auxSeries.setData(auxPts);
    emaSeries.applyOptions({ visible: !!showEMA });
    auxSeries.applyOptions({ visible: !!showAUX });

    // signals: prefer payload, then optional endpoint, then fallback compute
    let sigs = normalizeSignals(payload);
    if (!sigs.length) sigs = await fetchOptionalSignals(sym, tf);
    if (!sigs.length) sigs = computeSignalsCrossStable(bars, emaPts, auxPts, CONFIRM_WINDOW);

    applyMarkers(sigs);

    safeRun("fitContent", () => chart.timeScale().fitContent());

    // top text
    safeRun("topText", () => {
      const last = bars[bars.length - 1];
      if ($("symText")) $("symText").textContent = sym;
      if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);
      if ($("hintText")) $("hintText").textContent = `Loaded TF=${tf} bars=${bars.length} sigs=${sigs.length}`;
    });

    // snapshot output (consumer only)
    const N = Math.min(200, bars.length);
    const start = bars.length - N;
    const modeLabel = getDataModeLabel(meta);

    const snapshot = {
      version: "2026.01.22-FIX-DATASOURCE-SIGNALS",
      ts: Date.now(),
      apiBase: DEFAULT_API_BASE,
      urlUsed,
      symbol: sym,
      tf,
      dataSource: getEffectiveDataSource().source,
      dataSourceReason: getEffectiveDataSource().reason,
      dataMode: modeLabel, // {en, cn}
      delayedMinutes: meta && meta.delayedMinutes != null ? meta.delayedMinutes : null,
      params: { EMA_PERIOD, AUX_PERIOD, AUX_METHOD, CONFIRM_WINDOW },
      barsCount: bars.length,
      bars: bars.slice(start),
      ema: emaVals.slice(start),
      aux: auxVals.slice(start),
      sigs: sigs.slice(Math.max(0, sigs.length - 200)),
      lastClose: bars[bars.length - 1].close,
    };

    window.__DARRIUS_CHART_STATE__ = snapshot;
    safeRun("emit", () => {
      window.dispatchEvent(new CustomEvent("darrius:chartUpdated", { detail: snapshot }));
    });

    // Optional: update any badge element if present
    safeRun("badge", () => {
      const el = $("dataModeBadge");
      if (!el) return;
      // show bilingual
      el.textContent = `${modeLabel.en} / ${modeLabel.cn}`;
      // dim when forced demo
      el.style.opacity = (snapshot.dataSource === "demo" && snapshot.dataSourceReason === "no-subscription") ? "0.8" : "1";
    });

    // Optional: enforce UI disable market when no subscription (UX only)
    safeRun("lockMarket", () => {
      const sel = $("dataSourceSelect");
      if (!sel) return;
      const active = isSubscriptionActive();
      // If not active and user chose market, we keep selection visible but effective will be demo.
      // You may also disable the market option to reduce confusion.
      for (const opt of Array.from(sel.options || [])) {
        if (String(opt.value).toLowerCase() === "market") {
          opt.disabled = !active;
        }
      }
    });
  }

  // -----------------------------
  // Public entry
  // -----------------------------
  function boot() {
    safeRun("init", () => init({ containerId: "chart" }));
    // initial load
    load().catch(() => {});
  }

  // Auto boot
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // expose minimal controls
  window.DarriusChart = {
    reload: () => load(),
    setDataSource: (v) => { setSelectedDataSource(v); load().catch(() => {}); },
    getDataSource: () => getEffectiveDataSource(),
  };
})();
