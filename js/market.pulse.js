/* =========================================================================
 * DarriusAI - market.pulse.js (FINAL FROZEN DISPLAY-ONLY) v2026.02.02-PULSE-NAN-LOCK-R2 + BIG-BADGE-TOPBOT
 *
 * Purpose:
 *  - UI-only layer. Reads window.__DARRIUS_CHART_STATE__ snapshot (multi schema)
 *  - Renders Market Pulse + Risk Copilot text fields WITHOUT producing NaN
 *  - OPTIONAL: Renders BIG glowing badges (B/S/eB/eS) as overlay (DOM), fixed at TOP/BOTTOM
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
  console.log('[PULSE LOADED]', 'v2026.02.02-R2 + BIG-BADGE-TOPBOT', Date.now());
  window.__PULSE_LOADED__ = 'v2026.02.02-R2 + BIG-BADGE-TOPBOT';

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
  // ✅ FIX: 你现在的 sig 是数组（[{time,side,price}...]），compute 以前误当对象用，会导致 NaN。
  // 这里按数组计算 bull/bear/neutral counts。
  function computeFromSigArray(sigArr) {
    const arr = Array.isArray(sigArr) ? sigArr : [];
    let bullish = 0, bearish = 0, neutral = 0;

    for (const x of arr) {
      const side = String(x && x.side || '').trim();
      if (side === 'B' || side === 'eB') bullish++;
      else if (side === 'S' || side === 'eS') bearish++;
      else neutral++;
    }

    const total = bullish + bearish + neutral;
    if (total <= 0) {
      return { total: 0, bullPct: null, bearPct: null, neuPct: null, label: 'Warming up', net: 0, bullish, bearish, neutral };
    }

    const bullPct = safePct(bullish, total);
    const bearPct = safePct(bearish, total);
    const neuPct  = safePct(neutral, total);

    if ([bullPct, bearPct, neuPct].some(v => v === null)) {
      return { total: 0, bullPct: null, bearPct: null, neuPct: null, label: 'Warming up', net: 0, bullish, bearish, neutral };
    }

    const net = bullish - bearish;

    let label = 'Neutral';
    if (net > 0) label = 'Bullish';
    else if (net < 0) label = 'Bearish';
    else if (bullish > bearish) label = 'Bullish';
    else if (bearish > bullish) label = 'Bearish';

    return { total, bullPct, bearPct, neuPct, label, net, bullish, bearish, neutral };
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

  // === HARDENED SIGNAL FALLBACK ===
  // 当 snapshot 里没有信号时，从 __LAST_SIG__ 兜底
  function pickSignalsWithLastSigFallback(snap) {
    // 1) 先从 snapshot 里找
    let arr =
      (Array.isArray(snap?.signals) && snap.signals) ||
      (Array.isArray(snap?.sigs) && snap.sigs) ||
      (Array.isArray(snap?.data?.signals) && snap.data.signals) ||
      (Array.isArray(snap?.data?.sigs) && snap.data.sigs) ||
      [];

    // 2) snapshot 没有 → 用 __LAST_SIG__
    if (!arr.length) {
      const ls = window.__LAST_SIG__;
      arr =
        (Array.isArray(ls?.signals) && ls.signals) ||
        (Array.isArray(ls?.sigs) && ls.sigs) ||
        (Array.isArray(ls?.data?.signals) && ls.data.signals) ||
        (Array.isArray(ls?.data?.sigs) && ls.data.sigs) ||
        [];
    }

    // 3) 统一字段 + 去重
    const out = [];
    const seen = new Set();
    for (const x of arr) {
      if (!x) continue;
      const time = x.time ?? x.t ?? x.timestamp ?? x.ts;
      let side = String(x.side ?? x.type ?? x.action ?? '').trim();
      if (!time || !side) continue;

      const U = side.toUpperCase();
      if (U === 'EB') side = 'eB';
      else if (U === 'ES') side = 'eS';
      else if (U === 'B' || U.includes('BUY')) side = 'B';
      else if (U === 'S' || U.includes('SELL')) side = 'S';
      else continue;

      const key = `${time}:${side}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ time: Number(time), side, price: Number(x.price ?? x.p ?? null) });
    }

    // time 升序（方便 overlay 稳定）
    out.sort((a, b) => (a.time || 0) - (b.time || 0));
    return out;
  }

  function renderFromSnapshot(s) {
    const sigArr = pickSignalsWithLastSigFallback(s);
    const rk = readRisk(s);
    const bt = readBacktest(s);
    const mt = readMeta(s);

    const sent = computeFromSigArray(sigArr);
    if (sent.total <= 0) {
      renderEmpty(mt);
      // 即使文字 empty，也允许 overlay 尝试（不强制 return）
    } else {
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
    }

    // ✅ Big badges overlay (TOP/BOTTOM)
    safe(() => BigBadgeOverlay.update(s, sigArr));
  }

  // =========================================================================
  // BIG BADGE OVERLAY (DOM) - TOP/BOTTOM FORCED
  // =========================================================================
  const BigBadgeOverlay = (() => {
    const ID_STYLE = 'darrius-bigbadge-style';
    const ID_LAYER = 'darrius-bigbadge-layer';

    // 你要的固定规则：
    // S/eS -> TOP, B/eB -> BOTTOM
    const PAD_TOP = 14;
    const PAD_BOT = 18;

    // 同一根K线多徽章，做轻微横向错位，避免完全重叠
    const JITTER_X = 10;

    function injectStyleOnce() {
      if (document.getElementById(ID_STYLE)) return;
      const st = document.createElement('style');
      st.id = ID_STYLE;
      st.textContent = `
        #${ID_LAYER}{
          position:absolute; inset:0;
          pointer-events:none;
          z-index: 50;
        }
        .d-badge{
          position:absolute;
          transform: translate(-50%, -50%);
          width: 30px; height: 30px;
          border-radius: 999px;
          display:flex; align-items:center; justify-content:center;
          font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
          font-weight: 800;
          letter-spacing: -0.2px;
          user-select:none;
          box-sizing:border-box;
        }
        .d-badge.buy{
          background: #f5c542; /* 黄底 */
          border: 2px solid rgba(255,255,255,0.95); /* 白环 */
          color: #0b0f17; /* 黑字 */
          box-shadow:
            0 0 0 2px rgba(245,197,66,0.18),
            0 0 18px rgba(245,197,66,0.55),
            0 0 32px rgba(245,197,66,0.22);
        }
        .d-badge.sell{
          background: #ff4757; /* 红底 */
          border: 2px solid rgba(255,255,255,0.95); /* 白环 */
          color: #ffffff; /* 白字 */
          box-shadow:
            0 0 0 2px rgba(255,71,87,0.18),
            0 0 18px rgba(255,71,87,0.55),
            0 0 32px rgba(255,71,87,0.22);
        }
        .d-badge.small{
          width: 26px; height: 26px;
          font-weight: 800;
        }
        .d-badge .t{
          font-size: 14px;
          line-height: 1;
        }
      `;
      document.head.appendChild(st);
    }

    function ensureLayer() {
      injectStyleOnce();
      const chartEl =
        document.getElementById('chart') ||
        document.getElementById('mainChart') ||
        document.querySelector('.chart') ||
        null;

      if (!chartEl) return null;

      // chartEl 需要相对定位，layer 才能 absolute 覆盖
      const cs = window.getComputedStyle(chartEl);
      if (cs.position === 'static') chartEl.style.position = 'relative';

      let layer = document.getElementById(ID_LAYER);
      if (!layer) {
        layer = document.createElement('div');
        layer.id = ID_LAYER;
        chartEl.appendChild(layer);
      }
      return layer;
    }

    function topOrBottomY(side, layerH) {
      const isSell = (side === 'S' || side === 'eS');
      return isSell ? PAD_TOP : Math.max(PAD_TOP, layerH - PAD_BOT);
    }

    function labelForSide(side) {
      // 保留 eB/eS 字样（你旧图就是这样）
      return side;
    }

    function buildKey(sig) {
      return `${sig.time}:${sig.side}`;
    }

    function update(snapshot, sigArr) {
      const layer = ensureLayer();
      if (!layer) return;

      const DC = window.DarriusChart;
      if (!DC || typeof DC.timeToX !== 'function') {
        // 没有 bridge 时，不画（不报错）
        layer.innerHTML = '';
        return;
      }

      const W = layer.clientWidth || 0;
      const H = layer.clientHeight || 0;
      if (W <= 0 || H <= 0) return;

      // 只画这四类
      const arr = (Array.isArray(sigArr) ? sigArr : []).filter(x => {
        const s = String(x?.side || '');
        return (s === 'B' || s === 'eB' || s === 'S' || s === 'eS');
      });

      // 轻去重（保险）
      const seen = new Set();
      const uniq = [];
      for (const x of arr) {
        const k = buildKey(x);
        if (seen.has(k)) continue;
        seen.add(k);
        uniq.push(x);
      }

      // 计算同一 time 的序号，用来 jitter
      const timeIndex = new Map(); // time -> count used
      function nextJitter(t) {
        const n = (timeIndex.get(t) || 0);
        timeIndex.set(t, n + 1);
        // 0,1,2 -> 0, +1, -1 (交错)
        if (n === 0) return 0;
        return (n % 2 === 1) ? (Math.ceil(n / 2) * JITTER_X) : (-Math.ceil(n / 2) * JITTER_X);
      }

      // 用 fragment 重建（简单、稳定）
      const frag = document.createDocumentFragment();

      for (const sig of uniq) {
        const side = sig.side;
        const t = Number(sig.time);
        if (!Number.isFinite(t)) continue;

        const x = safe(() => DC.timeToX(t));
        if (!Number.isFinite(x)) continue;

        // 过滤掉画布外的点
        if (x < -50 || x > W + 50) continue;

        const y = topOrBottomY(side, H);
        const jitter = nextJitter(t);

        const isBuy = (side === 'B' || side === 'eB');
        const badge = document.createElement('div');
        badge.className = `d-badge ${isBuy ? 'buy' : 'sell'} ${side.startsWith('e') ? 'small' : ''}`;

        badge.style.left = `${x + jitter}px`;
        badge.style.top = `${y}px`;

        const span = document.createElement('span');
        span.className = 't';
        span.textContent = labelForSide(side);
        badge.appendChild(span);

        frag.appendChild(badge);
      }

      // 替换
      layer.innerHTML = '';
      layer.appendChild(frag);
    }

    function hardRefresh() {
      const s = getSnap();
      if (!s) return;
      const sigArr = pickSignalsWithLastSigFallback(s);
      update(s, sigArr);
    }

    // 监听窗口尺寸变化（chart.core.js 自己会 resize chart，这里跟着 overlay 重画）
    let _ro = null;
    function bindResize() {
      const layer = ensureLayer();
      if (!layer) return;
      const chartEl = layer.parentElement;
      if (!chartEl) return;

      if (_ro) return;
      _ro = new ResizeObserver(() => safe(() => hardRefresh()));
      _ro.observe(chartEl);
      window.addEventListener('resize', () => safe(() => hardRefresh()));
    }

    return { update, bindResize, hardRefresh };
  })();

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

    // overlay resize support
    safe(() => BigBadgeOverlay.bindResize());

    window.addEventListener('darrius:chartUpdated', onUpdate);
    safe(() => { scrubNaNText(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
