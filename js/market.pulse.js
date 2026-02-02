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

  // IMPORTANT: hard-stop on invalid denominator
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
    // v2 contract
    if (s.signals && typeof s.signals === 'object') {
      const bullish = num(s.signals.bullish, 0);
      const bearish = num(s.signals.bearish, 0);
      const neutral = num(s.signals.neutral, 0);
      const net = num(s.signals.net, bullish - bearish);
      return { bullish, bearish, neutral, net };
    }
    // older shapes
    const stats = s.stats || s.signal_stats || s.signals || {};
    const bullish = num(stats.bullish, 0);
    const bearish = num(stats.bearish, 0);
    const neutral = num(stats.neutral, 0);
    const net = num(stats.net, bullish - bearish);
    return { bullish, bearish, neutral, net };
  }

  function readRisk(s) {
    // v2
    if (s.risk && typeof s.risk === 'object') {
      return {
        entry: nnull(s.risk.entry),
        stop: nnull(s.risk.stop),
        targets: Array.isArray(s.risk.targets) ? s.risk.targets.filter(isNum).slice(0, 6) : [],
        confidence: nnull(s.risk.confidence)
      };
    }
    // older
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
    // Real ids you confirmed
    pulseScore: ['#pulseScore'],
    bullPct: ['#bullPct', '[data-pulse="bullish"]', '#pulseBullish', '.pulse-bullish', '.mp-bullish'],
    bearPct: ['#bearPct', '[data-pulse="bearish"]', '#pulseBearish', '.pulse-bearish', '.mp-bearish'],
    neuPct:  ['#neuPct',  '[data-pulse="neutral"]', '#pulseNeutral', '.pulse-neutral', '.mp-neutral'],
    confPct: ['#inSConf', '[data-risk="confidence"]', '#riskConfidence', '.risk-confidence'],
    winRate: ['#riskWR',  '[data-risk="winRate"]', '#riskWinRate', '.risk-winrate', '.backtest-winrate'],

    // Optional fields (if you have them, we fill; if not, ignore)
    entry:   ['#riskEntry', '[data-risk="entry"]', '.risk-entry'],
    stop:    ['#riskStop', '[data-risk="stop"]', '.risk-stop'],
    targets: ['#riskTargets', '[data-risk="targets"]', '.risk-targets'],
    statusLine: ['#pulseStatus', '[data-pulse="status"]', '.pulse-status', '.mp-status'],

    // The container line that showed "BullishNaN%" with class kv
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

    // Hard gate: if no structure, everything is empty state.
    if (total <= 0) {
      return {
        total: 0,
        bullPct: null,
        bearPct: null,
        neuPct: null,
        label: 'Warming up'
      };
    }

    const bullPct = safePct(sentSig.bullish, total);
    const bearPct = safePct(sentSig.bearish, total);
    const neuPct  = safePct(sentSig.neutral, total);

    // Another hard gate: any null => empty (prevents NaN ever)
    if ([bullPct, bearPct, neuPct].some(v => v === null)) {
      return {
        total: 0,
        bullPct: null,
        bearPct: null,
        neuPct: null,
        label: 'Warming up'
      };
    }

    // Label logic: prefer net, else compare bull/bear
    let label = 'Neutral';
    if (sentSig.net > 0) label = 'Bullish';
    else if (sentSig.net < 0) label = 'Bearish';
    else if (sentSig.bullish > sentSig.bearish) label = 'Bullish';
    else if (sentSig.bearish > sentSig.bullish) label = 'Bearish';

    return { total, bullPct, bearPct, neuPct, label };
  }

  function renderEmpty(meta) {
    // Market pulse
    setText(qAny(SEL.pulseScore), '—');
    setText(qAny(SEL.bullPct), '—');
    setText(qAny(SEL.bearPct), '—');
    setText(qAny(SEL.neuPct), '—');

    // Risk
    setText(qAny(SEL.confPct), '—');
    setText(qAny(SEL.winRate), '—');
    setText(qAny(SEL.entry), '—');
    setText(qAny(SEL.stop), '—');
    setText(qAny(SEL.targets), '—');

    // Status line (optional)
    const status = !meta.ready ? 'Loading…' : 'Warming up';
    setText(qAny(SEL.statusLine), status);

    // FIX the ".kv" line that currently concatenates "BullishNaN%"
    // We DO NOT alter layout; just replace the text if it still contains NaN.
    safe(() => {
      const kv = qAny(SEL.kv);
      if (!kv) return;
      const t = (kv.textContent || '');
      if (t.includes('NaN')) kv.textContent = 'Bullish —';
    });

    // Final fallback scrub (text nodes only)
    scrubNaNText();
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

  function renderFromSnapshot(s) {
    const sig = readSignals(s);
    const rk = readRisk(s);
    const bt = readBacktest(s);
    const mt = readMeta(s);

    const sent = compute(sig);

    // If empty structure => render empty
    if (sent.total <= 0) {
      renderEmpty(mt);
      return;
    }

    // Market Pulse: write percentages to the real ids
    setText(qAny(SEL.bullPct), fmtPct0(sent.bullPct));
    setText(qAny(SEL.bearPct), fmtPct0(sent.bearPct));
    setText(qAny(SEL.neuPct),  fmtPct0(sent.neuPct));

    // Center score: your DOM shows big "NaN" at #pulseScore.
    // Product-wise best: show label (Bullish/Bearish/Neutral).
    setText(qAny(SEL.pulseScore), sent.label);

    // Status line (optional)
    const status = (!mt.ready) ? 'Loading…' : (mt.source === 'delayed' ? 'Delayed data' : 'Ready');
    setText(qAny(SEL.statusLine), status);

    // Risk Copilot fields (NO NaN)
    setText(qAny(SEL.entry), fmtPrice2(rk.entry));
    setText(qAny(SEL.stop), fmtPrice2(rk.stop));

    if (rk.targets && rk.targets.length) {
      setText(qAny(SEL.targets), rk.targets.map(x => Number(x).toFixed(2)).join(' / '));
    } else {
      setText(qAny(SEL.targets), '—');
    }

    // Confidence & winRate are shown as % if present else —
    setText(qAny(SEL.confPct), rk.confidence === null ? '—' : fmtPct0(rk.confidence));
    setText(qAny(SEL.winRate), bt.winRate === null ? '—' : fmtPct0(bt.winRate));

    // Clean any leftover NaN text (just in case)
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
    // initial render
    safe(() => {
      const s = getSnap();
      if (s) renderFromSnapshot(s);
    });

    // listen updates
    window.addEventListener('darrius:chartUpdated', onUpdate);

    // if the event never fires (rare), still keep UI clean
    // (does not touch layout; only removes NaN text)
    safe(() => { scrubNaNText(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
