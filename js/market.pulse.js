/* =========================================================================
 * DarriusAI - market.pulse.js (FINAL DISPLAY-ONLY) v2026.02.03-PULSE-RISK-ONLY
 *
 * Purpose:
 *  - UI-only layer. Reads window.__DARRIUS_CHART_STATE__ snapshot (multi schema)
 *  - ONLY renders:
 *      1) Market Pulse (sentiment label + bullish/bearish/neutral %)
 *      2) Risk Copilot (entry/stop/targets/confidence)
 *      3) Backtest (win rate)
 *  - Does NOT draw ANY B/S/eB/eS badges/markers/overlays.
 *
 * Safety:
 *  - Never throws (absolute safe zone)
 *  - Missing DOM is OK
 *  - No NaN text
 * ========================================================================= */

(() => {
  'use strict';

  console.log('[PULSE LOADED]', 'v2026.02.03-PULSE-RISK-ONLY', Date.now());
  window.__PULSE_LOADED__ = 'v2026.02.03-PULSE-RISK-ONLY';

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

  // -----------------------------
  // Read "sentiment stats" (NOT trade signals array)
  // Prefer snapshot.stats / snapshot.signal_stats / snapshot.signals(object)
  // -----------------------------
  function readSentimentStats(s) {
    // Case A: s.signals is an object with bullish/bearish/neutral/net
    if (s && s.signals && typeof s.signals === 'object' && !Array.isArray(s.signals)) {
      const bullish = num(s.signals.bullish, 0);
      const bearish = num(s.signals.bearish, 0);
      const neutral = num(s.signals.neutral, 0);
      const net = num(s.signals.net, bullish - bearish);
      return { bullish, bearish, neutral, net };
    }

    // Case B: older schemas
    const stats = (s && (s.stats || s.signal_stats)) || {};
    const bullish = num(stats.bullish, 0);
    const bearish = num(stats.bearish, 0);
    const neutral = num(stats.neutral, 0);
    const net = num(stats.net, bullish - bearish);
    return { bullish, bearish, neutral, net };
  }

  function readRisk(s) {
    const r = (s && (s.risk || s.copilot)) || {};
    const entry = nnull(r.entry);
    const stop = nnull(r.stop);
    const targets = Array.isArray(r.targets) ? r.targets.filter(isNum).slice(0, 6) : [];
    const confidence = nnull(r.confidence);
    return { entry, stop, targets, confidence };
  }

  function readBacktest(s) {
    const b = (s && (s.backtest || s.bt)) || {};
    return {
      winRate: nnull(b.winRate),
      sampleSize: nnull(b.sampleSize)
    };
  }

  function readMeta(s) {
    const m = (s && s.meta) || {};
    return { ready: !!m.ready, source: str(m.source, 'unknown') };
  }

  // -----------------------------
  // DOM: real ids first + flexible fallbacks
  // -----------------------------
  const SEL = {
    pulseScore: ['#pulseScore'], // label (Bullish/Bearish/Neutral)
    bullPct: ['#bullPct', '[data-pulse="bullish"]', '#pulseBullish', '.pulse-bullish', '.mp-bullish'],
    bearPct: ['#bearPct', '[data-pulse="bearish"]', '#pulseBearish', '.pulse-bearish', '.mp-bearish'],
    neuPct:  ['#neuPct',  '[data-pulse="neutral"]', '#pulseNeutral', '.pulse-neutral', '.mp-neutral'],

    confPct: ['#inSConf', '[data-risk="confidence"]', '#riskConfidence', '.risk-confidence'],
    winRate: ['#riskWR',  '[data-risk="winRate"]', '#riskWinRate', '.risk-winrate', '.backtest-winrate'],

    entry:   ['#riskEntry', '[data-risk="entry"]', '.risk-entry'],
    stop:    ['#riskStop', '[data-risk="stop"]', '.risk-stop'],
    targets: ['#riskTargets', '[data-risk="targets"]', '.risk-targets'],

    statusLine: ['#pulseStatus', '[data-pulse="status"]', '.pulse-status', '.mp-status']
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
  function computeSentiment(stats) {
    const total = stats.bullish + stats.bearish + stats.neutral;

    if (total <= 0) {
      return { total: 0, bullPct: null, bearPct: null, neuPct: null, label: 'Warming up' };
    }

    const bullPct = safePct(stats.bullish, total);
    const bearPct = safePct(stats.bearish, total);
    const neuPct  = safePct(stats.neutral, total);

    if ([bullPct, bearPct, neuPct].some(v => v === null)) {
      return { total: 0, bullPct: null, bearPct: null, neuPct: null, label: 'Warming up' };
    }

    let label = 'Neutral';
    if (stats.net > 0) label = 'Bullish';
    else if (stats.net < 0) label = 'Bearish';
    else if (stats.bullish > stats.bearish) label = 'Bullish';
    else if (stats.bearish > stats.bullish) label = 'Bearish';

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

  function renderFromSnapshot(s) {
    const stats = readSentimentStats(s);
    const rk = readRisk(s);
    const bt = readBacktest(s);
    const mt = readMeta(s);

    const sent = computeSentiment(stats);
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
    safe(() => scrubNaNText());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
