/* darrius.mutant.js (UI plugin) v2026.01.23e
 * Darrius Mutant indicator panel (bottom sub-panel)
 * - Robust: renders bars even if DarriusChart.timeToX is missing / returns NaN
 * - CLEAN arrows: only at trend-confirm / reversal-confirm turning points
 * - Fix: remove duplicate legacy canvases/titles in #mutantPanel (e.g., leftover forex.mutant)
 * - Read-only; does NOT touch subscription/billing
 */
(() => {
  'use strict';

  function safe(fn) { try { return fn(); } catch (_) { return null; } }
  const $ = (id) => document.getElementById(id);

  const CFG = {
    hostId: 'mutantPanel',
    minHeight: 84,
    dprCap: 2,

    barMinW: 2,
    barMaxW: 8,
    barOpacity: 0.92,

    baselineAlpha: 0.18,
    gridAlpha: 0.06,
    gridLines: 2,

    title: 'Darrius Mutant',
    titleAlpha: 0.90,

    // Arrow overlay (CLEAN MODE)
    showArrow: true,
    arrowMode: 'turns',          // 'turns' | 'last'

    arrowAlpha: 0.97,
    arrowSize: 7,

    // Trend thresholds (hysteresis)
    arrowEnterThr: 0.22,
    arrowExitThr: 0.10,
    arrowConfirmBars: 2,

    // Arrow colors (per your request)
    arrowUpColor: 'rgba(255, 212, 0, 0.98)',     // GOLD
    arrowDownColor: 'rgba(255, 255, 255, 0.98)', // PURE WHITE
    arrowStroke: 'rgba(0,0,0,0.35)',             // subtle dark edge for white arrow readability
    arrowGlow: 12,

    lookback: 260,
    smooth: 3,

    posThr: 0.18,
    negThr: -0.18,

    tickMs: 700,
  };

  function getSnapshot() {
    if (window.DarriusChart && typeof window.DarriusChart.getSnapshot === 'function') {
      const s = safe(() => window.DarriusChart.getSnapshot());
      if (s) return s;
    }
    if (typeof window.getChartSnapshot === 'function') {
      const s = safe(() => window.getChartSnapshot());
      if (s) return s;
    }
    return window.__DARRIUS_CHART_STATE__ || null;
  }

  function pickCandles(snap) {
    if (!snap) return [];
    if (Array.isArray(snap.candles)) return snap.candles;
    if (Array.isArray(snap.bars)) return snap.bars;
    if (snap.data && Array.isArray(snap.data.candles)) return snap.data.candles;
    if (snap.data && Array.isArray(snap.data.bars)) return snap.data.bars;
    return [];
  }

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

  // Candle-only fallback mutant (always available)
  function computeMutantFromCandles(candles) {
    const n0 = candles.length;
    if (n0 < 10) return [];
    const n = Math.min(CFG.lookback, n0);
    const start = n0 - n;

    const raw = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const c = Number(candles[start + i]?.close);
      const p = (i >= 1) ? Number(candles[start + i - 1]?.close) : c;
      if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) { raw[i] = 0; continue; }
      raw[i] = Math.log(c / p) * 260;
    }

    const sm = emaOnArray(raw, Math.max(3, CFG.smooth + 2));

    const absVals = sm.filter(Number.isFinite).map(x => Math.abs(x)).sort((a, b) => a - b);
    const p95 = absVals.length ? absVals[Math.floor(absVals.length * 0.95)] : 1;
    const scale = Math.max(1e-9, p95);

    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = { time: candles[start + i].time, v: Number.isFinite(sm[i]) ? clamp(sm[i] / scale, -1, 1) : 0 };
    }
    return out;
  }

  // ---- Canvas ----
  const STATE = { host: null, canvas: null, ctx: null, w: 0, h: 0, dpr: 1 };

  function ensureHost() {
    return safe(() => {
      const host = $(CFG.hostId);
      if (!host) return null;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      return host;
    });
  }

  // remove legacy canvases that cause "double title"
  function purgeLegacyCanvases(host) {
    safe(() => {
      if (!host) return;

      // remove any canvas in the host that is NOT ours
      const all = Array.from(host.querySelectorAll('canvas'));
      for (const c of all) {
        const mine = c.getAttribute('data-darrius-mutant') === '1';
        if (!mine) c.remove();
      }
    });
  }

  function ensureCanvas(host) {
    return safe(() => {
      if (!host) return null;

      // 1) purge old/legacy canvases first (fix duplicate titles)
      purgeLegacyCanvases(host);

      // 2) ensure our canvas exists
      let c = host.querySelector('canvas[data-darrius-mutant="1"]');
      if (!c) {
        c = document.createElement('canvas');
        c.setAttribute('data-darrius-mutant', '1');
        c.style.position = 'absolute';
        c.style.inset = '0';
        c.style.width = '100%';
        c.style.height = '100%';
        c.style.display = 'block';
        c.style.pointerEvents = 'none';
        host.appendChild(c);
      }
      return c;
    });
  }

  function resizeCanvas() {
    return safe(() => {
      const host = STATE.host;
      const c = STATE.canvas;
      if (!host || !c) return;

      const r = host.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width));
      const h = Math.max(CFG.minHeight, Math.floor(r.height));
      const dpr = Math.min(CFG.dprCap, Math.max(1, window.devicePixelRatio || 1));

      STATE.w = w; STATE.h = h; STATE.dpr = dpr;
      c.width = Math.floor(w * dpr);
      c.height = Math.floor(h * dpr);

      const ctx = c.getContext('2d');
      STATE.ctx = ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
  }

  function observeResize() {
    safe(() => {
      const host = STATE.host;
      if (!host) return;
      try {
        new ResizeObserver(() => { resizeCanvas(); render(); }).observe(host);
      } catch (_) {
        window.addEventListener('resize', () => { resizeCanvas(); render(); });
      }
    });
  }

  function clear(ctx, w, h) { ctx.clearRect(0, 0, w, h); }

  function drawGrid(ctx, w, h) {
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${CFG.gridAlpha})`;
    ctx.lineWidth = 1;

    const lines = Math.max(0, CFG.gridLines | 0);
    for (let i = 1; i <= lines; i++) {
      const y = Math.floor((h * i) / (lines + 1)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    const y0 = Math.floor(h / 2) + 0.5;
    ctx.strokeStyle = `rgba(255,255,255,${CFG.baselineAlpha})`;
    ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(w, y0); ctx.stroke();

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

  function colorFor(v) {
    if (v >= CFG.posThr) return `rgba(43,226,166,${CFG.barOpacity})`;
    if (v <= CFG.negThr) return `rgba(255,90,90,${CFG.barOpacity})`;
    return `rgba(255,212,0,${CFG.barOpacity * 0.78})`;
  }

  function computeBarW(nPts, w) {
    if (nPts <= 2) return 4;
    const dx = w / nPts;
    return clamp(Math.floor(dx * 0.62), CFG.barMinW, CFG.barMaxW);
  }

  function drawArrowShape(ctx, x, y, dir, s) {
    ctx.beginPath();
    if (dir > 0) {
      ctx.moveTo(x, y - s);
      ctx.lineTo(x - s, y + s);
      ctx.lineTo(x + s, y + s);
    } else {
      ctx.moveTo(x, y + s);
      ctx.lineTo(x - s, y - s);
      ctx.lineTo(x + s, y - s);
    }
    ctx.closePath();
  }

  function renderTurningArrows(ctx, drawPts, w, h) {
    if (!CFG.showArrow || CFG.arrowMode !== 'turns' || !drawPts || drawPts.length < 3) return;

    const seq = drawPts
      .map(p => ({ x: p.x, v: p.v }))
      .sort((a, b) => a.x - b.x);

    const enterThr = Number(CFG.arrowEnterThr);
    const exitAbs = Math.abs(Number(CFG.arrowExitThr));
    const need = Math.max(1, CFG.arrowConfirmBars | 0);

    let state = 0;        // -1,0,+1
    let pending = 0;
    let pendingCount = 0;

    const turns = [];

    for (let i = 0; i < seq.length; i++) {
      const v = seq[i].v;

      let target = state;
      if (v >= enterThr) target = +1;
      else if (v <= -enterThr) target = -1;
      else if (Math.abs(v) <= exitAbs) target = 0;

      if (target === state) {
        pending = 0; pendingCount = 0;
        continue;
      }

      if (pending !== target) { pending = target; pendingCount = 1; }
      else pendingCount++;

      if (pendingCount >= need) {
        if (pending === +1 || pending === -1) {
          turns.push({ idx: i, dir: pending });
        }
        state = pending;
        pending = 0; pendingCount = 0;
      }
    }

    if (!turns.length) return;

    const midY = h / 2;
    const amp = h * 0.42;
    const s = CFG.arrowSize;

    for (const t of turns) {
      const p = seq[t.idx];
      const dir = t.dir;

      const col = (dir > 0) ? CFG.arrowUpColor : CFG.arrowDownColor;
      const yTip = midY - p.v * amp;
      const yPos = (dir > 0) ? (yTip - 10) : (yTip + 10);

      ctx.save();
      ctx.globalAlpha = CFG.arrowAlpha;

      // glow
      ctx.shadowColor = col;
      ctx.shadowBlur = CFG.arrowGlow;

      drawArrowShape(ctx, Math.round(p.x), Math.round(yPos), dir, s);

      ctx.fillStyle = col;
      ctx.fill();

      // edge stroke
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = CFG.arrowStroke;
      ctx.stroke();

      ctx.restore();
    }
  }

  function renderLastArrow(ctx, drawPts, h) {
    if (!CFG.showArrow || CFG.arrowMode !== 'last' || !drawPts || drawPts.length < 1) return;

    const last = drawPts[drawPts.length - 1];
    if (!last) return;

    const midY = h / 2;
    const amp = h * 0.42;
    const dir = (last.v >= 0) ? +1 : -1;
    const col = (dir > 0) ? CFG.arrowUpColor : CFG.arrowDownColor;

    const yTip = midY - last.v * amp;
    const yPos = (dir > 0) ? (yTip - 10) : (yTip + 10);
    const s = CFG.arrowSize;

    ctx.save();
    ctx.globalAlpha = CFG.arrowAlpha;
    ctx.shadowColor = col;
    ctx.shadowBlur = CFG.arrowGlow;

    drawArrowShape(ctx, Math.round(last.x), Math.round(yPos), dir, s);

    ctx.fillStyle = col;
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = CFG.arrowStroke;
    ctx.stroke();

    ctx.restore();
  }

  function render() {
    return safe(() => {
      const ctx = STATE.ctx;
      const w = STATE.w, h = STATE.h;
      if (!ctx || !w || !h) return;

      const snap = getSnapshot();
      const candles = pickCandles(snap);

      clear(ctx, w, h);
      drawGrid(ctx, w, h);
      drawTitle(ctx);

      if (!candles || candles.length < 10) return;

      const mutant = computeMutantFromCandles(candles);
      if (!mutant || mutant.length < 2) return;

      const timeToX = (window.DarriusChart && typeof window.DarriusChart.timeToX === 'function')
        ? window.DarriusChart.timeToX : null;

      const pts = mutant.map(p => ({ t: p.time, v: clamp(p.v, -1, 1) }));

      let useTimeToX = false;
      if (timeToX && pts.length) {
        const probe = safe(() => timeToX(pts[pts.length - 1].t));
        if (Number.isFinite(probe)) useTimeToX = true;
      }

      const drawPts = [];
      if (useTimeToX) {
        for (const p of pts) {
          const x = safe(() => timeToX(p.t));
          if (!Number.isFinite(x)) continue;
          if (x < -20 || x > w + 20) continue;
          drawPts.push({ x, v: p.v });
        }
      }

      if (!drawPts.length) {
        const n = pts.length;
        const leftPad = 10, rightPad = 10;
        const usableW = Math.max(1, w - leftPad - rightPad);
        for (let i = 0; i < n; i++) {
          const x = leftPad + (usableW * (i + 0.5) / n);
          drawPts.push({ x, v: pts[i].v });
        }
      }

      const barW = computeBarW(drawPts.length, w);
      const midY = h / 2;
      const amp = h * 0.42;

      // bars
      for (const p of drawPts) {
        const v = p.v;
        const y = midY - v * amp;
        const x0 = Math.round(p.x - barW / 2);
        const top = Math.min(y, midY);
        const hh = Math.max(1, Math.abs(midY - y));
        ctx.fillStyle = colorFor(v);
        ctx.fillRect(x0, top, barW, hh);
      }

      // arrows
      if (CFG.arrowMode === 'turns') renderTurningArrows(ctx, drawPts, w, h);
      else if (CFG.arrowMode === 'last') renderLastArrow(ctx, drawPts, h);
    });
  }

  function boot() {
    STATE.host = ensureHost();
    if (!STATE.host) return;

    STATE.canvas = ensureCanvas(STATE.host);
    if (!STATE.canvas) return;

    resizeCanvas();
    observeResize();
    render();

    safe(() => {
      window.addEventListener('darrius:chartUpdated', () => requestAnimationFrame(render));
    });

    setInterval(render, CFG.tickMs);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
