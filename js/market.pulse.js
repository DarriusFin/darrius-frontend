/* =========================================================================
 * market.pulse.js (FORCE-ROBUST LEFT PANEL) v2026.02.03
 * Purpose:
 *  - Only fill LEFT PANEL: Market Pulse / Risk Copilot / Waiting
 *  - UI-only, never touches chart rendering / billing / subscription
 *  - Robust snapshot detection + robust DOM row mapping (no hardcoded IDs)
 * ========================================================================= */
(() => {
  'use strict';

  // -----------------------------
  // Absolute no-throw safe zone
  // -----------------------------
  function safe(fn, fallback = null) {
    try { return fn(); } catch (e) { return fallback; }
  }

  // -----------------------------
  // Find LEFT PANEL container (yellow box area)
  // -----------------------------
  function getLeftPanelRoot() {
    // Try common containers; fallback to whole document
    return (
      document.querySelector('#left-panel') ||
      document.querySelector('.left-panel') ||
      document.querySelector('.sidebar-left') ||
      document.querySelector('aside') ||
      document.body
    );
  }

  // -----------------------------
  // Snapshot: ultra-robust getter
  // -----------------------------
  function normalizeCandles(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(b => ({
      t: b.t ?? b.time ?? b.ts ?? b.timestamp,
      o: + (b.o ?? b.open),
      h: + (b.h ?? b.high),
      l: + (b.l ?? b.low),
      c: + (b.c ?? b.close),
      v: + (b.v ?? b.volume ?? 0),
    })).filter(x =>
      Number.isFinite(x.o) && Number.isFinite(x.h) &&
      Number.isFinite(x.l) && Number.isFinite(x.c)
    );
  }

  function normalizeSnapshot(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const candles =
      raw.candles || raw.ohlcv || raw.bars ||
      safe(() => raw.data && (raw.data.candles || raw.data.ohlcv || raw.data.bars), null) ||
      safe(() => raw.snapshot && (raw.snapshot.candles || raw.snapshot.bars), null) ||
      [];

    const norm = normalizeCandles(candles);
    if (!norm.length) return null;

    const symbol =
      raw.symbol || raw.ticker ||
      safe(() => raw.meta && (raw.meta.symbol || raw.meta.ticker), null) ||
      '—';

    const tf =
      raw.timeframe || raw.tf ||
      safe(() => raw.meta && (raw.meta.timeframe || raw.meta.tf), null) ||
      '—';

    const lastPrice = norm[norm.length - 1].c;

    return { symbol, timeframe: tf, candles: norm, lastPrice, raw };
  }

  function scanWindowForSnapshot() {
    // Scan a handful of likely global names first
    const candidates = [
      safe(() => window.DarriusChart && window.DarriusChart.getSnapshot && window.DarriusChart.getSnapshot(), null),
      safe(() => window.__DARRIUS_CHART_STATE__, null),
      safe(() => window.__DARRIUS_CHART_SNAPSHOT__, null),
      safe(() => window.__CHART_SNAPSHOT__, null),
      safe(() => window.__SNAPSHOT__, null),
      safe(() => window.__STATE__, null),
    ];
    for (const c of candidates) {
      const s = normalizeSnapshot(c);
      if (s) return { snap: s, hint: 'direct' };
    }

    // If still none, scan window keys (bounded) for any object that looks like candles
    const keys = Object.keys(window);
    // Keep it cheap: only scan keys that look relevant
    const likely = keys.filter(k =>
      /snapshot|state|chart|darr|ohlc|candle|bar/i.test(k)
    ).slice(0, 80);

    for (const k of likely) {
      const v = safe(() => window[k], null);
      const s = normalizeSnapshot(v);
      if (s) return { snap: s, hint: `window.${k}` };
    }

    return { snap: null, hint: `no snapshot found; scanned ${likely.length} keys` };
  }

  // -----------------------------
  // Compute: Market Pulse (simple, explainable)
  // -----------------------------
  const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  const pct = (n, d = 0) => (Number.isFinite(n) ? (n * 100).toFixed(d) + '%' : '—');

  function computeMarketPulse(candles) {
    if (!candles || candles.length < 30) return null;

    const n = 20;
    const seg = candles.slice(-n);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    const ret1 = (last.c - prev.c) / (prev.c || last.c);
    const ret20 = (last.c - seg[0].c) / (seg[0].c || last.c);

    // slope of last 20 closes (normalized)
    let sx=0, sy=0, sxx=0, sxy=0;
    for (let i=0;i<seg.length;i++){
      const x=i, y=seg[i].c;
      sx+=x; sy+=y; sxx+=x*x; sxy+=x*y;
    }
    const denom = (n*sxx - sx*sx) || 1;
    const slope = (n*sxy - sx*sy) / denom;
    const slopeN = slope / (last.c || 1);

    // net inflow approx: up-volume - down-volume (20 bars)
    let upV=0, dnV=0;
    for (const b of seg) {
      if (b.c >= b.o) upV += (b.v||0); else dnV += (b.v||0);
    }
    const netInflow = upV - dnV;

    // score
    const score = (slopeN*200) + (ret20*80) + (ret1*40);
    let label = 'Neutral';
    if (score > 3) label = 'Bullish';
    else if (score < -3) label = 'Bearish';

    const bull = Math.max(0, Math.min(1, (score + 10) / 20));
    const bear = Math.max(0, Math.min(1, (10 - score) / 20));
    const neu  = Math.max(0, Math.min(1, 1 - Math.min(1, Math.abs(score)/10)));

    return { label, bull, bear, neu, netInflow };
  }

  // -----------------------------
  // Compute: Risk Copilot (ATR-based, conservative)
  // -----------------------------
  function computeRiskCopilot(candles) {
    if (!candles || candles.length < 30) return null;

    const last = candles[candles.length - 1];
    const entry = last.c;

    // ATR(14)
    const len = 14;
    let trs = [];
    for (let i=candles.length-len;i<candles.length;i++){
      const b=candles[i], p=candles[i-1];
      if(!b||!p) continue;
      const tr = Math.max(
        b.h - b.l,
        Math.abs(b.h - p.c),
        Math.abs(b.l - p.c)
      );
      trs.push(tr);
    }
    const atr = trs.length ? trs.reduce((a,b)=>a+b,0)/trs.length : NaN;

    const stop = Number.isFinite(atr) ? (entry - 1.5 * atr) : NaN;
    const r = Number.isFinite(stop) ? (entry - stop) : NaN;

    const t1 = Number.isFinite(r) ? (entry + 1.0 * r) : NaN;
    const t2 = Number.isFinite(r) ? (entry + 2.0 * r) : NaN;

    // confidence: up-bar ratio last 20
    const seg = candles.slice(-20);
    let up = 0;
    for (const b of seg) if (b.c >= b.o) up++;
    const confidence = seg.length ? up / seg.length : NaN;

    return { entry, stop, t1, t2, confidence };
  }

  // -----------------------------
  // DOM row writer (no hardcoded ids)
  // It finds a row by label text, then replaces right-side value (—)
  // -----------------------------
  function findModuleByTitle(root, titleIncludes) {
    const nodes = Array.from(root.querySelectorAll('*'));
    return nodes.find(n => {
      const t = (n.textContent || '').trim();
      return titleIncludes.some(x => t.includes(x));
    }) || null;
  }

  function setRowValue(root, labelTextList, valueText) {
    if (!root) return false;
    const nodes = Array.from(root.querySelectorAll('*'));
    // find the element that contains the label, then try to locate a sibling value area
    for (const n of nodes) {
      const txt = (n.textContent || '').trim();
      if (!txt) continue;
      if (labelTextList.some(k => txt === k || txt.includes(k))) {
        // Try: same row container = parent
        const row = n.closest('div') || n.parentElement;
        if (!row) continue;

        // Heuristic: pick the last child that looks like a value
        const candidates = Array.from(row.querySelectorAll('span,div')).filter(x => x !== n);
        // prefer right-aligned / short text nodes
        let target = candidates.reverse().find(x => {
          const t2 = (x.textContent || '').trim();
          return t2 === '—' || t2 === '-' || t2.length <= 12;
        }) || candidates[0];

        if (target) {
          target.textContent = valueText;
          return true;
        }
      }
    }
    return false;
  }

  function setWaiting(root, on, text) {
    // try find "Waiting..." block by containing text
    const nodes = Array.from(root.querySelectorAll('*'));
    const w = nodes.find(n => (n.textContent || '').includes('Waiting')) ||
              nodes.find(n => (n.textContent || '').includes('等待')) ||
              null;
    if (w) {
      // show it / update it
      w.style.opacity = on ? '1' : '0.6';
      // update nearby detail line
      const parent = w.closest('div') || w.parentElement;
      if (parent) {
        const detail = Array.from(parent.querySelectorAll('div,span')).find(x => (x.textContent||'').includes('confirmation') || (x.textContent||'').includes('确认') || (x.textContent||'').includes('Waiting for'));
        if (detail) detail.textContent = text;
      }
    }
  }

  // -----------------------------
  // Render
  // -----------------------------
  function render() {
    const root = getLeftPanelRoot();

    const { snap, hint } = scanWindowForSnapshot();
    if (!snap) {
      setWaiting(root, true, `No snapshot yet (${hint}).`);
      // also put dashes explicitly (optional)
      return;
    }

    setWaiting(root, false, `Snapshot OK: ${snap.symbol} ${snap.timeframe} (${hint})`);

    const mp = computeMarketPulse(snap.candles);
    const rc = computeRiskCopilot(snap.candles);

    // Market Pulse module block (title in screenshot: "Market Pulse - 市场情绪")
    // write values by label text
    if (mp) {
      setRowValue(root, ['Bullish'], pct(mp.bull, 0));
      setRowValue(root, ['Bearish'], pct(mp.bear, 0));
      setRowValue(root, ['Neutral'], pct(mp.neu, 0));
      setRowValue(root, ['Net Inflow'], Number.isFinite(mp.netInflow) ? Math.round(mp.netInflow).toLocaleString() : '—');
      // ring center “Sentiment” text often shows as dash; try set it
      setRowValue(root, ['Sentiment'], mp.label);
    }

    // Risk Copilot module block (title: "Risk Copilot - 风险助手")
    if (rc) {
      setRowValue(root, ['Entry', '入场'], fmt(rc.entry, 2));
      setRowValue(root, ['Stop', '止损'], fmt(rc.stop, 2));
      setRowValue(root, ['Targets', '目标'], `${fmt(rc.t1, 2)} / ${fmt(rc.t2, 2)}`);
      setRowValue(root, ['Confidence', '强度'], pct(rc.confidence, 0));
      // Backtest WinRate 不要伪造，给 —
      setRowValue(root, ['Backtest', '回测胜率'], '—');
    }
  }

  // -----------------------------
  // Bind to chart updates (multiple possible event names)
  // -----------------------------
  function bind() {
    const evs = [
      'darrius:chartUpdated',
      'darrius:updated',
      'chartUpdated',
      'chart:updated'
    ];
    evs.forEach(e => window.addEventListener(e, () => safe(render), { passive: true }));

    // also render immediately + retry (in case chart initializes later)
    render();
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      render();
      if (tries >= 20) clearInterval(timer);
      const { snap } = scanWindowForSnapshot();
      if (snap && snap.candles && snap.candles.length > 10) clearInterval(timer);
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }
})();
