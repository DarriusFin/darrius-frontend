/* =========================================================================
 * DarriusAI - chart.core.js
 * FINAL v4.1 (BACKEND-PROTOCOL ALIGNED)
 * ========================================================================= */

console.log("=== chart.core.js ACTIVE BUILD: 2026-02-02 FINAL-V4.1 ===");
window.__CHART_CORE_ACTIVE__ = "2026-02-02 FINAL-V4.1";

(() => {
  'use strict';

  const POLL_INTERVAL = 15000;

  const API_BASE = String(
    window.__DARRIUS_API_BASE__ || "https://darrius-api.onrender.com"
  ).replace(/\/+$/, "");

  const API_AGG  = `${API_BASE}/api/data/stocks/aggregates`;
  const API_SIGS = `${API_BASE}/api/market/sigs`;

  // ---------------- runtime ----------------
  window.__DARRIUS_CHART_RUNTIME__ = window.__DARRIUS_CHART_RUNTIME__ || {};
  const R = window.__DARRIUS_CHART_RUNTIME__;

  if (!R.__ERR_HOOKED__) {
    R.__ERR_HOOKED__ = true;
    window.addEventListener('error', e =>
      console.error('[window.onerror]', e.message)
    );
    window.addEventListener('unhandledrejection', e =>
      console.error('[unhandledrejection]', e.reason)
    );
  }

  // ---------------- utils ----------------
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

  function canInitNow() {
    return !!(
      window.LightweightCharts &&
      typeof window.LightweightCharts.createChart === 'function'
    );
  }

  // ---------------- chart init ----------------
  function initChart() {
    const container = findChartContainer();
    if (!container) return false;
    if (!canInitNow()) return false;

    ensureSize(container);

    try { R.chart?.remove?.(); } catch (_) {}

    const chart = LightweightCharts.createChart(container, {
      layout: { background: { color: '#0b1220' }, textColor: '#cfd8dc' },
      grid: {
        vertLines: { color: '#1f2a38' },
        horzLines: { color: '#1f2a38' }
      },
      timeScale: { timeVisible: true },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
    });

    R.chart = chart;
    R.candleSeries = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      borderVisible: false
    });

    R.emaFastSeries = chart.addLineSeries({ color: '#fdd835', lineWidth: 2 });
    R.emaSlowSeries = chart.addLineSeries({ color: '#42a5f5', lineWidth: 2 });

    window.addEventListener('resize', () => {
      const r = container.getBoundingClientRect();
      chart.applyOptions({ width: r.width, height: r.height });
    });

    console.log('[chart.core] chart initialized');
    return true;
  }

  // ---------------- data normalize ----------------
  function extractRows(payload) {
    return payload?.results || payload?.data?.results || [];
  }

  function normalizeTime(ms) {
    return ms > 10_000_000_000 ? Math.floor(ms / 1000) : ms;
  }

  function updateSeries(payload) {
    const rows = extractRows(payload);
    if (!rows.length) {
      console.error('[chart.core] NO rows', payload);
      window.__LAST_AGG__ = payload;
      return;
    }

    const candles = [];
    for (const r of rows) {
      if (![r.o, r.h, r.l, r.c].every(v => typeof v === 'number')) continue;
      candles.push({
        time: normalizeTime(r.t),
        open: r.o,
        high: r.h,
        low: r.l,
        close: r.c
      });
    }

    if (!candles.length) return;

    R.candleSeries.setData(candles);
    window.__DARRIUS_CHART_STATE__ = {
      count: candles.length,
      lastBar: candles[candles.length - 1]
    };
    window.__LAST_AGG__ = payload;

    window.dispatchEvent(
      new CustomEvent('darrius:chartUpdated', {
        detail: window.__DARRIUS_CHART_STATE__
      })
    );
  }

  // ---------------- timeframe mapping (关键修复) ----------------
  function mapTimeframe(tf) {
    switch (tf) {
      case '1m': return { multiplier: 1, timespan: 'minute', days: 3 };
      case '5m': return { multiplier: 5, timespan: 'minute', days: 7 };
      case '15m': return { multiplier: 15, timespan: 'minute', days: 14 };
      case '1h': return { multiplier: 1, timespan: 'hour', days: 60 };
      case '1D':
      default:
        return { multiplier: 1, timespan: 'day', days: 500 };
    }
  }

  function dateNDaysAgo(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }

  // ---------------- fetch ----------------
  async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-store' });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0,200)}`);
    return JSON.parse(text);
  }

  async function pollOnce() {
    try {
      const symbol = window.__CURRENT_SYMBOL__ || 'TSLA';
      const tf = window.__CURRENT_TIMEFRAME__ || '1D';
      const m = mapTimeframe(tf);

      const from = dateNDaysAgo(m.days);
      const to   = new Date().toISOString().slice(0, 10);

      const url = `${API_AGG}?ticker=${symbol}&multiplier=${m.multiplier}` +
                  `&timespan=${m.timespan}&from=${from}&to=${to}`;

      window.__LAST_AGG_URL__ = url;

      const data = await fetchJSON(url);
      updateSeries(data);
    } catch (e) {
      console.error('[chart.core] poll error', e);
    }
  }

  function startPolling() {
    if (R.pollingTimer) return;
    pollOnce();
    R.pollingTimer = setInterval(pollOnce, POLL_INTERVAL);
  }

  // ---------------- boot ----------------
  let tries = 0;
  const boot = setInterval(() => {
    tries++;
    if (!R.candleSeries) initChart();
    if (R.candleSeries) startPolling();
    if (R.candleSeries || tries > 200) clearInterval(boot);
  }, 50);

})();
