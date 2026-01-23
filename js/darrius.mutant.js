/* darrius.mutant.js (UI plugin) v2026.01.23b
 * Darrius Mutant indicator panel (bottom sub-panel)
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
  function safe(fn, tag = 'darrius.mutant') {
    try { return fn(); } catch (e) { return null; }
  }

  const $ = (id) => document.getElementById(id);

  // -----------------------------
  // Config (safe to tweak)
  // -----------------------------
  const CFG = {
    // Panel
    hostId: 'mutantPanel',
    minHeight: 84,
    dprCap: 2,

    // Bars
    barMinW: 2,
    barMaxW: 8,         // 你说“粗一点点”可以把 max 提到 8~10
    barGapMin: 1,
    barOpacity: 0.92,

    // Grid / baseline
    baselineAlpha: 0.18,
    gridAlpha: 0.06,
    gridLines: 2,

    // Label
    title: 'Darrius Mutant',
    titleAlpha: 0.90,

    // Arrow on bars
    showArrow: true,
    arrowMode: 'last',  // 'last' or 'all'
    arrowAlpha: 0.90,
    arrowSize: 6,

    // Smoothing / normalization
    lookback: 260,
    smooth: 3,
    power: 0.92,

    // Thresholds (color)
    posThr: 0.18,
    negThr: -0.18,

    // Update
    tickMs: 700,

    // Debug
    debugOnce: false, // true 会在控制台打印一次 snapshot keys（方便定位）
  };

  // -----------------------------
  // Snapshot reader (fallbacks)
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
    // 常见嵌套结构兜底
    if (snap.data && Array.isArray(snap.data.candles)) return snap.data.candles;
    if (snap.data && Array.isArray(snap.data.bars)) return snap.data.bars;
    return [];
  }

  // Try multiple keys & shapes for line series
  function pickLineByCandidates(snap, candidates) {
    if (!snap || !candidates || !candidates.length) return [];

    for (const k of candidates) {
      const v = snap[k];
      if (Array.isArray(v)) return v;
      // nested: snap.lines.ema / snap.series.ema
      if (snap.lines && Array.isArray(snap.lines[k])) return snap.lines[k];
      if (snap.series && Array.isArray(snap.series[k])) return snap.series[k];
      if (snap.indicators && Array.isArray(snap.indicators[k])) return snap.indicators[k];
    }

    // some chart cores export: snap.lines = { ema:{data:[...]}, aux:{data:[...]} }
    if (snap.lines && typeof snap.lines === 'object') {
      for (const k of candidates) {
        const obj = snap.lines[k];
        if (obj && Array.isArray(obj.data)) return obj.data;
        if (obj && Array.isArray(obj.points)) return obj.points;
      }
    }

    if (snap.series && typeof snap.series === 'object') {
      for (const k of candidates) {
        const obj = snap.series[k];
        if (obj && Array.isArray(obj.data)) return obj.data;
        if (obj && Array.isArray(obj.points)) return obj.points;
      }
    }

    return [];
  }

  // normalize line points -> map time => value
  function isBusinessDay(t) {
    return !!(t && typeof t === 'object' && t.year && t.month && t.day);
  }

  function timeKey(t) {
    if (isBusinessDay(t)) return `${t.year}-${t.month}-${t.day}`;
    return String(t);
  }

  function extractTime(p) {
    if (!p) return null;
    return (p.time ?? p.t ?? p.timestamp ?? p.ts ?? null);
  }

  function extractValue(p) {
    if (p == null) return null;
    if (typeof p === 'number') return Number.isFinite(p) ? p : null;
    const v = (p.value ?? p.v ?? p.y ?? p.close ?? null);
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function buildValueMap(lineArr) {
    const m = new Map();
    for (const p of (lineArr || [])) {
      const t = extractTime(p);
      if (t == null) continue;
      const v = extractValue(p);
      if (!Number.isFinite(v)) continue;
      m.set(timeKey(t), v);
    }
    return m;
  }

  // -----------------------------
  // Math helpers
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

  // -----------------------------
  // Mutant metric
  //  A) Preferred: EMA/AUX-driven momentum (if available)
  //  B) Fallback: candle-return momentum (always available)
  // -----------------------------
  function computeMutantFromEmaAux(candles, emaMap, auxMap) {
    const n0 = candles.length;
    if (n0 < 10) return [];

    const n = Math.min(CFG.lookback, n0);
    const start = n0 - n;

    const raw = new Array(n).fill(NaN);
    let usable = 0;

    for (let i = 0; i < n; i++) {
      const b = candles[start + i];
      const k = timeKey(b.time);
      const e = emaMap.get(k);
      const a = auxMap.get(k);
      if (!Number.isFinite(e) || !Number.isFinite(a)) { raw[i] = NaN; continue; }

      usable++;

      const spread = (e - a);

      let spreadPrev = null;
      if (i >= 1) {
        const b0 = candles[start + i - 1];
        const k0 = timeKey(b0.time);
        const e0 = emaMap.get(k0);
        const a0 = auxMap.get(k0);
        if (Number.isFinite(e0) && Number.isFinite(a0)) spreadPrev = (e0 - a0);
      }

      let auxSlope = 0;
      if (i >= 1) {
        const b0 = candles[start + i - 1];
        const k0 = timeKey(b0.time);
        const a0 = auxMap.get(k0);
        if (Number.isFinite(a0)) auxSlope = (a - a0);
      }

      const mom = (spreadPrev == null) ? 0 : (spread - spreadPrev);

      const px = Number(b.close);
      const base = Number.isFinite(px) ? Math.max(1e-9, Math.abs(px)) : Math.max(1e-9, Math.abs(e));
      let v = (mom / base) * 1200 + (auxSlope / base) * 520;

      const sign = v >= 0 ? 1 : -1;
      v = sign * Math.pow(Math.abs(v), CFG.power);
      raw[i] = v;
    }

    // If almost no usable points, treat as unavailable
    if (usable < Math.max(8, Math.floor(n * 0.06))) return [];

    const sm = emaOnArray(raw, CFG.smooth);

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

  function computeMutantFromCandles(candles) {
    const n0 = candles.length;
    if (n0 < 10) return [];
    const n = Math.min(CFG.lookback, n0);
    const start = n0 - n;

    // Use log-return momentum + smoothing
    const raw = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const b = candles[start + i];
      const c = Number(b.close);
      const p = (i >= 1) ? Number(candles[start + i - 1].close) : c;
      if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) { raw[i] = 0; continue; }
      const r = Math.log(c / p);
      raw[i] = r * 260; // scale
    }

    const sm = emaOnArray(raw, Math.max(3, CFG.smooth + 2));

    const absVals = sm.filter(Number.isFinite).map(x => Math.abs(x)).sort((a,b)=>a-b);
    const p95 = absVals.length ? absVals[Math.floor(absVals.length * 0.95)] : 1;
    const scale = Math.max(1e-9, p95);

    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const b = candles[start + i];
      const v = sm[i];
      out[i] = { time: b.time, v: Number.isFinite(v) ? clamp(v / scale, -1, 1) : 0 };
    }
    return out;
  }

  function computeMutantSeries(snap, candles) {
    // Try EMA/AUX first
    const emaArr = pickLineByCandidates(snap, ['ema','emaData','emaLine','ema_series','EMA','ema20','ema_20']);
    const auxArr = pickLineByCandidates(snap, ['aux','auxData','auxLine','aux_series','AUX','sma','smaData','aux40','aux_40']);

    const emaMap = buildValueMap(emaArr);
    const auxMap = buildValueMap(auxArr);

    const fromEmaAux = computeMutantFromEmaAux(candles, emaMap, auxMap);
    if (fromEmaAux && fromEmaAux.length) return fromEmaAux;

    // Fallback: candles-only (always available)
    return computeMutantFromCandles(candles);
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
    debugged: false,
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
          render();
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
  function clear(ctx, w, h) { ctx.clearRect(0, 0, w, h); }

  function drawGrid(ctx, w, h) {
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${CFG.gridAlpha})`;
    ctx.lineWidth = 1;

    const lines = Math.max(0, CFG.gridLines | 0);
    for (let i = 1; i <= lines; i++) {
      const y = Math.floor((h * i) / (lines + 1)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const y0 = Math.floor(h / 2) + 0.5;
    ctx.strokeStyle = `rgba(255,255,255,${CFG.baselineAlpha})`;
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(w, y0);
    ctx.stroke();

    ctx.restore();
  }

  function drawTitle(ctx) {
    ctx.save();
    ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial';
    ctx.fillStyle = `rgba(234,240,247,${CFG.titleAlpha})`;
    ctx.textBaseline = 'top';
    ctx.fillText(CFG.title, 8, 6);
    ctx.restore();
  }

  function clamp01(v) { return clamp(v, -1, 1); }

  function computeBarW(xs) {
    if (!xs || xs.length < 2) return { w: 4 };

    const dxs = [];
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i] - xs[i - 1];
      if (Number.isFinite(d) && d > 0) dxs.push(d);
    }
    dxs.sort((a,b)=>a-b);
    const med = dxs.length ? dxs[(dxs.length / 2) | 0] : 8;

    let bw = Math.floor(med * 0.62);
    bw = clamp(bw, CFG.barMinW, CFG.barMaxW);
    return { w: bw };
  }

  function colorFor(v) {
    if (v >= CFG.posThr) return `rgba(43,226,166,${CFG.barOpacity})`;   // up
    if (v <= CFG.negThr) return `rgba(255,90,90,${CFG.barOpacity})`;    // down
    return `rgba(255,212,0,${CFG.barOpacity * 0.78})`;                  // neutral
  }

  function drawArrow(ctx, x, y, dir, color) {
    // dir: +1 up, -1 down
    const s = CFG.arrowSize;
    ctx.save();
    ctx.globalAlpha = CFG.arrowAlpha;
    ctx.fillStyle = color;

    ctx.beginPath();
    if (dir > 0) {
      // triangle up
      ctx.moveTo(x, y - s);
      ctx.lineTo(x - s, y + s);
      ctx.lineTo(x + s, y + s);
    } else {
      // triangle down
      ctx.moveTo(x, y + s);
      ctx.lineTo(x - s, y - s);
      ctx.lineTo(x + s, y - s);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function render() {
    return safe(() => {
      const ctx = STATE.ctx;
      const w = STATE.w;
      const h = STATE.h;
      if (!ctx || !w || !h) return;

      const snap = getSnapshot();
      const candles = pickCandles(snap);

      // debug once
      if (CFG.debugOnce && snap && !STATE.debugged) {
        STATE.debugged = true;
        try {
          console.log('[Darrius Mutant] snapshot keys:', Object.keys(snap));
          if (snap.lines) console.log('[Darrius Mutant] snap.lines keys:', Object.keys(snap.lines));
          if (snap.series) console.log('[Darrius Mutant] snap.series keys:', Object.keys(snap.series));
        } catch(_) {}
      }

      clear(ctx, w, h);
      drawGrid(ctx, w, h);
      drawTitle(ctx);

      if (!candles || candles.length < 10) return;

      const timeToX = (window.DarriusChart && typeof window.DarriusChart.timeToX === 'function')
        ? window.DarriusChart.timeToX : null;
      if (!timeToX) return;

      const mutant = computeMutantSeries(snap, candles);
      if (!mutant || mutant.length < 2) return;

      // build visible points
      const xs = [];
      const pts = [];
      for (const p of mutant) {
        const x = timeToX(p.time);
        if (!Number.isFinite(x)) continue;
        if (x < -20 || x > w + 20) continue;
        xs.push(x);
        pts.push({ x, v: clamp01(p.v) });
      }
      if (pts.length < 2) return;

      const { w: barW } = computeBarW(xs);
      const midY = h / 2;
      const amp = h * 0.42;

      // bars
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const v = clamp01(p.v);
        const y = midY - v * amp;
        const x0 = Math.round(p.x - barW / 2);

        const col = colorFor(v);
        ctx.fillStyle = col;

        const top = Math.min(y, midY);
        const hh = Math.max(1, Math.abs(midY - y));
        ctx.fillRect(x0, top, barW, hh);
      }

      // arrows (optional)
      if (CFG.showArrow) {
        const drawAll = (CFG.arrowMode === 'all');
        const lastIdx = pts.length - 1;

        for (let i = 0; i < pts.length; i++) {
          if (!drawAll && i !== lastIdx) continue;
          const p = pts[i];
          const v = clamp01(p.v);
          if (Math.abs(v) < 0.02) continue;

          const dir = (v >= 0) ? +1 : -1;
          const col = colorFor(v);
          const yTip = midY - v * amp;
          const yPos = (dir > 0) ? (yTip - 8) : (yTip + 8);
          drawArrow(ctx, Math.round(p.x), Math.round(yPos), dir, col);
        }
      }
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

    safe(() => {
      window.addEventListener('darrius:chartUpdated', () => {
        requestAnimationFrame(() => render());
      });
    }, 'bindChartUpdated');

    setInterval(render, CFG.tickMs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
