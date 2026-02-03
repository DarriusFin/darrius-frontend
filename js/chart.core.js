/* =========================================================================
 * DarriusAI - chart.core.js
 * FINAL v4 (DATA AUTO-EXTRACT + HARD DIAGNOSTICS)
 * ========================================================================= */

console.log("=== chart.core.js ACTIVE BUILD: 2026-02-02 FINAL-V4 ===");
window.__CHART_CORE_ACTIVE__ = "2026-02-02 FINAL-V4";

(() => {
  'use strict';

  const POLL_INTERVAL = 15000;
  const API_BASE = String(window.__DARRIUS_API_BASE__ || "https://darrius-api.onrender.com")
  .replace(/\/+$/, "");

const API_AGG  = `${API_BASE}/api/data/stocks/aggregates`;
const API_SIGS = `${API_BASE}/api/market/sigs`;



  // Global runtime (always visible in console)
  window.__DARRIUS_CHART_RUNTIME__ = window.__DARRIUS_CHART_RUNTIME__ || {};
  const R = window.__DARRIUS_CHART_RUNTIME__;

  // capture unexpected errors (avoid silent failure)
  if (!R.__ERR_HOOKED__) {
    R.__ERR_HOOKED__ = true;
    window.addEventListener('error', (e) => console.log('[window.onerror]', e.message));
    window.addEventListener('unhandledrejection', (e) => console.log('[unhandledrejection]', e.reason));
  }

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

  function canInitNow() {
    return !!(window.LightweightCharts && typeof window.LightweightCharts.createChart === 'function');
  }

  function initChart() {
    const container = findChartContainer();
    if (!container) {
      console.error('[chart.core] #chart container NOT FOUND');
      return false;
    }
    if (!canInitNow()) {
      console.error('[chart.core] LightweightCharts NOT READY');
      return false;
    }

    const rect = ensureSize(container);
    console.log('[chart.core] init container:', { w: rect.width, h: rect.height, id: container.id, cls: container.className });

    // destroy previous chart if exists
    try { if (R.chart && R.chart.remove) R.chart.remove(); } catch (_) {}

    const chart = LightweightCharts.createChart(container, {
      layout: { background: { color: '#0b1220' }, textColor: '#cfd8dc' },
      grid: { vertLines: { color: '#1f2a38' }, horzLines: { color: '#1f2a38' } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#263238' },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
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

    window.addEventListener('resize', () => {
      const rr = container.getBoundingClientRect();
      try { chart.applyOptions({ width: rr.width, height: rr.height }); } catch (_) {}
    });

    console.log('[chart.core] chart init OK');
    return true;
  }

  // --------- 핵심：把任何形态的 payload 挖出 OHLC 数组 ----------
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
    // t could be seconds or milliseconds
    if (typeof t !== 'number') return null;
    if (t > 10_000_000_000) return Math.floor(t / 1000); // ms -> s
    return Math.floor(t); // already seconds
  }

  function updateSeries(payload) {
    if (!R.candleSeries) return;

    const rows = extractRows(payload);

    if (!Array.isArray(rows) || rows.length === 0) {
      // hard diagnostics
      console.error('[chart.core] NO ROWS extracted. payload keys:', payload ? Object.keys(payload) : null);
      // store raw for inspection
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

    window.__DARRIUS_CHART_STATE__ = { lastBar: candles[candles.length - 1], count: candles.length };
    window.__LAST_AGG__ = payload;

    window.dispatchEvent(new CustomEvent('darrius:chartUpdated', { detail: window.__DARRIUS_CHART_STATE__ }));
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-store' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (!res.ok) {
      console.error('[chart.core] fetch failed', res.status, url, 'body=', text.slice(0, 200));
      throw new Error(`HTTP ${res.status}`);
    }
    if (!json) {
      console.error('[chart.core] JSON parse failed. url=', url, 'body head=', text.slice(0, 200));
      throw new Error('JSON parse failed');
    }
    return json;
  }

  async function pollOnce() {
    try {
      const symbol = window.__CURRENT_SYMBOL__ || 'TSLA';
      const timeframe = window.__CURRENT_TIMEFRAME__ || '1D';
      const urlAgg = `${API_AGG}?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`;

      const data = await fetchJSON(urlAgg);
      updateSeries(data);
    } catch (e) {
      console.error('[chart.core] poll error', e);
    }

    // sigs: best-effort only
    try {
      const symbol = window.__CURRENT_SYMBOL__ || 'TSLA';
      const timeframe = window.__CURRENT_TIMEFRAME__ || '1D';
      const urlS = `${API_SIGS}?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`;
      window.__LAST_SIGS__ = await fetchJSON(urlS);
    } catch (_) {}
  }

  function startPolling() {
    if (R.pollingTimer) return;
    pollOnce();
    R.pollingTimer = setInterval(pollOnce, POLL_INTERVAL);
  }

  // boot loop (defeat layout timing)
  let tries = 0;
  const t = setInterval(() => {
    tries += 1;
    if (!R.candleSeries) {
      showLoading();
      initChart();
    }
    if (R.candleSeries) startPolling();
    if (R.candleSeries || tries > 200) clearInterval(t);
  }, 50);

})();
