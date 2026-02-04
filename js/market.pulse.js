/* =========================================================================
 * market.pulse.js (SAFE APPEND-ONLY) v2026.02.03
 * - Never overwrites existing module DOM (no textContent on containers)
 * - Only APPENDS tiny dynamic rows into each module
 * - UI-only: does not touch chart rendering / billing / subscription
 * ========================================================================= */
(() => {
  'use strict';

  function safe(fn, fallback = null) {
    try { return fn(); } catch (e) { return fallback; }
  }

  const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  const pct = (n, d = 0) => (Number.isFinite(n) ? (n * 100).toFixed(d) + '%' : '—');

  // -----------------------------
  // Find module by title text
  // -----------------------------
  function findModuleByTitle(includesList) {
    const all = Array.from(document.querySelectorAll('div,section,aside'));
    // choose the smallest container that contains title text
    let best = null;
    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (!t) continue;
      if (!includesList.some(k => t.includes(k))) continue;

      // heuristic: module containers are not too huge
      const area = (el.offsetWidth || 0) * (el.offsetHeight || 0);
      if (!best || area < best.area) best = { el, area };
    }
    return best ? best.el : null;
  }

  // -----------------------------
  // Create or get an injected panel inside a module
  // -----------------------------
  function ensureInjectedBox(moduleEl, boxId) {
    if (!moduleEl) return null;

    let box = moduleEl.querySelector(`#${boxId}`);
    if (box) return box;

    box = document.createElement('div');
    box.id = boxId;
    box.style.marginTop = '8px';
    box.style.padding = '8px 10px';
    box.style.border = '1px solid rgba(255,255,255,0.10)';
    box.style.borderRadius = '10px';
    box.style.background = 'rgba(0,0,0,0.25)';
    box.style.fontSize = '12px';
    box.style.lineHeight = '1.45';
    box.style.color = 'rgba(255,255,255,0.85)';

    // append near bottom but inside module
    moduleEl.appendChild(box);
    return box;
  }

  // -----------------------------
  // Snapshot getter (conservative + explicit)
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

    return { symbol, timeframe: tf, candles: norm, lastPrice: norm[norm.length - 1].c, raw };
  }

  function getSnapshot() {
    // Most reliable: DarriusChart.getSnapshot
    const s1 = safe(() => window.DarriusChart && window.DarriusChart.getSnapshot && window.DarriusChart.getSnapshot(), null);
    const n1 = normalizeSnapshot(s1);
    if (n1) return { snap: n1, hint: 'DarriusChart.getSnapshot()' };

    // Fallback: explicit global
    const s2 = safe(() => window.__DARRIUS_CHART_STATE__, null);
    const n2 = normalizeSnapshot(s2);
    if (n2) return { snap: n2, hint: '__DARRIUS_CHART_STATE__' };

    return { snap: null, hint: 'snapshot not exposed' };
  }

  // -----------------------------
  // Compute Market Pulse
  // -----------------------------
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

    // net inflow approx: up-volume - down-volume
    let upV=0, dnV=0;
    for (const b of seg) {
      if (b.c >= b.o) upV += (b.v||0); else dnV += (b.v||0);
    }
    const netInflow = upV - dnV;

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
  // Compute Risk Copilot (ATR-based)
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

    const seg = candles.slice(-20);
    let up = 0;
    for (const b of seg) if (b.c >= b.o) up++;
    const confidence = seg.length ? up / seg.length : NaN;

    return { entry, stop, t1, t2, confidence };
  }

  // -----------------------------
  // Render (append-only)
  // -----------------------------
  function render() {
    const mpModule = findModuleByTitle(['Market Pulse', '市场情绪']);
    const rcModule = findModuleByTitle(['Risk Copilot', '风险助手']);
    const wModule  = findModuleByTitle(['Waiting', '等待']);

    const mpBox = ensureInjectedBox(mpModule, 'mp_injected_box');
    const rcBox = ensureInjectedBox(rcModule, 'rc_injected_box');
    const wBox  = ensureInjectedBox(wModule,  'w_injected_box');

    const { snap, hint } = getSnapshot();

    if (!snap) {
      if (wBox) {
        wBox.innerHTML =
          `<div style="opacity:.9">Status: <b>NO SNAPSHOT</b></div>
           <div style="opacity:.75;margin-top:4px">Hint: ${hint}</div>
           <div style="opacity:.75;margin-top:4px">Fix: chart.core.js must expose <code>window.__DARRIUS_CHART_STATE__</code> or provide <code>DarriusChart.getSnapshot()</code>.</div>`;
      }
      if (mpBox) mpBox.innerHTML = `<div style="opacity:.8">Market Pulse: — (waiting snapshot)</div>`;
      if (rcBox) rcBox.innerHTML = `<div style="opacity:.8">Risk Copilot: — (waiting snapshot)</div>`;
      return;
    }

    if (wBox) {
      wBox.innerHTML =
        `<div style="opacity:.9">Status: <b>SNAPSHOT OK</b></div>
         <div style="opacity:.75;margin-top:4px">Symbol: ${snap.symbol} &nbsp; TF: ${snap.timeframe} &nbsp; Last: ${fmt(snap.lastPrice, 2)}</div>
         <div style="opacity:.75;margin-top:4px">Source: ${hint}</div>`;
    }

    const mp = computeMarketPulse(snap.candles);
    const rc = computeRiskCopilot(snap.candles);

    if (mpBox && mp) {
      mpBox.innerHTML =
        `<div><b>Sentiment:</b> ${mp.label}</div>
         <div style="margin-top:4px;opacity:.9">Bullish: ${pct(mp.bull,0)} &nbsp; Bearish: ${pct(mp.bear,0)} &nbsp; Neutral: ${pct(mp.neu,0)}</div>
         <div style="margin-top:4px;opacity:.9">Net Inflow (20 bars): ${Number.isFinite(mp.netInflow) ? Math.round(mp.netInflow).toLocaleString() : '—'}</div>`;
    }

    if (rcBox && rc) {
      rcBox.innerHTML =
        `<div><b>Entry:</b> ${fmt(rc.entry,2)} &nbsp; <b>Stop:</b> ${fmt(rc.stop,2)}</div>
         <div style="margin-top:4px;opacity:.9"><b>Targets:</b> ${fmt(rc.t1,2)} / ${fmt(rc.t2,2)}</div>
         <div style="margin-top:4px;opacity:.9"><b>Confidence:</b> ${pct(rc.confidence,0)} &nbsp; <span style="opacity:.7">(derived)</span></div>`;
    }
  }

  // -----------------------------
  // Bind to chart update events + retry init
  // -----------------------------
  function bind() {
    const evs = ['darrius:chartUpdated', 'chartUpdated', 'chart:updated'];
    evs.forEach(e => window.addEventListener(e, () => safe(render), { passive: true }));

    render();

    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      render();
      const { snap } = getSnapshot();
      if (snap || tries >= 20) clearInterval(timer);
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }
})();
