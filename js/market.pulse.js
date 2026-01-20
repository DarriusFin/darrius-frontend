/* market.pulse.js
 * UI-only layer. Must NOT mutate chart.core.js internals.
 * - Reads snapshot
 * - Renders Market Pulse
 * - Renders Risk Copilot
 * - Renders BIG glowing B/S overlay (independent from chart markers)
 */
(() => {
  'use strict';

  // -----------------------------
  // Absolute no-throw safe zone
  // -----------------------------
  function safe(fn, tag = 'market.pulse') {
    try { return fn(); } catch (e) { /* swallow */ return null; }
  }

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);

  const DOM = {
    // Market Pulse
    pulseScore: null,
    bullPct: null,
    bearPct: null,
    neuPct: null,
    netInflow: null,
    pulseGaugeMask: null,

    // Signal
    signalRow: null,
    signalSide: null,
    signalMeta: null,
    signalPx: null,
    signalTf: null,

    // Risk Copilot
    riskEntry: null,
    riskStop: null,
    riskTargets: null,
    riskConf: null,
    riskWR: null,

    // Overlay
    sigOverlay: null,
    chartWrap: null
  };

  function bindDOM() {
    DOM.pulseScore = $('pulseScore');
    DOM.bullPct = $('bullPct');
    DOM.bearPct = $('bearPct');
    DOM.neuPct = $('neuPct');
    DOM.netInflow = $('netInflow');
    DOM.pulseGaugeMask = $('pulseGaugeMask');

    DOM.signalRow = $('signalRow');
    DOM.signalSide = $('signalSide');
    DOM.signalMeta = $('signalMeta');
    DOM.signalPx = $('signalPx');
    DOM.signalTf = $('signalTf');

    DOM.riskEntry = $('riskEntry');
    DOM.riskStop = $('riskStop');
    DOM.riskTargets = $('riskTargets');
    DOM.riskConf = $('riskConf');
    DOM.riskWR = $('riskWR');

    DOM.sigOverlay = $('sigOverlay');
    DOM.chartWrap = $('chartWrap');
  }

  // -----------------------------
  // Snapshot reader (multiple fallbacks)
  // IMPORTANT: we DO NOT touch chart instance methods except read-only
  // -----------------------------
  function getSnapshot() {
    // Try common patterns without assuming exact names
    // 1) chart.core.js might expose window.DarriusChart.getSnapshot()
    if (window.DarriusChart && typeof window.DarriusChart.getSnapshot === 'function') {
      return safe(() => window.DarriusChart.getSnapshot(), 'getSnapshot:DarriusChart');
    }
    // 2) chart.core.js might expose window.getChartSnapshot()
    if (typeof window.getChartSnapshot === 'function') {
      return safe(() => window.getChartSnapshot(), 'getSnapshot:getChartSnapshot');
    }
    // 3) chart.core.js might keep a latest snapshot object
    if (window.__IH_SNAPSHOT__) return window.__IH_SNAPSHOT__;
    if (window.__CHART_SNAPSHOT__) return window.__CHART_SNAPSHOT__;

    // 4) some apps keep a global core object
    if (window.ChartCore && typeof window.ChartCore.getSnapshot === 'function') {
      return safe(() => window.ChartCore.getSnapshot(), 'getSnapshot:ChartCore');
    }
    return null;
  }

  // -----------------------------
  // Utilities
  // -----------------------------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (x, d = 2) => {
    if (x === null || x === undefined || Number.isNaN(x)) return '—';
    const n = Number(x);
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(d);
  };

  // Get candles array from snapshot
  function pickCandles(snap) {
    if (!snap) return null;
    if (Array.isArray(snap.candles)) return snap.candles;
    if (Array.isArray(snap.ohlc)) return snap.ohlc;
    if (Array.isArray(snap.data)) return snap.data;
    return null;
  }

  // Get signals (B/S) from snapshot
  function pickSignals(snap) {
    if (!snap) return [];
    if (Array.isArray(snap.signals)) return snap.signals;
    if (Array.isArray(snap.bsSignals)) return snap.bsSignals;
    if (Array.isArray(snap.markers)) return snap.markers; // sometimes chart markers are exposed
    return [];
  }

  function last(arr) { return arr && arr.length ? arr[arr.length - 1] : null; }

  // -----------------------------
  // Core derived metrics (Preset 2)
  // EMA 14 / AUX 40 / confirm 3
  // -----------------------------
  const PRESET = {
    ema: 14,
    aux: 40,
    confirm: 3
  };

  function deriveTrendRegime(snap, candles) {
    // Prefer ema array if provided
    const emaArr = snap && (snap.ema || snap.emaData || snap.ema14);
    if (Array.isArray(emaArr) && emaArr.length >= 6) {
      const a = emaArr[emaArr.length - 1]?.value ?? emaArr[emaArr.length - 1];
      const b = emaArr[emaArr.length - 6]?.value ?? emaArr[emaArr.length - 6];
      const slope = (a - b);
      const eps = Math.abs(a) * 0.0004; // 0.04% threshold
      if (slope > eps) return 'UP';
      if (slope < -eps) return 'DOWN';
      return 'FLAT';
    }

    // Fallback: use closes slope
    if (candles && candles.length >= 6) {
      const c1 = candles[candles.length - 1].close;
      const c0 = candles[candles.length - 6].close;
      const slope = c1 - c0;
      const eps = Math.abs(c1) * 0.003; // looser
      if (slope > eps) return 'UP';
      if (slope < -eps) return 'DOWN';
      return 'FLAT';
    }
    return 'FLAT';
  }

  function deriveStability(snap, candles) {
    // 0..100
    // Use AUX slope flatness + EMA flip frequency
    let auxFlat = 0.5; // 0..1 (higher = flatter)
    let emaFlips = 0.0; // 0..1 (higher = more flips)

    const auxArr = snap && (snap.aux || snap.auxData || snap.aux40);
    if (Array.isArray(auxArr) && auxArr.length >= 10) {
      const a = auxArr[auxArr.length - 1]?.value ?? auxArr[auxArr.length - 1];
      const b = auxArr[auxArr.length - 6]?.value ?? auxArr[auxArr.length - 6];
      const slope = Math.abs(a - b);
      const base = Math.max(1e-9, Math.abs(a));
      const ratio = slope / base; // smaller = flatter
      auxFlat = clamp(1 - ratio * 18, 0, 1);
    }

    const emaArr = snap && (snap.ema || snap.emaData || snap.ema14);
    if (Array.isArray(emaArr) && emaArr.length >= 15 && candles && candles.length >= 15) {
      // count sign of (close - ema)
      let flips = 0;
      let prev = null;
      for (let i = emaArr.length - 15; i < emaArr.length; i++) {
        const emaV = emaArr[i]?.value ?? emaArr[i];
        const close = candles[i]?.close;
        if (close == null || emaV == null) continue;
        const sign = close >= emaV ? 1 : -1;
        if (prev != null && sign !== prev) flips++;
        prev = sign;
      }
      emaFlips = clamp(flips / 8, 0, 1);
    }

    // stability: flatter AUX and fewer EMA flips -> higher stability
    const stability = clamp((auxFlat * 0.6 + (1 - emaFlips) * 0.4) * 100, 0, 100);
    return stability;
  }

  function deriveInflectionBias(snap) {
    const sigs = pickSignals(snap);
    if (!sigs || !sigs.length) return 'NEUTRAL';

    // Take the most recent "confirmed" signal if possible
    // We accept various shapes: {side:'B'/'S'} or {type:'buy'/'sell'} or {text:'B'}
    const normSide = (s) => {
      const t = (s.side || s.type || s.text || s.signal || '').toString().toUpperCase();
      if (t.includes('BUY') || t === 'B') return 'B';
      if (t.includes('SELL') || t === 'S') return 'S';
      return '';
    };

    for (let i = sigs.length - 1; i >= 0; i--) {
      const side = normSide(sigs[i]);
      if (!side) continue;
      // if provided confirmed flag, honor it
      if (sigs[i].confirmed === false) continue;
      return side === 'B' ? 'BULL' : 'BEAR';
    }
    return 'NEUTRAL';
  }

  function derivePulseLabel(trendRegime, bias, stability) {
    // Rules hard-coded (your product discipline)
    // Rule 1: EMA green (UP) => cannot be Bearish
    // Rule 2: recent confirmed B => direction must tilt bullish (cannot contradict)
    // Rule 3: AUX flat => ring shrinks (low tradability), not full
    let label = 'NEUTRAL';

    if (trendRegime === 'DOWN') label = 'BEARISH';
    if (trendRegime === 'UP') label = 'BULLISH';
    if (trendRegime === 'FLAT') label = 'NEUTRAL';

    if (bias === 'BULL') {
      // tilt to bullish
      label = (trendRegime === 'DOWN') ? 'NEUTRAL' : 'BULLISH';
    }
    if (bias === 'BEAR') {
      // tilt to bearish, but cannot contradict Rule 1
      label = (trendRegime === 'UP') ? 'NEUTRAL' : 'BEARISH';
    }

    // Rule 1 enforce
    if (trendRegime === 'UP' && label === 'BEARISH') label = 'NEUTRAL';

    // stability can downgrade certainty, not invert direction
    if (stability < 35) {
      if (label === 'BULLISH') label = 'NEUTRAL';
      if (label === 'BEARISH') label = 'NEUTRAL';
    }

    return label;
  }

  function deriveTradabilityScore(trendRegime, bias, stability) {
    // 0..100, "可交易度"
    let base = 35;

    if (trendRegime === 'UP') base += 18;
    if (trendRegime === 'DOWN') base += 12;
    if (trendRegime === 'FLAT') base -= 5;

    if (bias === 'BULL') base += 12;
    if (bias === 'BEAR') base += 10;

    // stability is a multiplier-style
    base = base * (0.55 + (stability / 100) * 0.45);

    // clamp
    return Math.round(clamp(base, 0, 100));
  }

  // -----------------------------
  // UI: Market Pulse ring + numbers
  // -----------------------------
  function updateMarketPulseUI(snap) {
    return safe(() => {
      if (!DOM.pulseScore || !DOM.pulseGaugeMask) return;

      const candles = pickCandles(snap);
      const trendRegime = deriveTrendRegime(snap, candles);
      const stability = deriveStability(snap, candles);
      const bias = deriveInflectionBias(snap);
      const label = derivePulseLabel(trendRegime, bias, stability);
      const score = deriveTradabilityScore(trendRegime, bias, stability);

      // Set number
      DOM.pulseScore.textContent = String(score);

      // Percent bars (simple, consistent, not "emotion")
      // We map label + stability into bull/bear/neutral shares.
      let bull = 10, bear = 10, neu = 80;
      if (label === 'BULLISH') { bull = 55; bear = 10; neu = 35; }
      if (label === 'BEARISH') { bull = 10; bear = 55; neu = 35; }
      if (label === 'NEUTRAL') { bull = 16; bear = 15; neu = 69; }
      // soften with low stability
      const shrink = clamp(1 - (stability / 100), 0, 1);
      neu = Math.round(neu + shrink * 10);
      bull = Math.round(bull - shrink * 5);
      bear = Math.round(bear - shrink * 5);
      bull = clamp(bull, 0, 100); bear = clamp(bear, 0, 100); neu = clamp(neu, 0, 100);

      if (DOM.bullPct) DOM.bullPct.textContent = bull + '%';
      if (DOM.bearPct) DOM.bearPct.textContent = bear + '%';
      if (DOM.neuPct) DOM.neuPct.textContent = neu + '%';
      if (DOM.netInflow) DOM.netInflow.textContent = '—';

      // Ring fill: enforce COLOR always (your issue: grey ring)
      const deg = Math.round(clamp(score, 0, 100) * 3.6);

      // Two-tone institutional gradient
      // IMPORTANT: write inline style to beat CSS overrides
      DOM.pulseGaugeMask.style.background =
        `conic-gradient(rgba(43,226,166,1) 0deg, rgba(76,194,255,1) ${deg}deg, rgba(255,255,255,.10) ${deg}deg, rgba(255,255,255,.10) 360deg)`;

      // Subtle ring opacity for low stability (Rule 3: flat => shrink)
      DOM.pulseGaugeMask.style.opacity = String(clamp(0.35 + (stability / 100) * 0.55, 0.35, 0.90));

      // Also update signal box meta (optional)
      if (DOM.signalMeta) {
        const ttxt = trendRegime === 'UP' ? 'EMA up' : (trendRegime === 'DOWN' ? 'EMA down' : 'EMA flat');
        const btxt = bias === 'BULL' ? 'Bias: B' : (bias === 'BEAR' ? 'Bias: S' : 'Bias: —');
        const stxt = stability < 40 ? 'AUX flat → shrink tradability' : 'Stable';
        DOM.signalMeta.innerHTML = `${ttxt} · ${btxt} · ${stxt}`;
      }

      return { score, label, trendRegime, bias, stability };
    }, 'updateMarketPulseUI');
  }

  // -----------------------------
  // UI: Risk Copilot (derived only)
  // -----------------------------
  function updateRiskCopilotUI(snap) {
    return safe(() => {
      if (!DOM.riskEntry || !DOM.riskStop || !DOM.riskTargets || !DOM.riskConf) return;

      const candles = pickCandles(snap);
      if (!candles || candles.length < 20) {
        DOM.riskEntry.textContent = '—';
        DOM.riskStop.textContent = '—';
        DOM.riskTargets.textContent = '—';
        DOM.riskConf.textContent = '—';
        if (DOM.riskWR) DOM.riskWR.textContent = '—';
        return;
      }

      const c = last(candles);
      const close = c.close;

      // Volatility proxy: avg(abs(close-closePrev)) last 14
      let vol = 0;
      const n = 14;
      for (let i = candles.length - n; i < candles.length; i++) {
        const prev = candles[i - 1]?.close;
        const cur = candles[i]?.close;
        if (prev == null || cur == null) continue;
        vol += Math.abs(cur - prev);
      }
      vol = vol / Math.max(1, n - 1);

      // Direction from last bias
      const bias = deriveInflectionBias(snap); // BULL/BEAR/NEUTRAL
      const dir = (bias === 'BEAR') ? 'SHORT' : 'LONG';

      // Entry: current close
      const entry = close;

      // Stop distance: 1.6 * vol (institutional conservative)
      const stopDist = Math.max(vol * 1.6, close * 0.004); // at least 0.4%
      const stop = (dir === 'LONG') ? (entry - stopDist) : (entry + stopDist);

      // Targets: 1R / 2R
      const t1 = (dir === 'LONG') ? (entry + stopDist) : (entry - stopDist);
      const t2 = (dir === 'LONG') ? (entry + stopDist * 2) : (entry - stopDist * 2);

      // Confidence: blend stability + trend regime agreement
      const trendRegime = deriveTrendRegime(snap, candles);
      const stability = deriveStability(snap, candles);

      let align = 0.5;
      if (dir === 'LONG' && trendRegime === 'UP') align = 0.9;
      else if (dir === 'SHORT' && trendRegime === 'DOWN') align = 0.9;
      else if (trendRegime === 'FLAT') align = 0.45;
      else align = 0.55;

      const conf = Math.round(clamp((stability * 0.55 + align * 100 * 0.45), 0, 100));

      DOM.riskEntry.textContent = fmt(entry, 2);
      DOM.riskStop.textContent = fmt(stop, 2);
      DOM.riskTargets.textContent = `${fmt(t1, 2)} / ${fmt(t2, 2)}`;
      DOM.riskConf.textContent = `${conf}%`;

      // winrate placeholder (derived proxy)
      if (DOM.riskWR) {
        const wr = Math.round(clamp(42 + (stability / 100) * 18 + (align - 0.5) * 25, 35, 72));
        DOM.riskWR.textContent = `${wr}%`;
      }
    }, 'updateRiskCopilotUI');
  }

  // -----------------------------
  // UI: BIG glowing B/S overlay (independent from chart markers)
  // This fixes your "B/S small and no glow" permanently.
  // -----------------------------
  function renderOverlaySignals(snap) {
    return safe(() => {
      if (!DOM.sigOverlay || !DOM.chartWrap) return;

      const candles = pickCandles(snap);
      const sigsRaw = pickSignals(snap);
      if (!candles || candles.length < 10) {
        DOM.sigOverlay.innerHTML = '';
        return;
      }

      // Normalize signals to {idx, side, price}
      // We try multiple shapes and fallback to mapping by nearest time
      const normSide = (s) => {
        const t = (s.side || s.type || s.text || s.signal || '').toString().toUpperCase();
        if (t.includes('BUY') || t === 'B') return 'B';
        if (t.includes('SELL') || t === 'S') return 'S';
        return '';
      };

      // Build time->index map
      const times = candles.map(x => x.time);
      const findNearestIndex = (t) => {
        if (t == null) return -1;
        // exact match first
        const exact = times.indexOf(t);
        if (exact >= 0) return exact;
        // nearest (linear scan ok for 600 bars)
        let best = -1, bestd = Infinity;
        for (let i = 0; i < times.length; i++) {
          const d = Math.abs(Number(times[i]) - Number(t));
          if (d < bestd) { bestd = d; best = i; }
        }
        return best;
      };

      const sigs = [];
      for (const s of (sigsRaw || [])) {
        const side = normSide(s);
        if (!side) continue;

        const t = (s.time ?? s.t ?? s.timestamp ?? s.x);
        let idx = (typeof s.index === 'number') ? s.index : findNearestIndex(t);

        // price
        let px = s.price ?? s.y ?? s.value;
        if (px == null && idx >= 0) px = candles[idx].close;

        if (idx < 0 || px == null) continue;
        sigs.push({ idx, side, price: Number(px) });
      }

      // take last 14 signals for cleanliness
      const lastSigs = sigs.slice(-14);

      // compute min/max for y mapping
      let minP = Infinity, maxP = -Infinity;
      for (const c of candles) { minP = Math.min(minP, c.low); maxP = Math.max(maxP, c.high); }
      if (!Number.isFinite(minP) || !Number.isFinite(maxP) || maxP <= minP) return;

      const rect = DOM.chartWrap.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;

      // clear overlay
      DOM.sigOverlay.innerHTML = '';

      // place marks
      for (const s of lastSigs) {
        const x = (s.idx / (candles.length - 1)) * W;
        const y = ((maxP - s.price) / (maxP - minP)) * H;

        const el = document.createElement('div');
        el.className = 'sigMark ' + (s.side === 'B' ? 'buy' : 'sell');

        // FORCE big + glow inline (beats any CSS override)
        el.style.fontSize = '24px';
        el.style.fontWeight = '950';
        el.style.padding = '4px 10px';
        el.style.borderRadius = '14px';
        el.style.transform = 'translate(-50%, -50%)';
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.position = 'absolute';
        el.style.background = 'rgba(0,0,0,.25)';
        el.style.backdropFilter = 'blur(2px)';
        el.style.border = s.side === 'B'
          ? '1px solid rgba(43,226,166,.40)'
          : '1px solid rgba(255,90,90,.40)';
        el.style.color = s.side === 'B' ? 'rgba(43,226,166,1)' : 'rgba(255,90,90,1)';
        el.style.textShadow = s.side === 'B'
          ? '0 0 10px rgba(43,226,166,.55), 0 0 18px rgba(43,226,166,.30)'
          : '0 0 10px rgba(255,90,90,.55), 0 0 18px rgba(255,90,90,.30)';
        el.style.boxShadow = '0 12px 28px rgba(0,0,0,.30)';

        el.textContent = s.side;

        DOM.sigOverlay.appendChild(el);
      }
    }, 'renderOverlaySignals');
  }

  // -----------------------------
  // Main tick
  // -----------------------------
  function tick() {
    return safe(() => {
      const snap = getSnapshot();
      if (!snap) return;

      updateMarketPulseUI(snap);
      updateRiskCopilotUI(snap);
      renderOverlaySignals(snap);
    }, 'tick');
  }

  // -----------------------------
  // Boot
  // -----------------------------
  function start() {
    bindDOM();

    // Ensure overlay is on top (in case CSS got overridden)
    safe(() => {
      if (DOM.sigOverlay) {
        DOM.sigOverlay.style.position = 'absolute';
        DOM.sigOverlay.style.inset = '0';
        DOM.sigOverlay.style.pointerEvents = 'none';
        DOM.sigOverlay.style.zIndex = '50';
      }
    }, 'overlayStyle');

    // Polling is safer than relying on chart events (no coupling)
    tick();
    setInterval(tick, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
