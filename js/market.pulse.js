/* =========================================================================
 * DarriusAI - market.pulse.js (FINAL FROZEN DISPLAY-ONLY)
 * v2026.02.02-PULSE-NAN-LOCK-R2
 *
 * Purpose:
 *  - UI-only layer. Reads window.__DARRIUS_CHART_STATE__ snapshot (multi schema)
 *  - Renders Market Pulse + Risk Copilot text fields WITHOUT producing NaN
 *  - Targets real DOM ids on darrius.ai (index.html):
 *      #pulseScore, #bullPct, #bearPct, #neuPct, #netInflow,
 *      #riskEntry, #riskStop, #riskTargets, #riskConf, #riskWR
 *  - Never touches billing/subscription/payment logic
 *  - Never mutates chart.core.js internals
 *
 * Safety:
 *  - Never throws (absolute safe zone)
 *  - Missing DOM is OK
 * ========================================================================= */

(() => {
  'use strict';

  // ---- build stamp (for verification) ----
  console.log('[PULSE LOADED]', 'v2026.02.02-PULSE-NAN-LOCK-R2', Date.now());
  window.__PULSE_LOADED__ = 'v2026.02.02-PULSE-NAN-LOCK-R2';

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
    return { winRate: nnull(b.winRate) };
  }

  // -----------------------------
  // DOM (real ids)
  // -----------------------------
  const $ = (id) => document.getElementById(id);

  const DOM = {
    pulseScore: () => $('pulseScore'),
    bullPct: () => $('bullPct'),
    bearPct: () => $('bearPct'),
    neuPct: () => $('neuPct'),
    netInflow: () => $('netInflow'),

    riskEntry: () => $('riskEntry'),
    riskStop: () => $('riskStop'),
    riskTargets: () => $('riskTargets'),
    riskConf: () => $('riskConf'),
    riskWR: () => $('riskWR')
  };

  function setText(el, text) {
    if (!el) return;
    el.textContent = text;
  }

  // -----------------------------
  // NaN scrub (last resort)
  // -----------------------------
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

  // -----------------------------
  // Compute & Render
  // -----------------------------
  function compute(sig) {
    const total = sig.bullish + sig.bearish + sig.neutral;
    if (total <= 0) {
      return { total: 0, bullPct: null, bearPct: null, neuPct: null, label: 'Warming up', net: 0 };
    }

    const bullPct = safePct(sig.bullish, total);
    const bearPct = safePct(sig.bearish, total);
    const neuPct  = safePct(sig.neutral, total);

    if ([bullPct, bearPct, neuPct].some(v => v === null)) {
      return { total: 0, bullPct: null, bearPct: null, neuPct: null, label: 'Warming up', net: 0 };
    }

    let label = 'Neutral';
    if (sig.net > 0) label = 'Bullish';
    else if (sig.net < 0) label = 'Bearish';
    else if (sig.bullish > sig.bearish) label = 'Bullish';
    else if (sig.bearish > sig.bullish) label = 'Bearish';

    return { total, bullPct, bearPct, neuPct, label, net: sig.net };
  }

  function renderEmpty() {
    setText(DOM.pulseScore(), '—');
    setText(DOM.bullPct(), '—');
    setText(DOM.bearPct(), '—');
    setText(DOM.neuPct(), '—');
    setText(DOM.netInflow(), '—');

    setText(DOM.riskEntry(), '—');
    setText(DOM.riskStop(), '—');
    setText(DOM.riskTargets(), '—');
    setText(DOM.riskConf(), '—');
    setText(DOM.riskWR(), '—');

    scrubNaNText();
  }

  function renderFromSnapshot(s) {
    const sig = readSignals(s);
    const rk = readRisk(s);
    const bt = readBacktest(s);

    const sent = compute(sig);

    if (sent.total <= 0) {
      renderEmpty();
      return;
    }

    setText(DOM.bullPct(), fmtPct0(sent.bullPct));
    setText(DOM.bearPct(), fmtPct0(sent.bearPct));
    setText(DOM.neuPct(),  fmtPct0(sent.neuPct));

    // center score: show label (prevents NaN big text)
    setText(DOM.pulseScore(), sent.label);

    // net inflow: show signed number
    setText(DOM.netInflow(), (sent.net > 0 ? `+${sent.net}` : `${sent.net}`));

    // Risk Copilot
    setText(DOM.riskEntry(), fmtPrice2(rk.entry));
    setText(DOM.riskStop(), fmtPrice2(rk.stop));

    if (rk.targets && rk.targets.length) {
      setText(DOM.riskTargets(), rk.targets.map(x => Number(x).toFixed(2)).join(' / '));
    } else {
      setText(DOM.riskTargets(), '—');
    }

    setText(DOM.riskConf(), rk.confidence === null ? '—' : fmtPct0(rk.confidence));
    setText(DOM.riskWR(), bt.winRate === null ? '—' : fmtPct0(bt.winRate));

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
      else renderEmpty();
    });

    window.addEventListener('darrius:chartUpdated', onUpdate);

    // keep clean even if snapshot never arrives
    safe(() => { scrubNaNText(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
