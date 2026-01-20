/* market.pulse.js
 * UI-only layer. Must NOT mutate chart.core.js internals.
 * - Reads snapshot
 * - Renders Market Pulse
 * - Renders Risk Copilot
 * - Renders BIG glowing B/S overlay (independent from chart markers)
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

    // Overlay host / layer
    chartWrap: null,
    chart: null,
    overlayLayer: null
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

  // candles
  function pickCandles(snap) {
    if (!snap) return null;
    if (Array.isArray(snap.candles)) return snap.candles;
    if (Array.isArray(snap.bars)) return snap.bars;
    if (Array.isArray(snap.ohlc)) return snap.ohlc;
    if (Array.isArray(snap.data)) return snap.data;
    return null;
  }

  // signals (support both schemas: signals or sigs)
  function pickSignals(snap) {
    if (!snap) return [];
    if (Array.isArray(snap.signals)) return snap.signals;
    if (Array.isArray(snap.sigs)) return snap.sigs;
    if (Array.isArray(snap.bsSignals)) return snap.bsSignals;
    if (Array.isArray(snap.markers)) return snap.markers;
    return [];
  }

  function normSide(s) {
    const t = (s?.side ?? s?.type ?? s?.text ?? s?.signal ?? s?.action ?? '').toString().toUpperCase();
    if (t.includes('BUY') || t === 'B') return 'B';
    if (t.includes('SELL') || t === 'S') return 'S';
    return '';
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
    const sigs = pickSignals(snap);
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

      let bull = 10, bear = 10, neu = 80;
      if (label === 'BULLISH') { bull = 55; bear = 10; neu = 35; }
      if (label === 'BEARISH') { bull = 10; bear = 55; neu = 35; }
      if (label === 'NEUTRAL') { bull = 16; bear = 15; neu = 69; }

      const shrink = clamp(1 - (stability / 100), 0, 1);
      neu = Math.round(neu + shrink * 10);
      bull = Math.round(bull - shrink * 5);
      bear = Math.round(bear - shrink * 5);

      bull = clamp(bull, 0, 100);
      bear = clamp(bear, 0, 100);
      neu = clamp(neu, 0, 100);

      if (DOM.bullPct) DOM.bullPct.textContent = bull + '%';
      if (DOM.bearPct) DOM.bearPct.textContent = bear + '%';
      if (DOM.neuPct) DOM.neuPct.textContent = neu + '%';
      if (DOM.netInflow) DOM.netInflow.textContent = '—';

      const deg = Math.round(clamp(score, 0, 100) * 3.6);
      DOM.pulseGaugeMask.style.background =
        `conic-gradient(rgba(43,226,166,1) 0deg, rgba(76,194,255,1) ${deg}deg, rgba(255,255,255,.10) ${deg}deg, rgba(255,255,255,.10) 360deg)`;
      DOM.pulseGaugeMask.style.opacity = String(clamp(0.35 + (stability / 100) * 0.55, 0.35, 0.90));

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

      let vol = 0;
      const n = 14;
      for (let i = candles.length - n; i < candles.length; i++) {
        const prev = candles[i - 1]?.close;
        const cur = candles[i]?.close;
        if (prev == null || cur == null) continue;
        vol += Math.abs(cur - prev);
      }
      vol = vol / Math.max(1, n - 1);

      const bias = deriveInflectionBias(snap);
      const dir = (bias === 'BEAR') ? 'SHORT' : 'LONG';

      const entry = close;
      const stopDist = Math.max(vol * 1.6, close * 0.004);
      const stop = (dir === 'LONG') ? (entry - stopDist) : (entry + stopDist);
      const t1 = (dir === 'LONG') ? (entry + stopDist) : (entry - stopDist);
      const t2 = (dir === 'LONG') ? (entry + stopDist * 2) : (entry - stopDist * 2);

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

      if (DOM.riskWR) {
        const wr = Math.round(clamp(42 + (stability / 100) * 18 + (align - 0.5) * 25, 35, 72));
        DOM.riskWR.textContent = `${wr}%`;
      }
    }, 'updateRiskCopilotUI');
  }

  // -----------------------------
  // BIG glowing B/S overlay (only big, no small markers)
  // Uses true coordinates from LightweightCharts (read-only)
  // -----------------------------
  function ensureOverlayLayer(host) {
    return safe(() => {
      if (!host) return null;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

      let layer = document.getElementById('bsOverlayLayer');
      if (!layer) {
        layer = document.createElement('div');
        layer.id = 'bsOverlayLayer';
        layer.style.position = 'absolute';
        layer.style.left = '0';
        layer.style.top = '0';
        layer.style.width = '100%';
        layer.style.height = '100%';
        layer.style.pointerEvents = 'none';
        layer.style.zIndex = '30';
        host.appendChild(layer);
      }
      return layer;
    }, 'ensureOverlayLayer');
  }

  function getChartBridge() {
    // read-only bridge
    const chart =
      window.__chart ||
      window.chart ||
      null;

    const candleSeries =
      window.__candleSeries ||
      window.candleSeries ||
      window._candleSeries ||
      null;

    const ok =
      chart &&
      typeof chart.timeScale === 'function' &&
      chart.timeScale() &&
      typeof chart.timeScale().timeToCoordinate === 'function' &&
      candleSeries &&
      typeof candleSeries.priceToCoordinate === 'function';

    if (!ok) return null;

    return { chart, candleSeries };
  }

  function renderOverlaySignals(snap) {
    safe(() => {
      const host = DOM.chartWrap || DOM.chart || document.getElementById('chartWrap') || document.getElementById('chart');
      if (!host) return;

      const layer = ensureOverlayLayer(host);
      if (!layer) return;
      layer.innerHTML = '';

      const bridge = getChartBridge();
      if (!bridge) return; // 没有真实坐标桥接就不画（避免错位/游离）

      const sigsRaw = pickSignals(snap);
      if (!sigsRaw.length) return;

      // Determine price for each signal:
      // - If signal has price => use it
      // - Else fallback to close at same time (if candles exist)
      const candles = pickCandles(snap) || [];
      const timeToClose = new Map();
      for (const b of candles) {
        if (b && b.time != null && Number.isFinite(Number(b.close))) timeToClose.set(b.time, Number(b.close));
      }

      const norm = [];
      for (let i = Math.max(0, sigsRaw.length - 80); i < sigsRaw.length; i++) {
        const s = sigsRaw[i];
        const side = normSide(s);
        if (!side) continue;

        const t = s.time ?? s.t ?? s.timestamp ?? s.ts ?? null;
        if (t == null) continue;

        const p0 = s.price ?? s.p ?? s.y ?? s.value ?? null;
        const p = (typeof p0 === 'number' && Number.isFinite(p0)) ? p0 : (timeToClose.get(t) ?? null);
        if (p == null) continue;

        norm.push({ time: t, price: p, side });
      }
      if (!norm.length) return;

      for (const s of norm) {
        const x = bridge.chart.timeScale().timeToCoordinate(s.time);
        const y = bridge.candleSeries.priceToCoordinate(s.price);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

        const el = document.createElement('div');
        el.textContent = s.side;

        el.style.position = 'absolute';
        el.style.transform = 'translate(-50%, -50%)';
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;

        el.style.width = '34px';
        el.style.height = '34px';
        el.style.borderRadius = '999px';
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';
        el.style.fontWeight = '800';
        el.style.fontSize = '16px';
        el.style.letterSpacing = '0.5px';

        if (s.side === 'B') {
          el.style.color = '#2BE2A6';
          el.style.border = '1px solid rgba(43,226,166,.70)';
          el.style.background = 'rgba(10, 30, 25, .35)';
          el.style.boxShadow = '0 0 10px rgba(43,226,166,.35), 0 0 22px rgba(43,226,166,.22)';
        } else {
          el.style.color = '#FF5A5A';
          el.style.border = '1px solid rgba(255,90,90,.70)';
          el.style.background = 'rgba(40, 10, 10, .35)';
          el.style.boxShadow = '0 0 10px rgba(255,90,90,.35), 0 0 22px rgba(255,90,90,.22)';
        }

        layer.appendChild(el);
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
    tick();
    setInterval(tick, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
