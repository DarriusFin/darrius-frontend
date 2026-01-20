/* market.pulse.js (FINAL - SAFE)
 * UI-only layer. Must NOT mutate chart.core.js internals.
 * - Reads snapshot
 * - Renders Market Pulse
 * - Renders Risk Copilot
 * - Renders BIG glowing B/S overlay (independent from chart markers)
 *
 * Fixes:
 * 1) Overlay uses DarriusChart.timeToX / priceToY (read-only bridge), NOT window.__chart.
 * 2) Robust signal normalization: supports signals/sigs/markers/etc even if not Array.
 * 3) Normalize time to seconds (ms -> sec) to match LightweightCharts in chart.core.js.
 * 4) Host container resolved via DarriusChart.__hostId (fallback chartWrap/chart).
 * 5) Never-throw zones preserved.
 */

(() => {
  'use strict';

  // NOTE:
  // 强烈建议：window.__OVERLAY_BIG_SIGS__ 由 index.html 在 chart.core.js 之前设置。
  // 这里不强制覆盖，只做兜底（避免你忘了放 index.html 时无法关小 markers）
  if (typeof window.__OVERLAY_BIG_SIGS__ !== 'boolean') window.__OVERLAY_BIG_SIGS__ = true;

  // -----------------------------
  // Absolute no-throw safe zone
  // -----------------------------
  function safe(fn, tag = 'market.pulse') {
    try { return fn(); } catch (_) { return null; }
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

    // Overlay host / layer
    chartWrap: null,
    chart: null,
    overlayLayer: null,
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

    DOM.chartWrap = $('chartWrap');
    DOM.chart = $('chart');
  }

  // -----------------------------
  // Snapshot reader (multiple fallbacks)
  // -----------------------------
  function getSnapshot() {
    if (window.DarriusChart && typeof window.DarriusChart.getSnapshot === 'function') {
      return safe(() => window.DarriusChart.getSnapshot(), 'getSnapshot:DarriusChart');
    }
    if (typeof window.getChartSnapshot === 'function') {
      return safe(() => window.getChartSnapshot(), 'getSnapshot:getChartSnapshot');
    }
    if (window.__DARRIUS_CHART_STATE__) return window.__DARRIUS_CHART_STATE__;
    if (window.__IH_SNAPSHOT__) return window.__IH_SNAPSHOT__;
    if (window.__CHART_SNAPSHOT__) return window.__CHART_SNAPSHOT__;
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
  function last(arr) { return arr && arr.length ? arr[arr.length - 1] : null; }

  // time normalize: ms -> sec
  function toSec(t) {
    if (t == null) return null;
    if (typeof t === 'number') {
      if (!Number.isFinite(t)) return null;
      return t > 2e10 ? Math.floor(t / 1000) : t;
    }
    // NOTE: we keep string time unsupported here (overlay relies on numeric time)
    return null;
  }

  function coerceArray(x) {
    if (!x) return [];
    if (Array.isArray(x)) return x;
    if (typeof x === 'object') {
      // dictionary-like or array-like object
      const out = [];
      for (const k of Object.keys(x)) {
        if (k === 'length') continue;
        out.push(x[k]);
      }
      return out.filter(Boolean);
    }
    return [];
  }

  // candles
  function pickCandles(snap) {
    if (!snap) return null;
    if (Array.isArray(snap.candles)) return snap.candles;
    if (Array.isArray(snap.bars)) return snap.bars;
    if (Array.isArray(snap.ohlc)) return snap.ohlc;
    if (Array.isArray(snap.data)) return snap.data;
    return null;
  }

  // raw signals picker (support both schemas: signals or sigs)
  function pickSignalsAnyShape(snap) {
    if (!snap) return [];
    // IMPORTANT: signals may be not Array (your console proved it), so coerce.
    const cand = snap.signals ?? snap.sigs ?? snap.bsSignals ?? snap.markers ?? [];
    return coerceArray(cand);
  }

  function normSide(s) {
    const t = (s?.side ?? s?.type ?? s?.text ?? s?.signal ?? s?.action ?? '').toString().toUpperCase();
    if (t.includes('BUY') || t === 'B') return 'B';
    if (t.includes('SELL') || t === 'S') return 'S';
    return '';
  }

  // Normalize overlay signals to {time(sec), price(number), side:'B'|'S'}
  function normalizeOverlaySignals(snap) {
    return safe(() => {
      const sigsRaw = pickSignalsAnyShape(snap);
      if (!sigsRaw.length) return [];

      const candles = pickCandles(snap) || [];
      const closeByTime = new Map();
      for (const b of candles) {
        const t = toSec(b?.time);
        const c = Number(b?.close);
        if (t != null && Number.isFinite(c)) closeByTime.set(t, c);
      }

      const out = [];
      // take last N to avoid clutter
      const start = Math.max(0, sigsRaw.length - 120);
      for (let i = start; i < sigsRaw.length; i++) {
        const s = sigsRaw[i] || {};
        const side = normSide(s);
        if (!side) continue;

        const t = toSec(s.time ?? s.t ?? s.timestamp ?? s.ts ?? s.date);
        if (t == null) continue;

        let p0 = s.price ?? s.p ?? s.y ?? s.value ?? null;
        let p = (typeof p0 === 'number' && Number.isFinite(p0)) ? p0 : closeByTime.get(t);
        p = Number(p);
        if (!Number.isFinite(p)) continue;

        out.push({ time: t, price: p, side });
      }

      out.sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));
      return out;
    }, 'normalizeOverlaySignals') || [];
  }

  // -----------------------------
  // Core derived metrics (Preset 2)
  // -----------------------------
  function deriveTrendRegime(snap, candles) {
    const emaArr = snap && (snap.ema || snap.emaData || snap.ema14);
    if (Array.isArray(emaArr) && emaArr.length >= 6) {
      const a = emaArr[emaArr.length - 1]?.value ?? emaArr[emaArr.length - 1];
      const b = emaArr[emaArr.length - 6]?.value ?? emaArr[emaArr.length - 6];
      const slope = (a - b);
      const eps = Math.abs(a) * 0.0004;
      if (slope > eps) return 'UP';
      if (slope < -eps) return 'DOWN';
      return 'FLAT';
    }
    if (candles && candles.length >= 6) {
      const c1 = candles[candles.length - 1].close;
      const c0 = candles[candles.length - 6].close;
      const slope = c1 - c0;
      const eps = Math.abs(c1) * 0.003;
      if (slope > eps) return 'UP';
      if (slope < -eps) return 'DOWN';
      return 'FLAT';
    }
    return 'FLAT';
  }

  function deriveStability(snap, candles) {
    let auxFlat = 0.5;
    let emaFlips = 0.0;

    const auxArr = snap && (snap.aux || snap.auxData || snap.aux40);
    if (Array.isArray(auxArr) && auxArr.length >= 10) {
      const a = auxArr[auxArr.length - 1]?.value ?? auxArr[auxArr.length - 1];
      const b = auxArr[auxArr.length - 6]?.value ?? auxArr[auxArr.length - 6];
      const slope = Math.abs(a - b);
      const base = Math.max(1e-9, Math.abs(a));
      const ratio = slope / base;
      auxFlat = clamp(1 - ratio * 18, 0, 1);
    }

    const emaArr = snap && (snap.ema || snap.emaData || snap.ema14);
    if (Array.isArray(emaArr) && emaArr.length >= 15 && candles && candles.length >= 15) {
      let flips = 0;
      let prev = null;
      const start = Math.max(0, emaArr.length - 15);
      for (let i = start; i < emaArr.length; i++) {
        const emaV = emaArr[i]?.value ?? emaArr[i];
        const close = candles[i]?.close;
        if (close == null || emaV == null) continue;
        const sign = close >= emaV ? 1 : -1;
        if (prev != null && sign !== prev) flips++;
        prev = sign;
      }
      emaFlips = clamp(flips / 8, 0, 1);
    }

    return clamp((auxFlat * 0.6 + (1 - emaFlips) * 0.4) * 100, 0, 100);
  }

  function deriveInflectionBias(snap) {
    const sigs = pickSignalsAnyShape(snap);
    if (!sigs.length) return 'NEUTRAL';

    for (let i = sigs.length - 1; i >= 0; i--) {
      const side = normSide(sigs[i]);
      if (!side) continue;
      if (sigs[i].confirmed === false) continue;
      return side === 'B' ? 'BULL' : 'BEAR';
    }
    return 'NEUTRAL';
  }

  function derivePulseLabel(trendRegime, bias, stability) {
    let label = 'NEUTRAL';
    if (trendRegime === 'DOWN') label = 'BEARISH';
    if (trendRegime === 'UP') label = 'BULLISH';
    if (trendRegime === 'FLAT') label = 'NEUTRAL';

    if (bias === 'BULL') label = (trendRegime === 'DOWN') ? 'NEUTRAL' : 'BULLISH';
    if (bias === 'BEAR') label = (trendRegime === 'UP') ? 'NEUTRAL' : 'BEARISH';

    if (trendRegime === 'UP' && label === 'BEARISH') label = 'NEUTRAL';

    if (stability < 35) {
      if (label === 'BULLISH') label = 'NEUTRAL';
      if (label === 'BEARISH') label = 'NEUTRAL';
    }
    return label;
  }

  function deriveTradabilityScore(trendRegime, bias, stability) {
    let base = 35;
    if (trendRegime === 'UP') base += 18;
    if (trendRegime === 'DOWN') base += 12;
    if (trendRegime === 'FLAT') base -= 5;
    if (bias === 'BULL') base += 12;
    if (bias === 'BEAR') base += 10;
    base = base * (0.55 + (stability / 100) * 0.45);
    return Math.round(clamp(base, 0, 100));
  }

  // -----------------------------
  // UI: Market Pulse
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

      DOM.pulseScore.textContent = String(score);

      let bull = 10, bear
