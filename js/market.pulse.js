/* =========================================================================
 * market.pulse.js (LAYOUT-SAFE PATCH) v2026.02.03
 * - ZERO DOM insertion (no appendChild)
 * - ZERO container text overwrite
 * - Only replaces existing right-side value placeholders ("—" / "-")
 * - UI-only; never touches chart rendering / billing / subscription
 * ========================================================================= */
(() => {
  'use strict';

  function safe(fn, fallback = null) { try { return fn(); } catch { return fallback; } }
  const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  const pct = (n, d = 0) => (Number.isFinite(n) ? (n * 100).toFixed(d) + '%' : '—');

  // -----------------------------
  // Snapshot (prefer DarriusChart.getSnapshot, fallback __DARRIUS_CHART_STATE__)
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

  function getSnapshot() {
    const s1 = safe(() => window.DarriusChart && window.DarriusChart.getSnapshot && window.DarriusChart.getSnapshot(), null);
    const n1 = normalizeSnapshot(s1);
    if (n1) return n1;

    const s2 = safe(() => window.__DARRIUS_CHART_STATE__, null);
    const n2 = normalizeSnapshot(s2);
    if (n2) return n2;

    return null;
  }

  // -----------------------------
  // Compute values (simple derived, consistent with candles)
  // -----------------------------
  function computeMarketPulse(candles) {
    if (!candles || candles.length < 30) return null;

    const n = 20;
    const seg = candles.slice(-n);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    const ret1 = (last.c - prev.c) / (prev.c || last.c);
    const ret20 = (last.c - seg[0].c) / (seg[0].c || last.c);

    // slope (normalized) on last 20 closes
    let sx=0, sy=0, sxx=0, sxy=0;
    for (let i=0;i<seg.length;i++){
      const x=i, y=seg[i].c;
      sx+=x; sy+=y; sxx+=x*x; sxy+=x*y;
    }
    const denom = (n*sxx - sx*sx) || 1;
    const slope = (n*sxy - sx*sy) / denom;
    const slopeN = slope / (last.c || 1);

    // net inflow approx: upV - downV
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
  // Layout-safe DOM mapping:
  // find a label element inside LEFT sidebar and replace its row's value element only
  // -----------------------------
  function findLeftSidebarRoot() {
    // pick the most likely left sidebar container (narrow column on the left)
    const candidates = Array.from(document.querySelectorAll('aside, .left, .sidebar, .sidebar-left, #left, #left-panel, .panel-left, .side'));
    // choose smallest width > 150
    let best = null;
    for (const el of candidates) {
      const w = el.getBoundingClientRect ? el.getBoundingClientRect().width : 0;
      if (w < 150 || w > 450) continue;
      if (!best || w < best.w) best = { el, w };
    }
    return best ? best.el : document.body;
  }

  function findRowValueEl(labelEl) {
    if (!labelEl) return null;

    // Row container: nearest div (or li) that likely holds "label + value"
    const row = labelEl.closest('div') || labelEl.closest('li') || labelEl.parentElement;
    if (!row) return null;

    // In that row, find a value node that is NOT the labelEl and looks like placeholder
    const nodes = Array.from(row.querySelectorAll('span,div'));
    // Prefer exact placeholder
    let val = nodes.find(n => n !== labelEl && ['—','-','--',''].includes((n.textContent||'').trim()));
    if (val) return val;

    // Fallback: rightmost short text node
    val = nodes.reverse().find(n => n !== labelEl && (n.textContent||'').trim().length <= 12);
    return val || null;
  }

  function setValueByLabel(sidebarRoot, labelKeywords, valueText) {
    const all = Array.from(sidebarRoot.querySelectorAll('span,div'));
    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (!t) continue;

      // match: exact or includes
      if (!labelKeywords.some(k => t === k || t.includes(k))) continue;

      const valEl = findRowValueEl(el);
      if (valEl) {
        valEl.textContent = valueText;
        return true;
      }
    }
    return false;
  }

  function setSentimentCenterText(sidebarRoot, valueText) {
    // Center text often is a single "—" inside the ring area; safer: find "Sentiment" label row first
    const ok = setValueByLabel(sidebarRoot, ['Sentiment'], valueText);
    if (ok) return true;

    // fallback: find the biggest ring container and then find a child with placeholder "—"
    const rings = Array.from(sidebarRoot.querySelectorAll('div')).filter(d => {
      const r = d.getBoundingClientRect ? d.getBoundingClientRect() : { width: 0, height: 0 };
      return r.width >= 80 && r.height >= 80 && r.width <= 220 && r.height <= 220;
    });
    const ring = rings[0];
    if (!ring) return false;
    const kids = Array.from(ring.querySelectorAll('span,div'));
    const target = kids.find(k => (k.textContent || '').trim() === '—');
    if (target) { target.textContent = valueText; return true; }
    return false;
  }

  function updateWaiting(sidebarRoot, text) {
    // ONLY update the line that contains "Waiting for confirmation" (don’t touch the container)
    const nodes = Array.from(sidebarRoot.querySelectorAll('div,span'));
    const line = nodes.find(n => {
      const t = (n.textContent || '');
      return t.includes('Waiting for confirmation') || t.includes('Waiting for') || t.includes('等待确认');
    });
    if (line) line.textContent = text;
  }

  // -----------------------------
  // Render
  // -----------------------------
  function render() {
    const sidebar = findLeftSidebarRoot();
    const snap = getSnapshot();

    if (!snap) {
      updateWaiting(sidebar, 'Waiting for confirmation... (no snapshot exposed)');
      // keep placeholders as-is
      return;
    }

    const mp = computeMarketPulse(snap.candles);
    const rc = computeRiskCopilot(snap.candles);

    updateWaiting(sidebar, `Ready: ${snap.symbol} ${snap.timeframe}  Last ${fmt(snap.lastPrice,2)}`);

    // Market Pulse
    if (mp) {
      setSentimentCenterText(sidebar, mp.label);
      setValueByLabel(sidebar, ['Bullish'], pct(mp.bull, 0));
      setValueByLabel(sidebar, ['Bearish'], pct(mp.bear, 0));
      setValueByLabel(sidebar, ['Neutral'], pct(mp.neu, 0));
      setValueByLabel(sidebar, ['Net Inflow'], Number.isFinite(mp.netInflow) ? Math.round(mp.netInflow).toLocaleString() : '—');
    }

    // Risk Copilot
    if (rc) {
      setValueByLabel(sidebar, ['Entry', '入场'], fmt(rc.entry, 2));
      setValueByLabel(sidebar, ['Stop', '止损'], fmt(rc.stop, 2));
      setValueByLabel(sidebar, ['Targets', '目标'], `${fmt(rc.t1, 2)} / ${fmt(rc.t2, 2)}`);
      setValueByLabel(sidebar, ['Confidence', '强度'], pct(rc.confidence, 0));
      // Backtest row leave as —
    }
  }

  // -----------------------------
  // Bind
  // -----------------------------
  function bind() {
    const evs = ['darrius:chartUpdated', 'chartUpdated', 'chart:updated'];
    evs.forEach(e => window.addEventListener(e, () => safe(render), { passive: true }));

    render();
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      render();
      const snap = getSnapshot();
      if (snap || tries >= 20) clearInterval(timer);
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }
})();
