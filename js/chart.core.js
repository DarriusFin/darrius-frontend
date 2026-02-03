/* =========================================================================
 * DarriusAI - chart.core.js
 * FINAL v5 (UI-BIND + FROM/TO + HEADERS + NO-PENDING)
 * - Works with backend /api/data/stocks/aggregates (ticker/multiplier/timespan/from/to)
 * - Pulls symbol/timeframe from UI DOM (Control Center) if globals not set
 * - Emits rich snapshot for market.pulse.js
 * - Writes diagnostics into "Darrius Mutant" panel if present
 * ========================================================================= */

console.log("=== chart.core.js ACTIVE BUILD: 2026-02-02 FINAL-V5 ===");
window.__CHART_CORE_ACTIVE__ = "2026-02-02 FINAL-V5";

(() => {
  'use strict';

  const POLL_INTERVAL = 15000;

  // API base (must be render backend; do NOT default to "/api" because GH Pages)
  const API_BASE = String(window.__DARRIUS_API_BASE__ || "https://darrius-api.onrender.com").replace(/\/+$/, "");
  const API_AGG  = `${API_BASE}/api/data/stocks/aggregates`;
  const API_SIGS = `${API_BASE}/api/market/sigs`;

  // Runtime (always visible in console)
  window.__DARRIUS_CHART_RUNTIME__ = window.__DARRIUS_CHART_RUNTIME__ || {};
  const R = window.__DARRIUS_CHART_RUNTIME__;

  // Hard error hooks (avoid silent failure)
  if (!R.__ERR_HOOKED__) {
    R.__ERR_HOOKED__ = true;
    window.addEventListener('error', (e) => console.log('[window.onerror]', e.message));
    window.addEventListener('unhandledrejection', (e) => console.log('[unhandledrejection]', e.reason));
  }

  // -----------------------------
  // DOM helpers (robust selectors)
  // -----------------------------
  function $(sel) { try { return document.querySelector(sel); } catch (_) { return null; } }
  function $all(sel) { try { return Array.from(document.querySelectorAll(sel)); } catch (_) { return []; } }

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

  // -----------------------------
  // UI -> state (Symbol/Timeframe)
  // -----------------------------
  function readSymbolFromUI() {
    // Try common inputs in your Control Center
    const candidates = [
      '#symbol',
      '#symbolInput',
      'input[name="symbol"]',
      'input[data-role="symbol"]',
      '.market-symbol input',
      '.control-center input[type="text"]',
    ];
    for (const sel of candidates) {
      const el = $(sel);
      const v = (el && el.value) ? String(el.value).trim() : '';
      if (v) return v;
    }

    // Also try text nodes that show "BTCUSDT"
    const textCandidates = [
      '#current-symbol',
      '[data-current-symbol]',
      '.symbol-value',
      '.market-symbol-value'
    ];
    for (const sel of textCandidates) {
      const el = $(sel);
      const v = el ? String(el.textContent || '').trim() : '';
      if (v && v.length <= 20) return v;
    }

    // Fallback to global
    return String(window.__CURRENT_SYMBOL__ || window.__DARRIUS_SYMBOL__ || 'TSLA').trim();
  }

  function readTimeframeFromUI() {
    // If you have a select dropdown
    const sel = $('#timeframe') || $('#timeframeSelect') || $('select[name="timeframe"]') || $('select[data-role="timeframe"]');
    if (sel && sel.value) return String(sel.value).trim();

    // If you have active button pills (5m/15m/1h/1D/1W/1M)
    const activeBtn =
      $('.tf-btn.active') ||
      $('.timeframe button.active') ||
      $('.timeframe .active') ||
      $('[data-tf].active');

    if (activeBtn) {
      const tf = activeBtn.getAttribute('data-tf') || activeBtn.textContent;
      if (tf) return String(tf).trim();
    }

    return String(window.__CURRENT_TIMEFRAME__ || window.__DARRIUS_TIMEFRAME__ || '1D').trim();
  }

  // Map UI timeframe -> backend params + range days
  function tfToAggParams(tf) {
    const t = String(tf || '').toUpperCase();

    // default
    let multiplier = 1;
    let timespan = 'day';
    let rangeDays = 365;

    if (t === '5M' || t === '5MIN')  { multiplier = 5;  timespan = 'minute'; rangeDays = 45; }
    if (t === '15M')                  { multiplier = 15; timespan = 'minute'; rangeDays = 120; }
    if (t === '30M')                  { multiplier = 30; timespan = 'minute'; rangeDays = 180; }
    if (t === '1H' || t === '60M')    { multiplier = 1;  timespan = 'hour';   rangeDays = 365; }
    if (t === '4H')                   { multiplier = 4;  timespan = 'hour';   rangeDays = 365 * 2; }
    if (t === '1D' || t === 'D')      { multiplier = 1;  timespan = 'day';    rangeDays = 365 * 2; }
    if (t === '1W' || t === 'W')      { multiplier = 1;  timespan = 'week';   rangeDays = 365 * 6; }
    if (t === '1M' || t === 'M')      { multiplier = 1;  timespan = 'month';  rangeDays = 365 * 10; }

    return { multiplier, timespan, rangeDays };
  }

  function fmtDate(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function buildAggURL(symbol, timeframe) {
    const sym = String(symbol || 'TSLA').trim().toUpperCase();
    const tf = String(timeframe || '1D').trim();

    const { multiplier, timespan, rangeDays } = tfToAggParams(tf);
    const to = new Date();
    const from = new Date(Date.now() - rangeDays * 24 * 3600 * 1000);

    // IMPORTANT: backend expects ticker/from/to
    const qs = new URLSearchParams();
    qs.set('ticker', sym);
    qs.set('multiplier', String(multiplier));
    qs.set('timespan', String(timespan));
    qs.set('from', fmtDate(from));
    qs.set('to', fmtDate(to));
    qs.set('adjusted', 'true');
    qs.set('sort', 'asc');
    qs.set('limit', '5000');
    qs.set('provider', 'auto'); // let backend choose (Twelve Data vs Massive)
    // qs.set('source', 'demo'); // optional; keep current policy at backend

    const url = `${API_AGG}?${qs.toString()}`;
    window.__LAST_AGG_URL__ = url;
    return url;
  }

  function buildSigsURL(symbol, timeframe) {
    const sym = String(symbol || 'TSLA').trim().toUpperCase();
    const tf = String(timeframe || '1D').trim();
    const qs = new URLSearchParams();
    qs.set('symbol', sym);
    qs.set('timeframe', tf);
    const url = `${API_SIGS}?${qs.toString()}`;
    window.__LAST_SIGS_URL__ = url;
    return url;
  }

  // -----------------------------
  // Chart init
  // -----------------------------
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

  // -----------------------------
  // Payload extract + normalize
  // -----------------------------
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
    if (t > 10_000_000_000) return Math.floor(t / 1000); // ms -> s
    return Math.floor(t);
  }

  function writeMutantPanel(lines) {
    const el =
      $('#darrius-mutant') ||
      $('#mutant') ||
      $('[data-mutant]') ||
      $('.darrius-mutant');
    if (!el) return;
    el.textContent = Array.isArray(lines) ? lines.join('\n') : String(lines || '');
  }

  function updateSeries(payload, meta) {
    if (!R.candleSeries) return;

    const rows = extractRows(payload);
    window.__LAST_AGG__ = payload;

    if (!Array.isArray(rows) || rows.length === 0) {
      console.error('[chart.core] NO ROWS extracted. payload keys:', payload ? Object.keys(payload) : null);
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
      return;
    }

    try { R.candleSeries.setData(candles); } catch (e) { console.error('[chart.core] setData candles error', e); }
    try { if (emaFast.length) R.emaFastSeries.setData(emaFast); } catch (_) {}
    try { if (emaSlow.length) R.emaSlowSeries.setData(emaSlow); } catch (_) {}

    hideLoadingOnce();

    const last = candles[candles.length - 1];
    const snap = {
      symbol: meta?.symbol,
      timeframe: meta?.timeframe,
      count: candles.length,
      lastBar: last,
      headers: meta?.headers || {},
      sigs: window.__LAST_SIGS__ || null,
      sigsError: window.__LAST_SIGS_ERR__ || null,
      ts: Date.now(),
    };

    window.__DARRIUS_CHART_STATE__ = snap;
    window.dispatchEvent(new CustomEvent('darrius:chartUpdated', { detail: snap }));

    // Fill mutant panel (bottom yellow box)
    const h = snap.headers || {};
    writeMutantPanel([
      `Darrius Mutant`,
      `symbol=${snap.symbol}  tf=${snap.timeframe}  bars=${snap.count}`,
      `lastClose=${(last && last.close != null) ? last.close : 'n/a'}  t=${(last && last.time != null) ? last.time : 'n/a'}`,
      `X-Data-Source=${h['x-data-source'] || h['X-Data-Source'] || 'n/a'}  X-Entitlement=${h['x-entitlement'] || h['X-Entitlement'] || 'n/a'}`,
      `X-Cache=${h['x-cache'] || h['X-Cache'] || 'n/a'}  X-Upstream=${h['x-upstream'] || h['X-Upstream'] || 'n/a'}`,
      `agg=${String(window.__LAST_AGG_URL__ || '').slice(0, 120)}`
    ]);
  }

  // -----------------------------
  // fetch with timeout (no pending)
  // -----------------------------
  async function fetchTextWithTimeout(url, ms = 12000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, {
        cache: 'no-store',
        credentials: 'include',
        signal: ctrl.signal
      });
      const text = await res.text();
      return { res, text };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchJSON(url) {
    const { res, text } = await fetchTextWithTimeout(url, 12000);
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
    return { json, res };
  }

  function lowerHeaderMap(res) {
    const out = {};
    try {
      for (const [k, v] of res.headers.entries()) out[k] = v;
    } catch (_) {}
    return out;
  }

  // -----------------------------
  // polling
  // -----------------------------
  async function pollOnce() {
    const symbol = readSymbolFromUI();
    const timeframe = readTimeframeFromUI();

    // persist to globals (so other modules can read)
    window.__CURRENT_SYMBOL__ = symbol;
    window.__CURRENT_TIMEFRAME__ = timeframe;

    // 1) aggregates (hard requirement)
    try {
      const urlAgg = buildAggURL(symbol, timeframe);
      const { json, res } = await fetchJSON(urlAgg);
      const headers = lowerHeaderMap(res);
      updateSeries(json, { symbol, timeframe, headers });
    } catch (e) {
      console.error('[chart.core] aggregates poll error', e);
      window.__LAST_AGG_ERR__ = String(e && e.message ? e.message : e);
    }

    // 2) sigs (best-effort)
    try {
      const urlS = buildSigsURL(symbol, timeframe);
      const { json } = await fetchJSON(urlS);
      window.__LAST_SIGS__ = json;
      window.__LAST_SIGS_ERR__ = null;
    } catch (e) {
      window.__LAST_SIGS_ERR__ = String(e && e.message ? e.message : e);
    }
  }

  function startPolling() {
    if (R.pollingTimer) return;
    pollOnce();
    R.pollingTimer = setInterval(pollOnce, POLL_INTERVAL);
  }

  function forceRefreshNow() {
    try {
      pollOnce();
    } catch (_) {}
  }

  // Bind "Symbol Load" button (right yellow box behavior)
  function bindUILoadButton() {
    const btn =
      $('#symbol-load') ||
      $('#btnSymbolLoad') ||
      $('button[data-action="symbol-load"]') ||
      $all('button').find(b => /Symbol\s*Load/i.test(b.textContent || ''));
    if (!btn || btn.__DARRIUS_BOUND__) return;
    btn.__DARRIUS_BOUND__ = true;
    btn.addEventListener('click', () => {
      // reset loading so user sees it
      R.loadingClosed = false;
      showLoading();
      forceRefreshNow();
    });
  }

  // Boot loop (defeat layout timing)
  let tries = 0;
  const t = setInterval(() => {
    tries += 1;

    bindUILoadButton();

    if (!R.candleSeries) {
      showLoading();
      initChart();
    }
    if (R.candleSeries) startPolling();

    if (R.candleSeries || tries > 200) clearInterval(t);
  }, 80);

})();
