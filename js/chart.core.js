/* =========================================================================
 * DarriusAI - chart.core.js
 * FULL REPLACEABLE v2026.02.02-FINAL-V7 (CORS-SAFE + HARDER DIAGNOSTICS)
 * ========================================================================= */

console.log("=== chart.core.js ACTIVE BUILD: 2026-02-02 FINAL-V7 ===");
window.__CHART_CORE_ACTIVE__ = "2026-02-02 FINAL-V7";

(() => {
  'use strict';

  const POLL_INTERVAL = 15000;

  const API_BASE = String(window.__DARRIUS_API_BASE__ || "https://darrius-api.onrender.com")
    .replace(/\/+$/, "");

  const API_AGG  = `${API_BASE}/api/data/stocks/aggregates`;
  const API_SIGS = `${API_BASE}/api/market/sigs`;

  window.__DARRIUS_CHART_RUNTIME__ = window.__DARRIUS_CHART_RUNTIME__ || {};
  const R = window.__DARRIUS_CHART_RUNTIME__;

  if (!R.__ERR_HOOKED__) {
    R.__ERR_HOOKED__ = true;
    window.addEventListener('error', (e) => console.log('[window.onerror]', e && e.message));
    window.addEventListener('unhandledrejection', (e) => console.log('[unhandledrejection]', e && e.reason));
  }

  function writeMutant(msg) {
    try {
      const el =
        document.querySelector('#darrius-mutant') ||
        document.querySelector('.darrius-mutant') ||
        document.querySelector('[data-mutant]') ||
        document.querySelector('.mutant') ||
        null;
      if (el) el.textContent = String(msg || '');
    } catch (_) {}
  }

  function findChartContainer() {
    return (
      document.querySelector('#chart') ||
      document.querySelector('#main-chart') ||
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
    return !!(window.LightweightCharts && typeof window.LightweightCharts.createChart === 'function');
  }

  function initChart() {
    const container = findChartContainer();
    if (!container) {
      writeMutant('Darrius Mutant\nERROR: chart container NOT FOUND (#chart / .chart-container / [data-chart])');
      console.error('[chart.core] container not found');
      return false;
    }
    if (!canInitNow()) {
      writeMutant('Darrius Mutant\nERROR: LightweightCharts NOT READY (script not loaded?)');
      console.error('[chart.core] LightweightCharts not ready');
      return false;
    }

    const rect = ensureSize(container);
    console.log('[chart.core] init container:', { w: rect.width, h: rect.height, id: container.id, cls: container.className });

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

    return true;
  }

  // ---------- tolerant parsing ----------
  function num(x) {
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (typeof x === 'string' && x.trim() !== '') {
      const v = Number(x);
      if (Number.isFinite(v)) return v;
    }
    return null;
  }

  function normalizeTime(t) {
    const tt = num(t);
    if (tt === null) return null;
    if (tt > 10_000_000_000) return Math.floor(tt / 1000); // ms -> s
    return Math.floor(tt);
  }

  function extractRows(payload) {
    if (!payload) return [];

    const direct = [payload.candles, payload.results, payload.bars, payload.data];
    for (const x of direct) if (Array.isArray(x) && x.length) return x;

    const nested = [
      payload.data?.results, payload.data?.candles, payload.data?.bars,
      payload.payload?.results, payload.payload?.candles, payload.payload?.bars,
      payload.result?.results, payload.result?.candles, payload.result?.bars,
    ];
    for (const x of nested) if (Array.isArray(x) && x.length) return x;

    try {
      for (const k of Object.keys(payload)) {
        const v = payload[k];
        if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
          const r0 = v[0] || {};
          if (('o' in r0 || 'open' in r0) && ('c' in r0 || 'close' in r0)) return v;
        }
      }
    } catch (_) {}

    return [];
  }

  function updateSeries(payload, meta) {
    if (!R.candleSeries) return;

    const rows = extractRows(payload);
    if (!rows.length) {
      window.__LAST_AGG__ = payload;
      writeMutant(`Darrius Mutant\nAGG ERROR: No rows extracted\nkeys=${payload ? Object.keys(payload).join(',') : 'null'}`);
      return;
    }

    const candles = [];
    const emaFast = [];
    const emaSlow = [];

    for (const r of rows) {
      const time = normalizeTime(r.t ?? r.timestamp ?? r.time);
      if (!time) continue;

      const o = num(r.o ?? r.open);
      const h = num(r.h ?? r.high);
      const l = num(r.l ?? r.low);
      const c = num(r.c ?? r.close);
      if ([o, h, l, c].some(v => v === null)) continue;

      candles.push({ time, open: o, high: h, low: l, close: c });

      const ef = num(r.ema_fast);
      const es = num(r.ema_slow);
      if (ef !== null) emaFast.push({ time, value: ef });
      if (es !== null) emaSlow.push({ time, value: es });
    }

    if (!candles.length) {
      window.__LAST_AGG__ = payload;
      writeMutant(`Darrius Mutant\nAGG ERROR: rows exist but candles empty\nsample=${JSON.stringify(rows[0]).slice(0,160)}`);
      return;
    }

    try { R.candleSeries.setData(candles); } catch (e) {
      window.__LAST_AGG__ = payload;
      writeMutant(`Darrius Mutant\nsetData ERROR: ${String(e && e.message ? e.message : e)}`);
      return;
    }

    try { if (emaFast.length) R.emaFastSeries.setData(emaFast); } catch (_) {}
    try { if (emaSlow.length) R.emaSlowSeries.setData(emaSlow); } catch (_) {}

    const lastBar = candles[candles.length - 1];
    window.__DARRIUS_CHART_STATE__ = {
      symbol: meta?.symbol || window.__CURRENT_SYMBOL__ || '',
      timeframe: meta?.timeframe || window.__CURRENT_TIMEFRAME__ || '',
      count: candles.length,
      lastBar,
      ts: Date.now(),
    };

    window.__LAST_AGG__ = payload;

    writeMutant(`Darrius Mutant\nOK: ${window.__DARRIUS_CHART_STATE__.symbol} ${window.__DARRIUS_CHART_STATE__.timeframe}\nBars: ${candles.length}\nLast: ${lastBar.close}`);
    window.dispatchEvent(new CustomEvent('darrius:chartUpdated', { detail: window.__DARRIUS_CHART_STATE__ }));
  }

  // -------- fetch: CORS-safe (omit credentials) --------
  async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
    const text = await res.text();

    window.__LAST_AGG_HTTP__ = res.status;
    window.__LAST_AGG_TEXT_HEAD__ = text.slice(0, 300);

    let json = null;
    try { json = JSON.parse(text); } catch (_) {}

    if (!res.ok) throw new Error(`HTTP ${res.status} | ${text.slice(0, 140)}`);
    if (!json) throw new Error(`JSON parse failed | head=${text.slice(0, 140)}`);
    return json;
  }

  // -------- timeframe -> aggregates params --------
  function fmtDate(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function subDaysUTC(days) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - days);
    return d;
  }
  function timeframeToAggParams(tf) {
    const t = String(tf || '1D').toUpperCase();
    if (t === '1D') return { multiplier: 1, timespan: 'day', daysBack: 550 };
    if (t === '1W') return { multiplier: 1, timespan: 'week', daysBack: 2000 };
    if (t === '1M') return { multiplier: 1, timespan: 'month', daysBack: 5000 };
    if (t === '4H') return { multiplier: 4, timespan: 'hour', daysBack: 180 };
    if (t === '1H') return { multiplier: 1, timespan: 'hour', daysBack: 90 };
    if (t === '30M') return { multiplier: 30, timespan: 'minute', daysBack: 45 };
    if (t === '15M') return { multiplier: 15, timespan: 'minute', daysBack: 25 };
    if (t === '5M')  return { multiplier: 5,  timespan: 'minute', daysBack: 10 };
    return { multiplier: 1, timespan: 'day', daysBack: 550 };
  }

  // -------- read symbol/timeframe (minimal + safe) --------
  function readSymbol() {
    // Use your global if you already set it elsewhere
    const g = String(window.__CURRENT_SYMBOL__ || window.__DARRIUS_SYMBOL__ || '').trim();
    if (g) return g.toUpperCase();
    // fallback
    return 'TSLA';
  }
  function readTimeframe() {
    return String(window.__CURRENT_TIMEFRAME__ || window.__DARRIUS_TIMEFRAME__ || '1D').trim().toUpperCase();
  }

  function buildAggUrl(symbol, timeframe) {
    const p = timeframeToAggParams(timeframe);
    const from = fmtDate(subDaysUTC(p.daysBack));
    const to = fmtDate(subDaysUTC(0));

    const qs = new URLSearchParams();
    qs.set('ticker', symbol);
    qs.set('multiplier', String(p.multiplier));
    qs.set('timespan', String(p.timespan));
    qs.set('from', from);
    qs.set('to', to);

    // optional passthrough
    if (window.__DARRIUS_DATA_SOURCE__) qs.set('source', String(window.__DARRIUS_DATA_SOURCE__));
    if (window.__DARRIUS_PROVIDER__) qs.set('provider', String(window.__DARRIUS_PROVIDER__));

    return `${API_AGG}?${qs.toString()}`;
  }

  async function pollOnce() {
    const symbol = readSymbol().toUpperCase();
    const timeframe = readTimeframe();

    window.__CURRENT_SYMBOL__ = symbol;
    window.__CURRENT_TIMEFRAME__ = timeframe;

    try {
      const url = buildAggUrl(symbol, timeframe);
      window.__LAST_AGG_URL__ = url;
      window.__LAST_AGG_ERR__ = '';

      const json = await fetchJSON(url);
      updateSeries(json, { symbol, timeframe });
    } catch (e) {
      window.__LAST_AGG_ERR__ = String(e && e.message ? e.message : e);
      writeMutant(`Darrius Mutant\nAGG ERROR: ${window.__LAST_AGG_ERR__}\nHTTP: ${window.__LAST_AGG_HTTP__}\nHEAD: ${String(window.__LAST_AGG_TEXT_HEAD__ || '').slice(0,140)}`);
      console.error('[chart.core] poll error', e);
    }

    // signals (best-effort)
    try {
      const urlS = `${API_SIGS}?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`;
      window.__LAST_SIGS__ = await fetchJSON(urlS);
    } catch (_) {}
  }

  function startPolling() {
    if (R.pollingTimer) return;
    pollOnce();
    R.pollingTimer = setInterval(pollOnce, POLL_INTERVAL);
  }

  // boot loop
  let tries = 0;
  const t = setInterval(() => {
    tries += 1;
    if (!R.candleSeries) initChart();
    if (R.candleSeries) startPolling();
    if (R.candleSeries || tries > 200) clearInterval(t);
  }, 50);

})();
