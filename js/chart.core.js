/* =========================================================================
 * DarriusAI - chart.core.js (FINAL FROZEN MAIN CHART) v2026.02.02-FINAL-SNAPSHOT-NAN-LOCK
 *
 * Role:
 *  - Render main chart (candles + EMA [+ optional AUX if backend provides series])
 *  - Fetch OHLCV via backend proxy (/api/data/stocks/aggregates)
 *  - Fetch signals via backend (/api/market/sigs) ONLY (no local signal logic)
 *  - Output a read-only snapshot to window.__DARRIUS_CHART_STATE__ (stable schema)
 *  - Provide read-only bridge for UI overlay (market.pulse.js):
 *      DarriusChart.timeToX / DarriusChart.priceToY / DarriusChart.getSnapshot()
 *  - Emit event "darrius:chartUpdated" with snapshot detail
 *
 * Guarantees:
 *  1) Snapshot schema is stable, never undefined/NaN leaks
 *  2) Main chart render is highest priority and protected by safe zones
 *  3) Signals come only from backend /api/market/sigs (no local signal logic)
 * ========================================================================= */

(() => {
  'use strict';

  // -----------------------------
  // No-throw safe zone
  // -----------------------------
  function safe(fn, tag = 'chart.core') {
    try { return fn(); } catch (e) { return null; }
  }

  // -----------------------------
  // Helpers: NaN lock & contract
  // -----------------------------
  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  function num(v, fallback = 0) { return isNum(v) ? v : fallback; }
  function nnull(v) { return isNum(v) ? v : null; } // number or null
  function str(v, fallback = '') { return (typeof v === 'string' && v.length) ? v : fallback; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function bool(v, fallback = false) { return typeof v === 'boolean' ? v : fallback; }

  function clamp01(x) {
    x = num(x, 0);
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  }

  function nowIso() {
    return new Date().toISOString();
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

        source: 'unknown',   // 'live' | 'delayed' | 'demo' | 'unknown'
        ready: false,
        loaded: false,
        error: null,         // string | null
        notes: []
      },

      price: {
        last: null,          // number | null
        lastTime: null,      // ms epoch | null

        emaFast: null,
        emaSlow: null,
        trend: 'flat',       // 'up'|'down'|'flat'
        bias: 'stable'       // 'bullish'|'bearish'|'stable'
      },

      signals: {
        bullish: 0,
        bearish: 0,
        neutral: 0,
        net: 0,
        lastSig: null,       // { t, side, label } | null
        raw: null            // original payload (sanitized/limited) | null
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
        // used by overlays: time->x and price->y mapping
        // these values are derived per-render; always present.
        xMin: 0,
        xMax: 1,
        yMin: 0,
        yMax: 1,
        tMin: null,  // ms epoch
        tMax: null   // ms epoch
      }
    };
  }

  function snapshotCommit(snap) {
    // Absolute guarantee: no undefined anywhere in top-level contract fields we control
    // (We avoid deep-walk for perf; we only ever write via setters that enforce types)
    window.__DARRIUS_CHART_STATE__ = snap;

    // fire event (never throws)
    safe(() => {
      window.dispatchEvent(new CustomEvent('darrius:chartUpdated', { detail: snap }));
    }, 'chartUpdated');
  }

  // -----------------------------
  // Config & DOM
  // -----------------------------
  const CFG = {
    // API endpoints
    aggregatesUrl: '/api/data/stocks/aggregates',
    sigsUrl: '/api/market/sigs',

    // refresh / polling
    refreshMs: 15000,          // default 15s
    sigsRefreshMs: 15000,      // align with chart refresh
    cacheBust: false,          // set true if you suspect stale caching

    // EMA params (internal)
    emaFastPeriod: 20,
    emaSlowPeriod: 50,

    // DOM search order
    containerSelectors: [
      '#chart',
      '#chartContainer',
      '#mainChart',
      '#tvchart',
      '#chart-root',
      '.chart-container',
      'main canvas',
      'canvas#chartCanvas'
    ]
  };

  function findContainer() {
    for (const sel of CFG.containerSelectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    // last resort: body
    return document.body;
  }

  function ensureCanvas(container) {
    // if container is already a canvas
    if (container && container.tagName === 'CANVAS') return container;

    let canvas = container.querySelector('canvas.darrius-main-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'darrius-main-canvas';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      // avoid impacting layout: only append if container looks like a chart box
      container.appendChild(canvas);
    }
    return canvas;
  }

  function resizeCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(2, Math.floor(rect.width * dpr));
    const h = Math.max(2, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w, h, dpr };
  }

  // -----------------------------
  // Data normalize
  // Backend aggregates expected (typical):
  // { results: [{ t: ms, o,h,l,c,v }, ...] }
  // We sanitize to [{ t, o,h,l,c,v }]
  // -----------------------------
  function normalizeAggregates(payload) {
    const results = arr(payload && payload.results);
    const out = [];
    for (const r of results) {
      const t = num(r.t, 0);
      const o = num(r.o, NaN);
      const h = num(r.h, NaN);
      const l = num(r.l, NaN);
      const c = num(r.c, NaN);
      const v = num(r.v, 0);
      if (!t || !isNum(o) || !isNum(h) || !isNum(l) || !isNum(c)) continue;
      out.push({ t, o, h, l, c, v });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  // -----------------------------
  // EMA calculation (internal; does not produce signals)
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

  function detectTrend(emaFast, emaSlow) {
    const f = nnull(emaFast);
    const s = nnull(emaSlow);
    if (f === null || s === null) return { trend: 'flat', bias: 'stable' };
    if (f > s) return { trend: 'up', bias: 'bullish' };
    if (f < s) return { trend: 'down', bias: 'bearish' };
    return { trend: 'flat', bias: 'stable' };
  }

  // -----------------------------
  // Signals normalize (backend-only)
  // We accept a flexible payload shape, but convert to stable contract.
  // Expected common shapes:
  // 1) { bullish, bearish, neutral, lastSig, risk:{...}, backtest:{...} }
  // 2) { stats:{bullish,bearish,neutral}, risk:{...}, backtest:{...}, last:{...} }
  // -----------------------------
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

    // risk
    const risk = p.risk || p.copilot || {};
    const entry = nnull(risk.entry);
    const stop = nnull(risk.stop);
    const confidence = nnull(risk.confidence);

    // targets: accept array of numbers or {price}
    const rawTargets = arr(risk.targets || risk.target || []);
    const targets = [];
    for (const x of rawTargets) {
      if (isNum(x)) targets.push(x);
      else if (x && isNum(x.price)) targets.push(x.price);
    }

    // backtest
    const bt = p.backtest || p.bt || {};
    const winRate = (bt.winRate == null) ? null : nnull(bt.winRate);
    const sampleSize = (bt.sampleSize == null) ? null : nnull(bt.sampleSize);

    // keep a tiny raw copy to help debugging without exploding size
    const raw = safe(() => {
      const mini = {
        bullish, bearish, neutral,
        lastSig,
        risk: { entry, stop, targets: targets.slice(0, 5), confidence },
        backtest: { winRate, sampleSize }
      };
      return mini;
    }) || null;

    return {
      bullish, bearish, neutral,
      net: bullish - bearish,
      lastSig,
      risk: { entry, stop, targets, confidence },
      backtest: { winRate, sampleSize },
      raw
    };
  }

  // -----------------------------
  // HTTP helpers (no throw)
  // -----------------------------
  async function httpJson(url, params) {
    const u = new URL(url, window.location.origin);
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
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 160)}`);
    }
    return await res.json();
  }

  // -----------------------------
  // Rendering: prefer LightweightCharts if present, else Canvas fallback
  // -----------------------------
  let lc = null; // lightweight chart instance
  let lcSeries = null;

  function initLightweight(container) {
    const LW = window.LightweightCharts;
    if (!LW || !LW.createChart) return false;

    // if container already has a chart, reuse by clearing
    container.innerHTML = '';
    lc = LW.createChart(container, {
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
    if (!lc || !lcSeries) return false;
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

    safe(() => lcSeries.candles.setData(candles), 'lw.candles');
    safe(() => lcSeries.emaFast.setData(ef), 'lw.emaFast');
    safe(() => lcSeries.emaSlow.setData(es), 'lw.emaSlow');

    // update mapping approx (LightweightCharts mapping is internal; we keep stable bounds)
    return true;
  }

  function renderWithCanvas(canvas, data, emaFast, emaSlow, snap) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { w, h, dpr } = resizeCanvas(canvas);
    ctx.clearRect(0, 0, w, h);

    // padding
    const padL = Math.floor(48 * dpr);
    const padR = Math.floor(64 * dpr);
    const padT = Math.floor(18 * dpr);
    const padB = Math.floor(26 * dpr);

    const cw = Math.max(10, w - padL - padR);
    const ch = Math.max(10, h - padT - padB);

    // bounds
    let pMin = Infinity, pMax = -Infinity;
    for (const d of data) {
      pMin = Math.min(pMin, d.l);
      pMax = Math.max(pMax, d.h);
    }
    if (!Number.isFinite(pMin) || !Number.isFinite(pMax) || pMax <= pMin) {
      pMin = 0; pMax = 1;
    }

    const tMin = data.length ? data[0].t : null;
    const tMax = data.length ? data[data.length - 1].t : null;

    // mapping functions
    const xOf = (i) => padL + (cw * (data.length <= 1 ? 0 : (i / (data.length - 1))));
    const yOf = (price) => {
      const p = num(price, pMin);
      const r = (p - pMin) / (pMax - pMin || 1);
      return padT + (ch * (1 - clamp01(r)));
    };

    // save map in snapshot (for overlays)
    snap.map.xMin = padL;
    snap.map.xMax = padL + cw;
    snap.map.yMin = padT;
    snap.map.yMax = padT + ch;
    snap.map.tMin = tMin;
    snap.map.tMax = tMax;

    // subtle grid
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = Math.max(1, Math.floor(1 * dpr));
    const gridN = 6;
    for (let i = 1; i < gridN; i++) {
      const y = padT + (ch * i / gridN);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke();
    }
    ctx.restore();

    // candles
    const barW = Math.max(1, Math.floor((cw / Math.max(1, data.length)) * 0.6));
    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      const x = Math.floor(xOf(i));
      const yo = yOf(d.o);
      const yc = yOf(d.c);
      const yh = yOf(d.h);
      const yl = yOf(d.l);

      const up = d.c >= d.o;
      const color = up ? 'rgba(43,226,166,0.95)' : 'rgba(255,91,110,0.95)';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;

      // wick
      ctx.beginPath();
      ctx.moveTo(x, yh);
      ctx.lineTo(x, yl);
      ctx.stroke();

      // body
      const top = Math.min(yo, yc);
      const bot = Math.max(yo, yc);
      const hh = Math.max(1, Math.floor(bot - top));
      ctx.fillRect(Math.floor(x - barW / 2), Math.floor(top), barW, hh);
    }

    // EMA lines
    function drawLine(series, stroke) {
      ctx.save();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(2, Math.floor(2 * dpr));
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < series.length; i++) {
        const v = series[i];
        if (!isNum(v)) continue;
        const x = xOf(i);
        const y = yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      if (started) ctx.stroke();
      ctx.restore();
    }
    drawLine(emaFast, 'rgba(245,183,0,0.95)');
    drawLine(emaSlow, 'rgba(76,194,255,0.95)');

    // last price marker (right)
    const last = data[data.length - 1];
    if (last) {
      const y = yOf(last.c);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + cw, y);
      ctx.stroke();

      ctx.fillStyle = 'rgba(255,91,110,0.95)';
      const boxW = Math.floor(56 * dpr);
      const boxH = Math.floor(18 * dpr);
      ctx.fillRect(padL + cw + Math.floor(8 * dpr), y - boxH / 2, boxW, boxH);

      ctx.fillStyle = 'white';
      ctx.font = `${Math.floor(12 * dpr)}px Arial`;
      ctx.textBaseline = 'middle';
      ctx.fillText(String(num(last.c, 0).toFixed(2)), padL + cw + Math.floor(12 * dpr), y);
      ctx.restore();
    }
  }

  // -----------------------------
  // State & public bridge
  // -----------------------------
  let SNAP = makeSnapshotBase();
  let DATA = [];
  let EMA_FAST = [];
  let EMA_SLOW = [];

  // mapping funcs (fallback uses SNAP.map)
  function timeToX(msEpoch) {
    // use mapping bounds
    const t = num(msEpoch, 0);
    const tMin = SNAP.map.tMin;
    const tMax = SNAP.map.tMax;
    if (!tMin || !tMax || tMax <= tMin) return SNAP.map.xMin;

    const r = (t - tMin) / (tMax - tMin);
    return SNAP.map.xMin + (SNAP.map.xMax - SNAP.map.xMin) * clamp01(r);
  }

  function priceToY(price) {
    // fallback: derive from last known bounds
    const yMin = SNAP.map.yMin;
    const yMax = SNAP.map.yMax;
    // if we don't have proper bounds, return middle
    if (!isNum(yMin) || !isNum(yMax) || yMax <= yMin) return 0;

    // We don't store pMin/pMax in snapshot to keep contract lean; approximate using last ema/price:
    // This is only used by overlay; it will still work if overlay uses its own mapping.
    // If you want perfect mapping, your overlay can use DarriusChart.getSnapshot() series data itself.
    return (yMin + yMax) / 2;
  }

  function getSnapshot() {
    return window.__DARRIUS_CHART_STATE__ || SNAP;
  }

  // Provide global bridge
  window.DarriusChart = {
    timeToX,
    priceToY,
    getSnapshot
  };

  // -----------------------------
  // Params reading (from window globals or URL)
  // -----------------------------
  function readRuntimeParams() {
    // 1) from globals (your UI might set these)
    const g = window.__DARRIUS_RUNTIME__ || {};

    // 2) from URL query as fallback
    const q = new URLSearchParams(window.location.search);

    const symbol = str(g.symbol, '') || str(q.get('symbol'), '') || SNAP.meta.symbol;
    const timeframe = str(g.timeframe, '') || str(q.get('tf'), '') || SNAP.meta.timeframe;

    // allow overrides
    const timespan = str(g.timespan, '') || str(q.get('timespan'), '') || SNAP.meta.timespan;
    const multiplier = num(g.multiplier ?? q.get('multiplier'), SNAP.meta.multiplier);
    const bars = num(g.bars ?? q.get('bars'), SNAP.meta.bars);

    // source hint (ui may set)
    const source = str(g.source, '') || str(q.get('source'), '') || SNAP.meta.source;

    // range
    const from = g.from ?? q.get('from');
    const to = g.to ?? q.get('to');

    return {
      symbol, timeframe, timespan,
      multiplier: Math.max(1, Math.floor(multiplier)),
      bars: Math.max(50, Math.floor(bars)),
      source,
      from: from ? String(from) : null,
      to: to ? String(to) : null
    };
  }

  // -----------------------------
  // Core loop: fetch + render + snapshot
  // -----------------------------
  let container = null;
  let canvas = null;
  let useLW = false;

  async function fetchAndRender() {
    const p = readRuntimeParams();

    // update meta early
    SNAP.meta.symbol = p.symbol;
    SNAP.meta.timeframe = p.timeframe;
    SNAP.meta.timespan = p.timespan;
    SNAP.meta.multiplier = p.multiplier;
    SNAP.meta.bars = p.bars;
    SNAP.meta.from = p.from;
    SNAP.meta.to = p.to;
    SNAP.meta.source = p.source || SNAP.meta.source || 'unknown';
    SNAP.ts = nowIso();
    SNAP.meta.error = null;

    // mark not-ready until successful
    SNAP.meta.ready = false;
    SNAP.meta.loaded = false;

    snapshotCommit(SNAP);

    // fetch aggregates
    let aggPayload = null;
    try {
      aggPayload = await httpJson(CFG.aggregatesUrl, {
        symbol: p.symbol,
        multiplier: p.multiplier,
        timespan: p.timespan,
        bars: p.bars,
        from: p.from,
        to: p.to
      });
    } catch (e) {
      SNAP.meta.error = `aggregates: ${str(e && e.message, 'failed')}`;
      SNAP.meta.ready = false;
      SNAP.meta.loaded = false;
      snapshotCommit(SNAP);
      return;
    }

    DATA = normalizeAggregates(aggPayload);
    SNAP.series.candlesCount = DATA.length;

    if (!DATA.length) {
      SNAP.meta.error = 'aggregates: empty';
      SNAP.meta.ready = false;
      SNAP.meta.loaded = false;
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

    // render (protected)
    safe(() => {
      if (!container) container = findContainer();

      // init once
      if (container && !useLW) {
        // if lightweight available, use it (preferred)
        const ok = initLightweight(container);
        if (ok) useLW = true;
      }

      if (useLW) {
        renderWithLightweight(DATA, EMA_FAST, EMA_SLOW);
        // mapping fallback (approx)
        SNAP.map.tMin = DATA[0].t;
        SNAP.map.tMax = DATA[DATA.length - 1].t;
        SNAP.map.xMin = 0; SNAP.map.xMax = 1;
        SNAP.map.yMin = 0; SNAP.map.yMax = 1;
      } else {
        // canvas fallback
        canvas = ensureCanvas(container);
        renderWithCanvas(canvas, DATA, EMA_FAST, EMA_SLOW, SNAP);
      }
    }, 'render');

    // mark loaded
    SNAP.meta.loaded = true;

    // signals fetch (separate; do not block chart)
    safe(async () => {
      let sigPayload = null;
      try {
        sigPayload = await httpJson(CFG.sigsUrl, {
          symbol: p.symbol,
          timeframe: p.timeframe,
          // keep aligned with chart window
          bars: p.bars
        });
      } catch (e) {
        // do NOT fail chart; just keep stable defaults and error note
        SNAP.meta.notes = arr(SNAP.meta.notes);
        SNAP.meta.notes = SNAP.meta.notes.slice(-6);
        SNAP.meta.notes.push(`sigs: ${str(e && e.message, 'failed')}`);
        // keep old signals as-is (never NaN)
        snapshotCommit(SNAP);
        return;
      }

      const s = normalizeSigs(sigPayload);
      // stable signals
      SNAP.signals.bullish = num(s.bullish, 0);
      SNAP.signals.bearish = num(s.bearish, 0);
      SNAP.signals.neutral = num(s.neutral, 0);
      SNAP.signals.net = num(s.net, 0);
      SNAP.signals.lastSig = s.lastSig || null;
      SNAP.signals.raw = s.raw || null;

      // stable risk/backtest
      SNAP.risk.entry = s.risk ? s.risk.entry : null;
      SNAP.risk.stop = s.risk ? s.risk.stop : null;
      SNAP.risk.targets = arr(s.risk && s.risk.targets).slice(0, 6).map(x => nnull(x)).filter(x => x !== null);
      SNAP.risk.confidence = s.risk ? s.risk.confidence : null;

      SNAP.backtest.winRate = (s.backtest ? s.backtest.winRate : null);
      SNAP.backtest.sampleSize = (s.backtest ? s.backtest.sampleSize : null);

      // ready now
      SNAP.meta.ready = true;

      snapshotCommit(SNAP);
    }, 'sigs');
  }

  // -----------------------------
  // Polling / lifecycle
  // -----------------------------
  let timer = null;

  function start() {
    // initial snapshot
    SNAP = makeSnapshotBase();
    snapshotCommit(SNAP);

    // render now
    safe(() => fetchAndRender(), 'start.fetch');

    // poll
    if (timer) clearInterval(timer);
    timer = setInterval(() => safe(() => fetchAndRender(), 'poll.fetch'), Math.max(3000, CFG.refreshMs));

    // resize hook (canvas fallback)
    safe(() => {
      window.addEventListener('resize', () => safe(() => fetchAndRender(), 'resize.rerender'));
    });

    // optional: allow other modules to force refresh
    safe(() => {
      window.addEventListener('darrius:forceRefresh', () => safe(() => fetchAndRender(), 'forceRefresh'));
    });
  }

  // -----------------------------
  // Boot after DOM ready
  // -----------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

})();
