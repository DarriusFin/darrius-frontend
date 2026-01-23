/* darrius.mutant.js (UI plugin) v2026.01.23d
 * Darrius Mutant indicator panel (bottom sub-panel)
 * - Robust: renders bars even if DarriusChart.timeToX is missing / returns NaN
 * - Read-only; does NOT touch subscription/billing/payment logic
 * - Fixes: duplicate title, duplicate canvases, safer layout fallback, arrows for bars
 */
(() => {
  'use strict';

  // -----------------------------
  // Absolute no-throw safe zone
  // -----------------------------
  function safe(fn) { try { return fn(); } catch (_) { return null; } }
  const $ = (id) => document.getElementById(id);

  // -----------------------------
  // Config (safe to adjust)
  // -----------------------------
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

    // Arrow overlay
    showArrow: true,
    // 'last' = only last bar
    // 'allStrong' = draw arrows only for strong bars (recommended)
    // 'all' = draw arrows for all non-trivial bars
    arrowMode: 'allStrong',
    arrowAlpha: 0.90,
    arrowSize: 6,
    arrowStrongThr: 0.18, // strong threshold for arrows in allStrong mode

    // Mutant series build
    lookback: 260,
    smooth: 3,

    posThr: 0.18,
    negThr: -0.18,

    // UI refresh cadence (NO data hits)
    tickMs: 700,

    // Cleanup legacy DOM (avoid double title)
    cleanupLegacyTitle: true,

    // Debug
    debugOnce: false,
  };

  // -----------------------------
  // Snapshot reader
  // -----------------------------
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
  // Candle-only fallback mutant (always available)
  // -----------------------------
  function computeMutantFromCandles(candles) {
    const n0 = candles.length;
    if (n0 < 10) return [];
    const n = Math.min(CFG.lookback, n0);
    const start = n0 - n;

    // raw: scaled log return
    const raw = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const c = Number(candles[start + i]?.close);
      const p = (i >= 1) ? Number(candles[start + i - 1]?.close) : c;
      if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) { raw[i] = 0; continue; }
      raw[i] = Math.log(c / p) * 260;
    }

    // smooth
    const sm = emaOnArray(raw, Math.max(3, CFG.smooth + 2));

    // robust normalize with p95 scale
    const absVals = sm
      .filter(Number.isFinite)
      .map(x => Math.abs(x))
      .sort((a, b) => a - b);

    const p95 = absVals.length ? absVals[Math.floor(absVals.length * 0.95)] : 1;
    const scale = Math.max(1e-9, p95);

    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const vv = Number.isFinite(sm[i]) ? clamp(sm[i] / scale, -1, 1) : 0;
      out[i] = { time: candles[start + i].time, v: vv };
    }
    return out;
  }

  // -----------------------------
  // Canvas state
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
    });
  }

  // Remove legacy / duplicate title DOM that might cause "two Darrius Mutant"
  function cleanupLegacy(host) {
    if (!CFG.cleanupLegacyTitle || !host) return;

    safe(() => {
      // 1) Remove legacy title nodes by known patterns
      const legacySelectors = [
        '[data-mutant-title="1"]',
        '.mutantTitle',
        '.mutant-title',
        '#mutantTitle',
        '#forexMutantTitle',
      ];
      for (const sel of legacySelectors) {
        host.querySelectorAll(sel).forEach((el) => safe(() => el.remove()));
      }

      // 2) If host contains plain text nodes that equal title (rare but possible), clear them
      //    (we only remove *exact* matches to avoid nuking other content)
      const title = String(CFG.title || '').trim();
      if (!title) return;
      const nodes = Array.from(host.childNodes || []);
      for (const n of nodes) {
        if (n && n.nodeType === Node.TEXT_NODE) {
          const t = String(n.textContent || '').trim();
          if (t && (t === title || t.toLowerCase() === title.toLowerCase())) {
            n.textContent = '';
          }
        }
      }
    });
  }

  function ensureSingleCanvas(host) {
    return safe(() => {
      if (!host) return null;

      // Remove duplicate canvases first (keep the first)
      const all = host.querySelectorAll('canvas[data-mutant="1"]');
      if (all && all.length > 1) {
        for (let i = 1; i < all.length; i++) safe(() => all[i].remove());
      }

      let c = host.querySelector('canvas[data-mutant="1"]');
      if (!c) {
        c = document.createElement('canvas');
        c.setAttribute('data-mutant', '1');
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

  function drawArrow(ctx, x, y, dir, color) {
    const s = CFG.arrowSize;
    ctx.save();
    ctx.globalAlpha = CFG.arrowAlpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (dir > 0) {
      // up triangle
      ctx.moveTo(x, y - s);
      ctx.lineTo(x - s, y + s);
      ctx.lineTo(x + s, y + s);
    } else {
      // down triangle
      ctx.moveTo(x, y + s);
      ctx.lineTo(x - s, y - s);
      ctx.lineTo(x + s, y - s);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // -----------------------------
  // Render
  // -----------------------------
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

      // Build base points
      const pts = [];
      for (let i = 0; i < mutant.length; i++) {
        pts.push({ t: mutant[i].time, v: clamp(mutant[i].v, -1, 1) });
      }

      // X mapping:
      // - Prefer timeToX when available and returns finite
      // - Otherwise fallback to equal spacing
      const timeToX = (window.DarriusChart && typeof window.DarriusChart.timeToX === 'function')
        ? window.DarriusChart.timeToX : null;

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
          // Keep only near view to avoid edge crowd
          if (x < -20 || x > w + 20) continue;
          drawPts.push({ x, v: p.v });
        }
      }

      // fallback if none
      if (!drawPts.length) {
        const n = pts.length;
        const leftPad = 10;
        const rightPad = 10;
        const usableW = Math.max(1, w - leftPad - rightPad);
        for (let i = 0; i < n; i++) {
          const x = leftPad + (usableW * (i + 0.5) / n);
          drawPts.push({ x, v: pts[i].v });
        }
      }

      if (drawPts.length < 2) return;

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
      if (CFG.showArrow) {
        const lastIdx = drawPts.length - 1;

        for (let i = 0; i < drawPts.length; i++) {
          if (CFG.arrowMode === 'last' && i !== lastIdx) continue;

          const p = drawPts[i];
          const absV = Math.abs(p.v);

          if (CFG.arrowMode === 'allStrong') {
            if (absV < Math.max(0.0001, CFG.arrowStrongThr)) continue;
          } else {
            // 'all' mode: still ignore near-zero to reduce clutter
            if (absV < 0.02) continue;
          }

          const dir = (p.v >= 0) ? +1 : -1;
          const col = colorFor(p.v);
          const yTip = midY - p.v * amp;
          const yPos = (dir > 0) ? (yTip - 8) : (yTip + 8);

          drawArrow(ctx, Math.round(p.x), Math.round(yPos), dir, col);
        }
      }

      // one-time debug (optional)
      if (CFG.debugOnce && !STATE.debugged) {
        STATE.debugged = true;
        safe(() => {
          console.log('[darrius.mutant] ok', {
            candles: candles.length,
            mutant: mutant.length,
            drawPts: drawPts.length,
            useTimeToX,
          });
        });
      }
    });
  }

  // -----------------------------
  // Boot
  // -----------------------------
  function boot() {
    STATE.host = ensureHost();
    if (!STATE.host) return;

    // cleanup legacy DOM to avoid duplicate titles
    cleanupLegacy(STATE.host);

    // ensure exactly one canvas
    STATE.canvas = ensureSingleCanvas(STATE.host);
    if (!STATE.canvas) return;

    resizeCanvas();
    observeResize();
    render();

    // re-render on chart update event
    safe(() => {
      window.addEventListener('darrius:chartUpdated', () => requestAnimationFrame(render));
    });

    // periodic UI refresh (NO data hits)
    setInterval(render, CFG.tickMs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
