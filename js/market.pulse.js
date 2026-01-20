/* =========================================================================
 * DarriusAI - market.pulse.js (UI LAYER) v2026.01.19-MP-ONLY
 *
 * Role:
 *  - Read snapshot from window.__DARRIUS_CHART_STATE__ (derived-only)
 *  - Render Market Pulse UI (Bullish/Neutral/Bearish + ring strength)
 *  - Must NEVER throw and must NEVER affect main chart
 *
 * Hard Rules:
 *  1) If EMA trend is Up (green regime), MP cannot be Bearish (only Neutral/Bullish)
 *     If EMA trend is Down (red regime), MP cannot be Bullish (only Neutral/Bearish)
 *  2) If recent confirmed B appears within confirm window (or recent bars), MP must bias bullish (no contradiction)
 *     Same for S -> bearish bias (no contradiction)
 *  3) If AUX is flat/unclear slope, ring strength must shrink (uncertainty = low participation)
 * ========================================================================= */

(() => {
  "use strict";

  const DIAG = (window.__DARRIUS_DIAG__ = window.__DARRIUS_DIAG__ || {});
  DIAG.mp = DIAG.mp || { lastError: null, lastRender: null };

  function safeRun(tag, fn) {
    try {
      return fn();
    } catch (e) {
      DIAG.mp.lastError = { tag, message: String(e?.message || e), stack: String(e?.stack || "") };
      return undefined;
    }
  }

  const $ = (id) => document.getElementById(id);
  const qs = (sel) => document.querySelector(sel);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

  // ---- Tunables (kept stable) ----
  const MP_N = 60;
  const L1 = 12;
  const TH = 0.20;

  const M = 12;
  const TAU = 6;
  const RECENT_SIG_MAXDIST = 8;

  const RANGE_K = 1.5;
  const AUX_C1 = 0.35;
  const FLIP_DEN = 0.35;
  const AUX_FLAT_ENERGY_TH = 0.15;
  const FLAT_SHRINK = 0.55;

  function mean(arr) {
    if (!arr.length) return NaN;
    let s = 0;
    for (const x of arr) s += x;
    return s / arr.length;
  }

  function computePulse(snapshot) {
    const bars = snapshot?.bars || [];
    const ema = snapshot?.ema || [];
    const aux = snapshot?.aux || [];
    const sigs = snapshot?.sigs || [];

    const nAll = bars.length;
    if (nAll < 10 || ema.length !== nAll || aux.length !== nAll) {
      return { side: "Neutral", strength: 0, TR_dir: 0, meta: { reason: "insufficient" } };
    }

    const N = Math.min(MP_N, nAll);
    const start = nAll - N;

    const sliceBars = bars.slice(start);
    const sliceEMA = ema.slice(start);
    const sliceAUX = aux.slice(start);

    // avg range
    const L2 = Math.min(20, sliceBars.length);
    const ranges = [];
    for (let i = sliceBars.length - L2; i < sliceBars.length; i++) {
      const b = sliceBars[i];
      ranges.push(Math.max(0, (b.high - b.low)));
    }
    const rangeAvg = Math.max(1e-9, mean(ranges));

    // Trend Regime (EMA slope voting + dist to EMA)
    const l1 = Math.min(L1, sliceEMA.length - 1);
    let upCnt = 0, dnCnt = 0;
    for (let i = sliceEMA.length - l1; i < sliceEMA.length; i++) {
      const e0 = sliceEMA[i - 1], e1 = sliceEMA[i];
      if (!Number.isFinite(e0) || !Number.isFinite(e1)) continue;
      const s = e1 - e0;
      if (s > 0) upCnt++;
      else if (s < 0) dnCnt++;
    }
    const denom = Math.max(1, l1);
    const upRatio = upCnt / denom;
    const dnRatio = dnCnt / denom;

    let TR_dir = 0;
    if (upRatio >= 0.67) TR_dir = +1;
    else if (dnRatio >= 0.67) TR_dir = -1;

    const lastClose = sliceBars[sliceBars.length - 1].close;
    const lastEMA = sliceEMA[sliceEMA.length - 1];
    const dist = (Number.isFinite(lastClose) && Number.isFinite(lastEMA)) ? (lastClose - lastEMA) : 0;
    const distNorm = clamp(dist / (rangeAvg * RANGE_K), -1, +1);

    let TR = clamp(0.6 * TR_dir + 0.4 * distNorm, -1, +1);

    // Inflection Bias from recent confirmed signals
    // build time->idx within snapshot bars
    const timeToIdx = new Map(bars.map((b, i) => [String(b.time), i]));

    const lookback = Math.min(M, nAll);
    const sigStartIdx = nAll - lookback;

    let Bscore = 0, Sscore = 0;
    let recentSig = null;

    for (let k = sigs.length - 1; k >= 0; k--) {
      const s = sigs[k];
      const idx = timeToIdx.get(String(s.time));
      if (idx == null) continue;
      if (idx < sigStartIdx) break;

      const d = (nAll - 1) - idx;
      const w = Math.exp(-d / TAU);

      if (s.side === "B") Bscore += w;
      else if (s.side === "S") Sscore += w;

      if (!recentSig || d < recentSig.dist) recentSig = { side: s.side, dist: d };
    }

    let IB_raw = 0;
    const denom2 = (Bscore + Sscore);
    if (denom2 > 1e-9) IB_raw = (Bscore - Sscore) / (denom2 + 1e-9);

    let IB = IB_raw;
    // damp counter-trend
    if (TR_dir === +1 && IB_raw < 0) IB = 0.5 * IB_raw;
    if (TR_dir === -1 && IB_raw > 0) IB = 0.5 * IB_raw;
    IB = clamp(IB, -1, +1);

    // Stability (AUX energy + flip stability + EMA flip stability)
    const L3 = Math.min(20, sliceAUX.length - 1);
    let auxAbsSum = 0, auxAbsCnt = 0, auxFlip = 0, prevAuxS = 0;

    for (let i = sliceAUX.length - L3; i < sliceAUX.length; i++) {
      const a0 = sliceAUX[i - 1], a1 = sliceAUX[i];
      if (!Number.isFinite(a0) || !Number.isFinite(a1)) continue;
      const s = a1 - a0;
      auxAbsSum += Math.abs(s);
      auxAbsCnt++;
      const ss = sign(s);
      if (i === sliceAUX.length - L3) prevAuxS = ss;
      else {
        if (ss !== 0 && prevAuxS !== 0 && ss !== prevAuxS) auxFlip++;
        if (ss !== 0) prevAuxS = ss;
      }
    }

    const auxAbs = auxAbsCnt ? (auxAbsSum / auxAbsCnt) : 0;
    const auxFlipRate = L3 > 1 ? (auxFlip / (L3 - 1)) : 0;
    const auxEnergy = clamp(auxAbs / (rangeAvg * AUX_C1), 0, 1);
    const auxStab = 1 - clamp(auxFlipRate / FLIP_DEN, 0, 1);
    const ST_aux = clamp(0.5 * auxEnergy + 0.5 * auxStab, 0, 1);

    const L4 = Math.min(20, sliceEMA.length - 1);
    let emaFlip = 0, prevE = 0;
    for (let i = sliceEMA.length - L4; i < sliceEMA.length; i++) {
      const e0 = sliceEMA[i - 1], e1 = sliceEMA[i];
      if (!Number.isFinite(e0) || !Number.isFinite(e1)) continue;
      const s = sign(e1 - e0);
      if (i === sliceEMA.length - L4) prevE = s;
      else {
        if (s !== 0 && prevE !== 0 && s !== prevE) emaFlip++;
        if (s !== 0) prevE = s;
      }
    }
    const emaFlipRate = L4 > 1 ? (emaFlip / (L4 - 1)) : 0;
    const ST_ema = 1 - clamp(emaFlipRate / FLIP_DEN, 0, 1);

    const ST = clamp(0.6 * ST_aux + 0.4 * ST_ema, 0, 1);

    // Side + Strength
    const absTR = Math.abs(TR);
    const agree = 1 - 0.5 * Math.abs(sign(TR) - sign(IB)); // 1,0.5,0

    let strength = 100 * clamp(0.55 * absTR + 0.25 * agree + 0.20 * ST, 0, 1);

    // Rule 3: AUX flat => shrink
    if (auxEnergy < AUX_FLAT_ENERGY_TH) strength *= FLAT_SHRINK;
    strength = clamp(strength, 0, 100);

    // Direction score
    let D = 0.7 * TR + 0.3 * IB;

    let side = "Neutral";
    if (D >= TH) side = "Bullish";
    else if (D <= -TH) side = "Bearish";

    // Rule 1: no contradiction with EMA regime
    if (TR_dir === +1 && side === "Bearish") side = "Neutral";
    if (TR_dir === -1 && side === "Bullish") side = "Neutral";

    // Rule 2: recent signal must bias (no contradiction)
    if (recentSig && recentSig.dist <= RECENT_SIG_MAXDIST) {
      if (recentSig.side === "B" && side === "Bearish") side = "Neutral";
      if (recentSig.side === "S" && side === "Bullish") side = "Neutral";

      // If EMA regime is neutral and we saw a recent signal, nudge the side to that signal
      if (side === "Neutral" && TR_dir === 0) {
        side = (recentSig.side === "B") ? "Bullish" : "Bearish";
      }
    }

    return {
      side,
      strength,
      TR_dir,
      meta: { TR, IB, ST, auxEnergy, agree, recentSig },
    };
  }

  // ---- UI bindings (safe, best-effort) ----
  function renderUI(mp, snapshot) {
    safeRun("renderUI", () => {
      // Try flexible selectors; you can later lock them down to exact ids
      const labelEl =
        $("marketPulseLabel") ||
        $("mpLabel") ||
        qs("[data-mp-label]") ||
        qs(".mp-label") ||
        qs("#marketPulse .label");

      const ringEl =
        $("marketPulseRing") ||
        $("mpRing") ||
        qs("[data-mp-ring]") ||
        qs(".mp-ring") ||
        qs("#marketPulse .ring");

      const valEl =
        $("marketPulseValue") ||
        $("mpValue") ||
        qs("[data-mp-value]") ||
        qs(".mp-value");

      if (labelEl) labelEl.textContent = mp.side;
      if (valEl) valEl.textContent = `${Math.round(mp.strength)}%`;

      if (ringEl) {
        const pct = clamp(mp.strength, 0, 100);
        const deg = pct * 3.6;
        const mainColor =
          mp.side === "Bullish" ? "rgba(43,226,166,1)" :
          mp.side === "Bearish" ? "rgba(255,90,90,1)" :
          "rgba(180,195,210,1)";

        ringEl.style.background =
          `conic-gradient(${mainColor} 0deg ${deg}deg, rgba(255,255,255,0.10) ${deg}deg 360deg)`;
        ringEl.style.borderRadius = "999px";
        ringEl.style.boxShadow =
          mp.side === "Bullish" ? "0 0 18px rgba(43,226,166,0.25)" :
          mp.side === "Bearish" ? "0 0 18px rgba(255,90,90,0.25)" :
          "0 0 18px rgba(200,210,220,0.18)";
      }

      // Optional: if you have a small debug line area
      const dbg = $("mpDebug") || qs("[data-mp-debug]");
      if (dbg) {
        const sym = snapshot?.symbol || "";
        const tf = snapshot?.tf || "";
        dbg.textContent = `${sym} ${tf} · ${mp.side} ${Math.round(mp.strength)}%`;
      }

      DIAG.mp.lastRender = { at: Date.now(), side: mp.side, strength: mp.strength, symbol: snapshot?.symbol, tf: snapshot?.tf };
    });
  }

  function onSnapshot(snapshot) {
    safeRun("onSnapshot", () => {
      const mp = computePulse(snapshot);
      renderUI(mp, snapshot);
    });
  }

  // ---- Wiring: event first, fallback polling ----
  safeRun("wire", () => {
    window.addEventListener("darrius:chartUpdated", (e) => {
      onSnapshot(e?.detail);
    });

    // If chart already loaded before this script, render once
    if (window.__DARRIUS_CHART_STATE__) {
      onSnapshot(window.__DARRIUS_CHART_STATE__);
    }

    // Fallback polling (lightweight) in case events are blocked
    let lastTs = 0;
    setInterval(() => {
      safeRun("poll", () => {
        const s = window.__DARRIUS_CHART_STATE__;
        const ts = Number(s?.ts || 0);
        if (ts && ts !== lastTs) {
          lastTs = ts;
          onSnapshot(s);
        }
      });
    }, 1000);
  });
})();
