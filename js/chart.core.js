console.log("=== chart.core.js ACTIVE BUILD: 2026-02-02-DEBUG ===");
window.__CHART_CORE_ACTIVE__ = "2026-02-02-DEBUG";

(() => {
  'use strict';

  console.log('[chart.core] FINAL v3 loaded');

  const POLL_INTERVAL = 15000;
  const API_AGG = '/api/data/stocks/aggregates';
  const API_SIGS = '/api/market/sigs';

  // --------- global refs (for diagnosis + self-heal) ----------
  window.__DARRIUS_CHART_RUNTIME__ = window.__DARRIUS_CHART_RUNTIME__ || {};
  const R = window.__DARRIUS_CHART_RUNTIME__;

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

  // ------------------- THE KEY FIX -------------------
  // If lock exists but chart isn't created, allow ONE self-heal init.
  function hasUsableChart() {
    return !!(R.chart && R.candleSeries);
  }

  function canInitNow() {
    return !!window.LightweightCharts && typeof window.LightweightCharts.createChart === 'function';
  }

  function initChart() {
    const container = findChartContainer();
    if (!container) return false;

    const rect = ensureSize(container);
    console.log('[chart.core] init with container:', { w: rect.width, h: rect.height, id: container.id, cls: container.className });

    // destroy previous (if any)
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

  async function fetchAggregates() {
    const symbol = window.__CURRENT_SYMBOL__ || 'TSLA';
    const timeframe = window.__CURRENT_TIMEFRAME__ || '1D';
    const url = `${API_AGG}?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`aggregates ${res.status}`);
    return res.json();
  }

  async function fetchSigs() {
    const symbol = window.__CURRENT_SYMBOL__ || 'TSLA';
    const timeframe = window.__CURRENT_TIMEFRAME__ || '1D';
    const url = `${API_SIGS}?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`sigs ${res.status}`);
    return res.json();
  }

  function updateSeries(payload) {
    if (!R.candleSeries) return;

    const rows = payload?.candles || payload?.results || [];
    if (!Array.isArray(rows) || rows.length === 0) {
      console.warn('[chart.core] empty candles');
      return;
    }

    const candles = [];
    const emaFast = [];
    const emaSlow = [];

    for (const r of rows) {
      const t = r.t || r.timestamp;
      if (!t) continue;
      const time = Math.floor(t / 1000);

      candles.push({
        time,
        open: r.o ?? r.open,
        high: r.h ?? r.high,
        low: r.l ?? r.low,
        close: r.c ?? r.close,
      });
      if (r.ema_fast != null) emaFast.push({ time, value: r.ema_fast });
      if (r.ema_slow != null) emaSlow.push({ time, value: r.ema_slow });
    }

    try { R.candleSeries.setData(candles); } catch (e) { console.error('[chart.core] setData candles error', e); }
    try { if (emaFast.length) R.emaFastSeries.setData(emaFast); } catch (_) {}
    try { if (emaSlow.length) R.emaSlowSeries.setData(emaSlow); } catch (_) {}

    hideLoadingOnce();

    window.__DARRIUS_CHART_STATE__ = { lastBar: candles[candles.length - 1], count: candles.length };
    window.dispatchEvent(new CustomEvent('darrius:chartUpdated', { detail: window.__DARRIUS_CHART_STATE__ }));
  }

  async function pollOnce() {
    try {
      const data = await fetchAggregates();
      updateSeries(data);
    } catch (e) {
      console.error('[chart.core] poll error', e);
    }
    fetchSigs().catch(() => null);
  }

  function startPolling() {
    if (R.pollingTimer) return;
    pollOnce();
    R.pollingTimer = setInterval(pollOnce, POLL_INTERVAL);
  }

  // ------------------- BOOT (self-heal) -------------------
  function boot() {
    // lib not ready
    if (!canInitNow()) return;

    // If chart usable, only ensure polling
    if (hasUsableChart()) {
      startPolling();
      return;
    }

    // self-heal init attempt (even if previous lock was set by old versions)
    showLoading();
    const ok = initChart();
    if (ok) startPolling();
  }

  // run boot repeatedly for a short window to defeat timing/layout issues
  let tries = 0;
  const t = setInterval(() => {
    tries += 1;
    boot();
    if (hasUsableChart() || tries > 200) clearInterval(t);
  }, 50);
})();
