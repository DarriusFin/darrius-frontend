/* ================================
 * Market Pulse + Risk Copilot FIX CORE
 * Drop-in patch (UI-only, no API calls)
 * ================================ */
(() => {
  'use strict';

  // ---------- no-throw ----------
  function safe(fn, fallback = null) {
    try { return fn(); } catch (e) { return fallback; }
  }

  // ---------- DOM (adjust selectors if yours differ) ----------
  const $ = (sel) => document.querySelector(sel);

  // 你左侧三个模块里一般会有这些占位节点：
  // 你需要让这些 selector 对上你实际 HTML（如果不同，告诉我你页面结构，我再给你对齐版）
  const dom = {
    // Market Pulse
    sentimentRingText: $('#mp-sentiment-text') || $('#market-pulse .sentiment .value') || $('#marketPulseSentimentText'),
    bullish: $('#mp-bullish') || $('#market-pulse .mp-bullish .v'),
    bearish: $('#mp-bearish') || $('#market-pulse .mp-bearish .v'),
    neutral: $('#mp-neutral') || $('#market-pulse .mp-neutral .v'),
    netInflow: $('#mp-netinflow') || $('#market-pulse .mp-netinflow .v'),
    mpNote: $('#mp-note') || $('#market-pulse .note'),

    // Risk Copilot
    rcEntry: $('#rc-entry') || $('#risk-copilot .rc-entry .v'),
    rcStop: $('#rc-stop') || $('#risk-copilot .rc-stop .v'),
    rcTargets: $('#rc-targets') || $('#risk-copilot .rc-targets .v'),
    rcConfidence: $('#rc-confidence') || $('#risk-copilot .rc-confidence .v'),
    rcBacktest: $('#rc-backtest') || $('#risk-copilot .rc-backtest .v'),

    // Waiting / status
    waitingBox: $('#mp-waiting') || $('#market-pulse-waiting') || $('#market-pulse .waiting'),
    waitingText: $('#mp-waiting-text') || $('#market-pulse .waiting .t'),
  };

  // ---------- helpers ----------
  const fmt = (n, digits = 2) => (Number.isFinite(n) ? n.toFixed(digits) : '—');
  const pct = (n, digits = 1) => (Number.isFinite(n) ? (n * 100).toFixed(digits) + '%' : '—');

  // ---------- Snapshot Normalizer (兼容多种 schema) ----------
  function getSnapshot() {
    // 1) preferred: DarriusChart.getSnapshot()
    const s1 = safe(() => window.DarriusChart && window.DarriusChart.getSnapshot && window.DarriusChart.getSnapshot(), null);
    if (s1) return normalizeSnapshot(s1);

    // 2) fallback: window.__DARRIUS_CHART_STATE__
    const s2 = safe(() => window.__DARRIUS_CHART_STATE__, null);
    if (s2) return normalizeSnapshot(s2);

    // 3) last fallback: window.__CHART_SNAPSHOT__ (有些人会这么叫)
    const s3 = safe(() => window.__CHART_SNAPSHOT__, null);
    if (s3) return normalizeSnapshot(s3);

    return null;
  }

  function normalizeSnapshot(raw) {
    // candles: 兼容 {candles:[{t,o,h,l,c,v}]} / {ohlcv:[]} / {bars:[]}
    const candles =
      raw.candles || raw.ohlcv || raw.bars ||
      safe(() => raw.data && (raw.data.candles || raw.data.ohlcv || raw.data.bars), null) ||
      [];

    // 统一 candles 格式：{t,o,h,l,c,v}
    const normCandles = Array.isArray(candles) ? candles.map(b => ({
      t: b.t ?? b.time ?? b.ts ?? b.timestamp,
      o: + (b.o ?? b.open),
      h: + (b.h ?? b.high),
      l: + (b.l ?? b.low),
      c: + (b.c ?? b.close),
      v: + (b.v ?? b.volume ?? 0),
    })).filter(b => Number.isFinite(b.c) && Number.isFinite(b.o) && Number.isFinite(b.h) && Number.isFinite(b.l)) : [];

    const symbol = raw.symbol || safe(() => raw.meta && raw.meta.symbol, null) || raw.ticker || '—';
    const tf = raw.timeframe || raw.tf || safe(() => raw.meta && (raw.meta.tf || raw.meta.timeframe), null) || '—';

    // EMA / AUX series（如果你有）
    const ema = raw.ema || safe(() => raw.series && raw.series.ema, null) || null;
    const aux = raw.aux || safe(() => raw.series && raw.series.aux, null) || null;

    // last price
    const last = normCandles.length ? normCandles[normCandles.length - 1].c : (raw.lastPrice ?? raw.last ?? NaN);

    return { symbol, timeframe: tf, candles: normCandles, ema, aux, lastPrice: last, raw };
  }

  // ---------- Compute: Market Pulse ----------
  function computeMarketPulse(snap) {
    const c = snap.candles;
    if (!c || c.length < 30) return null;

    const last = c[c.length - 1];
    const prev = c[c.length - 2];
    const close = last.c;
    const ret1 = (close - prev.c) / (prev.c || close);

    // 20-bar momentum
    const i20 = c.length - 21;
    const ret20 = i20 >= 0 ? (close - c[i20].c) / (c[i20].c || close) : NaN;

    // 简易“趋势强度”：最近 20 根收盘线性回归斜率（归一化）
    const n = 20;
    const seg = c.slice(-n);
    let sx=0, sy=0, sxx=0, sxy=0;
    for (let i=0;i<seg.length;i++){
      const x=i, y=seg[i].c;
      sx+=x; sy+=y; sxx+=x*x; sxy+=x*y;
    }
    const denom = (n*sxx - sx*sx) || 1;
    const slope = (n*sxy - sx*sy) / denom;
    const slopeN = slope / (close || 1); // 归一化

    // “量能净流入”近似：涨K量 - 跌K量（20根）
    let upV=0, dnV=0;
    for (let i=c.length-n;i<c.length;i++){
      const b=c[i]; if(!b) continue;
      if (b.c >= b.o) upV += (b.v||0); else dnV += (b.v||0);
    }
    const netInflow = upV - dnV;

    // 情绪打分：趋势斜率 + 20bar动量 + 1bar动量
    // （注意：这是 UI 派生指标，不是你的核心算法信号）
    const score = (slopeN*200) + (ret20*80) + (ret1*40); // 经验权重
    let label = 'Neutral';
    if (score > 3) label = 'Bullish';
    else if (score < -3) label = 'Bearish';

    // Bull/Bear/Neutral 三档显示值（这里给“强度条”式的百分比）
    const bull = Math.max(0, Math.min(1, (score + 10) / 20));
    const bear = Math.max(0, Math.min(1, (10 - score) / 20));
    const neu  = 1 - Math.min(1, Math.abs(score) / 10);

    return {
      label,
      bull, bear, neu,
      netInflow,
      note: `Derived from main chart: slope=${pct(slopeN,2)} mom20=${pct(ret20,1)}`,
    };
  }

  // ---------- Compute: Risk Copilot (保守、可解释、只依赖K线) ----------
  function computeRiskCopilot(snap) {
    const c = snap.candles;
    if (!c || c.length < 30) return null;

    const last = c[c.length - 1];
    const close = last.c;

    // ATR(14)
    const len = 14;
    let trs = [];
    for (let i=c.length-len;i<c.length;i++){
      const b=c[i], p=c[i-1];
      if(!b||!p) continue;
      const tr = Math.max(
        b.h - b.l,
        Math.abs(b.h - p.c),
        Math.abs(b.l - p.c)
      );
      trs.push(tr);
    }
    const atr = trs.length ? trs.reduce((a,b)=>a+b,0)/trs.length : NaN;

    // entry：当前价（或你也可改成上一根收盘）
    const entry = close;

    // stop：1.5 * ATR
    const stop = Number.isFinite(atr) ? (entry - 1.5 * atr) : NaN;

    // targets：1R / 2R（保守）
    const r = Number.isFinite(stop) ? (entry - stop) : NaN;
    const t1 = Number.isFinite(r) ? (entry + 1.0 * r) : NaN;
    const t2 = Number.isFinite(r) ? (entry + 2.0 * r) : NaN;

    // confidence：用“趋势一致性”粗估（最近20根上涨占比）
    const n=20;
    let up=0;
    for (let i=c.length-n;i<c.length;i++){
      const b=c[i]; if(!b) continue;
      if (b.c >= b.o) up++;
    }
    const conf = up / n;

    // backtest winrate：这里不要伪造回测，给 NA 或 derived
    const backtest = '—';

    return {
      entry, stop,
      targets: [t1, t2],
      confidence: conf,
      backtest,
    };
  }

  // ---------- Render ----------
  function renderAll() {
    const snap = getSnapshot();

    if (!snap || !snap.candles || snap.candles.length < 5) {
      // show waiting
      if (dom.waitingBox) dom.waitingBox.style.display = '';
      if (dom.waitingText) dom.waitingText.textContent = 'Waiting for main chart snapshot...';
      return;
    }

    // hide waiting
    if (dom.waitingBox) dom.waitingBox.style.display = 'none';

    const mp = computeMarketPulse(snap);
    const rc = computeRiskCopilot(snap);

    // Market Pulse
    if (mp) {
      if (dom.sentimentRingText) dom.sentimentRingText.textContent = mp.label;
      if (dom.bullish) dom.bullish.textContent = pct(mp.bull, 0);
      if (dom.bearish) dom.bearish.textContent = pct(mp.bear, 0);
      if (dom.neutral) dom.neutral.textContent = pct(mp.neu, 0);
      if (dom.netInflow) dom.netInflow.textContent = Number.isFinite(mp.netInflow) ? (Math.round(mp.netInflow)).toLocaleString() : '—';
      if (dom.mpNote) dom.mpNote.textContent = mp.note || '';
    }

    // Risk Copilot
    if (rc) {
      if (dom.rcEntry) dom.rcEntry.textContent = fmt(rc.entry, 2);
      if (dom.rcStop) dom.rcStop.textContent = fmt(rc.stop, 2);
      if (dom.rcTargets) dom.rcTargets.textContent =
        (rc.targets && rc.targets.length)
          ? rc.targets.map(x => fmt(x, 2)).join(' / ')
          : '—';
      if (dom.rcConfidence) dom.rcConfidence.textContent = pct(rc.confidence, 0);
      if (dom.rcBacktest) dom.rcBacktest.textContent = rc.backtest || '—';
    }
  }

  // ---------- Listen: main chart updates ----------
  function bind() {
    // 1) chart.core.js should emit this event
    window.addEventListener('darrius:chartUpdated', () => safe(renderAll), { passive: true });

    // 2) also render once on load + a short retry loop (防止主图晚一点才初始化)
    renderAll();
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      renderAll();
      if (tries > 20) clearInterval(timer); // ~10s
      const s = getSnapshot();
      if (s && s.candles && s.candles.length > 10) clearInterval(timer);
    }, 500);
  }

  // DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }
})();
