/* =========================================================================
 * DarriusAI - market.pulse.js (FINAL FROZEN DISPLAY-ONLY) v2026.02.02-PULSE-NAN-LOCK-R2
 *
 * Purpose:
 *  - UI-only layer. Reads window.__DARRIUS_CHART_STATE__ snapshot (multi schema)
 *  - Renders Market Pulse + Risk Copilot fields WITHOUT producing NaN
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

  // ---- probe: prove which file is running on prod ----
  try {
    window.__PULSE_LOADED__ = 'v2026.02.02-R2';
    console.log('[PULSE LOADED]', window.__PULSE_LOADED__, Date.now());
  } catch (_) {}

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
  const fmtInt = (v) => (v === null ? '—' : `${Math.round(Number(v))}`);

  // -----------------------------
  // Snapshot reader (supports v2 + older)
  // -----------------------------
  function getSnap() {
    const s = window.__DARRIUS_CHART_STATE__;
    return (s && typeof s === 'object') ? s : null;
  }

  function readSignals(s) {
    // v2 contract
    if (s && s.signals && typeof s.signals === 'object') {
      const bullish = num(s.signals.bullish, 0);
      const bearish = num(s.signals.bearish, 0);
      const neutral = num(s.signals.neutral, 0);
      const net = num(s.signals.net, bullish - bearish);
      return { bullish, bearish, neutral, net };
    }
    // older shapes
    const stats = (s && (s.stats || s.signal_stats || s.signals)) || {};
    const bullish = num(stats.bullish, 0);
    const bearish = num(stats.bearish, 0);
    const neutral = num(stats.neutral, 0);
    const net = num(stats.net, bullish - bearish);
    return { bullish, bearish, neutral, net };
  }

  function readRisk(s) {
    // v2
    if (s && s.risk && typeof s.risk === 'object') {
      return {
        entry: nnull(s.risk.entry),
        stop: nnull(s.risk.stop),
        targets: Array.isArray(s.risk.targets) ? s.risk.targets.filter(isNum).slice(0, 6) : [],
        confidence: nnull(s.risk.confidence)
      };
    }
    // older
    const r = (s && (s.risk || s.copilot)) || {};
    return {
      entry: nnull(r.entry),
      stop: nnull(r.stop),
      targets: Array.isArray(r.targets) ? r.targets.filter(isNum).slice(0, 6) : [],
      confidence: nnull(r.confidence)
    };
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
    return {
      ready: !!m.ready,
      source: str(m.source, 'unknown')
    };
  }

  // -----------------------------
  // DOM: real ids only (your index.html)
  // -----------------------------
  const SEL = {
    pulseScore: '#pulseScore',
    bullPct: '#bullPct',
    bearPct: '#bearPct',
    neuPct: '#neuPct',
    netInflow: '#netInflow',

    riskEntry: '#riskEntry',
    riskStop: '#riskStop',
    riskTargets: '#riskTargets',
    riskConf: '#riskConf',
    riskWR: '#riskWR',

    // gauge mask is optional
    gaugeMask: '#pulseGaugeMask'
  };

  const $ = (sel) => document.querySelector(sel);

  function setText(sel, text) {
    const el = $(sel);
    if (!el) return;
    el.textContent = text;
  }

  // -----------------------------
  // Rendering rules (NO NaN)
  // -----------------------------
  function computeSentiment(sig) {
    const total = sig.bullish + sig.bearish + sig.neutral;

    if (total <= 0) {
      return {
        total: 0,
        bullPct: null,
        bearPct: null,
        neuPct: null,
        label: '—',
        net: null
      };
    }

    const bullPct = safePct(sig.bullish, total);
    const bearPct = safePct(sig.bearish, total);
    const neuPct  = safePct(sig.neutral, total);

    // Hard gate: any null => empty
    if ([bullPct, bearPct, neuPct].some(v => v === null)) {
      return {
        total: 0,
        bullPct: null,
        bearPct: null,
        neuPct: null,
        label: '—',
        net: null
      };
    }

    // label logic: prefer net, else compare bull/bear
    let label = 'Neutral';
    if (sig.net > 0) label = 'Bullish';
    else if (sig.net < 0) label = 'Bearish';
    else if (sig.bullish > sig.bearish) label = 'Bullish';
    else if (sig.bearish > sig.bullish) label = 'Bearish';

    return { total, bullPct, bearPct, neuPct, label, net: sig.net };
  }

  function setGaugeByBullPct(bullPct) {
    // Optional: if gauge mask exists, we can visually reflect bullPct
    // We do NOT require it, and we do NOT break layout if missing.
    const mask = $(SEL.gaugeMask);
    if (!mask) return;

    // bullPct null => reset to 0 (no NaN)
    const p = (bullPct === null) ? 0 : Math.max(0, Math.min(100, Number(bullPct)));
    const deg = (p / 100) * 360;

    // This mask sits above the fancy conic-gradient gauge to show "filled" angle
    // Keep it simple: fill from 0 -> deg, rest dark.
    mask.style.background = `conic-gradient(rgba(43,226,166,.92) 0deg, rgba(43,226,166,.92) ${deg}deg, rgba(255,90,90,.22) ${deg}deg, rgba(255,90,90,.22) 360deg)`;
  }

  function renderEmpty(mt) {
    setText(SEL.pulseScore, '—');
    setText(SEL.bullPct, '—');
    setText(SEL.bearPct, '—');
    setText(SEL.neuPct, '—');
    setText(SEL.netInflow, '—');

    setText(SEL.riskEntry, '—');
    setText(SEL.riskStop, '—');
    setText(SEL.riskTargets, '—');
    setText(SEL.riskConf, '—');
    setText(SEL.riskWR, '—');

    setGaugeByBullPct(null);

    // best-effort scrub: remove literal "NaN" from any text node (rare legacy residue)
    scrubNaNText();

    // keep optional status somewhere? (you don't have pulseStatus in index.html)
    // we intentionally do nothing.
    void mt;
  }

  function scrubNaNText() {
    safe(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const v = n.nodeValue;
        if (!v) continue;
        if (v.includes('NaN%')) n.nodeValue = v.replaceAll('NaN%', '—');
        else if (v.trim() === 'NaN') n.nodeValue = '—';
      }
    });
  }

  function renderFromSnapshot(s) {
    const sig = readSignals(s);
    const rk = readRisk(s);
    const bt = readBacktest(s);
    const mt = readMeta(s);

    const sent = computeSentiment(sig);

    if (sent.total <= 0) {
      renderEmpty(mt);
      return;
    }

    // Market Pulse
    setText(SEL.bullPct, fmtPct0(sent.bullPct));
    setText(SEL.bearPct, fmtPct0(sent.bearPct));
    setText(SEL.neuPct, fmtPct0(sent.neuPct));

    // Center score: show label (not a number -> avoids NaN forever)
    setText(SEL.pulseScore, sent.label);

    // Net inflow: you display it green in UI; we output net count (or —)
    // If you later want it as %, you can change to fmtPct0(safePct(sig.net, totalAbs)) etc.
    setText(SEL.netInflow, (sent.net === null) ? '—' : (sent.net > 0 ? `+${sent.net}` : `${sent.net}`));

    setGaugeByBullPct(sent.bullPct);

    // Risk Copilot
    setText(SEL.riskEntry, fmtPrice2(rk.entry));
    setText(SEL.riskStop, fmtPrice2(rk.stop));

    if (rk.targets && rk.targets.length) {
      setText(SEL.riskTargets, rk.targets.map(x => Number(x).toFixed(2)).join(' / '));
    } else {
      setText(SEL.riskTargets, '—');
    }

    setText(SEL.riskConf, rk.confidence === null ? '—' : fmtPct0(rk.confidence));
    setText(SEL.riskWR, bt.winRate === null ? '—' : fmtPct0(bt.winRate));

    // Final scrub
    scrubNaNText();
    void mt;
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

    // if the event never fires, keep UI clean anyway
    safe(() => { scrubNaNText(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
