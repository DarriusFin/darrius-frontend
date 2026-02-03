/* =========================================================================
 * DarriusAI - chart.core.js (FINAL STABLE)
 * Purpose:
 *  - Chart initializes ONCE
 *  - Polling only updates data
 *  - Loading shows ONCE
 *  - Never re-create chart instance
 * ========================================================================= */

(() => {
  'use strict';

  /* ---------------------------------------------------------
   * HARD GUARD: prevent re-initialization
   * --------------------------------------------------------- */
  if (window.__DARRIUS_CHART_ENGINE__) {
    console.warn('[chart.core] engine already initialized, skip');
    return;
  }
  window.__DARRIUS_CHART_ENGINE__ = true;

  console.log('[chart.core] FINAL STABLE loaded');

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
  let loadingClosed = false;
  let initialized = false;

  /* ---------------------------------------------------------
   * DOM helpers
   * --------------------------------------------------------- */
  function $(id) {
    return document.getElementById(id);
  }

  function showLoading() {
    const el = $('chart-loading');
    if (el) el.style.display = 'block';
  }

  function hideLoadingOnce() {
    if (loadingClosed) return;
    loadingClosed = true;
    const el = $('chart-loading');
    if (el) el.style.display = 'none';
  }

  /* ---------------------------------------------------------
   * Chart Init (ONLY ONCE)
   * --------------------------------------------------------- */
  function initChartOnce() {
    if (initialized) return;
    initialized = true;

    const container = $('chart');
    if (!container) {
      console.error('[chart.core] chart container not found');
      return;
    }

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
      chart.applyOptions({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    });
  }

  /* ---------------------------------------------------------
   * Data Fetch
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
   * Data Update (NO REINIT)
   * --------------------------------------------------------- */
  function updateSeries(payload) {
    const candles = payload?.candles || payload?.results || [];
    if (!Array.isArray(candles) || candles.length === 0) {
      console.warn('[chart.core] empty candles');
      return;
    }

    const candleData = [];
    const emaFast = [];
    const emaSlow = [];

    for (const c of candles) {
      const t = c.t || c.timestamp;
      if (!t) continue;

      candleData.push({
        time: Math.floor(t / 1000),
        open: c.o ?? c.open,
        high: c.h ?? c.high,
        low: c.l ?? c.low,
        close: c.c ?? c.close,
      });

      if (c.ema_fast != null) {
        emaFast.push({
          time: Math.floor(t / 1000),
          value: c.ema_fast,
        });
      }
      if (c.ema_slow != null) {
        emaSlow.push({
          time: Math.floor(t / 1000),
          value: c.ema_slow,
        });
      }
    }

    candleSeries.setData(candleData);
    if (emaFast.length) emaFastSeries.setData(emaFast);
    if (emaSlow.length) emaSlowSeries.setData(emaSlow);

    hideLoadingOnce();

    // snapshot (read-only)
    window.__DARRIUS_CHART_STATE__ = {
      lastBar: candleData[candleData.length - 1],
      count: candleData.length,
    };

    window.dispatchEvent(
      new CustomEvent('darrius:chartUpdated', {
        detail: window.__DARRIUS_CHART_STATE__,
      })
    );
  }

  /* ---------------------------------------------------------
   * Polling Loop
   * --------------------------------------------------------- */
  async function pollOnce() {
    try {
      const agg = await fetchAggregates();
      updateSeries(agg);
    } catch (e) {
      console.error('[chart.core] poll error', e);
    }

    // sigs 是辅助，不允许影响主图
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
  initChartOnce();
  startPolling();

})();
