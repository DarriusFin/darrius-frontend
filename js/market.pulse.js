/* market.pulse.js (FINAL - REPLACEABLE)
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
    try { return fn(); } catch (e) { return null; }
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

  function isBusinessDay(t) {
    return !!(t && typeof t === 'object' && t.year && t.month && t.day);
  }

  function toUtcSec(t) {
    if (t == null) return null;
    if (typeof t === 'number' && Number.isFinite(t)) {
      // ms -> sec
      if (t > 2e10) return Math.floor(t / 1000);
      return t;
    }
    if (typeof t === 'string') {
      const ms = Date.parse(t);
      if (!Number.isFinite(ms)) return null;
      return Math.floor(ms / 1000);
    }
    if (isBusinessDay(t)) {
      const ms = Date.UTC(t.year, (t.month || 1) - 1, t.day || 1, 0, 0, 0);
      return Math.floor(ms / 1000);
    }
    return null;
  }

  function toBusinessDayFromUtcSec(sec) {
    const ms = sec * 1000;
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return null;
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }

  function timeKey(t) {
    // for Map key
    if (isBusinessDay(t)) return `${t.year}-${t.month}-${t.day}`;
    return String(t);
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

  // signals (support both schemas: signals or sigs)
  function pickSignalsRaw(snap) {
    if (!snap) return null;
    if (snap.signals != null) return snap.signals;
    if (snap.sigs != null) return snap.sigs;
    if (snap.bsSignals != null) return snap.bsSignals;
    if (snap.markers != null) return snap.markers;
    return null;
  }

  function asArrayMaybe(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    // handle object-like "array"
    if (typeof raw === 'object') {
      const keys = Object.keys(raw).filter(k => k !== 'length');
      // if it's actually a dict, this still works
      return keys.map(k => raw[k]).filter(Boolean);
    }
    return [];
  }

  function normSide(s) {
    const t = (s?.side ?? s?.type ?? s?.text ?? s?.signal ?? s?.action ?? '').toString().toUpperCase();
    if (t.includes('BUY') || t === 'B') return 'B';
    if (t.includes('SELL') || t === 'S') return 'S';
    return '';
  }

  function detectCandleTimeMode(candles) {
    const c0 = candles && candles.length ? candles[0] : null;
    const t0 = c0 && c0.time;
    return isBusinessDay(t0) ? 'businessDay' : 'utc';
  }

  function buildCandleTimeIndex(candles) {
    // returns { mode, timesUtcSecSorted, timeKeyToCandleTime, timeKeyToClose }
    const mode = detectCandleTimeMode(candles);
    const timesUtcSec = [];
    const timeKeyToCandleTime = new Map();
    const timeKeyToClose = new Map();

    for (const b of (candles || [])) {
      if (!b || b.time == null) continue;

      const t = b.time;
      const k = timeKey(t);
      timeKeyToCandleTime.set(k, t);

      const close = Number(b.close);
      if (Number.isFinite(close)) timeKeyToClose.set(k, close);

      const sec = toUtcSec(t);
      if (sec != null) timesUtcSec.push(sec);
    }

    timesUtcSec.sort((a, b) => a - b);

    return { mode, timesUtcSecSorted: timesUtcSec, timeKeyToCandleTime, timeKeyToClose };
  }

  function nearestCandleUtcSec(sortedSecs, targetSec) {
    if (!sortedSecs || !sortedSecs.length || targetSec == null) return null;
    let lo = 0, hi = sortedSecs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = sortedSecs[mid];
      if (v === targetSec) return v;
      if (v < targetSec) lo = mid + 1;
      else hi = mid - 1;
    }
    const a = sortedSecs[Math.max(0, hi)];
    const b = sortedSecs[Math.min(sortedSecs.length - 1, lo)];
    if (a == null) return b ?? null;
    if (b == null) return a ?? null;
    return (Math.abs(a - targetSec) <= Math.abs(b - targetSec)) ? a : b;
  }

  function normalizeOverlaySignals(snap) {
    const raw = pickSignalsRaw(snap);
    const arr = asArrayMaybe(raw);
    if (!arr.length) return [];

    const candles = pickCandles(snap) || [];
    const idx = buildCandleTimeIndex(candles);

    const out = [];
    const start = Math.max(0, arr.length - 160);

    for (let i = start; i < arr.length; i++) {
      const s = arr[i] || {};
      const side = normSide(s);
      if (!side) continue;

      // ---- raw time ----
      let t = s.time ?? s.t ?? s.timestamp ?? s.ts ?? s.date ?? null;
      if (t == null) continue;

      // unify to utcSec if possible
      const sec = toUtcSec(t);
      if (sec == null) continue;

      // absorb to nearest candle day/time (fix: timeToCoordinate null)
      const nearSec = nearestCandleUtcSec(idx.timesUtcSecSorted, sec);
      if (nearSec == null) continue;

      let candleTime;
      if (idx.mode === 'businessDay') {
        // convert nearest sec to business day
        candleTime = toBusinessDayFromUtcSec(nearSec);
        if (!candleTime) continue;
      } else {
        candleTime = nearSec; // utc seconds
      }

      // price
      const p0 = s.price ?? s.p ?? s.y ?? s.value ?? null;
      let price = (typeof p0 === 'number' && Number.isFinite(p0)) ? p0 : null;

      if (price == null) {
        const k = timeKey(candleTime);
        price = idx.timeKeyToClose.get(k) ?? null;
      }
      if (price == null || !Number.isFinite(Number(price))) continue;

      out.push({ time: candleTime, price: Number(price), side });
    }

    return out;
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
    const sigs = normalizeOverlaySignals(snap);
    if (!sigs.length) return 'NEUTRAL';

    for (let i = sigs.length - 1; i >= 0; i--) {
      const side = sigs[i].side;
      if (!side) continue;
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
  // Uses TRUE coordinates from chart.core.js read-only bridge:
  //   DarriusChart.timeToX / DarriusChart.priceToY
  // -----------------------------
  function getOverlayHost() {
    const hostId = (window.DarriusChart && window.DarriusChart.__hostId) ? window.DarriusChart.__hostId : 'chart';
    return document.getElementById(hostId) || DOM.chart || document.getElementById('chart');
  }

  function ensureOverlayLayer(host) {
    return safe(() => {
      if (!host) return null;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

      let layer = host.querySelector('#bsOverlayLayer');
      if (!layer) {
        layer = document.createElement('div');
        layer.id = 'bsOverlayLayer';
        layer.style.position = 'absolute';
        layer.style.left = '0';
        layer.style.top = '0';
        layer.style.width = '100%';
        layer.style.height = '100%';
        layer.style.pointerEvents = 'none';
        layer.style.zIndex = '9999';
        host.appendChild(layer);
      }
      return layer;
    }, 'ensureOverlayLayer');
  }

  function ensurePulseKeyframes() {
  safe(() => {
    if (document.getElementById('bsPulseKeyframes')) return;

    const style = document.createElement('style');
    style.id = 'bsPulseKeyframes';
    style.textContent = `
      @keyframes darriusPulseGold {
        0%   { transform: translate(-50%, -50%) scale(1.00); filter: brightness(1); }
        35%  { transform: translate(-50%, -50%) scale(1.18); filter: brightness(1.25); }
        70%  { transform: translate(-50%, -50%) scale(1.06); filter: brightness(1.10); }
        100% { transform: translate(-50%, -50%) scale(1.00); filter: brightness(1); }
      }

      /* 额外加一个“光晕扩散”的伪元素（很高级） */
      .darrius-pulse-b {
        position: absolute;
      }
      .darrius-pulse-b::after {
        content: '';
        position: absolute;
        left: 50%;
        top: 50%;
        width: 34px;
        height: 34px;
        border-radius: 999px;
        transform: translate(-50%, -50%);
        background: rgba(255,193,7,0.18);
        box-shadow: 0 0 18px rgba(255,193,7,0.55), 0 0 44px rgba(255,193,7,0.30);
        opacity: 0;
        animation: darriusPulseGoldRing 1.2s ease-out 0s 1 both;
        pointer-events: none;
        z-index: -1;
      }
      @keyframes darriusPulseGoldRing {
        0%   { transform: translate(-50%, -50%) scale(0.95); opacity: 0.0; }
        25%  { opacity: 0.8; }
        100% { transform: translate(-50%, -50%) scale(2.2); opacity: 0.0; }
      }
    `;
    document.head.appendChild(style);
  }, 'ensurePulseKeyframes');
}

  function renderOverlaySignals(snap) {
    safe(() => {
      const host = getOverlayHost();
      if (!host) return;

      const layer = ensureOverlayLayer(host);
      if (!layer) return;

      // clear
      layer.innerHTML = '';

      // must have bridge
      const timeToX = window.DarriusChart && typeof window.DarriusChart.timeToX === 'function'
        ? window.DarriusChart.timeToX
        : null;
      const priceToY = window.DarriusChart && typeof window.DarriusChart.priceToY === 'function'
        ? window.DarriusChart.priceToY
        : null;

      if (!timeToX || !priceToY) return;

      const sigs = normalizeOverlaySignals(snap);
      ensurePulseKeyframes();

// only pulse the last BUY
let lastBIndex = -1;
for (let i = sigs.length - 1; i >= 0; i--) {
  if (sigs[i] && sigs[i].side === 'B') { lastBIndex = i; break; }
}
      if (!sigs.length) return;

      // draw last N (avoid overcrowding)
      const start = Math.max(0, sigs.length - 80);
      for (let i = start; i < sigs.length; i++) {
        const s = sigs[i];

        const x = timeToX(s.time);
        const y = priceToY(s.price);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

        const el = document.createElement('div');
        el.textContent = s.side;
        
const isLastBuy = (i === lastBIndex && s.side === 'B');
if (isLastBuy) {
  el.classList.add('darrius-pulse-b');                 // 给 ::after 用
  el.style.animation = 'darriusPulseGold 1.2s ease-out 0s 1 both';
}

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
  // BUY：金黄色实心 + 黑字 + 金色脉冲
  el.style.color = '#0B0B0B';                             // ← 黑色 B
  el.style.background = 'rgba(255,193,7,0.95)';          // 金黄色底
  el.style.border = '1px solid rgba(255,255,255,0.75)';
  el.style.boxShadow =
    '0 0 10px rgba(255,193,7,0.65), 0 0 26px rgba(255,193,7,0.40)';
  el.style.textShadow = '0 1px 1px rgba(255,255,255,0.25)'; // 轻微提亮边缘
} else {
  // SELL：亮红色实心 + 白字
  el.style.color = '#FFFFFF';
  el.style.background = 'rgba(255,90,90,0.95)';         // 亮红底
  el.style.border = '1px solid rgba(255,255,255,0.65)'; // 白色描边
  el.style.boxShadow =
    '0 0 10px rgba(255,90,90,0.55), 0 0 26px rgba(255,90,90,0.35)';
  el.style.textShadow = '0 1px 2px rgba(0,0,0,0.35)';
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

    // initial
    tick();

    // best: react to chart updated
    safe(() => {
      window.addEventListener('darrius:chartUpdated', () => tick());
    }, 'bindChartUpdated');

    // fallback interval
    setInterval(tick, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
