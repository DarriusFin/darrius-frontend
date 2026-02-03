/* =========================================================================
 * DarriusAI - market.pulse.js (FINAL FROZEN DISPLAY-ONLY) v2026.02.02-PULSE-NAN-LOCK-R2
 *
 * Purpose:
 *  - UI-only layer. Reads window.__DARRIUS_CHART_STATE__ snapshot (multi schema)
 *  - Renders Market Pulse + Risk Copilot text fields WITHOUT producing NaN
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
  console.log('[PULSE LOADED]', 'v2026.02.02-R2', Date.now());
  window.__PULSE_LOADED__ = 'v2026.02.02-R2';

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

  function readSignals(s) {
    if (s.signals && typeof s.signals === 'object') {
      const bullish = num(s.signals.bullish, 0);
      const bearish = num(s.signals.bearish, 0);
      const neutral = num(s.signals.neutral, 0);
      const net = num(s.signals.net, bullish - bearish);
      return { bullish, bearish, neutral, net };
    }
    const stats = s.stats || s.signal_stats || s.signals || {};
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
    let side = String(x.side ?? x.type ?? x.action ?? "").trim();
    if (!time || !side) continue;

    const U = side.toUpperCase();
    if (U === "EB") side = "eB";
    else if (U === "ES") side = "eS";
    else if (U === "B" || U.includes("BUY")) side = "B";
    else if (U === "S" || U.includes("SELL")) side = "S";
    else continue;

    const key = `${time}:${side}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ time, side, price: Number(x.price ?? x.p ?? null) });
  }

  return out;
}

  function renderFromSnapshot(s) {
    const sig = pickSignalsWithLastSigFallback(s);
    const rk = readRisk(s);
    const bt = readBacktest(s);
    const mt = readMeta(s);

    const sent = compute(sig);
    if (sent.total <= 0) {
      renderEmpty(mt);
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
