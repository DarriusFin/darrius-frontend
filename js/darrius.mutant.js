/* forex.mutant.js (UI plugin) v2026.01.23
 * FOREX-MUTANT SYSTEM indicator panel (bottom sub-panel)
 *
 * Role:
 *  - Render a compact histogram panel aligned to main chart time scale
 *  - Read-only: uses DarriusChart.getSnapshot() (preferred) or __DARRIUS_CHART_STATE__ fallback
 *  - Uses DarriusChart.timeToX() to align bars horizontally
 *
 * Safety:
 *  - Never throws
 *  - Never touches billing/subscription logic
 *  - Never mutates chart.core.js internals
 */
(() => {
  'use strict';

  // -----------------------------
  // Absolute no-throw safe zone
  // -----------------------------
  function safe(fn, tag = 'forex.mutant') {
    try { return fn(); } catch (_) { return null; }
  }

  const $ = (id) => document.getElementById(id);

  // -----------------------------
  // Config (you can adjust safely)
  // -----------------------------
  const CFG = {
    // Panel
    hostId: 'mutantPanel',        // the container div id
    minHeight: 84,                // minimum height safeguard
    dprCap: 2,                    // cap devicePixelRatio for perf

    // Bar visuals (thin by default)
    barMinW: 2,                   // thinnest bar width (px)
    barMaxW: 6,                   // thickest bar width (px)
    barGapMin: 1,                 // minimum gap (px)
    barOpacity: 0.92,

    // Baseline / grid
    baselineAlpha: 0.18,
    gridAlpha: 0.06,
    gridLines: 2,                 // top/mid lines; keep subtle

    // Label
    title: 'FOREX-MUTANT SYSTEM',
    titleAlpha: 0.85,

    // Smoothing / normalization
    lookback: 220,                // how many bars to consider
    smooth: 3,                    // EMA smoothing window for histogram
    power: 0.92,                  // non-linear compression (smaller -> more contrast near 0)

    // Thresholds for colors
    posThr: 0.18,
    negThr: -0.18,

    // Update
    tickMs: 700,                  // UI refresh cadence (NO data hits)
  };

  // -----------------------------
  // Snapshot reader (multiple fallbacks)
  // -----------------------------
  function getSnapshot() {
    if (window.DarriusChart && typeof window.DarriusChart.getSnapshot === 'function') {
      const s = safe(() => window.DarriusChart.getSnapshot(), 'getSnapshot:DarriusChart');
      if (s) return s;
    }
    if (typeof window.getChartSnapshot === 'function') {
      const s = safe(() => window.getChartSnapshot(), 'getSnapshot:getChartSnapshot');
      if (s) return s;
    }
    if (window.__DARRIUS_CHART_STATE__) return window.__DARRIUS_CHART_STATE__;
    return null;
  }

  function pickCandles(snap) {
    if (!snap) return [];
    if (Array.isArray(snap.candles)) return snap.candles;
    if (Array.isArray(snap.bars)) return snap.bars;
    return [];
  }

  function pickLine(snap, keyA, keyB) {
    const a = snap && snap[keyA];
    if (Array.isArray(a)) return a;
    const b = snap && snap[keyB];
    if (Array.isArray(b)) return b;
    return [];
  }

  // normalize line points -> map time(sec|businessDay) => value
  function isBusinessDay(t) {
    return !!(t && typeof t === 'object' && t.year && t.month && t.day);
  }

  function timeKey(t) {
    if (isBusinessDay(t)) return `${t.year}-${t.month}-${t.day}`;
    return String(t);
  }

  function valueOfPoint(p) {
    if (p == null) return null;
    if (typeof p === 'number') return Number.isFinite(p) ? p : null;
    const v = p.value ?? p.v ?? null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function buildValueMap(lineArr) {
    const m = new Map();
    for (const p of (lineArr || [])) {
      const t = p && (p.time ?? p.t ?? p.timestamp ?? p.ts);
      if (t == null) continue;
      const v = valueOfPoint(p);
      if (!Number.isFinite(v)) continue;
      m.set(timeKey(t), v);
    }
    return m;
  }

  // -----------------------------
  // Mutant metric (simple but stable)
  //   We derive a histogram from:
  //     - delta(EMA-AUX) momentum + AUX slope regime
  //   Then normalize & smooth to [-1, +1]
  // -----------------------------
  function emaOnArray(vals, period) {
    const n = Math.max(1, Math.floor(period || 3));
    const k = 2 / (n + 1);
    let e = null;
    const out = new Array(vals.length);
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (!Number.isFinite(v)) { out[i] = NaN; continue; }
      e = (e == null) ? v : (v * k + e * (1 - k));
      out[i] = e;
    }
    return out;
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function computeMutantSeries(candles, emaMap, auxMap) {
    const n0 = candles.length;
    if (n0 < 10) return [];

    const n = Math.min(CFG.lookback, n0);
    const start = n0 - n;

    const raw = new Array(n).fill(NaN);

    // Compute raw signal: momentum of spread (EMA-AUX) + aux slope
    for (let i = 0; i < n; i++) {
      const b = candles[start + i];
      const k = timeKey(b.time);
      const e = emaMap.get(k);
      const a = auxMap.get(k);
      if (!Number.isFinite(e) || !Number.isFinite(a)) { raw[i] = NaN; continue; }

      const spread = (e - a);

      // prev
      let spreadPrev = null;
      if (i >= 1) {
        const b0 = candles[start + i - 1];
        const k0 = timeKey(b0.time);
        const e0 = emaMap.get(k0);
        const a0 = auxMap.get(k0);
        if (Number.isFinite(e0) && Number.isFinite(a0)) spreadPrev = (e0 - a0);
      }

      // aux slope
      let auxSlope = 0;
      if (i >= 1) {
        const b0 = candles[start + i - 1];
        const k0 = timeKey(b0.time);
        const a0 = auxMap.get(k0);
        if (Number.isFinite(a0)) auxSlope = (a - a0);
      }

      const mom = (spreadPrev == null) ? 0 : (spread - spreadPrev);

      // combine: momentum (dominant) + slope (secondary)
      // scale by price to be dimensionless-ish
      const px = Number(b.close);
      const base = Number.isFinite(px) ? Math.max(1e-9, Math.abs(px)) : Math.max(1e-9, Math.abs(e));
      let v = (mom / base) * 1200 + (auxSlope / base) * 520;

      // compress tails (nonlinear)
      const sign = v >= 0 ? 1 : -1;
      v = sign * Math.pow(Math.abs(v), CFG.power);

      raw[i] = v;
    }

    // Smooth
    const sm = emaOnArray(raw, CFG.smooth);

    // Normalize to [-1,1] using robust scale (p95)
    const absVals = sm.filter(Number.isFinite).map(x => Math.abs(x)).sort((a,b)=>a-b);
    const p95 = absVals.length ? absVals[Math.floor(absVals.length * 0.95)] : 1;
    const scale = Math.max(1e-9, p95);

    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = sm[i];
      const b = candles[start + i];
      if (!Number.isFinite(v)) { out[i] = { time: b.time, v: 0 }; continue; }
      out[i] = { time: b.time, v: clamp(v / scale, -1, 1) };
    }
    return out;
  }

  // -----------------------------
  // Canvas layer
  // -----------------------------
  const STATE = {
    host: null,
    canvas: null,
    ctx: null,
    w: 0,
    h: 0,
    dpr: 1,
    lastKey: '',
  };

  function ensureHost() {
    return safe(() => {
      const host = $(CFG.hostId);
      if (!host) return null;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      return host;
    }, 'ensureHost');
  }

  function ensureCanvas(host) {
    return safe(() => {
      if (!host) return null;

      let c = host.querySelector('canvas[data-mutant="1"]');
      if (!c) {
        c = document.createElement('canvas');
        c.setAttribute('data-mutant', '1');
        c.style.width = '100%';
        c.style.height = '100%';
        c.style.display = 'block';
        c.style.pointerEvents = 'none';
        host.appendChild(c);
      }
      return c;
    }, 'ensureCanvas');
  }

  function resizeCanvas() {
    return safe(() => {
      const host = STATE.host;
      if (!host || !STATE.canvas) return;

      const r = host.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width));
      const h = Math.max(CFG.minHeight, Math.floor(r.height));

      const dpr = Math.min(CFG.dprCap, Math.max(1, window.devicePixelRatio || 1));

      STATE.w = w; STATE.h = h; STATE.dpr = dpr;

      STATE.canvas.width = Math.floor(w * dpr);
      STATE.canvas.height = Math.floor(h * dpr);

      const ctx = STATE.canvas.getContext('2d');
      STATE.ctx = ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }, 'resizeCanvas');
  }

  function observeResize() {
    safe(() => {
      const host = STATE.host;
      if (!host) return;
      try {
        new ResizeObserver(() => {
          resizeCanvas();
          render(); // re-render on size change
        }).observe(host);
      } catch (_) {
        window.addEventListener('resize', () => {
          resizeCanvas();
          render();
        });
      }
    }, 'observeResize');
  }

  // -----------------------------
  // Drawing helpers
  // -----------------------------
  function clear(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
  }

  function drawGrid(ctx, w, h) {
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${CFG.gridAlpha})`;
    ctx.lineWidth = 1;

    // horizontal subtle lines
    const lines = Math.max(0, CFG.gridLines | 0);
    for (let i = 1; i <= lines; i++) {
      const y = Math.floor((h * i) / (lines + 1)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // baseline at mid
    const y0 = Math.floor(h / 2) + 0.5;
    ctx.strokeStyle = `rgba(255,255,255,${CFG.baselineAlpha})`;
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(w, y0);
    ctx.stroke();

    ctx.restore();
  }

  function drawTitle(ctx, w) {
    ctx.save();
    ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial';
    ctx.fillStyle = `rgba(234,240,247,${CFG.titleAlpha})`;
    ctx.textBaseline = 'top';
    ctx.fillText(CFG.title, 8, 6);
    ctx.restore();
  }

  // adaptive bar width based on visible candle density
  function computeBarW(xs) {
    if (!xs || xs.length < 2) return { w: 3, gap: 2 };

    // estimate median dx
    const dxs = [];
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i] - xs[i - 1];
      if (Number.isFinite(d) && d > 0) dxs.push(d);
    }
    dxs.sort((a,b)=>a-b);
    const med = dxs.length ? dxs[(dxs.length / 2) | 0] : 6;

    // keep them thin: bar = 0.55*dx, gap = rest
    let bw = Math.floor(med * 0.55);
    bw = clamp(bw, CFG.barMinW, CFG.barMaxW);

    let gap = Math.max(CFG.barGapMin, Math.floor(med - bw));
    gap = clamp(gap, CFG.barGapMin, 10);

    return { w: bw, gap };
  }

  function colorFor(v) {
    // v in [-1,1]
    if (v >= CFG.posThr) return `rgba(43,226,166,${CFG.barOpacity})`;      // green-ish
    if (v <= CFG.negThr) return `rgba(255,90,90,${CFG.barOpacity})`;       // red-ish
    return `rgba(255,212,0,${CFG.barOpacity * 0.78})`;                     // yellow-ish neutral
  }

  function render() {
    return safe(() => {
      const ctx = STATE.ctx;
      const w = STATE.w;
      const h = STATE.h;
      if (!ctx || !w || !h) return;

      const snap = getSnapshot();
      const candles = pickCandles(snap);
      if (!candles || candles.length < 10) {
        clear(ctx, w, h);
        drawGrid(ctx, w, h);
        drawTitle(ctx, w);
        return;
      }

      // timeToX bridge required for alignment
      const timeToX = window.DarriusChart && typeof window.DarriusChart.timeToX === 'function'
        ? window.DarriusChart.timeToX : null;
      if (!timeToX) {
        clear(ctx, w, h);
        drawGrid(ctx, w, h);
        drawTitle(ctx, w);
        return;
      }

      // data lines
      const emaArr = pickLine(snap, 'ema', 'emaData');
      const auxArr = pickLine(snap, 'aux', 'auxData');
      const emaMap = buildValueMap(emaArr);
      const auxMap = buildValueMap(auxArr);

      const mutant = computeMutantSeries(candles, emaMap, auxMap);
      if (!mutant.length) {
        clear(ctx, w, h);
        drawGrid(ctx, w, h);
        drawTitle(ctx, w);
        return;
      }

      // precompute x coords; keep only those in view
      const xs = [];
      const pts = [];
      for (const p of mutant) {
        const x = timeToX(p.time);
        if (!Number.isFinite(x)) continue;
        if (x < -20 || x > w + 20) continue;
        xs.push(x);
        pts.push({ x, v: p.v });
      }

      clear(ctx, w, h);
      drawGrid(ctx, w, h);
      drawTitle(ctx, w);

      if (pts.length < 2) return;

      const bw = computeBarW(xs);
      const barW = bw.w;

      const midY = h / 2;
      const amp = (h * 0.42); // amplitude
      ctx.save();

      // draw bars
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const v = clamp(p.v, -1, 1);
        const y = midY - v * amp;
        const x0 = Math.round(p.x - barW / 2);

        ctx.fillStyle = colorFor(v);

        if (v >= 0) {
          // positive bar: up from baseline to y
          const top = Math.min(y, midY);
          const hh = Math.max(1, Math.abs(midY - y));
          ctx.fillRect(x0, top, barW, hh);
        } else {
          // negative bar: down from baseline to y
          const top = Math.min(midY, y);
          const hh = Math.max(1, Math.abs(midY - y));
          ctx.fillRect(x0, top, barW, hh);
        }
      }

      ctx.restore();
    }, 'render');
  }

  // -----------------------------
  // Boot
  // -----------------------------
  function boot() {
    STATE.host = ensureHost();
    if (!STATE.host) return;

    STATE.canvas = ensureCanvas(STATE.host);
    if (!STATE.canvas) return;

    resizeCanvas();
    observeResize();

    render();

    // re-render on chart update event
    safe(() => {
      window.addEventListener('darrius:chartUpdated', () => {
        requestAnimationFrame(() => render());
      });
    }, 'bindChartUpdated');

    // periodic UI refresh (NO data hits)
    setInterval(render, CFG.tickMs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
