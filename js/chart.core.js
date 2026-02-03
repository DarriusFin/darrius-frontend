/* =========================================================================
 * DarriusAI - chart.core.js
 * FINAL + DOM AUTO ADAPTIVE VERSION
 * ========================================================================= */

(() => {
  'use strict';

  /* ---------------------------------------------------------
   * HARD STOP: prevent re-init
   * --------------------------------------------------------- */
  if (window.__DARRIUS_CHART_ENGINE_FINAL__) {
    console.warn('[chart.core] already initialized, skip');
    return;
  }
  window.__DARRIUS_CHART_ENGINE_FINAL__ = true;

  console.log('[chart.core] FINAL DOM-AUTO version loaded');

  /* ---------------------------------------------------------
   * Guard: LightweightCharts
   * --------------------------------------------------------- */
  if (!window.LightweightCharts) {
    console.error('[chart.core] LightweightCharts NOT loaded');
    return;
  }

  /* ---------------------------------------------------------
   * Config
   * --------------------------------------------------------- */
  const POLL_INTERVAL = 15000;
  const API_AGG = '/api/data/stocks/aggregates';
  const API_SIGS = '/api/market/sigs';

  /* ---------------------------------------------------------
   * State
   * --------------------------------------------------------- */
  let chart = null;
  let candleSeries = null;
  let emaFastSeries = null;
  let emaSlowSeries = null;

  let pollingTimer = null;
  let initialized = false;
  let loadingClosed = false;

  /* ---------------------------------------------------------
   * DOM helpers
   * --------------------------------------------------------- */
  function findChartContainer() {
    const selectors = [
      '#chart',
      '.chart',
      '.chart-container',
      '.tv-lightweight-chart',
      '.tv-chart',
      '[data-chart]',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function ensureContainerSize(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) el.style.width = '100%';
    if (rect.height === 0) el.style.minHeight = '420px';
  }

  function showLoading() {
    const el = document.getElementById('chart-loading');
    if (el) el.style.display = 'block';
  }

  function hideLoadingOnce() {
    if (loadingClosed) return;
    loadingClosed = true;
    const el = document.getElementById('chart-loading');
    if (el) el.style.display = 'none';
  }

  /* ---------------------------------------------------------
   * Init Chart (ONLY ONCE)
   * --------------------------------------------------------- */
  function initChartOnce() {
    if (initialized) return;
    initialized = true;

    const container = findChartContainer();
    if (!container) {
      console.error('[chart.core] chart container NOT FOUND');
      return;
    }

    ensureContainerSize(container);

    chart = LightweightCharts.createChart(container, {
      layout: {
        background: { color: '#0b1220' },
        textColor: '#cfd8dc',
      },
      grid: {
        vertLines: { color: '#1f2a38' },
        horzLines: { color: '#1f2a38' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: '#263238',
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
      },
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      borderVisible: false,
    });

    emaFastSeries = chart.addLineSeries({
      color: '#fdd835',
      lineWidth: 2,
    });

    emaSlowSeries = chart.addLineSeries({
      color: '#42a5f5',
      lineWidth: 2,
    });

    window.addEventListener('resize', () => {
      const r = container.getBoundingClientRect();
      chart.applyOptions({ width: r.width, height: r.height });
    });
  }

  /* ---------------------------------------------------------
   * Fetch
   * --------------------------------------------------------- */
  async function fetchAggregates() {
    const symbol = window.__CURRENT_SYMBOL__ || 'TSLA';
    const timeframe = window.__CURRENT_TIMEFRAME__ || '1D';
    const url = `${API_AGG}?symbol=${symbol}&timeframe=${timeframe}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error('aggregates fetch failed');
    return res.json();
  }

  async function fetchSigs() {
    const symbol = window.__CURRENT_SYMBOL__ || 'TSLA';
    const timeframe = window.__CURRENT_TIMEFRAME__ || '1D';
    const url = `${API_SIGS}?symbol=${symbol}&timeframe=${timeframe}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error('sigs fetch failed');
    return res.json();
  }

  /* ---------------------------------------------------------
   * Update Series (NO REINIT)
   * --------------------------------------------------------- */
  function updateSeries(payload) {
    if (!candleSeries) return;

    const rows = payload?.candles || payload?.results || [];
    if (!Array.isArray(rows) || rows.length === 0) {
      console.warn('[chart.core] empty data');
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

      if (r.ema_fast != null)
        emaFast.push({ time, value: r.ema_fast });

      if (r.ema_slow != null)
        emaSlow.push({ time, value: r.ema_slow });
    }

    candleSeries.setData(candles);
    if (emaFast.length) emaFastSeries.setData(emaFast);
    if (emaSlow.length) emaSlowSeries.setData(emaSlow);

    hideLoadingOnce();

    window.__DARRIUS_CHART_STATE__ = {
      lastBar: candles[candles.length - 1],
      count: candles.length,
    };

    window.dispatchEvent(
      new CustomEvent('darrius:chartUpdated', {
        detail: window.__DARRIUS_CHART_STATE__,
      })
    );
  }

  /* ---------------------------------------------------------
   * Polling
   * --------------------------------------------------------- */
  async function pollOnce() {
    try {
      const data = await fetchAggregates();
      updateSeries(data);
    } catch (e) {
      console.error('[chart.core] poll error', e);
    }

    // sigs 不影响主图
    fetchSigs().catch(() => null);
  }

  function startPolling() {
    if (pollingTimer) return;
    pollOnce();
    pollingTimer = setInterval(pollOnce, POLL_INTERVAL);
  }

  /* ---------------------------------------------------------
   * Boot
   * --------------------------------------------------------- */
  showLoading();

  // 等 DOM 真正 ready（防止你页面是异步 layout）
  const bootTimer = setInterval(() => {
    const el = findChartContainer();
    if (el && window.LightweightCharts) {
      clearInterval(bootTimer);
      initChartOnce();
      startPolling();
    }
  }, 100);

})();
