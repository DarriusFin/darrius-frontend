/* =========================================================================
 * DarriusAI - chart.core.js
 * FINAL v5 (BACKEND-PARAMS ALIGNED + DOM AUTO-ADAPT + HARD DIAGNOSTICS)
 *
 * Key Fix:
 *  - /api/data/stocks/aggregates expects:
 *      ticker, multiplier, timespan, from, to
 *    NOT symbol/timeframe.
 * ========================================================================= */

console.log("=== chart.core.js ACTIVE BUILD: 2026-02-02 FINAL-V5 ===");
window.__CHART_CORE_ACTIVE__ = "2026-02-02 FINAL-V5";

(() => {
  'use strict';

  // =========================
  // Config
  // =========================
  const POLL_INTERVAL = 15000;

  // Allow env injection BEFORE this file loads:
  // <script>window.__DARRIUS_API_BASE__="https://darrius-api.onrender.com";</script>
  const API_BASE = String(window.__DARRIUS_API_BASE__ || "https://darrius-api.onrender.com")
    .replace(/\/+$/, "");

  const API_AGG  = `${API_BASE}/api/data/stocks/aggregates`;
  const API_SIGS = `${API_BASE}/api/market/sigs`;

  // =========================
  // Global runtime (visible in console)
  // =========================
  window.__DARRIUS_CHART_RUNTIME__ = window.__DARRIUS_CHART_RUNTIME__ || {};
  const R = window.__DARRIUS_CHART_RUNTIME__;

  // capture unexpected errors (avoid silent failure)
  if (!R.__ERR_HOOKED__) {
    R.__ERR_HOOKED__ = true;
    window.addEventListener('error', (e) => console.log('[window.error]', e.message || e));
    window.addEventListener('unhandledrejection', (e) => console.log('[unhandledrejection]', e.reason || e));
  }

  // Diagnostics exports
  R.__API_BASE__ = API_BASE;
  R.__API_AGG__ = API_AGG;
  R.__API_SIGS__ = API_SIGS;

  // =========================
  // DOM helpers
  // =========================
  function findChartContainer() {
    return (
      document.querySelector('#chart') ||
      document.querySelector('.chart-container') ||
      document.querySelector('.tv-lightweight-chart') ||
      document.querySelector('.tv-chart') ||
      document.querySelector('[data-chart]')
    );
  }

  function ensureSize(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) el.style.width = '100%';
    if (r.height === 0) el.style.minHeight = '420px';
    return el.getBoundingClientRect();
  }

  function showLoading() {
    const el = document.getElementById('chart-loading');
    if (el) el.style.display = 'block';
  }

  function hideLoadingOnce() {
    if (R.loadingClosed) return;
    R.loadingClosed = true;
    const el = document.getElementById('chart-loading');
    if (el) el.style.display = 'none';
  }

  // =========================
  // Chart init
  // =========================
  function canInitNow() {
    return !!(window.LightweightCharts && typeof window.LightweightCharts.createChart === 'function');
  }

  function initChart() {
    const container = findChartContainer();
    if (!container) {
      console.error('[chart.core] chart container NOT FOUND');
      return false;
    }
    if (!canInitNow()) {
      console.error('[chart.core] LightweightCharts NOT READY');
      return false;
    }

    const LWC = window.LightweightCharts; // <-- never use bare "LightweightCharts"
    const rect = ensureSize(container);
    console.log('[chart.core] init container:', { w: rect.width, h: rect.height, id: container.id, cls: container.className });

    // destroy previous chart if exists
    try { if (R.chart && R.chart.remove) R.chart.remove(); } catch (_) {}

    const chart = LWC.createChart(container, {
      layout: { background: { color: '#0b1220' }, textColor: '#cfd8dc' },
      grid: { vertLines: { color: '#1f2a38' }, horzLines: { color: '#1f2a38' } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#263238' },
      crosshair: { mode: LWC.CrosshairMode.Normal },
      width: rect.width,
      height: rect.height,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      borderVisible: false,
    });

    const emaFastSeries = chart.addLineSeries({ color: '#fdd835', lineWidth: 2 });
    const emaSlowSeries = chart.addLineSeries({ color: '#42a5f5', lineWidth: 2 });

    R.chart = chart;
    R.candleSeries = candleSeries;
    R.emaFastSeries = emaFastSeries;
    R.emaSlowSeries = emaSlowSeries;

    // Resize observer (more reliable than only window.resize)
    try {
      if (R.__ro__) R.__ro__.disconnect();
      R.__ro__ = new ResizeObserver(() => {
        try {
          const rr = container.getBoundingClientRect();
          chart.applyOptions({ width: rr.width, height: rr.height });
        } catch (_) {}
      });
      R.__ro__.observe(container);
    } catch (_) {
      // fallback
      window.addEventListener('resize', () => {
        const rr = container.getBoundingClientRect();
        try { chart.applyOptions({ width: rr.width, height: rr.height }); } catch (_) {}
      });
    }

    console.log('[chart.core] chart init OK');
    return true;
  }

  // =========================
  // Backend parameter mapping
  // =========================
  function pad2(n) { return String(n).padStart(2, '0'); }

  // Use UTC date to avoid timezone edge cases
  function formatDateUTC(d) {
    const y = d.getUTCFullYear();
    const m = pad2(d.getUTCMonth() + 1);
    const dd = pad2(d.getUTCDate());
    return `${y}-${m}-${dd}`;
  }

  function addDaysUTC(d, days) {
    const x = new Date(d.getTime());
    x.setUTCDate(x.getUTCDate() + days);
    return x;
  }

  // UI timeframe -> backend (multiplier,timespan,lookbackDays)
  function mapTimeframe(tfRaw) {
    const tf = String(tfRaw || '').trim();

    // normalize common UI values
    // examples: "5m","15m","30m","1h","4h","1D","1W","1M"
    const table = {
      '5m':  { multiplier: 5,  timespan: 'minute', lookbackDays: 7 },
      '15m': { multiplier: 15, timespan: 'minute', lookbackDays: 14 },
      '30m': { multiplier: 30, timespan: 'minute', lookbackDays: 30 },
      '1h':  { multiplier: 1,  timespan: 'hour',   lookbackDays: 60 },
      '4h':  { multiplier: 4,  timespan: 'hour',   lookbackDays: 180 },
      '1D':  { multiplier: 1,  timespan: 'day',    lookbackDays: 730 },
      '1W':  { multiplier: 1,  timespan: 'week',   lookbackDays: 3650 },
      '1M':  { multiplier: 1,  timespan: 'month',  lookbackDays: 3650 },
    };

    if (table[tf]) return table[tf];

    // fallback: accept lowercase versions
    const low = tf.toLowerCase();
    if (table[low]) return table[low];

    // conservative default
    return { multiplier: 1, timespan: 'day', lookbackDays: 730 };
  }

  function resolveTicker() {
    // prefer your existing global
    const t = window.__CURRENT_SYMBOL__ || window.__SYMBOL__ || 'TSLA';
    return String(t).trim().toUpperCase();
  }

  function resolveTimeframe() {
    const tf = window.__CURRENT_TIMEFRAME__ || window.__TIMEFRAME__ || '1D';
    return String(tf).trim();
  }

  function resolveUserId() {
    // best-effort only; do NOT break anything if absent
    try {
      return (
        window.__USER_ID__ ||
        window.__DARRIUS_USER_ID__ ||
        localStorage.getItem('darrius_user_id') ||
        ''
      );
    } catch (_) {
      return '';
    }
  }

  function buildAggUrl() {
    const ticker = resolveTicker();
    const tf = resolveTimeframe();
    const m = mapTimeframe(tf);

    const now = new Date();
    const dateTo = formatDateUTC(addDaysUTC(now, 1)); // inclusive-ish
    const dateFrom = formatDateUTC(addDaysUTC(now, -m.lookbackDays));

    const u = new URL(API_AGG);
    // backend expects ticker/multiplier/timespan/from/to
    u.searchParams.set('ticker', ticker);
    u.searchParams.set('multiplier', String(m.multiplier));
    u.searchParams.set('timespan', m.timespan);
    u.searchParams.set('from', dateFrom);
    u.searchParams.set('to', dateTo);

    // keep your system compatible with gate headers (optional)
    // demo is always allowed; provider requires ACTIVE
    // If your UI selects Demo(Local), keep it demo by default.
    const source = String(window.__DATA_SOURCE__ || 'demo').toLowerCase();
    u.searchParams.set('source', source); // demo|provider

    // provider selection (optional)
    const provider = String(window.__MARKET_PROVIDER__ || 'auto').toLowerCase();
    u.searchParams.set('provider', provider);

    // user_id for entitlement checks (optional)
    const uid = resolveUserId();
    if (uid) u.searchParams.set('user_id', uid);

    // diagnostics
    R.__LAST_TICKER__ = ticker;
    R.__LAST_TIMEFRAME__ = tf;
    R.__LAST_FROM__ = dateFrom;
    R.__LAST_TO__ = dateTo;
    R.__LAST_MULTIPLIER__ = m.multiplier;
    R.__LAST_TIMESPAN__ = m.timespan;

    return u.toString();
  }

  function buildSigsUrl() {
    // keep your sig endpoint signature; if backend uses symbol/timeframe, keep as-is
    const symbol = resolveTicker();
    const timeframe = resolveTimeframe();
    const u = new URL(API_SIGS);
    u.searchParams.set('symbol', symbol);
    u.searchParams.set('timeframe', timeframe);
    return u.toString();
  }

  // =========================
  // Payload extraction / normalize
  // =========================
  function extractRows(payload) {
    if (!payload) return [];

    // direct candidates
    const direct = [
      payload.candles,
      payload.results,
      payload.bars,
      payload.data,
    ];
    for (const x of direct) {
      if (Array.isArray(x) && x.length) return x;
    }

    // nested common wrappers
    const nested = [
      payload.data?.results,
      payload.data?.candles,
      payload.data?.bars,
      payload.payload?.results,
      payload.payload?.candles,
      payload.payload?.bars,
      payload.result?.results,
      payload.result?.candles,
      payload.result?.bars,
    ];
    for (const x of nested) {
      if (Array.isArray(x) && x.length) return x;
    }

    // last resort: scan first-level keys for an array of objects with o/h/l/c
    for (const k of Object.keys(payload)) {
      const v = payload[k];
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
        const r0 = v[0] || {};
        if (('o' in r0 || 'open' in r0) && ('c' in r0 || 'close' in r0)) return v;
      }
    }

    return [];
  }

  function normalizeTime(t) {
    if (typeof t !== 'number') return null;
    // ms -> s
    if (t > 10_000_000_000) return Math.floor(t / 1000);
    return Math.floor(t);
  }

  function updateSeries(payload) {
    if (!R.candleSeries) return;

    const rows = extractRows(payload);

    if (!Array.isArray(rows) || rows.length === 0) {
      console.error('[chart.core] NO ROWS extracted. payload keys:', payload ? Object.keys(payload) : null);
      window.__LAST_AGG__ = payload;
      return;
    }

    const candles = [];
    const emaFast = [];
    const emaSlow = [];

    for (const r of rows) {
      const t = r.t ?? r.timestamp ?? r.time;
      const time = normalizeTime(t);
      if (!time) continue;

      const o = r.o ?? r.open;
      const h = r.h ?? r.high;
      const l = r.l ?? r.low;
      const c = r.c ?? r.close;

      if ([o, h, l, c].some(v => typeof v !== 'number')) continue;

      candles.push({ time, open: o, high: h, low: l, close: c });

      // optional EMA series if backend provides
      if (typeof r.ema_fast === 'number') emaFast.push({ time, value: r.ema_fast });
      if (typeof r.ema_slow === 'number') emaSlow.push({ time, value: r.ema_slow });
    }

    if (!candles.length) {
      console.error('[chart.core] rows extracted BUT normalized candles empty. sample row=', rows[0]);
      window.__LAST_AGG__ = payload;
      return;
    }

    try { R.candleSeries.setData(candles); } catch (e) { console.error('[chart.core] setData candles error', e); }
    try { if (emaFast.length) R.emaFastSeries.setData(emaFast); } catch (_) {}
    try { if (emaSlow.length) R.emaSlowSeries.setData(emaSlow); } catch (_) {}

    hideLoadingOnce();

    // publish snapshot (read-only)
    window.__DARRIUS_CHART_STATE__ = {
      lastBar: candles[candles.length - 1],
      count: candles.length,
      ticker: R.__LAST_TICKER__ || null,
      timeframe: R.__LAST_TIMEFRAME__ || null,
      from: R.__LAST_FROM__ || null,
      to: R.__LAST_TO__ || null,
    };

    window.__LAST_AGG__ = payload;

    try {
      window.dispatchEvent(new CustomEvent('darrius:chartUpdated', { detail: window.__DARRIUS_CHART_STATE__ }));
    } catch (_) {}
  }

  // =========================
  // Fetch
  // =========================
  async function fetchJSON(url) {
    R.__LAST_FETCH_URL__ = url;
    window.__LAST_FETCH_URL__ = url;

    const res = await fetch(url, {
      cache: 'no-store',
      credentials: 'include', // safe if you later rely on cookies
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}

    if (!res.ok) {
      console.error('[chart.core] fetch failed', res.status, url, 'body head=', text.slice(0, 200));
      // store for debug
      window.__LAST_FETCH_FAIL__ = { status: res.status, url, head: text.slice(0, 500) };
      throw new Error(`HTTP ${res.status}`);
    }

    if (!json) {
      console.error('[chart.core] JSON parse failed. url=', url, 'body head=', text.slice(0, 200));
      throw new Error('JSON parse failed');
    }

    return json;
  }

  async function pollOnce() {
    // aggregates: critical
    try {
      const urlAgg = buildAggUrl();
      window.__LAST_AGG_URL__ = urlAgg;
      const data = await fetchJSON(urlAgg);
      updateSeries(data);
    } catch (e) {
      console.error('[chart.core] aggregates poll error', e);
    }

    // sigs: best-effort only
    try {
      const urlS = buildSigsUrl();
      window.__LAST_SIGS_URL__ = urlS;
      window.__LAST_SIGS__ = await fetchJSON(urlS);
    } catch (_) {}
  }

  function startPolling() {
    if (R.pollingTimer) return;
    pollOnce();
    R.pollingTimer = setInterval(pollOnce, POLL_INTERVAL);
  }

  // =========================
  // Public read-only bridge for overlay/UI
  // =========================
  if (!window.DarriusChart) {
    window.DarriusChart = {
      getSnapshot: () => (window.__DARRIUS_CHART_STATE__ || null),
      timeToX: (unixSec) => {
        try {
          if (!R.chart || typeof unixSec !== 'number') return null;
          const ts = R.chart.timeScale();
          return ts.timeToCoordinate(unixSec);
        } catch (_) { return null; }
      },
      priceToY: (price) => {
        try {
          if (!R.candleSeries || typeof price !== 'number') return null;
          return R.candleSeries.priceToCoordinate(price);
        } catch (_) { return null; }
      },
      // optional helper (won't break UI if unused)
      forceRefresh: () => { try { pollOnce(); } catch (_) {} },
    };
  }

  // =========================
  // Boot loop (defeat layout timing)
  // =========================
  let tries = 0;
  const t = setInterval(() => {
    tries += 1;

    if (!R.candleSeries) {
      showLoading();
      initChart();
    }

    if (R.candleSeries) startPolling();

    // stop once ready or after ~10s
    if (R.candleSeries || tries > 200) clearInterval(t);
  }, 50);

})();
