/* market.pulse.js (STABLE COMPAT - REPLACEABLE) v2026.01.23
 * UI-only layer. Must NOT mutate chart.core.js internals.
 * - Reads snapshot (multiple schemas)
 * - Renders Market Pulse
 * - Renders Risk Copilot
 * - Renders BIG glowing B/S overlay (independent from chart markers)
 *
 * Patch v2026.01.23:
 * - Anchor BIG signals to EMA/AUX lines:
 *   - B/eB => always BELOW EMA
 *   - S/eS => always ABOVE AUX
 * - Pulse the last: B, eB, S, eS (like last B effect)
 *
 * Safety:
 * - Never throws
 * - Never touches billing/subscription logic
 */
(() => {
  'use strict';

  // Overlay default (do NOT override if already set by index.html)
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

  // -----------------------------
  // DOM binding (IDs must be UNIQUE in index.html)
  // -----------------------------
  const DOM = {
    // Market Pulse
    pulseScore: null,
    bullPct: null,
    bearPct: null,
    neuPct: null,
    netInflow: null,
    pulseGaugeMask: null,

    // Signal UI
    signalMeta: null,

    // Risk Copilot
    riskEntry: null,
    riskStop: null,
    riskTargets: null,
    riskConf: null,
    riskWR: null,

    // Chart host
    chart: null,
  };

  function bindDOM() {
    DOM.pulseScore = $('pulseScore');
    DOM.bullPct = $('bullPct');
    DOM.bearPct = $('bearPct');
    DOM.neuPct = $('neuPct');
    DOM.netInflow = $('netInflow');
    DOM.pulseGaugeMask = $('pulseGaugeMask');

    DOM.signalMeta = $('signalMeta');

    DOM.riskEntry = $('riskEntry');
    DOM.riskStop = $('riskStop');
    DOM.riskTargets = $('riskTargets');
    DOM.riskConf = $('riskConf');
    DOM.riskWR = $('riskWR');

    DOM.chart = $('chart') || document.querySelector('#chart');
  }

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
    if (window.__IH_SNAPSHOT__) return window.__IH_SNAPSHOT__;
    if (window.__CHART_SNAPSHOT__) return window.__CHART_SNAPSHOT__;
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
      if (t > 2e10) return Math.floor(t / 1000); // ms->s
      return t; // already s
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

  function pickCandles(snap) {
    if (!snap) return null;
    if (Array.isArray(snap.candles)) return snap.candles;
    if (Array.isArray(snap.bars)) return snap.bars;
    return null;
  }

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
    if (typeof raw === 'object') return Object.keys(raw).map(k => raw[k]).filter(Boolean);
    return [];
  }

  function normSide(s) {
    const raw = (s?.side ?? s?.type ?? s?.text ?? s?.signal ?? s?.action ?? '').toString().trim();
    const t = raw.toUpperCase();

    if (raw === 'eB' || raw === 'eS') return raw;
    if (t === 'EB' || t === 'E B' || t.includes('EBUY')) return 'eB';
    if (t === 'ES' || t === 'E S' || t.includes('ESELL')) return 'eS';

    if (t.includes('BUY') || t === 'B') return 'B';
    if (t.includes('SELL') || t === 'S') return 'S';
    return '';
  }

  function getTfFromSnap(snap) {
    const tf =
      snap?.meta?.timeframe ??
      snap?.meta?.tf ??
      snap?.tf ??
      snap?.timeframe ??
      snap?.params?.tf ??
      null;
    return (tf == null ? '' : String(tf)).trim();
  }

  function isIntradayTF(tf) {
    const s = String(tf || '').toLowerCase();
    return s.includes('m') || s.includes('h');
  }

  // -----------------------------
  // Normalize overlay signals
  // -----------------------------
  function normalizeOverlaySignals(snap) {
    const raw = pickSignalsRaw(snap);
    const arr = asArrayMaybe(raw);
    if (!arr.length) return [];

    const candles = pickCandles(snap) || [];
    const tf = getTfFromSnap(snap);
    const intraday = isIntradayTF(tf);

    const closeByKey = new Map();
    const candleTimesSec = [];

    for (const b of candles) {
      if (!b || b.time == null) continue;
      const sec = toUtcSec(b.time);
      if (sec != null) candleTimesSec.push(sec);
      const k = isBusinessDay(b.time) ? `${b.time.year}-${b.time.month}-${b.time.day}` : String(b.time);
      const c = Number(b.close);
      if (Number.isFinite(c)) closeByKey.set(k, c);
    }

    candleTimesSec.sort((a, b) => a - b);

    function nearestSec(target) {
      if (!candleTimesSec.length || target == null) return null;
      let lo = 0, hi = candleTimesSec.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = candleTimesSec[mid];
        if (v === target) return v;
        if (v < target) lo = mid + 1;
        else hi = mid - 1;
      }
      const a = candleTimesSec[Math.max(0, hi)];
      const b = candleTimesSec[Math.min(candleTimesSec.length - 1, lo)];
      if (a == null) return b ?? null;
      if (b == null) return a ?? null;
      return (Math.abs(a - target) <= Math.abs(b - target)) ? a : b;
    }

    function floorSec(target) {
      if (!candleTimesSec.length || target == null) return null;
      let lo = 0, hi = candleTimesSec.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = candleTimesSec[mid];
        if (v === target) return v;
        if (v < target) lo = mid + 1;
        else hi = mid - 1;
      }
      const idx = Math.max(0, Math.min(hi, candleTimesSec.length - 1));
      return candleTimesSec[idx] ?? null;
    }

    const out = [];
    const used = new Set();

    const start = Math.max(0, arr.length - 160);
    for (let i = start; i < arr.length; i++) {
      const s = arr[i] || {};
      const side = normSide(s);
      if (!side) continue;

      const tRaw = s.time ?? s.t ?? s.timestamp ?? s.ts ?? s.date ?? null;
      const sec = toUtcSec(tRaw);
      if (sec == null) continue;

      const isEarly = (side === 'eB' || side === 'eS');
      const near = isEarly ? floorSec(sec) : nearestSec(sec);
      if (near == null) continue;

      let t;
      if (intraday) {
        t = near;
      } else {
        const c0 = candles[0]?.time;
        if (isBusinessDay(c0)) {
          const d = new Date(near * 1000);
          t = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
        } else {
          t = near;
        }
      }

      const p0 = s.price ?? s.p ?? s.y ?? s.value ?? null;
      let price = (typeof p0 === 'number' && Number.isFinite(p0)) ? p0 : null;
      if (price == null) {
        const k = isBusinessDay(t) ? `${t.year}-${t.month}-${t.day}` : String(t);
        price = closeByKey.get(k) ?? null;
      }
      if (price == null || !Number.isFinite(Number(price))) continue;

      const key = `${isBusinessDay(t) ? `${t.year}-${t.month}-${t.day}` : t}:${side}`;
      if (used.has(key)) continue;
      used.add(key);

      out.push({ time: t, price: Number(price), side });
    }

    return out;
  }

  // -----------------------------
  // Line anchoring helpers (EMA/AUX)
  // -----------------------------
  function pickEmaLine(snap) {
    return (
      snap?.emaLine ||
      snap?.ema ||
      snap?.emaData ||
      snap?.ema14 ||
      snap?.indicators?.ema ||
      snap?.lines?.ema ||
      snap?.series?.ema ||
      null
    );
  }

  function pickAuxLine(snap) {
    return (
      snap?.auxLine ||
      snap?.aux ||
      snap?.auxData ||
      snap?.aux40 ||
      snap?.indicators?.aux ||
      snap?.lines?.aux ||
      snap?.series?.aux ||
      null
    );
  }

  function normalizeLineArr(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'object') {
      return Object.keys(raw).map(k => raw[k]).filter(Boolean);
    }
    return [];
  }

  function linePointTimeSec(p) {
    const t = p?.time ?? p?.t ?? p?.timestamp ?? p?.ts ?? null;
    return toUtcSec(t);
  }

  function linePointValue(p) {
    const v = (p?.value != null) ? p.value : (p?.price != null ? p.price : p?.y);
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function nearestLineValueAtSec(lineArr, targetSec) {
    if (!Array.isArray(lineArr) || !lineArr.length || targetSec == null) return null;

    // Fast path: if already sorted-ish, still safe to scan (line length typically <= bars)
    let best = null;
    let bestDt = Infinity;
    for (let i = 0; i < lineArr.length; i++) {
      const p = lineArr[i];
      const sec = linePointTimeSec(p);
      if (sec == null) continue;
      const dt = Math.abs(sec - targetSec);
      if (dt < bestDt) {
        bestDt = dt;
        best = p;
      }
    }
    if (!best) return null;
    return linePointValue(best);
  }

  // -----------------------------
  // Core derived metrics (simple + stable)
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
      if (side === 'B' || side === 'eB') return 'BULL';
      if (side === 'S' || side === 'eS') return 'BEAR';
    }
    return 'NEUTRAL';
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
      const score = deriveTradabilityScore(trendRegime, bias, stability);

      DOM.pulseScore.textContent = String(score);

      let bull = 16, bear = 15, neu = 69;
      if (trendRegime === 'UP') { bull = 55; bear = 10; neu = 35; }
      if (trendRegime === 'DOWN') { bull = 10; bear = 55; neu = 35; }
      if (bias === 'BULL' && trendRegime !== 'DOWN') { bull += 8; neu -= 8; }
      if (bias === 'BEAR' && trendRegime !== 'UP') { bear += 8; neu -= 8; }

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
        const stxt = stability < 40 ? 'Low stability' : 'Stable';
        DOM.signalMeta.innerHTML = `${ttxt} · ${btxt} · ${stxt}`;
      }
    }, 'updateMarketPulseUI');
  }

  // -----------------------------
  // UI: Risk Copilot (derived only)
  // -----------------------------
  function updateRiskCopilotUI(snap) {
    return safe(() => {
      if (!DOM.riskEntry || !DOM.riskStop || !DOM.riskTargets || !DOM.riskConf) return;

      if (DOM.riskEntry === DOM.riskStop || DOM.riskEntry === DOM.riskTargets || DOM.riskEntry === DOM.riskConf) {
        return;
      }

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
      const close = Number(c?.close);
      if (!Number.isFinite(close)) return;

      let vol = 0;
      const n = 14;
      for (let i = candles.length - n; i < candles.length; i++) {
        const prev = Number(candles[i - 1]?.close);
        const cur = Number(candles[i]?.close);
        if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
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

      let align = 0.55;
      if (dir === 'LONG' && trendRegime === 'UP') align = 0.9;
      else if (dir === 'SHORT' && trendRegime === 'DOWN') align = 0.9;
      else if (trendRegime === 'FLAT') align = 0.45;

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
  // Overlay (BIG eB/eS + B/S)
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
        @keyframes darriusPulseGlow {
          0%   { transform: translate(-50%, -50%) scale(1.00); filter: brightness(1); }
          35%  { transform: translate(-50%, -50%) scale(1.18); filter: brightness(1.28); }
          70%  { transform: translate(-50%, -50%) scale(1.06); filter: brightness(1.12); }
          100% { transform: translate(-50%, -50%) scale(1.00); filter: brightness(1); }
        }

        /* ring uses css var --pulseRgb like: 255,193,7 */
        .darrius-pulse-sig { position:absolute; }
        .darrius-pulse-sig::after{
          content:'';
          position:absolute;
          left:50%; top:50%;
          width:34px; height:34px;
          border-radius:999px;
          transform:translate(-50%,-50%);
          background: rgba(var(--pulseRgb, 255,193,7), 0.18);
          box-shadow: 0 0 18px rgba(var(--pulseRgb, 255,193,7), 0.55),
                      0 0 44px rgba(var(--pulseRgb, 255,193,7), 0.30);
          opacity:0;
          animation: darriusPulseRing 1.2s ease-out 0s infinite;
          pointer-events:none;
          z-index:-1;
        }
        @keyframes darriusPulseRing{
          0%   { transform: translate(-50%,-50%) scale(0.95); opacity:0.0; }
          25%  { opacity:0.85; }
          100% { transform: translate(-50%,-50%) scale(2.2); opacity:0.0; }
        }
      `;
      document.head.appendChild(style);
    }, 'ensurePulseKeyframes');
  }

  function findLastIndexBySide(sigs, side) {
    for (let i = sigs.length - 1; i >= 0; i--) {
      if (sigs[i]?.side === side) return i;
    }
    return -1;
  }

  // Anchor y to EMA/AUX instead of candle price
  function computeAnchoredY(snap, sig, priceToY, gapPx) {
    // gap rules:
    // - BUY => below EMA => y + gap
    // - SELL => above AUX => y - gap
    const side = sig?.side || '';
    const sec = toUtcSec(sig?.time);
    if (sec == null) return null;

    const emaRaw = pickEmaLine(snap);
    const auxRaw = pickAuxLine(snap);
    const emaArr = normalizeLineArr(emaRaw);
    const auxArr = normalizeLineArr(auxRaw);

    const isBuy = (side === 'B' || side === 'eB');
    const isSell = (side === 'S' || side === 'eS');

    let anchorPrice = null;
    if (isBuy) anchorPrice = nearestLineValueAtSec(emaArr, sec);
    if (isSell) anchorPrice = nearestLineValueAtSec(auxArr, sec);

    // fallback (never disappear)
    if (anchorPrice == null || !Number.isFinite(Number(anchorPrice))) {
      anchorPrice = sig?.price;
    }

    const y0 = priceToY(Number(anchorPrice));
    if (!Number.isFinite(y0)) return null;

    if (isBuy) return y0 + gapPx;
    if (isSell) return y0 - gapPx;
    return y0;
  }

  function renderOverlaySignals(snap) {
    safe(() => {
      const host = getOverlayHost();
      if (!host) return;

      const layer = ensureOverlayLayer(host);
      if (!layer) return;

      layer.innerHTML = '';

      const timeToX = window.DarriusChart && typeof window.DarriusChart.timeToX === 'function'
        ? window.DarriusChart.timeToX : null;
      const priceToY = window.DarriusChart && typeof window.DarriusChart.priceToY === 'function'
        ? window.DarriusChart.priceToY : null;
      if (!timeToX || !priceToY) return;

      const sigs = normalizeOverlaySignals(snap);
      if (!sigs.length) return;

      ensurePulseKeyframes();

      // last indices (pulse these)
      const lastB  = findLastIndexBySide(sigs, 'B');
      const lastEB = findLastIndexBySide(sigs, 'eB');
      const lastS  = findLastIndexBySide(sigs, 'S');
      const lastES = findLastIndexBySide(sigs, 'eS');

      // draw last N
      const start = Math.max(0, sigs.length - 80);
      const gapPx = 12; // 你要更“贴线明显”，调 14/16 都行

      for (let i = start; i < sigs.length; i++) {
        const s = sigs[i];
        const x = timeToX(s.time);
        if (!Number.isFinite(x)) continue;

        // ✅ anchor y to EMA/AUX
        const y = computeAnchoredY(snap, s, priceToY, gapPx);
        if (!Number.isFinite(y)) continue;

        const el = document.createElement('div');
        el.textContent = s.side; // 'eB','eS','B','S'

        const isPulse = (i === lastB) || (i === lastEB) || (i === lastS) || (i === lastES);
        if (isPulse) {
          el.classList.add('darrius-pulse-sig');
          el.style.animation = 'darriusPulseGlow 1.2s ease-in-out 0s infinite';
        }

        el.style.position = 'absolute';
        el.style.transform = 'translate(-50%, -50%)';
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;

        const isEarly = (s.side === 'eB' || s.side === 'eS');
        el.style.width = isEarly ? '28px' : '34px';
        el.style.height = isEarly ? '28px' : '34px';
        el.style.borderRadius = '999px';
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';
        el.style.fontWeight = '800';
        el.style.fontSize = isEarly ? '14px' : '16px';
        el.style.opacity = isEarly ? '0.78' : '1';

        if (s.side === 'B' || s.side === 'eB') {
          // BUY
          el.style.setProperty('--pulseRgb', '255,193,7'); // gold
          el.style.color = '#0B0B0B';
          el.style.background = isEarly ? 'rgba(255,193,7,0.78)' : 'rgba(255,193,7,0.95)';
          el.style.border = '1px solid rgba(255,255,255,0.75)';
          el.style.boxShadow = isEarly
            ? '0 0 8px rgba(255,193,7,0.45), 0 0 18px rgba(255,193,7,0.25)'
            : '0 0 10px rgba(255,193,7,0.65), 0 0 26px rgba(255,193,7,0.40)';
        } else {
          // SELL
          el.style.setProperty('--pulseRgb', '255,90,90'); // red glow ring (matches your S/eS bg)
          el.style.color = '#FFFFFF';
          el.style.background = isEarly ? 'rgba(255,90,90,0.78)' : 'rgba(255,90,90,0.95)';
          el.style.border = '1px solid rgba(255,255,255,0.65)';
          el.style.boxShadow = isEarly
            ? '0 0 8px rgba(255,90,90,0.40), 0 0 18px rgba(255,90,90,0.22)'
            : '0 0 10px rgba(255,90,90,0.55), 0 0 26px rgba(255,90,90,0.35)';
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

    safe(() => {
      window.addEventListener('darrius:chartUpdated', () => {
        requestAnimationFrame(() => tick());
      });
    }, 'bindChartUpdated');

    // UI-only refresh (NO data provider hits)
    setInterval(tick, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
