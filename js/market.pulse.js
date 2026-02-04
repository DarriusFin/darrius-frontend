/* =========================================================================
 * market.pulse.js (HIT-STRONG / LAYOUT-SAFE) v2026.02.03
 * - ZERO DOM insertion
 * - ZERO container overwrite
 * - Replaces ONLY existing value placeholders inside each module
 * - Shows tiny status in Waiting line (no layout break)
 * ========================================================================= */
(() => {
  'use strict';

  function safe(fn, fallback = null) { try { return fn(); } catch { return fallback; } }
  const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  const pct = (n, d = 0) => (Number.isFinite(n) ? (n * 100).toFixed(d) + '%' : '—');

  // -----------------------------
  // Snapshot
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

    return { symbol, timeframe: tf, candles: norm, lastPrice: norm[norm.length - 1].c };
  }

  function getSnapshotWithHint() {
    const s1 = safe(() => window.DarriusChart && window.DarriusChart.getSnapshot && window.DarriusChart.getSnapshot(), null);
    const n1 = normalizeSnapshot(s1);
    if (n1) return { snap: n1, hint: 'DarriusChart.getSnapshot' };

    const s2 = safe(() => window.__DARRIUS_CHART_STATE__, null);
    const n2 = normalizeSnapshot(s2);
    if (n2) return { snap: n2, hint: '__DARRIUS_CHART_STATE__' };

    return { snap: null, hint: 'no snapshot' };
  }

  // -----------------------------
  // Compute
  // -----------------------------
  function computeMarketPulse(candles) {
    if (!candles || candles.length < 30) return null;

    const n = 20;
    const seg = candles.slice(-n);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    const ret1 = (last.c - prev.c) / (prev.c || last.c);
    const ret20 = (last.c - seg[0].c) / (seg[0].c || last.c);

    // slope normalized
    let sx=0, sy=0, sxx=0, sxy=0;
    for (let i=0;i<seg.length;i++){
      const x=i, y=seg[i].c;
      sx+=x; sy+=y; sxx+=x*x; sxy+=x*y;
    }
    const denom = (n*sxx - sx*sx) || 1;
    const slope = (n*sxy - sx*sy) / denom;
    const slopeN = slope / (last.c || 1);

    // net inflow approx
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
  // Find module containers by title text (stable)
  // -----------------------------
  function findModuleByTitleText(titleIncludes) {
    const blocks = Array.from(document.querySelectorAll('div,section,aside'));
    let best = null;

    for (const el of blocks) {
      const t = (el.textContent || '').trim();
      if (!t) continue;
      if (!titleIncludes.some(k => t.includes(k))) continue;

      // Prefer medium sized card-like containers
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
      const area = r.width * r.height;
      if (r.width < 180 || r.width > 420) continue;
      if (area < 20000 || area > 250000) continue;

      if (!best || area < best.area) best = { el, area };
    }

    // fallback: first match
    if (!best) {
      const el = blocks.find(x => {
        const t = (x.textContent || '').trim();
        return titleIncludes.some(k => t.includes(k));
      });
      return el || null;
    }
    return best.el;
  }

  // -----------------------------
  // Robust row value replace inside a module
  // -----------------------------
  const PLACEHOLDERS = new Set(['—', '-', '--', '–', '— —', '']);

  function looksLikePlaceholderText(s) {
    const t = (s || '').trim();
    if (PLACEHOLDERS.has(t)) return true;
    // some UI uses short blanks
    return t.length <= 2 && /^[—\-–]*$/.test(t);
  }

  function findValueNearLabel(labelEl) {
    if (!labelEl) return null;

    // climb up a few levels to find a "row" that contains a placeholder value
    let cur = labelEl;
    for (let i=0; i<5 && cur; i++) {
      const row = cur.closest('div') || cur.closest('li') || cur.parentElement;
      if (!row) break;

      const candidates = Array.from(row.querySelectorAll('span,div')).filter(n => n !== labelEl);
      // prefer placeholder node
      let val = candidates.find(n => looksLikePlaceholderText(n.textContent));
      if (val) return val;

      // if no placeholder, prefer rightmost small node
      val = candidates.reverse().find(n => ((n.textContent||'').trim().length <= 12));
      if (val) return val;

      cur = row.parentElement;
    }

    // last resort: next siblings
    let sib = labelEl.nextElementSibling;
    while (sib) {
      if (sib.matches('span,div') && (looksLikePlaceholderText(sib.textContent) || (sib.textContent||'').trim().length <= 12)) return sib;
      sib = sib.nextElementSibling;
    }

    return null;
  }

  function setInModule(moduleEl, labelKeywords, valueText) {
    if (!moduleEl) return false;
    const nodes = Array.from(moduleEl.querySelectorAll('span,div'));

    for (const n of nodes) {
      const t = (n.textContent || '').trim();
      if (!t) continue;
      if (!labelKeywords.some(k => t === k || t.includes(k))) continue;

      const v = findValueNearLabel(n);
      if (v) {
        v.textContent = valueText;
        return true;
      }
    }
    return false;
  }

  function setSentimentCenter(moduleEl, valueText) {
    // Try row "Sentiment" first
    if (setInModule(moduleEl, ['Sentiment'], valueText)) return true;

    // Otherwise: find a standalone placeholder inside the ring
    const nodes = Array.from(moduleEl.querySelectorAll('span,div'));
    const target = nodes.find(n => (n.textContent || '').trim() === '—' && n.getBoundingClientRect && n.getBoundingClientRect().width <= 80);
    if (target) { target.textContent = valueText; return true; }
    return false;
  }

  function updateWaitingLine(waitingModule, text) {
    if (!waitingModule) return;
    const lines = Array.from(waitingModule.querySelectorAll('div,span'));
    const line = lines.find(n => {
      const t = (n.textContent || '');
      return t.includes('Waiting for confirmation') || t.includes('Waiting for') || t.includes('等待确认');
    });
    if (line) line.textContent = text;
  }

  // -----------------------------
  // Render
  // -----------------------------
  function render() {
    const mpModule = findModuleByTitleText(['Market Pulse', '市场情绪']);
    const rcModule = findModuleByTitleText(['Risk Copilot', '风险助手']);
    const wModule  = findModuleByTitleText(['Waiting', '等待']);

    const { snap, hint } = getSnapshotWithHint();
    if (!snap) {
      updateWaitingLine(wModule, `Waiting for confirmation... (${hint})`);
      return;
    }

    updateWaitingLine(wModule, `Ready (${hint}) · ${snap.symbol} ${snap.timeframe} · ${fmt(snap.lastPrice,2)}`);

    const mp = computeMarketPulse(snap.candles);
    const rc = computeRiskCopilot(snap.candles);

    if (mpModule && mp) {
      setSentimentCenter(mpModule, mp.label);
      setInModule(mpModule, ['Bullish'], pct(mp.bull, 0));
      setInModule(mpModule, ['Bearish'], pct(mp.bear, 0));
      setInModule(mpModule, ['Neutral'], pct(mp.neu, 0));
      setInModule(mpModule, ['Net Inflow'], Number.isFinite(mp.netInflow) ? Math.round(mp.netInflow).toLocaleString() : '—');
    }

    if (rcModule && rc) {
      setInModule(rcModule, ['Entry', '入场'], fmt(rc.entry, 2));
      setInModule(rcModule, ['Stop', '止损'], fmt(rc.stop, 2));
      setInModule(rcModule, ['Targets', '目标'], `${fmt(rc.t1, 2)} / ${fmt(rc.t2, 2)}`);
      setInModule(rcModule, ['Confidence', '强度'], pct(rc.confidence, 0));
    }
  }

  // -----------------------------
  // Bind
  // -----------------------------
  function bind() {
    ['darrius:chartUpdated', 'chartUpdated', 'chart:updated'].forEach(e =>
      window.addEventListener(e, () => safe(render), { passive: true })
    );

    render();
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      render();
      const { snap } = getSnapshotWithHint();
      if (snap || tries >= 20) clearInterval(timer);
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }
})();
