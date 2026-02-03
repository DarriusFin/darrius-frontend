/* =========================================================================
 * DarriusAI - chart.core.js
 * FULL REPLACEABLE v2026.02.02-FINAL-V6
 *
 * Goals:
 *  - Render main chart (candles + EMA series if backend provides)
 *  - Fetch aggregates via backend proxy:
 *      GET {API_BASE}/api/data/stocks/aggregates
 *        ?ticker=TSLA&multiplier=1&timespan=day&from=YYYY-MM-DD&to=YYYY-MM-DD
 *        [&source=demo|provider] [&provider=auto|twelvedata|massive]
 *  - Fetch signals (best-effort only):
 *      GET {API_BASE}/api/market/sigs?symbol=TSLA&timeframe=1D
 *  - Robust payload extraction (Polygon/Massive/TwelveData normalized/loosely-compatible)
 *  - Hard diagnostics:
 *      window.__LAST_AGG_URL__, window.__LAST_AGG__, window.__LAST_AGG_ERR__
 *      window.__CURRENT_SYMBOL__, window.__CURRENT_TIMEFRAME__
 *  - Never touch subscription / billing / UI logic
 * ========================================================================= */

console.log("=== chart.core.js ACTIVE BUILD: 2026-02-02 FINAL-V6 ===");
window.__CHART_CORE_ACTIVE__ = "2026-02-02 FINAL-V6";

(() => {
  'use strict';

  // -----------------------------
  // Config
  // -----------------------------
  const POLL_INTERVAL = 15000;

  const API_BASE = String(window.__DARRIUS_API_BASE__ || "https://darrius-api.onrender.com")
    .replace(/\/+$/, "");

  const API_AGG  = `${API_BASE}/api/data/stocks/aggregates`;
  const API_SIGS = `${API_BASE}/api/market/sigs`;

  // If you want to pass source/provider by frontend (optional)
  // window.__DARRIUS_DATA_SOURCE__ = "demo" | "provider"
  // window.__DARRIUS_PROVIDER__    = "auto" | "twelvedata" | "massive"
  const DEFAULT_SOURCE   = String(window.__DARRIUS_DATA_SOURCE__ || "").trim().toLowerCase();   // "" means omit
  const DEFAULT_PROVIDER = String(window.__DARRIUS_PROVIDER__ || "").trim().toLowerCase();      // "" means omit

  // Global runtime (always visible in console)
  window.__DARRIUS_CHART_RUNTIME__ = window.__DARRIUS_CHART_RUNTIME__ || {};
  const R = window.__DARRIUS_CHART_RUNTIME__;

  // Capture unexpected errors (avoid silent failure)
  if (!R.__ERR_HOOKED__) {
    R.__ERR_HOOKED__ = true;
    window.addEventListener('error', (e) => console.log('[window.onerror]', e && e.message));
    window.addEventListener('unhandledrejection', (e) => console.log('[unhandledrejection]', e && e.reason));
    console.log('err hook ready');
  }

  // -----------------------------
  // DOM helpers
  // -----------------------------
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

  // Put errors into "Darrius Mutant" panel (if exists)
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

  // -----------------------------
  // Chart init
  // -----------------------------
  function canInitNow() {
    return !!(window.LightweightCharts && typeof window.LightweightCharts.createChart === 'function');
  }

  function initChart() {
    const container = findChartContainer();
    if (!container) {
      console.error('[chart.core] #chart container NOT FOUND');
      writeMutant('Darrius Mutant\nERROR: #chart container not found');
      return false;
    }
    if (!canInitNow()) {
      console.error('[chart.core] LightweightCharts NOT READY');
      writeMutant('Darrius Mutant\nERROR: LightweightCharts not ready');
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

  // -----------------------------
  // UI reading (FIX: never read "User ID" as symbol)
  // -----------------------------
  function isLikelySymbol(v) {
    const s = String(v || '').trim().toUpperCase();
    if (!s) return false;
    // Crypto pairs like BTCUSDT, ETHUSDT, BTCUSD etc
    if (/^[A-Z]{2,10}(USDT|USD|USDC)$/.test(s)) return true;
    // Stock symbols TSLA / BRK.B / RIVN / etc
    if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) return true;
    return false;
  }

  function normalizeSymbol(v) {
    return String(v || '').trim().toUpperCase();
  }

  function readSymbolFromUI() {
    // 1) Strong selectors (if you ever add them, this becomes perfect)
    const strongCandidates = [
      '#symbol',
      '#symbolInput',
      'input[name="symbol"]',
      'input[data-role="symbol"]',
    ];
    for (const sel of strongCandidates) {
      const el = document.querySelector(sel);
      const v = (el && el.value) ? String(el.value).trim() : '';
      if (isLikelySymbol(v)) return normalizeSymbol(v);
    }

    // 2) Search within Control Center only, but exclude user/email fields.
    const cc = document.querySelector('.control-center') || document;

    // Gather candidate texts from inputs + visible blocks
    const nodes = Array.from(cc.querySelectorAll('input, textarea, div, span, p'))
      .map(el => {
        const tag = (el.tagName || '').toUpperCase();
        const v = (tag === 'INPUT' || tag === 'TEXTAREA') ? (el.value || '') : (el.textContent || '');
        return { el, v: String(v || '').trim() };
      })
      .filter(x => x.v && x.v.length <= 30);

    // Helper: exclude user/email/id-ish controls by nearby label text
    function looksLikeUserField(x) {
      const el = x.el;
      const tag = (el.tagName || '').toUpperCase();
      const name = String(el.getAttribute('name') || '').toLowerCase();
      const id = String(el.getAttribute('id') || '').toLowerCase();
      const ph = tag === 'INPUT' ? String(el.getAttribute('placeholder') || '').toLowerCase() : '';
      const near = (el.closest('.field, .row, .form-group, .control, .section') || el.parentElement);
      const nearText = near ? String(near.textContent || '').toLowerCase() : '';

      // explicit markers
      if (name.includes('user') || name.includes('email')) return true;
      if (id.includes('user') || id.includes('email')) return true;
      if (ph.includes('user') || ph.includes('email')) return true;
      if (nearText.includes('user id') || nearText.includes('email') || nearText.includes('邮箱') || nearText.includes('用户')) return true;

      // value patterns
      const v = String(x.v || '');
      if (v.includes('@')) return true;                 // email
      if (/^darrius/i.test(v)) return true;             // your user naming pattern
      if (v.toLowerCase() === 'id') return true;        // the exact bug you hit
      return false;
    }

    // 3) Prefer candidates near "Symbol/品种"
    for (const x of nodes) {
      if (looksLikeUserField(x)) continue;
      const near = (x.el.closest('.field, .row, .form-group, .control, .section') || x.el.parentElement);
      const nearText = near ? String(near.textContent || '').toLowerCase() : '';
      if (nearText.includes('symbol') || nearText.includes('品种')) {
        if (isLikelySymbol(x.v)) return normalizeSymbol(x.v);
      }
    }

    // 4) Fallback scan: pick first likely symbol, excluding numeric-heavy strings
    for (const x of nodes) {
      if (looksLikeUserField(x)) continue;
      const v = String(x.v || '');
      if (/\s/.test(v)) continue;
      if (v.length > 15) continue;
      // Exclude values with lots of digits (user ids)
      if ((v.match(/\d/g) || []).length >= 2) continue;
      if (isLikelySymbol(v)) return normalizeSymbol(v);
    }

    // 5) Final fallback
    return normalizeSymbol(window.__CURRENT_SYMBOL__ || window.__DARRIUS_SYMBOL__ || 'TSLA');
  }

  function readTimeframeFromUI() {
    const sel =
      document.querySelector('#timeframe') ||
      document.querySelector('#timeframeSelect') ||
      document.querySelector('select[name="timeframe"]') ||
      document.querySelector('select[data-role="timeframe"]');

    let raw = '';
    if (sel && sel.value) raw = String(sel.value).trim();
    if (!raw) raw = String(window.__CURRENT_TIMEFRAME__ || window.__DARRIUS_TIMEFRAME__ || '1D').trim();

    // accept "1d - 日线" etc
    const u = raw.toUpperCase();
    if (u.startsWith('1D')) return '1D';
    if (u.startsWith('1W')) return '1W';
    if (u.startsWith('1M')) return '1M';
    if (u.startsWith('4H')) return '4H';
    if (u.startsWith('1H')) return '1H';
    if (u.startsWith('30M')) return '30M';
    if (u.startsWith('15M')) return '15M';
    if (u.startsWith('5M')) return '5M';
    return u || '1D';
  }

  // -----------------------------
  // Timeframe -> aggregates params
  // -----------------------------
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
    // Choose sane windows so you get enough candles but not insane.
    // You can tune later without breaking anything.
    const t = String(tf || '1D').toUpperCase();

    // default to daily 400-550 bars
    if (t === '1D') return { multiplier: 1, timespan: 'day', daysBack: 550 };
    if (t === '1W') return { multiplier: 1, timespan: 'week', daysBack: 2000 };
    if (t === '1M') return { multiplier: 1, timespan: 'month', daysBack: 5000 };

    if (t === '4H') return { multiplier: 4, timespan: 'hour', daysBack: 180 };
    if (t === '1H') return { multiplier: 1, timespan: 'hour', daysBack: 90 };

    if (t === '30M') return { multiplier: 30, timespan: 'minute', daysBack: 45 };
    if (t === '15M') return { multiplier: 15, timespan: 'minute', daysBack: 25 };
    if (t === '5M')  return { multiplier: 5,  timespan: 'minute', daysBack: 10 };

    // fallback
    return { multiplier: 1, timespan: 'day', daysBack: 550 };
  }

  // -----------------------------
  // Payload extraction (robust)
  // -----------------------------
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

  function normalizeTime(t) {
    // t could be seconds or milliseconds
    if (typeof t !== 'number') return null;
    if (t > 10_000_000_000) return Math.floor(t / 1000); // ms -> s
    return Math.floor(t); // already seconds
  }

  function updateSeries(payload, meta) {
    if (!R.candleSeries) return;

    const rows = extractRows(payload);

    if (!Array.isArray(rows) || rows.length === 0) {
      console.error('[chart.core] NO ROWS extracted. payload keys:', payload ? Object.keys(payload) : null);
      window.__LAST_AGG__ = payload;
      writeMutant(`Darrius Mutant\nAGG ERROR: No rows extracted\nkeys=${payload ? Object.keys(payload).join(',') : 'null'}`);
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

      // optional EMA from backend
      if (typeof r.ema_fast === 'number') emaFast.push({ time, value: r.ema_fast });
      if (typeof r.ema_slow === 'number') emaSlow.push({ time, value: r.ema_slow });
    }

    if (!candles.length) {
      console.error('[chart.core] rows extracted BUT normalized candles empty. sample row=', rows[0]);
      window.__LAST_AGG__ = payload;
      writeMutant(`Darrius Mutant\nAGG ERROR: rows extracted but candles empty\nsample=${JSON.stringify(rows[0]).slice(0,120)}`);
      return;
    }

    try { R.candleSeries.setData(candles); } catch (e) { console.error('[chart.core] setData candles error', e); }
    try { if (emaFast.length) R.emaFastSeries.setData(emaFast); } catch (_) {}
    try { if (emaSlow.length) R.emaSlowSeries.setData(emaSlow); } catch (_) {}

    hideLoadingOnce();

    // snapshot
    const lastBar = candles[candles.length - 1];
    window.__DARRIUS_CHART_STATE__ = {
      symbol: meta?.symbol || window.__CURRENT_SYMBOL__ || '',
      timeframe: meta?.timeframe || window.__CURRENT_TIMEFRAME__ || '',
      count: candles.length,
      lastBar,
      // keep useful upstream headers if you want later (optional)
      headers: meta?.headers || null,
      ts: Date.now(),
    };

    window.__LAST_AGG__ = payload;

    // Update Mutant with a simple heartbeat
    writeMutant(
      `Darrius Mutant\nOK: ${window.__DARRIUS_CHART_STATE__.symbol} ${window.__DARRIUS_CHART_STATE__.timeframe}\nBars: ${candles.length}\nLast: ${lastBar.close}`
    );

    window.dispatchEvent(new CustomEvent('darrius:chartUpdated', { detail: window.__DARRIUS_CHART_STATE__ }));
  }

  // -----------------------------
  // Fetch helper
  // -----------------------------
  async function fetchText(url) {
    const res = await fetch(url, { cache: 'no-store', credentials: 'include' });
    const text = await res.text();
    return { res, text };
  }

  async function fetchJSON(url) {
    const { res, text } = await fetchText(url);
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}

    if (!res.ok) {
      console.error('[chart.core] fetch failed', res.status, url, 'body=', text.slice(0, 240));
      throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
    }
    if (!json) {
      console.error('[chart.core] JSON parse failed. url=', url, 'body head=', text.slice(0, 240));
      throw new Error('JSON parse failed');
    }
    return { json, headers: res.headers };
  }

  // -----------------------------
  // Poll
  // -----------------------------
  function buildAggUrl(symbol, timeframe) {
    const s = normalizeSymbol(symbol);
    const tf = String(timeframe || '1D').toUpperCase();

    const p = timeframeToAggParams(tf);
    const from = fmtDate(subDaysUTC(p.daysBack));
    const to = fmtDate(subDaysUTC(0));

    const qs = new URLSearchParams();
    qs.set('ticker', s);
    qs.set('multiplier', String(p.multiplier));
    qs.set('timespan', String(p.timespan));
    qs.set('from', from);
    qs.set('to', to);

    // optional passthrough (does not break if backend ignores)
    if (DEFAULT_SOURCE) qs.set('source', DEFAULT_SOURCE);
    if (DEFAULT_PROVIDER) qs.set('provider', DEFAULT_PROVIDER);

    return `${API_AGG}?${qs.toString()}`;
  }

  async function pollOnce() {
    const symbol = readSymbolFromUI();
    const timeframe = readTimeframeFromUI();

    // publish current selection to globals (for your console checks)
    window.__CURRENT_SYMBOL__ = symbol;
    window.__CURRENT_TIMEFRAME__ = timeframe;

    // -------- aggregates: must succeed
    try {
      const urlAgg = buildAggUrl(symbol, timeframe);
      window.__LAST_AGG_URL__ = urlAgg;
      window.__LAST_AGG_ERR__ = '';

      const { json, headers } = await fetchJSON(urlAgg);

      // Keep a few useful headers (CORS-safe ones only; custom headers may be blocked by browser)
      const h = {};
      try {
        ['x-data-source', 'x-entitlement', 'x-cache', 'x-upstream', 'x-provider'].forEach(k => {
          const v = headers.get(k);
          if (v) h[k] = v;
        });
      } catch (_) {}

      updateSeries(json, { symbol, timeframe, headers: h });
    } catch (e) {
      console.error('[chart.core] aggregates poll error', e);
      window.__LAST_AGG_ERR__ = String(e && e.message ? e.message : e);
      writeMutant(`Darrius Mutant\nAGG ERROR: ${window.__LAST_AGG_ERR__}\nURL: ${String(window.__LAST_AGG_URL__ || '').slice(0,160)}`);
      // do not throw (keep loop alive)
    }

    // -------- sigs: best-effort only (won't break chart)
    try {
      const urlS = `${API_SIGS}?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`;
      window.__LAST_SIGS__ = (await fetchJSON(urlS)).json;
    } catch (_) {}
  }

  function startPolling() {
    if (R.pollingTimer) return;
    pollOnce();
    R.pollingTimer = setInterval(pollOnce, POLL_INTERVAL);
  }

  // -----------------------------
  // Boot loop (defeat layout timing)
  // -----------------------------
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
