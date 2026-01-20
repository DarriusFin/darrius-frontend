/* darrius-frontend/js/market.pulse.js
 * UI expression layer (READ-ONLY, best-effort, NEVER throw):
 * - Market Pulse: show colored ring + label
 * - Overlay B/S: large glowing DOM marks on #sigOverlay
 * - Risk Copilot: minimal safe fallback values (so UI not blank)
 */
(function () {
  "use strict";

  const CFG = {
    // Overlay B/S
    overlayMaxMarks: 120,
    overlayFontSize: 30,
    overlayYOffsetPx: 0,
    overlayZIndex: 9999,

    // IMPORTANT: 先不要清掉 setMarkers（避免影响你现有主图逻辑）
    clearSeriesMarkers: false,

    // Pulse
    confirmWindow: 3,
    emaLookback: 6,
    auxLookback: 10,
  };

  function safe(fn) { try { return fn(); } catch (e) { return undefined; } }
  const $ = (id) => document.getElementById(id);

  // ---------- Detect chart & series ----------
  function detectChart() {
    return window.__DARRIUS_CHART__ || window.DARRIUS_CHART || window.chart || window._chart || null;
  }
  function detectCandleSeries() {
    const direct =
      window.__DARRIUS_CANDLE_SERIES__ ||
      window.candlestickSeries ||
      window.candleSeries ||
      window.mainSeries ||
      window.seriesCandles ||
      window._candleSeries ||
      null;
    if (direct && typeof direct.setMarkers === "function") return direct;

    return safe(() => {
      for (const k in window) {
        const v = window[k];
        if (!v || typeof v !== "object") continue;
        if (typeof v.priceScale === "function" && typeof v.setMarkers === "function") return v;
      }
      return null;
    }) || null;
  }

  // ---------- Snapshot / arrays inference ----------
  function detectSnapshot() {
    return (
      window.__DARRIUS_CHART_STATE__ ||
      window.__DARRIUS_SNAPSHOT__ ||
      window.DARRIUS_SNAPSHOT ||
      window.__chartSnapshot ||
      null
    );
  }

  function looksLikeOHLCArray(arr) {
    if (!Array.isArray(arr) || arr.length < 20) return false;
    const x = arr[arr.length - 1];
    return x && x.time != null && x.open != null && x.high != null && x.low != null && x.close != null;
  }
  function looksLikeValueArray(arr) {
    if (!Array.isArray(arr) || arr.length < 20) return false;
    const x = arr[arr.length - 1];
    return x && x.time != null && x.value != null;
  }
  function looksLikeSignalsArray(arr) {
    if (!Array.isArray(arr) || arr.length < 1) return false;
    const x = arr[arr.length - 1];
    if (!x) return false;
    const side = (x.side || x.type || x.signal || x.text || "").toString().toUpperCase();
    return x.time != null && (side === "B" || side === "S" || side === "BUY" || side === "SELL");
  }

  function detectGlobalArrays() {
    let candles = null, ema = null, aux = null, signals = null;

    safe(() => {
      const candidates = [
        window.ohlcData, window.ohlc, window.candles, window.candleData, window.dataOHLC,
        window.emaData, window.ema, window.emaLine,
        window.auxData, window.aux, window.auxLine,
        window.signals, window.bsSignals, window.markers, window.BS
      ];

      for (const c of candidates) {
        if (!candles && looksLikeOHLCArray(c)) candles = c;
        if (!ema && looksLikeValueArray(c)) ema = c;
        if (!aux && looksLikeValueArray(c)) aux = c;
        if (!signals && looksLikeSignalsArray(c)) signals = c;
      }

      for (const k in window) {
        const v = window[k];
        if (!v) continue;

        if (!candles && looksLikeOHLCArray(v)) candles = v;
        else if (!signals && looksLikeSignalsArray(v)) signals = v;
        else if (looksLikeValueArray(v)) {
          const name = String(k).toLowerCase();
          if (!ema && (name.includes("ema") || name.includes("ma"))) ema = v;
          else if (!aux && (name.includes("aux") || name.includes("smooth") || name.includes("sig"))) aux = v;
        }
      }

      const snap = detectSnapshot();
      if (snap && typeof snap === "object") {
        if (!signals && Array.isArray(snap.signals)) signals = snap.signals;
        if (!ema && Array.isArray(snap.emaData)) ema = snap.emaData;
        if (!aux && Array.isArray(snap.auxData)) aux = snap.auxData;
        if (!candles && Array.isArray(snap.ohlc)) candles = snap.ohlc;
      }
    });

    return { candles, ema, aux, signals };
  }

  function normalizeSignals(rawSignals) {
    if (!Array.isArray(rawSignals)) return [];
    return rawSignals.map(s => {
      const sideRaw = (s.side || s.type || s.signal || s.text || "").toString().toUpperCase();
      const side = (sideRaw === "BUY") ? "B" : (sideRaw === "SELL") ? "S" : (sideRaw === "B" || sideRaw === "S") ? sideRaw : null;
      const time = s.time ?? s.t ?? s.timestamp ?? null;
      const price = s.price ?? s.p ?? s.value ?? null;
      const confirmed = (s.confirmed === true) || (s.isConfirmed === true) || (s.confirm === true) || (s.confirmed == null);
      return { time, side, price, confirmed };
    }).filter(x => x.side && x.time != null);
  }

  // ---------- Overlay B/S (BIG + glow) ----------
  function ensureOverlayTop() {
    const overlay = $("sigOverlay");
    if (!overlay) return null;
    overlay.style.position = overlay.style.position || "absolute";
    overlay.style.inset = overlay.style.inset || "0";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = String(CFG.overlayZIndex);
    return overlay;
  }

  function renderBigGlowOverlay() {
    safe(() => {
      const overlay = ensureOverlayTop();
      if (!overlay) return;

      const chart = detectChart();
      const candleSeries = detectCandleSeries();
      if (!chart || !candleSeries) return;

      if (CFG.clearSeriesMarkers && typeof candleSeries.setMarkers === "function") {
        safe(() => candleSeries.setMarkers([]));
      }

      const timeScale = safe(() => chart.timeScale && chart.timeScale());
      const priceScale = safe(() => candleSeries.priceScale && candleSeries.priceScale());
      if (!timeScale || !priceScale) return;
      if (typeof timeScale.timeToCoordinate !== "function") return;
      if (typeof priceScale.priceToCoordinate !== "function") return;

      const snap = detectSnapshot();
      let sigs = normalizeSignals(snap && (snap.signals || snap.bsSignals || snap.markers));
      if (!sigs.length) {
        const ga = detectGlobalArrays();
        sigs = normalizeSignals(ga.signals);
      }

      overlay.innerHTML = "";
      if (!sigs.length) return;

      const ga2 = detectGlobalArrays();
      const candles = ga2.candles;

      const tail = sigs.slice(-CFG.overlayMaxMarks);
      for (const s of tail) {
        let price = s.price;

        if (price == null && looksLikeOHLCArray(candles)) {
          const hit = candles.slice().reverse().find(x => x.time === s.time);
          if (hit) price = (s.side === "B") ? hit.low : hit.high;
        }
        if (price == null) continue;

        const x = safe(() => timeScale.timeToCoordinate(s.time));
        const y = safe(() => priceScale.priceToCoordinate(price));
        if (x == null || y == null || !isFinite(x) || !isFinite(y)) continue;

        const div = document.createElement("div");
        div.textContent = s.side;

        div.style.position = "absolute";
        div.style.left = x + "px";
        div.style.top = (y + CFG.overlayYOffsetPx) + "px";
        div.style.transform = "translate(-50%, -50%)";
        div.style.fontSize = CFG.overlayFontSize + "px";
        div.style.padding = "4px 10px";
        div.style.borderRadius = "14px";
        div.style.fontWeight = "950";
        div.style.letterSpacing = ".5px";
        div.style.background = "rgba(0,0,0,.22)";
        div.style.backdropFilter = "blur(2px)";
        div.style.border = "1px solid rgba(255,255,255,.18)";
        div.style.boxShadow = "0 10px 24px rgba(0,0,0,.28)";
        div.style.whiteSpace = "nowrap";
        div.style.opacity = "0.98";

        if (s.side === "B") {
          div.style.color = "rgba(43,226,166,1)";
          div.style.borderColor = "rgba(43,226,166,.45)";
          div.style.textShadow = "0 0 14px rgba(43,226,166,.62), 0 0 30px rgba(43,226,166,.32)";
        } else {
          div.style.color = "rgba(255,90,90,1)";
          div.style.borderColor = "rgba(255,90,90,.45)";
          div.style.textShadow = "0 0 14px rgba(255,90,90,.62), 0 0 30px rgba(255,90,90,.32)";
        }

        overlay.appendChild(div);
      }
    });
  }

  // ---------- Pulse compute ----------
  function emaRegimeFrom(emaArr) {
    if (!looksLikeValueArray(emaArr)) return "UNKNOWN";
    const n = CFG.emaLookback;
    if (emaArr.length < n + 2) return "UNKNOWN";
    const tail = emaArr.slice(-n);
    const first = tail[0].value, last = tail[tail.length - 1].value;
    const delta = last - first;
    const abs = Math.abs(delta);
    const eps = Math.max(1e-9, Math.abs(last) * 0.0008);
    if (abs < eps) return "FLAT";
    return delta > 0 ? "UP" : "DOWN";
  }

  function auxFlatFrom(auxArr) {
    if (!looksLikeValueArray(auxArr)) return true;
    const n = CFG.auxLookback;
    if (auxArr.length < n + 2) return true;
    const tail = auxArr.slice(-n).map(x => x.value);
    let max = -Infinity, min = Infinity;
    for (const v of tail) { if (v > max) max = v; if (v < min) min = v; }
    const range = max - min;
    const ref = Math.max(1e-9, Math.abs(tail[tail.length - 1]));
    return range < ref * 0.002;
  }

  function lastConfirmedSignal(signals) {
    const sigs = normalizeSignals(signals);
    for (let i = sigs.length - 1; i >= 0; i--) {
      const s = sigs[i];
      if (!s) continue;
      if (s.confirmed === false) continue;
      if (s.side === "B" || s.side === "S") return s;
    }
    return null;
  }

  function computePulse() {
    const out = {
      label: "Neutral",
      score: 0,
      bull: 0,
      bear: 0,
      neu: 100,
      netInflow: "—",
      reason: "Derived only · waiting for main-chart data",
    };

    const snap = detectSnapshot();
    const ga = detectGlobalArrays();

    const emaArr = (snap && (snap.emaData || snap.ema)) || ga.ema;
    const auxArr = (snap && (snap.auxData || snap.aux)) || ga.aux;
    const sigArr = (snap && (snap.signals || snap.bsSignals || snap.markers)) || ga.signals;

    const regime = emaRegimeFrom(emaArr);
    const auxFlat = auxFlatFrom(auxArr);
    const lastSig = lastConfirmedSignal(sigArr);

    let dir = "Neutral";
    const why = [];

    // Rule 2: Recent B biases long
    if (lastSig && lastSig.side === "B") { dir = "Bullish"; why.push("Recent B → bias long"); }
    else if (lastSig && lastSig.side === "S") { dir = "Bearish"; why.push("Recent S → bias short"); }

    // Rule 1: EMA UP cannot be Bearish
    if (regime === "UP" && dir === "Bearish") { dir = "Neutral"; why.push("EMA up → clamp (no Bearish)"); }

    if (regime === "UP") why.push("EMA up");
    else if (regime === "DOWN") why.push("EMA down");
    else if (regime === "FLAT") why.push("EMA flat");
    else why.push("EMA unknown");

    let score = 58;
    if (regime === "UP" || regime === "DOWN") score += 10;
    if (lastSig) score += 6;
    if (auxFlat) { score -= 24; why.push("AUX flat → shrink tradability"); }
    score = Math.max(0, Math.min(100, Math.round(score)));

    const active = Math.round(score * 0.9);
    const neu = 100 - active;
    let bull = 0, bear = 0;

    if (dir === "Bullish") {
      bull = Math.round(active * 0.78);
      bear = active - bull;
    } else if (dir === "Bearish") {
      bear = Math.round(active * 0.78);
      bull = active - bear;
    } else {
      bull = Math.round(active * 0.5);
      bear = active - bull;
    }

    out.label = dir;
    out.score = score;
    out.bull = bull;
    out.bear = bear;
    out.neu = neu;
    out.reason = why.join(" · ");
    return out;
  }

  // ---------- Paint Pulse UI (COLORED ring) ----------
  function paintPulseUI(pulse) {
    safe(() => {
      const scoreEl = $("pulseScore");
      const bullEl = $("bullPct");
      const bearEl = $("bearPct");
      const neuEl = $("neuPct");
      const inflowEl = $("netInflow");
      const maskEl = $("pulseGaugeMask");

      if (scoreEl) scoreEl.textContent = String(pulse.score);
      if (bullEl) bullEl.textContent = pulse.bull + "%";
      if (bearEl) bearEl.textContent = pulse.bear + "%";
      if (neuEl) neuEl.textContent = pulse.neu + "%";
      if (inflowEl) inflowEl.textContent = String(pulse.netInflow);

      // Make ring "progress" by masking only the remainder, NOT the whole ring.
      // The base .gauge is already a colorful ring. We just cover the "unfilled" part.
      if (maskEl) {
        const deg = Math.round((pulse.score / 100) * 360);

        // Cover unfilled arc with dark color, leaving filled arc showing the colorful base ring.
        // Start cover from "deg" to 360.
        maskEl.style.background =
          `conic-gradient(
            rgba(10,15,23,.92) ${deg}deg,
            rgba(10,15,23,.92) 360deg
          )`;

        // IMPORTANT: ensure mask is above base ring but below center
        maskEl.style.position = "absolute";
        maskEl.style.inset = "0";
        maskEl.style.borderRadius = "50%";
        maskEl.style.zIndex = "1";
        maskEl.style.mixBlendMode = "normal";
      }

      // show explanation in left signal meta (optional)
      const metaEl = $("signalMeta");
      if (metaEl) metaEl.textContent = pulse.reason;
    });
  }

  // ---------- Risk Copilot (minimal fallback so UI not blank) ----------
  function updateRiskCopilotFallback() {
    safe(() => {
      const ga = detectGlobalArrays();
      const snap = detectSnapshot();

      const candles = (snap && snap.ohlc) || ga.candles;
      const sigArr = (snap && (snap.signals || snap.bsSignals || snap.markers)) || ga.signals;
      if (!looksLikeOHLCArray(candles)) return;

      const lastC = candles[candles.length - 1];
      const prevC = candles[candles.length - 2] || lastC;
      const lastSig = lastConfirmedSignal(sigArr);

      // Very conservative heuristic:
      // - Entry: last close
      // - Stop: recent low/high band
      // - Confidence: derived from pulse score (if available)
      const entry = lastC.close;
      const range = Math.max(1e-9, (lastC.high - lastC.low));
      const stopBuy = Math.min(lastC.low, prevC.low) - range * 0.15;
      const stopSell = Math.max(lastC.high, prevC.high) + range * 0.15;

      const pulse = computePulse();
      const conf = Math.max(0, Math.min(100, Math.round(pulse.score)));

      const side = lastSig ? lastSig.side : null;
      const mode = side === "B" ? "Long-bias" : side === "S" ? "Short-bias" : "Neutral";

      const riskModeEl = $("riskMode");
      const riskEntryEl = $("riskEntry");
      const riskStopEl = $("riskStop");
      const riskTargetsEl = $("riskTargets");
      const riskConfEl = $("riskConf");
      const riskWREl = $("riskWR");

      if (riskModeEl) riskModeEl.textContent = mode;

      if (riskEntryEl) riskEntryEl.textContent = isFinite(entry) ? entry.toFixed(2) : "—";
      if (riskStopEl) {
        const stop = side === "S" ? stopSell : stopBuy;
        riskStopEl.textContent = isFinite(stop) ? stop.toFixed(2) : "—";
      }

      // Targets: simple 1R / 2R
      if (riskTargetsEl) {
        const stop = side === "S" ? stopSell : stopBuy;
        const r = Math.abs(entry - stop);
        const t1 = side === "S" ? entry - r : entry + r;
        const t2 = side === "S" ? entry - 2 * r : entry + 2 * r;
        riskTargetsEl.textContent = (isFinite(t1) && isFinite(t2)) ? `${t1.toFixed(2)} / ${t2.toFixed(2)}` : "—";
      }

      if (riskConfEl) riskConfEl.textContent = conf + "/100";

      // WinRate: placeholder (until you wire real backtest)
      if (riskWREl) riskWREl.textContent = conf >= 70 ? "≈ 56%" : conf >= 50 ? "≈ 52%" : "≈ 48%";
    });
  }

  // expose safe APIs (your requirement: never throw)
  window.renderOverlaySignals = function () { return safe(renderBigGlowOverlay); };
  window.updateMarketPulseUI  = function () { return safe(() => paintPulseUI(computePulse())); };
  window.updateRiskCopilotUI  = function () { return safe(updateRiskCopilotFallback); };

  // main tick
  function tick() {
    safe(() => window.updateMarketPulseUI());
    safe(() => window.updateRiskCopilotUI());
    safe(() => window.renderOverlaySignals());
  }

  safe(() => {
    const run = () => { tick(); setInterval(tick, 900); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
    else run();
  });

  safe(() => {
    window.addEventListener("darrius:chartUpdated", tick);
    window.addEventListener("darrius:snapshot", tick);
  });
})();
