/* =========================================================================
 * DarriusAI - market.pulse.js (FINAL FROZEN DISPLAY-ONLY) v2026.02.03-BADGE-ANCHOR-HILO
 *
 * Purpose:
 *  - UI-only layer. Reads window.__DARRIUS_CHART_STATE__ snapshot (multi schema)
 *  - Renders Market Pulse + Risk Copilot text fields WITHOUT producing NaN
 *  - Renders BIG glowing B/S/eB/eS badges (overlay) anchored to candle high/low
 *  - Targets real DOM ids on darrius.ai:
 *      #pulseScore, #bullPct, #bearPct, #neuPct, #inSConf, #riskWR, .kv
 *  - Never touches billing/subscription/payment logic
 *  - Never mutates chart.core.js internals
 *
 * Safety:
 *  - Never throws (absolute safe zone)
 *  - Missing DOM is OK
 * ========================================================================= */

(() => {
  'use strict';

  // ===== PROBE (to prove which file is running) =====
  console.log('[PULSE LOADED]', 'v2026.02.03-BADGE-ANCHOR-HILO', Date.now());
  window.__PULSE_LOADED__ = 'v2026.02.03-BADGE-ANCHOR-HILO';

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
  // Snapshot reader (supports v2 + older)
  // -----------------------------
  function getSnap() {
    const s = window.__DARRIUS_CHART_STATE__;
    return (s && typeof s === 'object') ? s : null;
  }

  // NOTE: 这里用于“Market Pulse统计”，不是B/S徽章数组
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
    return {
      winRate: nnull(b.winRate),
      sampleSize: nnull(b.sampleSize)
    };
  }

  function readMeta(s) {
    const m = s.meta || {};
    return {
      ready: !!m.ready,
      source: str(m.source, 'unknown')
    };
  }

  // -----------------------------
  // DOM: real ids first + flexible fallbacks
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

  // -----------------------------
  // Rendering rules (NO NaN)
  // -----------------------------
  function compute(sentSig) {
    const total = sentSig.bullish + sentSig.bearish + sentSig.neutral;

    if (total <= 0) {
      return { total: 0, bullPct: null, bearPct: null, neuPct: null, label: 'Warming up' };
    }

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

    safe(() => {
      const kv = qAny(SEL.kv);
      if (!kv) return;
      const t = (kv.textContent || '');
      if (t.includes('NaN')) kv.textContent = 'Bullish —';
    });

    scrubNaNText();
  }

  // ------------------------------------------------------------------
  // HARDENED SIGNAL ARRAY FALLBACK (徽章用的 B/S/eB/eS 数组)
  // ------------------------------------------------------------------
  function pickSigArrayWithFallback(snap) {
    let arr =
      (Array.isArray(snap?.signals) && snap.signals) ||
      (Array.isArray(snap?.sigs) && snap.sigs) ||
      (Array.isArray(snap?.data?.signals) && snap.data.signals) ||
      (Array.isArray(snap?.data?.sigs) && snap.data.sigs) ||
      [];

    if (!arr.length) {
      const ls = window.__LAST_SIG__;
      arr =
        (Array.isArray(ls?.signals) && ls.signals) ||
        (Array.isArray(ls?.sigs) && ls.sigs) ||
        (Array.isArray(ls?.data?.signals) && ls.data.signals) ||
        (Array.isArray(ls?.data?.sigs) && ls.data.sigs) ||
        [];
    }

    // normalize + dedupe
    const out = [];
    const seen = new Set();

    for (const x of arr) {
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

      const price = Number(x.price ?? x.p ?? NaN);
      out.push({ time, side, price: Number.isFinite(price) ? price : null });
    }

    return out;
  }

  // ------------------------------------------------------------------
  // BIG BADGE OVERLAY (anchored to candle high/low)
  // ------------------------------------------------------------------
  const BigBadgeOverlay = (() => {
    let layer = null;
    let mounted = false;

    // 你可以微调这个值：徽章离K线 high/low 的像素偏移
    const OFFSET_Y = 12;

    // 你可以微调：徽章大小
    const SIZE = 26;

    const Z = 50; // above chart

    function ensureLayer() {
      if (mounted && layer && layer.parentNode) return layer;

      const chartEl = document.getElementById('chart');
      if (!chartEl) return null;

      // chart 容器一般是 position: relative 或者我们强制设置
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
      layer.style.zIndex = String(Z);

      chartEl.appendChild(layer);
      mounted = true;
      return layer;
    }

    function clear() {
      if (!layer) return;
      layer.innerHTML = '';
    }

    // Build time->bar map from snapshot bars
    function buildBarIndex(snapshot) {
      const bars =
        (Array.isArray(snapshot?.bars) && snapshot.bars) ||
        (Array.isArray(snapshot?.data?.bars) && snapshot.data.bars) ||
        (Array.isArray(snapshot?.candles) && snapshot.candles) ||
        (Array.isArray(snapshot?.ohlcv) && snapshot.ohlcv) ||
        [];

      const map = new Map();
      for (const b of bars) {
        const t = Number(b?.time);
        if (!Number.isFinite(t)) continue;
        map.set(t, b);
      }
      return map;
    }

    function yNearCandle(DC, bar, side, H) {
      if (!DC || typeof DC.priceToY !== 'function' || !bar) return null;

      const isSell = (side === 'S' || side === 'eS');
      const high = Number(bar.high);
      const low  = Number(bar.low);

      const anchorPrice = isSell
        ? (Number.isFinite(high) ? high : Number(bar.close))
        : (Number.isFinite(low)  ? low  : Number(bar.close));

      if (!Number.isFinite(anchorPrice)) return null;

      const y0 = DC.priceToY(anchorPrice);
      if (!Number.isFinite(y0)) return null;

      let y = isSell ? (y0 - OFFSET_Y) : (y0 + OFFSET_Y);

      // clamp
      y = Math.max(12, Math.min(H - 12, y));
      return y;
    }

    function styleFor(side) {
      const isBuy = (side === 'B' || side === 'eB');
      const isSell = (side === 'S' || side === 'eS');

      if (isBuy) {
        // 黄底 + 白圈 + 黑字（你最新要求）
        return {
          bg: '#F5C542',
          ring: 'rgba(255,255,255,0.95)',
          text: '#000000',
          glow: 'rgba(245,197,66,0.65)',
        };
      }
      if (isSell) {
        // 红底 + 白圈 + 白字
        return {
          bg: '#FF4757',
          ring: 'rgba(255,255,255,0.95)',
          text: '#FFFFFF',
          glow: 'rgba(255,71,87,0.55)',
        };
      }
      return {
        bg: '#888',
        ring: 'rgba(255,255,255,0.8)',
        text: '#000',
        glow: 'rgba(255,255,255,0.2)',
      };
    }

    function makeBadge(side) {
      const st = styleFor(side);

      const d = document.createElement('div');
      d.className = 'darrius-badge';
      d.textContent = side; // B/S/eB/eS

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

      // white ring
      d.style.boxSizing = 'border-box';
      d.style.border = `2px solid ${st.ring}`;

      // glow
      d.style.boxShadow = `0 0 0 2px rgba(0,0,0,0.20), 0 0 16px ${st.glow}`;

      // small text shadow for readability
      d.style.textShadow = '0 1px 0 rgba(0,0,0,0.35)';

      return d;
    }

    function update(snapshot, sigArr) {
      const L = ensureLayer();
      if (!L) return;

      const DC = window.DarriusChart;
      if (!DC) return;

      // If user disabled overlay elsewhere, respect it
      if (typeof window.__OVERLAY_BIG_SIGS__ === 'boolean' && window.__OVERLAY_BIG_SIGS__ === false) {
        clear();
        return;
      }

      // dimensions
      const rect = L.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      if (!W || !H) return;

      // Build bar index once per update
      const barIndex = buildBarIndex(snapshot);

      // Clear then render
      clear();

      // Dedup
      const seen = new Set();

      for (const s of (sigArr || [])) {
        const side = String(s?.side || '').trim();
        const t = Number(s?.time);
        if (!side || !Number.isFinite(t)) continue;

        // Only draw B/S/eB/eS
        if (!(side === 'B' || side === 'S' || side === 'eB' || side === 'eS')) continue;

        const key = `${t}:${side}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const bar = barIndex.get(t);
        if (!bar) continue;

        // x: time->coordinate
        const x = safe(() => DC.timeToX(t));
        if (!Number.isFinite(x)) continue;

        // y: candle high/low anchor
        const y = yNearCandle(DC, bar, side, H);
        if (!Number.isFinite(y)) continue;

        const b = makeBadge(side);

        // center badge at (x,y)
        b.style.left = `${Math.round(x - SIZE / 2)}px`;
        b.style.top  = `${Math.round(y - SIZE / 2)}px`;

        L.appendChild(b);
      }
    }

    return { update, clear };
  })();

  // -----------------------------
  // Render (Market Pulse + Risk Copilot + Big Badges)
  // -----------------------------
  function renderFromSnapshot(s) {
    const sigStats = readSignalsStats(s);
    const rk = readRisk(s);
    const bt = readBacktest(s);
    const mt = readMeta(s);

    const sent = compute(sigStats);
    if (sent.total <= 0) {
      renderEmpty(mt);
      // 即便统计为空，也尝试画徽章（徽章来自数组）
      safe(() => {
        const sigArr = pickSigArrayWithFallback(s);
        BigBadgeOverlay.update(s, sigArr);
      });
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

    // ---- BIG BADGES (ONLY big, no tiny duplicates) ----
    safe(() => {
      const sigArr = pickSigArrayWithFallback(s);
      BigBadgeOverlay.update(s, sigArr);
    });
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
    safe(() => { scrubNaNText(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
