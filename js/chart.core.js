/* =========================================================================
 * DarriusAI - chart.core.js (FINAL STABLE) v2026.02.02-FIX-RANGE-AND-BIND-R1
 *
 * Fix goals:
 *  1) ALWAYS provide from/to when calling /api/data/stocks/aggregates
 *     - backend requires YYYY-MM-DD (your screenshot proves it)
 *  2) Never break UI even if data fails; keep stable snapshot contract
 *  3) Self-bind "Symbol Load" button if other binder is missing/broken
 *  4) Do NOT touch billing/subscription/payment logic
 *
 * Outputs:
 *  - window.__DARRIUS_CHART_STATE__ (darrius.snapshot.v2)
 *  - window.DarriusChart bridge: timeToX / priceToY / getSnapshot
 *  - dispatch "darrius:chartUpdated"
 * ========================================================================= */

(() => {
  'use strict';

  // -----------------------------
  // Absolute safe zone
  // -----------------------------
  function safe(fn, _tag) { try { return fn(); } catch (_) { return null; } }

  // -----------------------------
  // Helpers (NaN lock)
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
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  function nowIso() { return new Date().toISOString(); }

  // -----------------------------
  // API base resolver (supports absolute/proxy)
  // -----------------------------
  function resolveApi(urlPath) {
    // If you have a global API base, prefer it
    const base =
      str(window.__API_BASE__, '') ||
      str((window.__DARRIUS_RUNTIME__ || {}).apiBase, '') ||
      ''; // empty => same-origin proxy

    if (base) {
      // avoid double slashes
      return base.replace(/\/+$/, '') + '/' + String(urlPath).replace(/^\/+/, '');
    }
    return urlPath; // same-origin
  }

  // -----------------------------
  // Snapshot contract (stable)
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
        source: 'unknown',   // live | delayed | demo | unknown
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
        xMin: 0, xMax: 1, yMin: 0, yMax: 1,
        tMin: null, tMax: null
      }
    };
  }

  function snapshotCommit(snap) {
    window.__DARRIUS_CHART_STATE__ = snap;
    safe(() => {
      window.dispatchEvent(new CustomEvent('darrius:chartUpdated', { detail: snap }));
    });
  }

  // -----------------------------
  // Config
  // -----------------------------
  const CFG = {
    aggregatesUrl: resolveApi('/api/data/stocks/aggregates'),
    sigsUrl: resolveApi('/api/market/sigs'),
    refreshMs: 15000,
    emaFastPeriod: 20,
    emaSlowPeriod: 50
  };

  // -----------------------------
  // DOM finders
  // -----------------------------
  function q(sel) { return document.querySelector(sel); }

  // Try to find "Symbol Load" button even if no id exists
  function findSymbolLoadButton() {
    // common ids
    const byId =
      q('#symbolLoadBtn') ||
      q('#btnSymbolLoad') ||
      q('[data-action="symbol-load"]');
    if (byId) return byId;

    // fallback: scan buttons by text
    const btns = Array.from(document.querySelectorAll('button'));
    for (const b of btns) {
      const t = (b.textContent || '').toLowerCase();
      if (t.includes('symbol load') || t.includes('品种加载')) return b;
    }
    return null;
  }

  function findSymbolInput() {
    return (
      q('#symbol') ||
      q('#symbolInput') ||
      q('input[name="symbol"]') ||
      q('input[placeholder*="TSLA"]') ||
      q('input[placeholder*="BTC"]')
    );
  }

  function findTimeframeSelect() {
    return (
      q('#timeframe') ||
      q('#tf') ||
      q('#timeframeSelect') ||
      q('select[name="timeframe"]') ||
      q('select[name="tf"]')
    );
  }

  function findDataSourceSelect() {
    return (
      q('#dataSource') ||
      q('#source') ||
      q('#dataSourceSelect') ||
      q('select[name="source"]')
    );
  }

  // -----------------------------
  // Normalize aggregates
  // -----------------------------
  function normalizeAggregates(payload) {
    const results = arr(payload && payload.results);
    const out = [];
    for (const r of results) {
      const t = num(r.t, 0);
      const o = r.o, h = r.h, l = r.l, c = r.c, v = r.v;
      if (!t) continue;
      if (!isNum(o) || !isNum(h) || !isNum(l) || !isNum(c)) continue;
      out.push({ t, o, h, l, c, v: num(v, 0) });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  // -----------------------------
  // EMA (internal only)
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
  // HTTP json (throws to caller)
  // -----------------------------
  async function httpJson(url, params) {
    const u = new URL(url, window.location.origin);
    if (params && typeof params === 'object') {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '') continue;
        u.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(u.toString(), {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    const txt = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 160)}`);
    return txt ? JSON.parse(txt) : {};
  }

  // -----------------------------
  // Range builder (CRITICAL FIX)
  // backend requires from/to YYYY-MM-DD
  // -----------------------------
  function estimateDays(timespan, multiplier, bars) {
    const ts = String(timespan || 'day').toLowerCase();
    const m = Math.max(1, Math.floor(num(multiplier, 1)));
    const b = Math.max(10, Math.floor(num(bars, 10)));

    // We always convert to "days back" for YYYY-MM-DD range.
    if (ts === 'day') return b * m;
    if (ts === 'week') return b * m * 7;
    if (ts === 'month') return b * m * 30;

    // intraday approximation:
    if (ts === 'hour') return Math.ceil((b * m) / 24);
    if (ts === 'minute') return Math.ceil((b * m) / (24 * 60));

    // default safe
    return b * m;
  }

  function buildFromTo(p) {
    // If caller already provided valid YYYY-MM-DD, respect it.
    const from = str(p.from, '');
    const to = str(p.to, '');
    const re = /^\d{4}-\d{2}-\d{2}$/;

    if (re.test(from) && re.test(to)) return { from, to };

    const today = new Date();
    const toDate = new Date(today.getFullYear(), today.getMonth(), today.getDate()); // strip time
    const daysBack = Math.max(5, estimateDays(p.timespan, p.multiplier, p.bars));
    const fromDate = new Date(toDate.getTime() - daysBack * 24 * 3600 * 1000);

    return { from: ymd(fromDate), to: ymd(toDate) };
  }

  // -----------------------------
  // State & bridge
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
    // Overlay fallback: return mid if no precise mapping.
    const yMin = SNAP.map.yMin;
    const yMax = SNAP.map.yMax;
    if (!isNum(yMin) || !isNum(yMax) || yMax <= yMin) return 0;
    return (yMin + yMax) / 2;
  }

  function getSnapshot() {
    return window.__DARRIUS_CHART_STATE__ || SNAP;
  }

  window.DarriusChart = { timeToX, priceToY, getSnapshot };

  // -----------------------------
  // Runtime params
  // -----------------------------
  function readRuntimeParams() {
    const g = window.__DARRIUS_RUNTIME__ || {};
    const qsp = new URLSearchParams(window.location.search);

    const symbol = str(g.symbol, '') || str(qsp.get('symbol'), '') || SNAP.meta.symbol;
    const timeframe = str(g.timeframe, '') || str(qsp.get('tf'), '') || SNAP.meta.timeframe;

    const timespan = str(g.timespan, '') || str(qsp.get('timespan'), '') || SNAP.meta.timespan;
    const multiplier = num(g.multiplier ?? qsp.get('multiplier'), SNAP.meta.multiplier);
    const bars = num(g.bars ?? qsp.get('bars'), SNAP.meta.bars);

    const source = str(g.source, '') || str(qsp.get('source'), '') || SNAP.meta.source;

    const from = g.from ?? qsp.get('from');
    const to = g.to ?? qsp.get('to');

    const p = {
      symbol,
      timeframe,
      timespan,
      multiplier: Math.max(1, Math.floor(multiplier)),
      bars: Math.max(10, Math.floor(bars)),
      source,
      from: from ? String(from) : null,
      to: to ? String(to) : null
    };

    // CRITICAL: guarantee from/to
    const r = buildFromTo(p);
    p.from = r.from;
    p.to = r.to;

    return p;
  }

  // -----------------------------
  // Rendering (LightweightCharts if present)
  // -----------------------------
  let chart = null;
  let seriesC = null, seriesEF = null, seriesES = null;
  let container = null;

  function findChartContainer() {
    return (
      q('#chart') ||
      q('#chartContainer') ||
      q('#mainChart') ||
      q('#tvchart') ||
      q('#chart-root') ||
      q('.chart-container') ||
      q('main') ||
      document.body
    );
  }

  function initLightweightChart() {
    const LW = window.LightweightCharts;
    if (!LW || !LW.createChart) return false;

    if (!container) container = findChartContainer();
    if (!container) return false;

    // Keep layout: do not nuke container if it includes other UI.
    // We create an inner div only for chart render.
    let host = container.querySelector('.darrius-lw-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'darrius-lw-host';
      host.style.width = '100%';
      host.style.height = '100%';
      host.style.minHeight = '420px';
      container.appendChild(host);
    }

    if (chart) return true;

    chart = LW.createChart(host, {
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#9fb3c8' },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)' },
      crosshair: { mode: 1 }
    });

    seriesC = chart.addCandlestickSeries({
      upColor: '#2BE2A6',
      downColor: '#FF5B6E',
      wickUpColor: '#2BE2A6',
      wickDownColor: '#FF5B6E',
      borderVisible: false
    });
    seriesEF = chart.addLineSeries({ lineWidth: 2, color: '#F5B700' });
    seriesES = chart.addLineSeries({ lineWidth: 2, color: '#4CC2FF' });

    return true;
  }

  function renderLightweight(data, emaFast, emaSlow) {
    if (!chart || !seriesC) return;
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
    safe(() => seriesC.setData(candles));
    safe(() => seriesEF.setData(ef));
    safe(() => seriesES.setData(es));

    // mapping bounds for overlay (approx)
    SNAP.map.tMin = data[0].t;
    SNAP.map.tMax = data[data.length - 1].t;
    SNAP.map.xMin = 0; SNAP.map.xMax = 1;
    SNAP.map.yMin = 0; SNAP.map.yMax = 1;
  }

  // -----------------------------
  // Core fetch & update loop
  // -----------------------------
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
    SNAP.meta.source = p.source || 'unknown';
    SNAP.ts = nowIso();
    SNAP.meta.error = null;
    SNAP.meta.ready = false;
    SNAP.meta.loaded = false;

    snapshotCommit(SNAP);

    // 1) aggregates (REQUIRES from/to)
    let agg = null;
    try {
      agg = await httpJson(CFG.aggregatesUrl, {
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

    DATA = normalizeAggregates(agg);
    SNAP.series.candlesCount = DATA.length;

    if (!DATA.length) {
      SNAP.meta.error = 'aggregates: empty';
      SNAP.meta.loaded = false;
      SNAP.meta.ready = false;
      snapshotCommit(SNAP);
      return;
    }

    // 2) EMA
    const closes = DATA.map(d => d.c);
    EMA_FAST = calcEMA(closes, CFG.emaFastPeriod);
    EMA_SLOW = calcEMA(closes, CFG.emaSlowPeriod);
    SNAP.series.emaCount = DATA.length;

    const last = DATA[DATA.length - 1];
    SNAP.price.last = nnull(last && last.c);
    SNAP.price.lastTime = nnull(last && last.t);
    SNAP.price.emaFast = nnull(EMA_FAST[EMA_FAST.length - 1]);
    SNAP.price.emaSlow = nnull(EMA_SLOW[EMA_SLOW.length - 1]);

    const tb = detectTrend(SNAP.price.emaFast, SNAP.price.emaSlow);
    SNAP.price.trend = tb.trend;
    SNAP.price.bias = tb.bias;

    // 3) render
    safe(() => {
      initLightweightChart();
      renderLightweight(DATA, EMA_FAST, EMA_SLOW);
    });

    SNAP.meta.loaded = true;
    snapshotCommit(SNAP);

    // 4) signals (do not block chart)
    safe(async () => {
      let sp = null;
      try {
        sp = await httpJson(CFG.sigsUrl, {
          symbol: p.symbol,
          timeframe: p.timeframe,
          bars: p.bars
        });
      } catch (e) {
        SNAP.meta.notes = arr(SNAP.meta.notes).slice(-6);
        SNAP.meta.notes.push(`sigs: ${str(e && e.message, 'failed')}`);
        snapshotCommit(SNAP);
        return;
      }

      const s = normalizeSigs(sp);

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
    });
  }

  // -----------------------------
  // Self-bind Symbol Load (fix "button not clickable")
  // -----------------------------
  function bindSymbolLoad() {
    const btn = findSymbolLoadButton();
    if (!btn) return;

    // Force enable (some old code may set disabled)
    safe(() => { btn.disabled = false; });
    safe(() => { btn.style.pointerEvents = 'auto'; });

    // Avoid double-binding
    if (btn.__darriusBound) return;
    btn.__darriusBound = true;

    btn.addEventListener('click', (e) => {
      safe(() => { e.preventDefault(); e.stopPropagation(); });

      const symEl = findSymbolInput();
      const tfEl = findTimeframeSelect();
      const srcEl = findDataSourceSelect();

      const symbol = str(symEl && symEl.value, '').trim() || 'TSLA';
      const timeframe = str(tfEl && tfEl.value, '').trim() || '1D';

      // Map timeframe -> timespan/multiplier (basic)
      // You can refine later; this won't break anything.
      let timespan = 'day';
      let multiplier = 1;
      if (timeframe === '5m') { timespan = 'minute'; multiplier = 5; }
      else if (timeframe === '15m') { timespan = 'minute'; multiplier = 15; }
      else if (timeframe === '30m') { timespan = 'minute'; multiplier = 30; }
      else if (timeframe === '1h') { timespan = 'hour'; multiplier = 1; }
      else if (timeframe === '4h') { timespan = 'hour'; multiplier = 4; }
      else if (timeframe === '1D' || timeframe === '1d') { timespan = 'day'; multiplier = 1; }
      else if (timeframe === '1W' || timeframe === '1w') { timespan = 'week'; multiplier = 1; }

      const source = str(srcEl && srcEl.value, '').trim() || (window.__DARRIUS_RUNTIME__ || {}).source || 'unknown';

      window.__DARRIUS_RUNTIME__ = window.__DARRIUS_RUNTIME__ || {};
      window.__DARRIUS_RUNTIME__.symbol = symbol;
      window.__DARRIUS_RUNTIME__.timeframe = timeframe;
      window.__DARRIUS_RUNTIME__.timespan = timespan;
      window.__DARRIUS_RUNTIME__.multiplier = multiplier;

      // keep bars sane
      window.__DARRIUS_RUNTIME__.bars = num((window.__DARRIUS_RUNTIME__ || {}).bars, 480);

      window.__DARRIUS_RUNTIME__.source = source;

      // IMPORTANT: do NOT set from/to here; core will build required range automatically
      safe(() => fetchAndRender());
    }, { passive: false });
  }

  // -----------------------------
  // Polling / lifecycle
  // -----------------------------
  let timer = null;

  function start() {
    SNAP = makeSnapshotBase();
    snapshotCommit(SNAP);

    // bind UI once (and keep trying if DOM changes)
    safe(() => bindSymbolLoad());
    safe(() => setTimeout(bindSymbolLoad, 800));
    safe(() => setTimeout(bindSymbolLoad, 2000));

    // initial draw
    safe(() => fetchAndRender());

    // poll
    if (timer) clearInterval(timer);
    timer = setInterval(() => safe(() => fetchAndRender()), Math.max(5000, CFG.refreshMs));

    // resize -> redraw (lightweight handles resize; still safe to refresh)
    safe(() => {
      window.addEventListener('resize', () => safe(() => fetchAndRender()));
    });

    // external refresh hook
    safe(() => {
      window.addEventListener('darrius:forceRefresh', () => safe(() => fetchAndRender()));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
