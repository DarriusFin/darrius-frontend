/* =========================================================================
 * DarriusAI - chart.core.js (FINAL / DROP-IN) v2026.02.02-FINAL-FULL-FIX-R3
 *
 * Role:
 *  - Render main chart (candles + EMA [+ optional AUX if backend provides series])
 *  - Fetch OHLCV via backend proxy:   /api/data/stocks/aggregates
 *  - Fetch signals via backend ONLY:  /api/market/sigs   (NO local signal logic)
 *  - Output stable snapshot: window.__DARRIUS_CHART_STATE__  (never NaN/undefined)
 *  - Provide read-only bridge for UI overlay (market.pulse.js):
 *      DarriusChart.timeToX / DarriusChart.priceToY / DarriusChart.getSnapshot()
 *  - Emit event "darrius:chartUpdated" with snapshot detail
 *
 * HARD FIXES INCLUDED:
 *  A) Always call backend with absolute API_BASE (prevents GitHub Pages /api 404)
 *  B) Auto-fill from/to (YYYY-MM-DD) if missing (backend requires it)
 *  C) Snapshot schema v2 is stable; no NaN leaks; safe zones everywhere
 * ========================================================================= */

(() => {
  'use strict';

  // ---- PROVE LOADED (debug) ----
  try {
    console.log('[CHART CORE LOADED]', 'v2026.02.02-R3', Date.now());
    window.__CHART_CORE_LOADED__ = 'v2026.02.02-R3';
  } catch (_) {}

  // -----------------------------
  // No-throw safe zone
  // -----------------------------
  function safe(fn, _tag = 'chart.core') {
    try { return fn(); } catch (e) { return null; }
  }

  // -----------------------------
  // Helpers: NaN lock & contract
  // -----------------------------
  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  function num(v, fb = 0) {
    const x = (typeof v === 'string' && v.trim() !== '') ? Number(v) : v;
    return isNum(x) ? x : fb;
  }
  function nnull(v) { const x = num(v, NaN); return Number.isFinite(x) ? x : null; }
  function str(v, fb = '') { return (typeof v === 'string' && v.length) ? v : fb; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function clamp01(x) { x = num(x, 0); return x < 0 ? 0 : x > 1 ? 1 : x; }
  function nowIso() { return new Date().toISOString(); }
  function fmtDateYYYYMMDD(d) { return d.toISOString().slice(0, 10); }

  // -----------------------------
  // API base (ABSOLUTE)  ✅ FIX A
  // -----------------------------
  function apiBase() {
    // priority: __API_BASE__ > API_BASE > hard default
    const b = (window.__API_BASE__ || window.API_BASE || 'https://darrius-api.onrender.com');
    return String(b).replace(/\/+$/, '');
  }
  function apiUrl(path) {
    const p = String(path || '');
    if (/^https?:\/\//i.test(p)) return p;
    if (!p.startsWith('/')) return apiBase() + '/' + p;
    return apiBase() + p;
  }

  // -----------------------------
  // Stable Snapshot Contract (NEVER NaN/undefined)
  // -----------------------------
  function makeSnapshotBase() {
    return {
      schema: 'darrius.snapshot.v2',
      ts: nowIso(),
      meta: {
        symbol: 'TSLA',
        timeframe: '1D',
        timespan: 'day',
        multiplier: 1,
        bars: 480,
        from: null,
        to: null,
        source: 'unknown', // 'live'|'delayed'|'demo'|'unknown'
        ready: false,
        loaded: false,
        error: null,
        notes: []
      },
      price: {
        last: null,
        lastTime: null,
        emaFast: null,
        emaSlow: null,
        trend: 'flat',
        bias: 'stable'
      },
      signals: {
        bullish: 0,
        bearish: 0,
        neutral: 0,
        net: 0,
        lastSig: null, // { t, side, label } | null
        raw: null
      },
      risk: {
        entry: null,
        stop: null,
        targets: [],
        confidence: null
      },
      backtest: {
        winRate: null,
        sampleSize: null
      },
      series: {
        candlesCount: 0,
        emaCount: 0,
        auxCount: 0
      },
      map: {
        xMin: 0, xMax: 1,
        yMin: 0, yMax: 1,
        tMin: null, tMax: null,
        pMin: null, pMax: null
      }
    };
  }

  function snapshotCommit(snap) {
    // hard guarantee: always an object
    if (!snap || typeof snap !== 'object') snap = makeSnapshotBase();
    window.__DARRIUS_CHART_STATE__ = snap;
    safe(() => {
      window.dispatchEvent(new CustomEvent('darrius:chartUpdated', { detail: snap }));
    }, 'chartUpdated');
  }

  // -----------------------------
  // Config (minimal, do NOT touch billing/subscription)
  // -----------------------------
  const CFG = {
    aggregatesPath: '/api/data/stocks/aggregates',
    sigsPath: '/api/market/sigs',

    refreshMs: 15000,
    sigsRefreshMs: 15000,
    cacheBust: false,

    emaFastPeriod: 20,
    emaSlowPeriod: 50,

    containerSelectors: [
      '#chart',
      '#chartWrap #chart',
      '#chartContainer',
      '#mainChart',
      '#tvchart',
      '#chart-root',
      '.chart-container'
    ]
  };

  // -----------------------------
  // DOM container
  // -----------------------------
  function findContainer() {
    for (const sel of CFG.containerSelectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // -----------------------------
  // Normalize aggregates
  // backend format: { results: [{ t, o,h,l,c,v }, ...] }
  // -----------------------------
  function normalizeAggregates(payload) {
    const results = arr(payload && payload.results);
    const out = [];
    for (const r of results) {
      const t = num(r.t, 0);
      const o = nnull(r.o);
      const h = nnull(r.h);
      const l = nnull(r.l);
      const c = nnull(r.c);
      const v = nnull(r.v) ?? 0;
      if (!t || o === null || h === null || l === null || c === null) continue;
      out.push({ t, o, h, l, c, v: num(v, 0) });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  // -----------------------------
  // EMA (internal; does NOT produce signals)
  // -----------------------------
  function calcEMA(values, period) {
    const p = Math.max(1, Math.floor(num(period, 1)));
    const k = 2 / (p + 1);
    let ema = null;
    const out = new Array(values.length).fill(null);
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!isNum(v)) { out[i] = null; continue; }
      if (ema === null) ema = v;
      else ema = (v - ema) * k + ema;
      out[i] = ema;
    }
    return out;
  }

  function detectTrend(emaFastLast, emaSlowLast) {
    const f = nnull(emaFastLast);
    const s = nnull(emaSlowLast);
    if (f === null || s === null) return { trend: 'flat', bias: 'stable' };
    if (f > s) return { trend: 'up', bias: 'bullish' };
    if (f < s) return { trend: 'down', bias: 'bearish' };
    return { trend: 'flat', bias: 'stable' };
  }

  // -----------------------------
  // Signals normalize (backend-only)
  // Accept flexible shapes, convert to stable contract.
  // -----------------------------
  function normalizeSigs(payload) {
    const p = payload || {};
    const stats = p.stats || p.signal_stats || p.signals || p;

    const bullish = num(stats && stats.bullish, 0);
    const bearish = num(stats && stats.bearish, 0);
    const neutral = num(stats && stats.neutral, 0);

    const last = p.lastSig || p.last || p.last_signal || null;
    let lastSig = null;
    if (last && typeof last === 'object') {
      const t = num(last.t || last.time || last.ts || 0, 0);
      if (t > 0) {
        const side = str(last.side || last.type || last.dir || '', '') || null;
        const label = str(last.label || last.name || '', '') || null;
        lastSig = { t, side, label };
      }
    }

    const risk = p.risk || p.copilot || {};
    const entry = nnull(risk.entry);
    const stop = nnull(risk.stop);
    const confidence = nnull(risk.confidence);

    const rawTargets = arr(risk.targets || risk.target || []);
    const targets = [];
    for (const x of rawTargets) {
      if (isNum(x)) targets.push(x);
      else if (x && isNum(x.price)) targets.push(x.price);
    }

    const bt = p.backtest || p.bt || {};
    const winRate = (bt.winRate == null) ? null : nnull(bt.winRate);
    const sampleSize = (bt.sampleSize == null) ? null : nnull(bt.sampleSize);

    const rawMini = safe(() => ({
      bullish, bearish, neutral,
      lastSig,
      risk: { entry, stop, targets: targets.slice(0, 6), confidence },
      backtest: { winRate, sampleSize }
    })) || null;

    return {
      bullish, bearish, neutral,
      net: bullish - bearish,
      lastSig,
      risk: { entry, stop, targets, confidence },
      backtest: { winRate, sampleSize },
      raw: rawMini
    };
  }

  // -----------------------------
  // HTTP json (absolute; no throw outside)
  // -----------------------------
  async function httpJson(absUrl, params) {
    const u = new URL(absUrl);
    if (params && typeof params === 'object') {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '') continue;
        u.searchParams.set(k, String(v));
      }
    }
    if (CFG.cacheBust) u.searchParams.set('_', String(Date.now()));

    const res = await fetch(u.toString(), {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      // keep error short but useful
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 180)}`);
    }
    return await res.json();
  }

  // -----------------------------
  // Runtime params
  //  - respects window.__DARRIUS_RUNTIME__ and URL query
  //  - auto-fills from/to ✅ FIX B
  // -----------------------------
  function readRuntimeParams(SNAP) {
    const g = window.__DARRIUS_RUNTIME__ || {};
    const q = new URLSearchParams(window.location.search);

    const symbol = str(g.symbol, '') || str(q.get('symbol'), '') || (SNAP && SNAP.meta.symbol) || 'TSLA';
    const timeframe = str(g.timeframe, '') || str(q.get('tf'), '') || (SNAP && SNAP.meta.timeframe) || '1D';

    const timespan = str(g.timespan, '') || str(q.get('timespan'), '') || (SNAP && SNAP.meta.timespan) || 'day';
    const multiplier = num(g.multiplier ?? q.get('multiplier'), (SNAP && SNAP.meta.multiplier) || 1);
    const bars = num(g.bars ?? q.get('bars'), (SNAP && SNAP.meta.bars) || 480);

    const source = str(g.source, '') || str(q.get('source'), '') || (SNAP && SNAP.meta.source) || 'unknown';

    let from = g.from ?? q.get('from');
    let to   = g.to   ?? q.get('to');

    if (!from || !to) {
      // cover enough window for bars; conservative, stable
      const m = Math.max(1, Math.floor(multiplier));
      const b = Math.max(50, Math.floor(bars));

      // if day-based chart: bars ~ days; else still use days as backend expects date window
      const days = Math.max(10, Math.min(3650, Math.ceil((b / m) + 10)));
      const dTo = new Date();
      const dFrom = new Date(dTo.getTime() - days * 86400000);

      from = from || fmtDateYYYYMMDD(dFrom);
      to   = to   || fmtDateYYYYMMDD(dTo);
    }

    return {
      symbol,
      timeframe,
      timespan,
      multiplier: Math.max(1, Math.floor(multiplier)),
      bars: Math.max(50, Math.floor(bars)),
      source,
      from: from ? String(from) : null,
      to: to ? String(to) : null
    };
  }

  // -----------------------------
  // Rendering: LightweightCharts (preferred)
  // -----------------------------
  let lwChart = null;
  let lwSeries = null;
  let lwInited = false;

  function initLightweight(container) {
    const LW = window.LightweightCharts;
    if (!LW || !LW.createChart) return false;

    // do NOT nuke the whole container if it contains overlay nodes;
    // only clear if it's a pure chart div.
    safe(() => { container.innerHTML = ''; });

    lwChart = LW.createChart(container, {
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#9fb3c8' },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)' },
      crosshair: { mode: 1 }
    });

    lwSeries = {
      candles: lwChart.addCandlestickSeries({
        upColor: '#2BE2A6',
        downColor: '#FF5B6E',
        wickUpColor: '#2BE2A6',
        wickDownColor: '#FF5B6E',
        borderVisible: false
      }),
      emaFast: lwChart.addLineSeries({ lineWidth: 2, color: '#F5B700' }),
      emaSlow: lwChart.addLineSeries({ lineWidth: 2, color: '#4CC2FF' })
    };

    lwInited = true;
    return true;
  }

  function renderWithLightweight(DATA, EMA_FAST, EMA_SLOW) {
    if (!lwInited || !lwChart || !lwSeries) return false;

    const candles = DATA.map(d => ({
      time: Math.floor(d.t / 1000),
      open: d.o, high: d.h, low: d.l, close: d.c
    }));

    const ef = [];
    const es = [];
    for (let i = 0; i < DATA.length; i++) {
      const t = Math.floor(DATA[i].t / 1000);
      const f = EMA_FAST[i];
      const s = EMA_SLOW[i];
      if (isNum(f)) ef.push({ time: t, value: f });
      if (isNum(s)) es.push({ time: t, value: s });
    }

    safe(() => lwSeries.candles.setData(candles), 'lw.candles');
    safe(() => lwSeries.emaFast.setData(ef), 'lw.emaFast');
    safe(() => lwSeries.emaSlow.setData(es), 'lw.emaSlow');

    safe(() => {
      // keep visible window sensible
      lwChart.timeScale().fitContent();
    }, 'lw.fit');

    return true;
  }

  function resizeLightweight() {
    if (!lwInited || !lwChart) return;
    const container = findContainer();
    if (!container) return;
    const r = container.getBoundingClientRect();
    const w = Math.max(100, Math.floor(r.width));
    const h = Math.max(100, Math.floor(r.height));
    safe(() => lwChart.applyOptions({ width: w, height: h }), 'lw.resize');
  }

  // -----------------------------
  // Mapping (for overlay)
  // -----------------------------
  function computeBounds(DATA) {
    let pMin = Infinity, pMax = -Infinity;
    for (const d of DATA) {
      pMin = Math.min(pMin, d.l);
      pMax = Math.max(pMax, d.h);
    }
    if (!Number.isFinite(pMin) || !Number.isFinite(pMax) || pMax <= pMin) {
      pMin = 0; pMax = 1;
    }
    const tMin = DATA.length ? DATA[0].t : null;
    const tMax = DATA.length ? DATA[DATA.length - 1].t : null;
    return { pMin, pMax, tMin, tMax };
  }

  // Bridge functions use snapshot bounds (work even if chart impl changes)
  function timeToX(msEpoch) {
    const snap = window.__DARRIUS_CHART_STATE__ || SNAP;
    const t = num(msEpoch, 0);
    const tMin = snap.map.tMin;
    const tMax = snap.map.tMax;
    if (!tMin || !tMax || tMax <= tMin) return snap.map.xMin;
    const r = clamp01((t - tMin) / (tMax - tMin));
    return snap.map.xMin + (snap.map.xMax - snap.map.xMin) * r;
  }

  function priceToY(price) {
    const snap = window.__DARRIUS_CHART_STATE__ || SNAP;
    const p = nnull(price);
    const pMin = snap.map.pMin;
    const pMax = snap.map.pMax;
    if (p === null || pMin === null || pMax === null || pMax <= pMin) return (snap.map.yMin + snap.map.yMax) / 2;
    const r = clamp01((p - pMin) / (pMax - pMin));
    // y increases downward
    return snap.map.yMin + (snap.map.yMax - snap.map.yMin) * (1 - r);
  }

  function getSnapshot() {
    return window.__DARRIUS_CHART_STATE__ || SNAP;
  }

  window.DarriusChart = window.DarriusChart || {};
  window.DarriusChart.timeToX = timeToX;
  window.DarriusChart.priceToY = priceToY;
  window.DarriusChart.getSnapshot = getSnapshot;

  // -----------------------------
  // State
  // -----------------------------
  let SNAP = makeSnapshotBase();
  let DATA = [];
  let EMA_FAST = [];
  let EMA_SLOW = [];

  // -----------------------------
  // Main loop: fetch aggregates -> render -> fetch sigs -> commit snapshot
  // -----------------------------
  async function fetchAndRender() {
    const p = readRuntimeParams(SNAP);

    // meta early
    SNAP.ts = nowIso();
    SNAP.meta.symbol = p.symbol;
    SNAP.meta.timeframe = p.timeframe;
    SNAP.meta.timespan = p.timespan;
    SNAP.meta.multiplier = p.multiplier;
    SNAP.meta.bars = p.bars;
    SNAP.meta.from = p.from;
    SNAP.meta.to = p.to;
    SNAP.meta.source = p.source || 'unknown';
    SNAP.meta.error = null;
    SNAP.meta.ready = false;
    SNAP.meta.loaded = false;

    snapshotCommit(SNAP);

    // ---- aggregates (ABSOLUTE + from/to) ----
    let aggPayload;
    try {
      aggPayload = await httpJson(apiUrl(CFG.aggregatesPath), {
        symbol: p.symbol,
        multiplier: p.multiplier,
        timespan: p.timespan,
        bars: p.bars,
        from: p.from,
        to: p.to
      });
    } catch (e) {
      SNAP.meta.error = `aggregates: ${str(e && e.message, 'failed')}`;
      SNAP.meta.loaded = false;
      SNAP.meta.ready = false;
      snapshotCommit(SNAP);
      return;
    }

    DATA = normalizeAggregates(aggPayload);
    SNAP.series.candlesCount = DATA.length;

    if (!DATA.length) {
      SNAP.meta.error = 'aggregates: empty';
      SNAP.meta.loaded = false;
      SNAP.meta.ready = false;
      snapshotCommit(SNAP);
      return;
    }

    // compute EMA
    const closes = DATA.map(d => d.c);
    EMA_FAST = calcEMA(closes, CFG.emaFastPeriod);
    EMA_SLOW = calcEMA(closes, CFG.emaSlowPeriod);
    SNAP.series.emaCount = DATA.length;

    // last price
    const last = DATA[DATA.length - 1];
    SNAP.price.last = nnull(last && last.c);
    SNAP.price.lastTime = nnull(last && last.t);

    // ema last
    SNAP.price.emaFast = nnull(EMA_FAST[EMA_FAST.length - 1]);
    SNAP.price.emaSlow = nnull(EMA_SLOW[EMA_SLOW.length - 1]);

    // trend/bias
    const tb = detectTrend(SNAP.price.emaFast, SNAP.price.emaSlow);
    SNAP.price.trend = tb.trend;
    SNAP.price.bias = tb.bias;

    // bounds -> snapshot map
    const b = computeBounds(DATA);
    SNAP.map.tMin = b.tMin;
    SNAP.map.tMax = b.tMax;
    SNAP.map.pMin = b.pMin;
    SNAP.map.pMax = b.pMax;

    // map x/y bounds: use container rect (so overlay mapping is stable)
    safe(() => {
      const c = findContainer();
      if (!c) return;
      const r = c.getBoundingClientRect();
      SNAP.map.xMin = 0;
      SNAP.map.xMax = Math.max(1, Math.floor(r.width));
      SNAP.map.yMin = 0;
      SNAP.map.yMax = Math.max(1, Math.floor(r.height));
    });

    // render (prefer LW)
    safe(() => {
      const container = findContainer();
      if (!container) return;

      if (!lwInited) {
        const ok = initLightweight(container);
        if (ok) resizeLightweight();
      }
      if (lwInited) {
        renderWithLightweight(DATA, EMA_FAST, EMA_SLOW);
      }
    }, 'render');

    SNAP.meta.loaded = true;

    // commit after chart render (so UI sees latest price/ema even if sigs fails)
    snapshotCommit(SNAP);

    // ---- signals (backend-only; do not block chart) ----
    safe(async () => {
      let sigPayload;
      try {
        sigPayload = await httpJson(apiUrl(CFG.sigsPath), {
          symbol: p.symbol,
          timeframe: p.timeframe,
          bars: p.bars
        });
      } catch (e) {
        SNAP.meta.notes = arr(SNAP.meta.notes).slice(-6);
        SNAP.meta.notes.push(`sigs: ${str(e && e.message, 'failed')}`);
        // keep existing stable defaults
        SNAP.meta.ready = true; // chart is ready even if sigs fails
        snapshotCommit(SNAP);
        return;
      }

      const s = normalizeSigs(sigPayload);

      SNAP.signals.bullish = num(s.bullish, 0);
      SNAP.signals.bearish = num(s.bearish, 0);
      SNAP.signals.neutral = num(s.neutral, 0);
      SNAP.signals.net = num(s.net, 0);
      SNAP.signals.lastSig = s.lastSig || null;
      SNAP.signals.raw = s.raw || null;

      SNAP.risk.entry = s.risk ? s.risk.entry : null;
      SNAP.risk.stop = s.risk ? s.risk.stop : null;
      SNAP.risk.targets = arr(s.risk && s.risk.targets).slice(0, 6).map(x => nnull(x)).filter(x => x !== null);
      SNAP.risk.confidence = s.risk ? s.risk.confidence : null;

      SNAP.backtest.winRate = (s.backtest ? s.backtest.winRate : null);
      SNAP.backtest.sampleSize = (s.backtest ? s.backtest.sampleSize : null);

      SNAP.meta.ready = true;
      snapshotCommit(SNAP);
    }, 'sigs');
  }

  // -----------------------------
  // Polling / lifecycle
  // -----------------------------
  let timer = null;

  function start() {
    // init snapshot immediately
    SNAP = makeSnapshotBase();
    snapshotCommit(SNAP);

    // first render
    safe(() => fetchAndRender(), 'start.fetch');

    // polling
    if (timer) clearInterval(timer);
    timer = setInterval(() => safe(() => fetchAndRender(), 'poll.fetch'), Math.max(3000, CFG.refreshMs));

    // resize (LW)
    safe(() => {
      window.addEventListener('resize', () => safe(() => resizeLightweight(), 'resize'));
    });

    // allow others to force refresh
    safe(() => {
      window.addEventListener('darrius:forceRefresh', () => safe(() => fetchAndRender(), 'forceRefresh'));
    });
  }

  // -----------------------------
  // Boot
  // -----------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
