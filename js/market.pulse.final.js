/* =========================================================================
 * market.pulse.final.js
 * FINAL UI-ONLY FIX — NO NaN, NO Waiting deadlock
 * ========================================================================= */
(() => {
  'use strict';

  function $(sel) {
    return document.querySelector(sel);
  }

  function text(el, v) {
    if (el) el.textContent = v;
  }

  function fmtPct(v) {
    return typeof v === 'number' && isFinite(v) ? `${v.toFixed(0)}%` : '—';
  }

  function render(snapshot) {
    if (!snapshot || !snapshot.meta) return;

    const sig = snapshot.signals || {};
    const b = Number(sig.bullish) || 0;
    const s = Number(sig.bearish) || 0;
    const n = Number(sig.neutral) || 0;
    const total = b + s + n;

    // ---- Market Pulse ----
    if (total === 0) {
      text($('#mp-bullish'), '—');
      text($('#mp-bearish'), '—');
      text($('#mp-neutral'), '—');
      text($('#mp-sentiment'), 'Warming up');
    } else {
      text($('#mp-bullish'), fmtPct((b / total) * 100));
      text($('#mp-bearish'), fmtPct((s / total) * 100));
      text($('#mp-neutral'), fmtPct((n / total) * 100));
      text($('#mp-sentiment'), b > s ? 'Bullish' : s > b ? 'Bearish' : 'Neutral');
    }

    // ---- Risk Copilot ----
    const risk = snapshot.risk || {};
    text($('#risk-confidence'), fmtPct(risk.confidence));
    text($('#risk-backtest'), fmtPct(risk.backtestWinRate));

    // ---- Status ----
    if (snapshot.meta.ready) {
      text($('#pulse-status'), 'Ready');
    }
  }

  window.addEventListener('darrius:chartUpdated', e => {
    render(e.detail);
  });
})();
