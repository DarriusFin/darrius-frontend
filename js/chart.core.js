/* =========================================================================
 * DarriusAI - chart.core.js (FINAL STABLE MAIN CHART)
 * v2026.02.02-FIX-FROMTO-RANGE-R1
 *
 * Fixes:
 *  - ALWAYS send from/to (YYYY-MM-DD) to /api/data/stocks/aggregates
 *    => prevents 400 "from/to required" and the downstream "Loading..." freeze
 *  - Works with API_BASE (darrius-api.onrender.com) OR relative /api on same origin
 *
 * Safety:
 *  - UI-only chart renderer; never touches billing/subscription/payment logic
 *  - No-throw safe zones
 *  - Stable snapshot schema (no undefined / NaN leaks)
 * ========================================================================= */

(() => {
  'use strict';

  // -----------------------------
  // No-throw safe zone
  // -----------------------------
  function safe(fn) { try { return fn(); } catch (_) { return null; } }

  // -----------------------------
  // Helpers: NaN lock & contract
  // -----------------------------
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const num = (v, fb = 0) => (isNum(v) ? v : fb);
  const nnull = (v) => (isNum(v) ? v : null);
  const str = (v, fb = '') => (typeof v === 'string' && v.length ? v : fb);
  const arr = (v) => (Array.isArray(v) ? v : []);

  const clamp01 = (x) => {
    x = num(x, 0);
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  };

  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtYMD = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  function nowIso() { return new Date().toISOString(); }

  // -----------------------------
  // Snapshot (stable)
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

        source: 'unknown',  // live|delayed|demo|unknown
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
        lastSig: null,
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
        tMin: null, tMax: null
      }
    };
  }

  function snapshotCommit(snap) {
    window.__DARRIUS_CHART_STATE__ = snap;
    safe(() => window.dispatchEvent(new CustomEvent('darrius:chartUpdated', { detail: snap })));
  }

  // -----------------------------
  // Config
  // -----------------------------
  const CFG = {
    aggregatesPath: '/api/data/stocks/aggregates',
    sigsPath: '/api/market/sigs',

    refreshMs: 15000,

    emaFastPeriod: 20,
    emaSlowPeriod: 50
  };

  // IMPORTANT: support API_BASE (your site uses https://darrius-api.onrender.com)
  function getApiBase() {
    // common variants in your project
    const b =
      window.__API_BASE__ ||
      window.API_BASE ||
      (window.__DARRIUS_GLOBALS__ && window.__DARRIUS_GLOBALS__.API_BASE) ||
      '';
    return str(b, '').trim();
  }

  function buildUrl(pathOrUrl) {
    const apiBase = getApiBase();
    // absolute already
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    // if apiBase provided, use it
    if (/^https?:\/\//i.test(apiBase)) {
      return apiBase.replace(/\/+$/, '') + pathOrUrl;
    }
    // fallback same-origin
    return new URL(pathOrUrl, window.location.origin).toString();
  }

  async function httpJson(pathOrUrl, params) {
    const url = new URL(buildUrl(pathOrUrl));
    if (params && typeof params === 'object') {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '') continue;
        url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString(), {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
    return text ? JSON.parse(text) : {};
  }

  // -----------------------------
  // Runtime params (from UI globals / URL)
  // -----------------------------
  function readRuntimeParams(snap) {
    const g = window.__DARRIUS_RUNTIME__ || {};
    const q = new URLSearchParams(window.location.search);

    const symbol = str(g.symbol, '') || str(q.get('symbol'), '') || snap.meta.symbol;
    const timeframe = str(g.timeframe, '') || str(q.get('tf'), '') || snap.meta.timeframe;

    // chart core uses aggregates timespan/multiplier
    const timespan = str(g.timespan, '') || str(q.get('timespan'), '') || snap.meta.timespan;
    const multiplier = Math.max(1, Math.floor(num(g.multiplier ?? q.get('multiplier'), snap.meta.multiplier)));
    const bars = Math.max(10, Math.floor(num(g.bars ?? q.get('bars'), snap.meta.bars)));

    // source hint
    const source = str(g.source, '') || str(q.get('source'), '') || snap.meta.source;

    // user may pass from/to; we will still auto-fix if missing/invalid
    const from = g.from ?? q.get('from');
    const to = g.to ?? q.get('to');

    return {
      symbol,
      timeframe,
      timespan,
      multiplier,
      bars,
      source,
      from: from ? String(from) : null,
      to: to ? String(to) : null
    };
  }

  // -----------------------------
  // Auto range (THE KEY FIX)
  // Always produce from/to in YYYY-MM-DD
  // -----------------------------
  function ensureFromTo(p) {
    // accept valid YYYY-MM-DD
    const isYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

    let to = isYMD(p.to) ? p.to : null;
    let from = isYMD(p.from) ? p.from : null;

    // choose "to" as today (UTC-ish local date is fine for backend)
    if (!to) to = fmtYMD(new Date());

    // compute from based on bars & timeframe
    if (!from) {
      const bars = Math.max(10, Math.floor(num(p.bars, 480)));
      const mult = Math.max(1, Math.floor(num(p.multiplier, 1)));
      const span = str(p.timespan, 'day').toLowerCase();

      // rough horizon in days (+ buffer) so backend always happy
      let days = 30;

      if (span === 'day') {
        days = Math.ceil(bars * mult * 1.4); // buffer
      } else if (span === 'week') {
        days = Math.ceil(bars * mult * 7 * 1.2);
      } else if (span === 'month') {
        days = Math.ceil(bars * mult * 30 * 1.1);
      } else if (span === 'hour') {
        days = Math.ceil((bars * mult) / 24 * 1.6);
      } else if (span === 'minute') {
        days = Math.ceil((bars * mult) / (24 * 60) * 2.2);
      } else {
        days = 180; // safe fallback
      }

      // clamp sane limits
      if (!Number.isFinite(days) || days < 7) days = 30;
      if (days > 900) days = 900;

      const dTo = new Date(to + 'T00:00:00');
      const dFrom = new Date(dTo.getTime() - days * 86400000);
      from = fmtYMD(dFrom);
    }

    return { from, to };
  }

  // -----------------------------
  // Data normalize
  // -----------------------------
  function normalizeAggregates(payload) {
    const results = arr(payload && payload.results);
    const out = [];
    for (const r of results) {
      const t = num(r.t, 0);
      const o = r.o, h = r.h, l = r.l, c = r.c;
      const v = num(r.v, 0);
      if (!t) continue;
      if (!isNum(o) || !isNum(h) || !isNum(l) || !isNum(c)) continue;
      out.push({ t, o, h, l, c, v });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  // EMA (internal only)
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

  function detectTrend(emaFast, emaSlow) {
    const f = nnull(emaFast);
    const s = nnull(emaSlow);
    if (f === null || s === null) return { trend: 'flat', bias: 'stable' };
    if (f > s) return { trend: 'up', bias: 'bullish' };
    if (f < s) return { trend: 'down', bias: 'bearish' };
    return { trend: 'flat', bias: 'stable' };
  }

  // signals normalize (backend-only)
  function normalizeSigs(payload) {
    const p = payload || {};
    const stats = p.stats || p.signal_stats || p.signals || p;

    const bullish = num(stats && stats.bullish, 0);
    const bearish = num(stats && stats.bearish, 0);
    const neutral = num(stats && stats.neutral, 0);

    const last = p.lastSig || p.last || null;
    let lastSig = null;
    if (last && (last.t || last.time || last.ts)) {
      const t = num(last.t || last.time || last.ts, 0);
      const side = str(last.side || last.type || last.dir || '', '');
      const label = str(last.label || last.name || '', '');
      if (t > 0) lastSig = { t, side: side || null, label: label || null };
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
    const winRate = bt.winRate == null ? null : nnull(bt.winRate);
    const sampleSize = bt.sampleSize == null ? null : nnull(bt.sampleSize);

    return {
      bullish, bearish, neutral,
      net: bullish - bearish,
      lastSig,
      risk: { entry, stop, targets, confidence },
      backtest: { winRate, sampleSize },
      raw: {
        bullish, bearish, neutral,
        lastSig,
        risk: { entry, stop, targets: targets.slice(0, 5), confidence },
        backtest: { winRate, sampleSize }
      }
    };
  }

  // -----------------------------
  // Chart rendering: LightweightCharts if present
  // (without nuking container)
  // -----------------------------
  const containerSelectors = [
    '#chart', '#chartContainer', '#mainChart', '#tvchart',
    '#chart-root', '.chart-container', 'main'
  ];

  function findContainer() {
    for (const sel of containerSelectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return document.body;
  }

  function ensureLwRoot(container) {
    let root = container.querySelector('.darrius-lw-root');
    if (!root) {
      root = document.createElement('div');
      root.className = 'darrius-lw-root';
      root.style.width = '100%';
      root.style.height = '100%';
      root.style.position = 'relative';
      root.style.zIndex = '0';
      container.appendChild(root);
    }
    return root;
  }

  let lc = null;
  let lcSeries = null;

  function initLightweight(container) {
    const LW = window.LightweightCharts;
    if (!LW || !LW.createChart) return false;

    const root = ensureLwRoot(container);
    // if already init, keep
    if (lc && lcSeries) return true;

    lc = LW.createChart(root, {
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#9fb3c8' },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)' },
      crosshair: { mode: 1 }
    });

    lcSeries = {
      candles: lc.addCandlestickSeries({
        upColor: '#2BE2A6',
        downColor: '#FF5B6E',
        wickUpColor: '#2BE2A6',
        wickDownColor: '#FF5B6E',
        borderVisible: false
      }),
      emaFast: lc.addLineSeries({ lineWidth: 2, color: '#F5B700' }),
      emaSlow: lc.addLineSeries({ lineWidth: 2, color: '#4CC2FF' })
    };
    return true;
  }

  function renderWithLightweight(data, emaFast, emaSlow) {
    if (!lc || !lcSeries) return;

    const candles = data.map(d => ({
      time: Math.floor(d.t / 1000),
      open: d.o, high: d.h, low: d.l, close: d.c
    }));

    const ef = [];
    const es = [];
    for (let i = 0; i < data.length; i++) {
      const t = Math.floor(data[i].t / 1000);
      if (isNum(emaFast[i])) ef.push({ time: t, value: emaFast[i] });
      if (isNum(emaSlow[i])) es.push({ time: t, value: emaSlow[i] });
    }

    safe(() => lcSeries.candles.setData(candles));
    safe(() => lcSeries.emaFast.setData(ef));
    safe(() => lcSeries.emaSlow.setData(es));
  }

  // -----------------------------
  // Public bridge for overlay
  // -----------------------------
  let SNAP = makeSnapshotBase();
  let DATA = [];
  let EMA_FAST = [];
  let EMA_SLOW = [];

  function timeToX(msEpoch) {
    const t = num(msEpoch, 0);
    const tMin = SNAP.map.tMin;
    const tMax = SNAP.map.tMax;
    if (!tMin || !tMax || tMax <= tMin) return SNAP.map.xMin;
    const r = (t - tMin) / (tMax - tMin);
    return SNAP.map.xMin + (SNAP.map.xMax - SNAP.map.xMin) * clamp01(r);
  }

  function priceToY(_price) {
    // overlay can use its own mapping; keep stable fallback
    return (SNAP.map.yMin + SNAP.map.yMax) / 2;
  }

  function getSnapshot() { return window.__DARRIUS_CHART_STATE__ || SNAP; }

  window.DarriusChart = { timeToX, priceToY, getSnapshot };

  // -----------------------------
  // Core loop
  // -----------------------------
  let container = null;

  async function fetchAndRender() {
    const p0 = readRuntimeParams(SNAP);
    const { from, to } = ensureFromTo(p0);
    const p = { ...p0, from, to };

    // meta
    SNAP.ts = nowIso();
    SNAP.meta.symbol = p.symbol;
    SNAP.meta.timeframe = p.timeframe;
    SNAP.meta.timespan = p.timespan;
    SNAP.meta.multiplier = p.multiplier;
    SNAP.meta.bars = p.bars;
    SNAP.meta.from = p.from;
    SNAP.meta.to = p.to;
    SNAP.meta.source = p.source || SNAP.meta.source || 'unknown';
    SNAP.meta.error = null;
    SNAP.meta.ready = false;
    SNAP.meta.loaded = false;
    snapshotCommit(SNAP);

    // aggregates
    let aggPayload;
    try {
      aggPayload = await httpJson(CFG.aggregatesPath, {
        symbol: p.symbol,
        multiplier: p.multiplier,
        timespan: p.timespan,
        bars: p.bars,
        from: p.from,
        to: p.to
      });
    } catch (e) {
      SNAP.meta.error = `aggregates: ${str(e && e.message, 'failed')}`;
      snapshotCommit(SNAP);
      return;
    }

    DATA = normalizeAggregates(aggPayload);
    SNAP.series.candlesCount = DATA.length;

    if (!DATA.length) {
      SNAP.meta.error = 'aggregates: empty';
      snapshotCommit(SNAP);
      return;
    }

    // EMA
    const closes = DATA.map(d => d.c);
    EMA_FAST = calcEMA(closes, CFG.emaFastPeriod);
    EMA_SLOW = calcEMA(closes, CFG.emaSlowPeriod);
    SNAP.series.emaCount = DATA.length;

    // price
    const last = DATA[DATA.length - 1];
    SNAP.price.last = nnull(last && last.c);
    SNAP.price.lastTime = nnull(last && last.t);
    SNAP.price.emaFast = nnull(EMA_FAST[EMA_FAST.length - 1]);
    SNAP.price.emaSlow = nnull(EMA_SLOW[EMA_SLOW.length - 1]);

    const tb = detectTrend(SNAP.price.emaFast, SNAP.price.emaSlow);
    SNAP.price.trend = tb.trend;
    SNAP.price.bias = tb.bias;

    // mapping basics for overlay
    SNAP.map.tMin = DATA[0].t;
    SNAP.map.tMax = DATA[DATA.length - 1].t;

    // render
    safe(() => {
      if (!container) container = findContainer();
      // prefer LightweightCharts
      initLightweight(container);
      renderWithLightweight(DATA, EMA_FAST, EMA_SLOW);
      // keep stable numbers (no NaN)
      SNAP.map.xMin = 0; SNAP.map.xMax = 1;
      SNAP.map.yMin = 0; SNAP.map.yMax = 1;
    });

    SNAP.meta.loaded = true;

    // signals (non-blocking)
    safe(async () => {
      let sigPayload;
      try {
        sigPayload = await httpJson(CFG.sigsPath, {
          symbol: p.symbol,
          timeframe: p.timeframe,
          bars: p.bars
        });
      } catch (e) {
        const notes = arr(SNAP.meta.notes).slice(-6);
        notes.push(`sigs: ${str(e && e.message, 'failed')}`);
        SNAP.meta.notes = notes;
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
      SNAP.risk.targets = arr(s.risk && s.risk.targets).slice(0, 6).map(nnull).filter(x => x !== null);
      SNAP.risk.confidence = s.risk ? s.risk.confidence : null;

      SNAP.backtest.winRate = s.backtest ? s.backtest.winRate : null;
      SNAP.backtest.sampleSize = s.backtest ? s.backtest.sampleSize : null;

      SNAP.meta.ready = true;
      snapshotCommit(SNAP);
    });
  }

  // -----------------------------
  // Boot / Poll
  // -----------------------------
  let timer = null;

  function start() {
    SNAP = makeSnapshotBase();
    snapshotCommit(SNAP);

    safe(() => fetchAndRender());

    if (timer) clearInterval(timer);
    timer = setInterval(() => safe(() => fetchAndRender()), Math.max(3000, CFG.refreshMs));

    safe(() => window.addEventListener('darrius:forceRefresh', () => safe(() => fetchAndRender())));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

})();
