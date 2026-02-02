/* =========================================================================
 * DarriusAI - market.pulse.js (FINAL FROZEN DISPLAY-ONLY) v2026.02.02-PULSE-NAN-LOCK
 *
 * Purpose:
 *  - UI-only layer. Reads window.__DARRIUS_CHART_STATE__ snapshot (multi schema)
 *  - Renders Market Pulse + Risk Copilot text fields WITHOUT producing NaN
 *  - Never touches billing/subscription/payment logic
 *  - Never mutates chart.core.js internals
 *
 * Safety:
 *  - Never throws (absolute safe zone)
 *  - Missing DOM is OK
 * ========================================================================= */

(() => {
  'use strict';

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

  const pct = (part, total) => {
    const p = num(part, 0);
    const t = num(total, 0);
    if (t <= 0) return null;            // IMPORTANT: no NaN
    return (p / t) * 100;
  };

  const fmtPct = (v) => (v === null ? '—' : `${v.toFixed(0)}%`);
  const fmtPrice = (v) => (v === null ? '—' : `${v.toFixed(2)}`);
  const fmtMaybePct = (v) => (v === null ? '—' : `${v.toFixed(0)}%`);

  // -----------------------------
  // Snapshot reader (supports v2 + older)
  // -----------------------------
  function getSnap() {
    const s = window.__DARRIUS_CHART_STATE__;
    if (!s || typeof s !== 'object') return null;
    return s;
  }

  function readSignals(s) {
    // v2 contract
    if (s.signals && typeof s.signals === 'object') {
      return {
        bullish: num(s.signals.bullish, 0),
        bearish: num(s.signals.bearish, 0),
        neutral: num(s.signals.neutral, 0),
        net: num(s.signals.net, 0)
      };
    }
    // older possible shapes
    const stats = s.stats || s.signal_stats || s.signals || {};
    return {
      bullish: num(stats.bullish, 0),
      bearish: num(stats.bearish, 0),
      neutral: num(stats.neutral, 0),
      net: num((stats.bullish || 0) - (stats.bearish || 0), 0)
    };
  }

  function readPrice(s) {
    // v2
    if (s.price && typeof s.price === 'object') {
      return {
        last: nnull(s.price.last),
        bias: str(s.price.bias, 'stable'),
        trend: str(s.price.trend, 'flat')
      };
    }
    // older
    return {
      last: nnull(s.last || s.lastPrice),
      bias: str(s.bias, 'stable'),
      trend: str(s.trend, 'flat')
    };
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
  // DOM: be flexible, do NOT change layout.
  // We try multiple selectors so we don't need you to rename HTML.
  // -----------------------------
  const SEL = {
    // Market Pulse numbers
    bullish: ['[data-pulse="bullish"]', '#pulseBullish', '.pulse-bullish', '.mp-bullish'],
    bearish: ['[data-pulse="bearish"]', '#pulseBearish', '.pulse-bearish', '.mp-bearish'],
    neutral: ['[data-pulse="neutral"]', '#pulseNeutral', '.pulse-neutral', '.mp-neutral'],
    net:     ['[data-pulse="net"]', '#pulseNet', '.pulse-net', '.mp-net'],

    // Sentiment center label
    sentimentText: ['[data-pulse="sentimentText"]', '#pulseSentiment', '.pulse-sentiment', '.mp-sentiment'],
    sentimentValue: ['[data-pulse="sentimentValue"]', '#pulseSentimentValue', '.pulse-sentiment-value', '.mp-sentiment-value'],

    // Risk Copilot
    entry: ['[data-risk="entry"]', '#riskEntry', '.risk-entry'],
    stop: ['[data-risk="stop"]', '#riskStop', '.risk-stop'],
    targets: ['[data-risk="targets"]', '#riskTargets', '.risk-targets'],
    confidence: ['[data-risk="confidence"]', '#riskConfidence', '.risk-confidence'],
    winRate: ['[data-risk="winRate"]', '#riskWinRate', '.risk-winrate', '.backtest-winrate'],

    // Optional: a small status line
    statusLine: ['[data-pulse="status"]', '#pulseStatus', '.pulse-status', '.mp-status']
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
    // preserve layout: only set textContent
    el.textContent = text;
  }

  // -----------------------------
  // Rendering rules (NO NaN)
  // -----------------------------
  function computeSentiment(sig) {
    const total = sig.bullish + sig.bearish + sig.neutral;
    if (total <= 0) {
      return { label: 'Warming up', note: 'Awaiting sufficient market structure', bp: null, sp: null, np: null };
    }
    const bp = pct(sig.bullish, total);
    const sp = pct(sig.bearish, total);
    const np = pct(sig.neutral, total);

    // label by net
    let label = 'Neutral';
    if (sig.net > 0) label = 'Bullish';
    else if (sig.net < 0) label = 'Bearish';

    return { label, note: '', bp, sp, np };
  }

  function renderFromSnapshot(s) {
    const sig = readSignals(s);
    const px = readPrice(s);
    const rk = readRisk(s);
    const bt = readBacktest(s);
    const mt = readMeta(s);

    const total = sig.bullish + sig.bearish + sig.neutral;
    const sent = computeSentiment(sig);

    // ---- Market Pulse ----
    // If your UI expects percentages, we display %; if it expects raw, still okay—your selectors decide.
    // Here we choose percentage strings for bullish/bearish/neutral because your screenshot shows "NaN%".
    const bullEl = qAny(SEL.bullish);
    const bearEl = qAny(SEL.bearish);
    const neutEl = qAny(SEL.neutral);
    const netEl = qAny(SEL.net);

    setText(bullEl, fmtPct(sent.bp));
    setText(bearEl, fmtPct(sent.sp));
    setText(neutEl, fmtPct(sent.np));

    // net: show number (or — if no structure)
    setText(netEl, (total <= 0) ? '—' : (sig.net > 0 ? `+${sig.net}` : `${sig.net}`));

    // Sentiment center
    setText(qAny(SEL.sentimentText), 'Sentiment');
    setText(qAny(SEL.sentimentValue), total <= 0 ? '—' : sent.label);

    // Optional status line
    const status = (!mt.ready)
      ? 'Loading…'
      : (total <= 0 ? sent.note : (mt.source === 'delayed' ? 'Delayed data' : 'Live/Ready'));
    setText(qAny(SEL.statusLine), status);

    // ---- Risk Copilot ----
    // entry/stop/targets may be null; we show "—" not NaN
    setText(qAny(SEL.entry), fmtPrice(rk.entry));
    setText(qAny(SEL.stop), fmtPrice(rk.stop));

    if (rk.targets && rk.targets.length) {
      const t = rk.targets.map(x => x.toFixed(2)).join(' / ');
      setText(qAny(SEL.targets), t);
    } else {
      setText(qAny(SEL.targets), '—');
    }

    // confidence: if null, show —
    setText(qAny(SEL.confidence), rk.confidence === null ? '—' : fmtMaybePct(rk.confidence));

    // backtest: if null, show —
    setText(qAny(SEL.winRate), bt.winRate === null ? '—' : fmtMaybePct(bt.winRate));

    // Done.
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
