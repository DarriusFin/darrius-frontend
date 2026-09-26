/* market.pulse.js (STABLE COMPAT - FIXED UI) v2026.02.03
 * Based on your v2026.01.23 stable ID-binding architecture.
 *
 * What this patch does:
 * - NO DEBUG text injection (removes getSnapshot hints)
 * - NO BIG B/S/eB/eS overlay (keeps chart clean; does not touch your old B/S logic)
 * - Fix gauge coloring: Neutral not all-red; color follows regime
 * - Fill Bull/Bear/Neutral values
 *
 * Safety:
 * - Never throws
 * - Never touches billing/subscription logic
 * - Never mutates chart.core.js internals
 */
(() => {
  'use strict';

  // IMPORTANT: disable big overlay here (per your request: keep chart clean)
  window.__OVERLAY_BIG_SIGS__ = false;

  function safe(fn) { try { return fn(); } catch { return null; } }
  const $ = (id) => document.getElementById(id);

  const DOM = {
    // Market Pulse
    pulseScore: null,
    bullPct: null,
    bearPct: null,
    neuPct: null,
    pulseGaugeMask: null,

    // Waiting/status line (optional, if you have it)
    waitingLine: null,
  };

  function bindDOM() {
    DOM.pulseScore = $('pulseScore');
    DOM.bullPct = $('bullPct');
    DOM.bearPct = $('bearPct');
    DOM.neuPct = $('neuPct');
    DOM.pulseGaugeMask = $('pulseGaugeMask');

    // OPTIONAL: if you have a small "Waiting..." sub line, bind it by id.
    // If not present, we simply do nothing.
    DOM.waitingLine = $('waitingLine');
  }

  // -------- snapshot --------
  function getSnapshot() {
    if (window.DarriusChart && typeof window.DarriusChart.getSnapshot === 'function') {
      const s = safe(() => window.DarriusChart.getSnapshot());
      if (s) return s;
    }
    if (typeof window.getChartSnapshot === 'function') {
      const s = safe(() => window.getChartSnapshot());
      if (s) return s;
    }
    if (window.__DARRIUS_CHART_STATE__) return window.__DARRIUS_CHART_STATE__;
    if (window.__IH_SNAPSHOT__) return window.__IH_SNAPSHOT__;
    if (window.__CHART_SNAPSHOT__) return window.__CHART_SNAPSHOT__;
    return null;
  }

  function pickCandles(snap) {
    if (!snap) return null;
    if (Array.isArray(snap.candles)) return snap.candles;
    if (Array.isArray(snap.bars)) return snap.bars;
    return null;
  }

  // -------- utils --------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (x, d = 2) => {
    if (x === null || x === undefined || Number.isNaN(x)) return '—';
    const n = Number(x);
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(d);
  };
  const pct = (x, d = 0) => Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '—';
  const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);

  // -------- derived metrics (stable + intuitive) --------
  // 1) Momentum + slope score (0..100)
  function derivePulseScore(candles) {
    if (!candles || candles.length < 30) return null;

    const n = 20;
    const seg = candles.slice(-n);
    const lastB = candles[candles.length - 1];
    const prevB = candles[candles.length - 2];

    const lastC = Number(lastB?.close ?? lastB?.c);
    const prevC = Number(prevB?.close ?? prevB?.c);
    const firstC = Number(seg[0]?.close ?? seg[0]?.c);

    if (!Number.isFinite(lastC) || !Number.isFinite(prevC) || !Number.isFinite(firstC)) return null;

    const r1 = (lastC - prevC) / (prevC || lastC);
    const r20 = (lastC - firstC) / (firstC || lastC);

    // simple slope via linear regression on closes
    let sx=0, sy=0, sxx=0, sxy=0;
    for (let i=0;i<seg.length;i++){
      const x=i;
      const y=Number(seg[i]?.close ?? seg[i]?.c);
      if (!Number.isFinite(y)) continue;
      sx+=x; sy+=y; sxx+=x*x; sxy+=x*y;
    }
    const denom = (n*sxx - sx*sx) || 1;
    const slope = (n*sxy - sx*sy) / denom;
    const slopeN = slope / (lastC || 1);

    // score normalize
    const raw = (slopeN*200) + (r20*80) + (r1*40);
    // map raw roughly into 0..100
    const score = clamp(50 + raw*3.5, 0, 100);
    return Math.round(score);
  }

  // 2) Regime label from score
  function scoreToLabel(score) {
    if (!Number.isFinite(score)) return 'Neutral';
    if (score >= 60) return 'Bullish';
    if (score <= 40) return 'Bearish';
    return 'Neutral';
  }

  // 3) Percent split (Bull/Bear/Neutral) from score
  function scoreToSplit(score) {
    if (!Number.isFinite(score)) return { bull: 0.33, bear: 0.33, neu: 0.34 };

    // center 50 is neutral peak
    const d = Math.abs(score - 50);           // 0..50
    const neu = clamp(1 - (d / 50) * 0.9, 0.10, 0.95);

    // remaining goes to bull/bear by direction
    const rest = 1 - neu;
    let bull = rest * (score >= 50 ? 0.75 : 0.25);
    let bear = rest - bull;

    // normalize safety
    const s = bull + bear + neu;
    bull /= s; bear /= s;

    return { bull, bear, neu };
  }

  // -------- UI update --------
  function setGaugeVisual(score, label) {
    if (!DOM.pulseGaugeMask) return;

    // Color policy: follow label
    // Bullish: green→cyan
    // Neutral: blue/gray
    // Bearish: red→orange
    let c1 = 'rgba(43,226,166,1)';
    let c2 = 'rgba(76,194,255,1)';
    if (label === 'Neutral') { c1 = 'rgba(76,194,255,1)'; c2 = 'rgba(200,220,255,1)'; }
    if (label === 'Bearish') { c1 = 'rgba(255,90,90,1)'; c2 = 'rgba(255,193,7,1)'; }

    const deg = Math.round(clamp(score, 0, 100) * 3.6);
    DOM.pulseGaugeMask.style.background =
      `conic-gradient(${c1} 0deg, ${c2} ${deg}deg, rgba(255,255,255,.10) ${deg}deg, rgba(255,255,255,.10) 360deg)`;
    DOM.pulseGaugeMask.style.opacity = '0.85';
  }

  function updateMarketPulseUI(snap) {
    return safe(() => {
      if (!DOM.pulseScore) return;

      const candles = pickCandles(snap);
      const score = derivePulseScore(candles);
      if (!Number.isFinite(score)) return;

      const label = scoreToLabel(score);
      const split = scoreToSplit(score);

      // CENTER NUMBER: keep % like your screenshot (48%)
      DOM.pulseScore.textContent = String(score);

      // right list numbers
      if (DOM.bullPct) DOM.bullPct.textContent = pct(split.bull, 0);
      if (DOM.bearPct) DOM.bearPct.textContent = pct(split.bear, 0);
      if (DOM.neuPct)  DOM.neuPct.textContent  = pct(split.neu, 0);

      setGaugeVisual(score, label);

    });
  }

  // Waiting line: keep TSLA/1d/price small & subtle if you have a node for it
  function updateWaitingSmall(snap) {
    if (!DOM.waitingLine) return;
    const sym = (snap?.meta?.symbol ?? snap?.symbol ?? '—');
    const tf  = (snap?.meta?.timeframe ?? snap?.tf ?? snap?.timeframe ?? '—');
    const candles = pickCandles(snap);
    const lp = Number(last(candles)?.close ?? last(candles)?.c);
    DOM.waitingLine.textContent = `${sym} ${tf} · ${fmt(lp, 2)}`;
    DOM.waitingLine.style.fontSize = '11px';
    DOM.waitingLine.style.opacity = '0.75';
  }

  function tick() {
    return safe(() => {
      const snap = getSnapshot();
      if (!snap) return;
      updateMarketPulseUI(snap);
      updateWaitingSmall(snap);
    });
  }

  function start() {
    bindDOM();
    tick();

    safe(() => {
      window.addEventListener('darrius:chartUpdated', () => requestAnimationFrame(tick));
    });

    // UI-only refresh
    setInterval(tick, 650);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
