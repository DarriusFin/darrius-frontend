/* =========================================================================
 * DarriusAI - market.pulse.js (FINAL FROZEN DISPLAY-ONLY) v2026.02.03-BADGE-CLEAN-HILO
 *
 * - UI-only. Never touches billing/subscription/payment.
 * - Market Pulse + Risk Copilot (NaN lock) kept.
 * - BIG glowing badges only (B/S/eB/eS), anchored to candle high/low.
 * - Prevent dirty screen:
 *    1) Do NOT draw tiny markers here (tiny markers are from chart.core.js).
 *    2) Do NOT use __LAST_SIG__ unless symbol/tf matches current snapshot.
 * ========================================================================= */

(() => {
  'use strict';

  console.log('[PULSE LOADED]', 'v2026.02.03-BADGE-CLEAN-HILO', Date.now());
  window.__PULSE_LOADED__ = 'v2026.02.03-BADGE-CLEAN-HILO';

  // -----------------------------
  // Safe zone
  // -----------------------------
  function safe(fn) { try { return fn(); } catch (_) { return null; } }

  // -----------------------------
  // Helpers (NaN lock)
  // -----------------------------
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const num = (v, fb = 0) => (isNum(v) ? v : fb);
  const nnull = (v) => (isNum(v) ? v : null);
  const str = (v, fb = '') => (typeof v === 'string' && v.length ? v : fb);

  const safePct = (part, total) => {
    const p = Number(part);
    const t = Number(total);
    if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return null;
    return (p / t) * 100;
  };

  const fmtPct0 = (v) => (v === null ? '—' : `${Math.round(v)}%`);
  const fmtPrice2 = (v) => (v === null ? '—' : `${Number(v).toFixed(2)}`);

  // -----------------------------
  // Snapshot reader
  // -----------------------------
  function getSnap() {
    const s = window.__DARRIUS_CHART_STATE__;
    return (s && typeof s === 'object') ? s : null;
  }

  function readSignalsStats(s) {
    if (s.signals && typeof s.signals === 'object' && !Array.isArray(s.signals)) {
      const bullish = num(s.signals.bullish, 0);
      const bearish = num(s.signals.bearish, 0);
      const neutral = num(s.signals.neutral, 0);
      const net = num(s.signals.net, bullish - bearish);
      return { bullish, bearish, neutral, net };
    }
    const stats = s.stats || s.signal_stats || {};
    const bullish = num(stats.bullish, 0);
    const bearish = num(stats.bearish, 0);
    const neutral = num(stats.neutral, 0);
    const net = num(stats.net, bullish - bearish);
    return { bullish, bearish, neutral, net };
  }

  function readRisk(s) {
    if (s.risk && typeof s.risk === 'object') {
      return {
        entry: nnull(s.risk.entry),
        stop: nnull(s.risk.stop),
        targets: Array.isArray(s.risk.targets) ? s.risk.targets.filter(isNum).slice(0, 6) : [],
        confidence: nnull(s.risk.confidence)
      };
    }
    const r = s.risk || s.copilot || {};
    return {
      entry: nnull(r.entry),
      stop: nnull(r.stop),
      targets: Array.isArray(r.targets) ? r.targets.filter(isNum).slice(0, 6) : [],
      confidence: nnull(r.confidence)
    };
  }

  function readBacktest(s) {
    const b = s.backtest || s.bt || {};
    return { winRate: nnull(b.winRate), sampleSize: nnull(b.sampleSize) };
  }

  function readMeta(s) {
    const m = s.meta || {};
    return { ready: !!m.ready, source: str(m.source, 'unknown') };
  }

  // -----------------------------
  // DOM targets
  // -----------------------------
  const SEL = {
    pulseScore: ['#pulseScore'],
    bullPct: ['#bullPct', '[data-pulse="bullish"]', '#pulseBullish', '.pulse-bullish', '.mp-bullish'],
    bearPct: ['#bearPct', '[data-pulse="bearish"]', '#pulseBearish', '.pulse-bearish', '.mp-bearish'],
    neuPct:  ['#neuPct',  '[data-pulse="neutral"]', '#pulseNeutral', '.pulse-neutral', '.mp-neutral'],
    confPct: ['#inSConf', '[data-risk="confidence"]', '#riskConfidence', '.risk-confidence'],
    winRate: ['#riskWR',  '[data-risk="winRate"]', '#riskWinRate', '.risk-winrate', '.backtest-winrate'],
    entry:   ['#riskEntry', '[data-risk="entry"]', '.risk-entry'],
    stop:    ['#riskStop', '[data-risk="stop"]', '.risk-stop'],
    targets: ['#riskTargets', '[data-risk="targets"]', '.risk-targets'],
    statusLine: ['#pulseStatus', '[data-pulse="status"]', '.pulse-status', '.mp-status'],
    kv: ['.kv']
  };

  function qAny(list) {
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function setText(el, text) {
    if (!el) return;
    el.textContent = text;
  }

  function compute(sentSig) {
    const total = sentSig.bullish + sentSig.bearish + sentSig.neutral;

    if (total <= 0) return { total: 0, bullPct: null, bearPct: null, neuPct: null, label: 'Warming up' };

    const bullPct = safePct(sentSig.bullish, total);
    const bearPct = safePct(sentSig.bearish, total);
    const neuPct  = safePct(sentSig.neutral, total);

    if ([bullPct, bearPct, neuPct].some(v => v === null)) {
      return { total: 0, bullPct: null, bearPct: null, neuPct: null, label: 'Warming up' };
    }

    let label = 'Neutral';
    if (sentSig.net > 0) label = 'Bullish';
    else if (sentSig.net < 0) label = 'Bearish';
    else if (sentSig.bullish > sentSig.bearish) label = 'Bullish';
    else if (sentSig.bearish > sentSig.bullish) label = 'Bearish';

    return { total, bullPct, bearPct, neuPct, label };
  }

  function scrubNaNText() {
    safe(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (!n.nodeValue) continue;
        if (n.nodeValue.includes('NaN%')) n.nodeValue = n.nodeValue.replaceAll('NaN%', '—');
        if (n.nodeValue.trim() === 'NaN') n.nodeValue = '—';
      }
    });
  }

  function renderEmpty(meta) {
    setText(qAny(SEL.pulseScore), '—');
    setText(qAny(SEL.bullPct), '—');
    setText(qAny(SEL.bearPct), '—');
    setText(qAny(SEL.neuPct), '—');

    setText(qAny(SEL.confPct), '—');
    setText(qAny(SEL.winRate), '—');
    setText(qAny(SEL.entry), '—');
    setText(qAny(SEL.stop), '—');
    setText(qAny(SEL.targets), '—');

    const status = !meta.ready ? 'Loading…' : 'Warming up';
    setText(qAny(SEL.statusLine), status);

    scrubNaNText();
  }

  // -----------------------------
  // Signal array (badges) — CLEAN PICK
  // -----------------------------
  function readSymbolTfFromSnap(snap) {
    const symbol = str(snap?.symbol, str(snap?.meta?.symbol, ''));
    const tf = str(snap?.tf, str(snap?.meta?.tf, ''));
    return { symbol, tf };
  }

  function normalizeSigArray(arr) {
    const out = [];
    const seen = new Set();
    for (const x of (arr || [])) {
      if (!x) continue;
      const time = Number(x.time ?? x.t ?? x.timestamp ?? x.ts);
      if (!Number.isFinite(time) || time <= 0) continue;

      let side = String(x.side ?? x.type ?? x.action ?? '').trim();
      if (!side) continue;

      const U = side.toUpperCase();
      if (U === 'EB') side = 'eB';
      else if (U === 'ES') side = 'eS';
      else if (U === 'B' || U.includes('BUY')) side = 'B';
      else if (U === 'S' || U.includes('SELL')) side = 'S';
      else continue;

      const key = `${time}:${side}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ time, side });
    }
    return out;
  }

  function pickSigArray(snap) {
    // 1) snapshot first
    let arr =
      (Array.isArray(snap?.signals) && snap.signals) ||
      (Array.isArray(snap?.sigs) && snap.sigs) ||
      (Array.isArray(snap?.data?.signals) && snap.data.signals) ||
      (Array.isArray(snap?.data?.sigs) && snap.data.sigs) ||
      [];

    arr = normalizeSigArray(arr);
    if (arr.length) return arr;

    // 2) fallback only if same symbol/tf
    const ls = window.__LAST_SIG__;
    if (!ls || typeof ls !== 'object') return [];

    const A = readSymbolTfFromSnap(snap);
    const B = readSymbolTfFromSnap(ls);

    const symOk = (A.symbol && B.symbol && A.symbol.toUpperCase() === B.symbol.toUpperCase());
    const tfOk = (!A.tf || !B.tf) ? true : (A.tf === B.tf); // tf missing => allow, but prefer match
    if (!symOk || !tfOk) return [];

    let fb =
      (Array.isArray(ls?.signals) && ls.signals) ||
      (Array.isArray(ls?.sigs) && ls.sigs) ||
      (Array.isArray(ls?.data?.signals) && ls.data.signals) ||
      (Array.isArray(ls?.data?.sigs) && ls.data.sigs) ||
      [];

    return normalizeSigArray(fb);
  }

  // -----------------------------
  // BIG BADGE OVERLAY (anchored to candle high/low)
  // -----------------------------
  const BigBadgeOverlay = (() => {
    let layer = null;

    const OFFSET_Y = 12;
    const SIZE = 26;

    function ensureLayer() {
      if (layer && layer.parentNode) return layer;
      const chartEl = document.getElementById('chart');
      if (!chartEl) return null;

      safe(() => {
        const cs = window.getComputedStyle(chartEl);
        if (cs.position === 'static') chartEl.style.position = 'relative';
      });

      layer = document.createElement('div');
      layer.id = 'darrius-big-badges';
      layer.style.position = 'absolute';
      layer.style.left = '0';
      layer.style.top = '0';
      layer.style.right = '0';
      layer.style.bottom = '0';
      layer.style.pointerEvents = 'none';
      layer.style.zIndex = '50';
      chartEl.appendChild(layer);
      return layer;
    }

    function clear() {
      if (layer) layer.innerHTML = '';
    }

    function barsFromSnap(s) {
      return (
        (Array.isArray(s?.bars) && s.bars) ||
        (Array.isArray(s?.data?.bars) && s.data.bars) ||
        (Array.isArray(s?.candles) && s.candles) ||
        (Array.isArray(s?.ohlcv) && s.ohlcv) ||
        []
      );
    }

    function buildBarIndex(snapshot) {
      const bars = barsFromSnap(snapshot);
      const map = new Map();
      for (const b of bars) {
        const t = Number(b?.time);
        if (!Number.isFinite(t)) continue;
        map.set(t, b);
      }
      return map;
    }

    function styleFor(side) {
      const isBuy = (side === 'B' || side === 'eB');
      const isSell = (side === 'S' || side === 'eS');

      if (isBuy) {
        return { bg: '#F5C542', ring: 'rgba(255,255,255,0.95)', text: '#000', glow: 'rgba(245,197,66,0.65)' };
      }
      if (isSell) {
        return { bg: '#FF4757', ring: 'rgba(255,255,255,0.95)', text: '#FFF', glow: 'rgba(255,71,87,0.55)' };
      }
      return { bg: '#888', ring: 'rgba(255,255,255,0.8)', text: '#000', glow: 'rgba(255,255,255,0.2)' };
    }

    function makeBadge(side) {
      const st = styleFor(side);
      const d = document.createElement('div');
      d.textContent = side;
      d.style.position = 'absolute';
      d.style.width = `${SIZE}px`;
      d.style.height = `${SIZE}px`;
      d.style.borderRadius = '999px';
      d.style.display = 'flex';
      d.style.alignItems = 'center';
      d.style.justifyContent = 'center';
      d.style.background = st.bg;
      d.style.color = st.text;
      d.style.fontWeight = '800';
      d.style.fontSize = (side.length === 2 ? '12px' : '13px');
      d.style.lineHeight = '1';
      d.style.boxSizing = 'border-box';
      d.style.border = `2px solid ${st.ring}`;
      d.style.boxShadow = `0 0 0 2px rgba(0,0,0,0.20), 0 0 16px ${st.glow}`;
      d.style.textShadow = '0 1px 0 rgba(0,0,0,0.35)';
      return d;
    }

    function yNearCandle(DC, bar, side, H) {
      const isSell = (side === 'S' || side === 'eS');
      const high = Number(bar.high);
      const low  = Number(bar.low);

      const anchor = isSell
        ? (Number.isFinite(high) ? high : Number(bar.close))
        : (Number.isFinite(low)  ? low  : Number(bar.close));

      if (!Number.isFinite(anchor)) return null;

      const y0 = DC.priceToY(anchor);
      if (!Number.isFinite(y0)) return null;

      let y = isSell ? (y0 - OFFSET_Y) : (y0 + OFFSET_Y);
      y = Math.max(12, Math.min(H - 12, y));
      return y;
    }

    function update(snapshot, sigArr) {
      const L = ensureLayer();
      if (!L) return;

      const DC = window.DarriusChart;
      if (!DC || typeof DC.timeToX !== 'function' || typeof DC.priceToY !== 'function') return;

      clear();

      const rect = L.getBoundingClientRect();
      const W = rect.width, H = rect.height;
      if (!W || !H) return;

      const barIndex = buildBarIndex(snapshot);

      const seen = new Set();

      for (const s of (sigArr || [])) {
        const side = String(s?.side || '').trim();
        const t = Number(s?.time);
        if (!side || !Number.isFinite(t)) continue;

        if (!(side === 'B' || side === 'S' || side === 'eB' || side === 'eS')) continue;

        const key = `${t}:${side}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const bar = barIndex.get(t);
        if (!bar) continue; // 必须在bars里找到同time的K线，否则不画（杜绝乱入）

        const x = Number(safe(() => DC.timeToX(t)));
        if (!Number.isFinite(x)) continue;

        // x clamp：超出画布的不要画
        if (x < -SIZE || x > (W + SIZE)) continue;

        const y = yNearCandle(DC, bar, side, H);
        if (!Number.isFinite(y)) continue;

        const b = makeBadge(side);
        b.style.left = `${Math.round(x - SIZE / 2)}px`;
        b.style.top  = `${Math.round(y - SIZE / 2)}px`;
        L.appendChild(b);
      }
    }

    return { update, clear };
  })();

  // -----------------------------
  // Render
  // -----------------------------
  function renderFromSnapshot(s) {
    const sigStats = readSignalsStats(s);
    const rk = readRisk(s);
    const bt = readBacktest(s);
    const mt = readMeta(s);

    const sent = compute(sigStats);
    if (sent.total <= 0) {
      renderEmpty(mt);
      safe(() => BigBadgeOverlay.update(s, pickSigArray(s)));
      return;
    }

    setText(qAny(SEL.bullPct), fmtPct0(sent.bullPct));
    setText(qAny(SEL.bearPct), fmtPct0(sent.bearPct));
    setText(qAny(SEL.neuPct),  fmtPct0(sent.neuPct));
    setText(qAny(SEL.pulseScore), sent.label);

    const status = (!mt.ready) ? 'Loading…' : (mt.source === 'delayed' ? 'Delayed data' : 'Ready');
    setText(qAny(SEL.statusLine), status);

    setText(qAny(SEL.entry), fmtPrice2(rk.entry));
    setText(qAny(SEL.stop), fmtPrice2(rk.stop));

    if (rk.targets && rk.targets.length) {
      setText(qAny(SEL.targets), rk.targets.map(x => Number(x).toFixed(2)).join(' / '));
    } else {
      setText(qAny(SEL.targets), '—');
    }

    setText(qAny(SEL.confPct), rk.confidence === null ? '—' : fmtPct0(rk.confidence));
    setText(qAny(SEL.winRate), bt.winRate === null ? '—' : fmtPct0(bt.winRate));

    scrubNaNText();

    // BIG badges only
    safe(() => BigBadgeOverlay.update(s, pickSigArray(s)));
  }

  // -----------------------------
  // Event wiring
  // -----------------------------
  function onUpdate(e) {
    safe(() => {
      const s = (e && e.detail && typeof e.detail === 'object') ? e.detail : getSnap();
      if (!s) return;
      renderFromSnapshot(s);
    });
  }

  function boot() {
    safe(() => {
      const s = getSnap();
      if (s) renderFromSnapshot(s);
    });
    window.addEventListener('darrius:chartUpdated', onUpdate);
    safe(() => scrubNaNText());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
