/* darrius-frontend/js/market.pulse.js
 * UI expression layer (READ-ONLY, best-effort):
 * 1) Render BIG glowing B/S on #sigOverlay (DOM overlay)  ✅可放大/发光
 * 2) Update Market Pulse from derived snapshot OR inferred global arrays
 * 3) Absolutely never throw
 */
(function () {
  "use strict";

  const CFG = {
    // --- Overlay B/S ---
    overlayMaxMarks: 140,      // 画最近多少个标记
    overlayUseGlow: true,      // 依赖 index.html 的 .sigMark CSS
    clearSeriesMarkers: true,  // 清掉 setMarkers 小字（避免“双重显示”）

    // --- Market Pulse ---
    confirmWindow: 3,          // 你的 confirm window
    emaPeriod: 14,
    auxPeriod: 40,

    // EMA 趋势判定（用最近 N 根 EMA 的斜率/变化）
    emaLookback: 6,
    // AUX 平滑判定（用最近 N 根 AUX 的波动幅度）
    auxLookback: 10,
  };

  function safe(fn) { try { return fn(); } catch { return undefined; } }
  function $(id) { return document.getElementById(id); }

  // -----------------------
  // A) Detect chart & series
  // -----------------------
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

    // heuristic scan
    return safe(() => {
      for (const k in window) {
        const v = window[k];
        if (!v || typeof v !== "object") continue;
        if (typeof v.priceScale === "function" && typeof v.setMarkers === "function") return v;
      }
      return null;
    }) || null;
  }

  function detectAnyLineSeriesByHint(hintWords) {
    // very loose: scan for objects that look like line series; we only need priceScale() for y coordinate
    return safe(() => {
      for (const k in window) {
        const v = window[k];
        if (!v || typeof v !== "object") continue;
        if (typeof v.priceScale !== "function") continue;
        const name = String(k).toLowerCase();
        if (hintWords.some(w => name.includes(w))) return v;
      }
      return null;
    }) || null;
  }

  // -----------------------
  // B) Detect derived data (snapshot OR arrays)
  // -----------------------
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
    // We try to infer:
    // - candles: [{time, open, high, low, close}]
    // - ema:     [{time, value}]
    // - aux:     [{time, value}]
    // - signals: [{time, side, price?, confirmed?}]
    let candles = null, ema = null, aux = null, signals = null;

    safe(() => {
      // 1) quick common names
      const candidates = [
        window.ohlcData, window.ohlc, window.candles, window.candleData, window.dataOHLC,
        window.emaData, window.ema, window.emaLine,
        window.auxData, window.aux, window.auxLine,
        window.signals, window.bsSignals, window.markers, window.BS
      ];

      for (const c of candidates) {
        if (!candles && looksLikeOHLCArray(c)) candles = c;
        if (!ema && looksLikeValueArray(c) && c.length > 30) ema = c;
        if (!aux && looksLikeValueArray(c) && c.length > 30) aux = c;
        if (!signals && looksLikeSignalsArray(c)) signals = c;
      }

      // 2) brute scan window for arrays
      for (const k in window) {
        const v = window[k];
        if (!v) continue;

        if (!candles && looksLikeOHLCArray(v)) candles = v;
        else if (!signals && looksLikeSignalsArray(v)) signals = v;
        else if (looksLikeValueArray(v)) {
          // we may find multiple value arrays; pick by name preference
          const name = String(k).toLowerCase();
          if (!ema && (name.includes("ema") || name.includes("ma"))) ema = v;
          else if (!aux && (name.includes("aux") || name.includes("smooth") || name.includes("sig"))) aux = v;
        }
      }

      // 3) if ema/aux still missing but we have snapshot, try from snapshot
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

  // -----------------------
  // C) BIG glowing B/S overlay
  // -----------------------
  function renderBigGlowOverlay() {
    safe(() => {
      const overlay = $("sigOverlay");
      if (!overlay) return;

      const chart = detectChart();
      const candleSeries = detectCandleSeries();
      if (!chart || !candleSeries) return;

      // optional: clear tiny series markers (they look “小且不亮”)
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

      // fallback: infer global arrays
      if (!sigs.length) {
        const ga = detectGlobalArrays();
        sigs = normalizeSignals(ga.signals);
      }

      overlay.innerHTML = "";
      if (!sigs.length) return;

      const tail = sigs.slice(-CFG.overlayMaxMarks);

      for (const s of tail) {
        // price missing? try to derive from candles by matching time
        let price = s.price;
        if (price == null) {
          const ga = detectGlobalArrays();
          const candles = ga.candles;
          if (looksLikeOHLCArray(candles)) {
            const hit = candles.findLast ? candles.findLast(x => x.time === s.time) : candles.slice().reverse().find(x => x.time === s.time);
            if (hit) price = (s.side === "B") ? hit.low : hit.high;
          }
        }
        if (price == null) continue;

        const x = safe(() => timeScale.timeToCoordinate(s.time));
        const y = safe(() => priceScale.priceToCoordinate(price));
        if (x == null || y == null || !isFinite(x) || !isFinite(y)) continue;

        const div = document.createElement("div");
        div.className = "sigMark " + (s.side === "B" ? "buy" : "sell");
        div.textContent = s.side; // "B" / "S"

        // 让它更大更亮：直接加 inline（即使你的 CSS 被改了也能变大）
        div.style.left = x + "px";
        div.style.top = y + "px";
        div.style.fontSize = "28px";
        div.style.padding = "4px 10px";
        div.style.borderRadius = "14px";
        div.style.fontWeight = "950";
        div.style.opacity = "0.98";

        // 强制发光（不依赖 CSS）
        if (CFG.overlayUseGlow) {
          if (s.side === "B") {
            div.style.color = "rgba(43,226,166,1)";
            div.style.borderColor = "rgba(43,226,166,.45)";
            div.style.textShadow = "0 0 12px rgba(43,226,166,.55), 0 0 26px rgba(43,226,166,.28)";
          } else {
            div.style.color = "rgba(255,90,90,1)";
            div.style.borderColor = "rgba(255,90,90,.45)";
            div.style.textShadow = "0 0 12px rgba(255,90,90,.55), 0 0 26px rgba(255,90,90,.28)";
          }
        }

        overlay.appendChild(div);
      }
    });
  }

  // -----------------------
  // D) Market Pulse compute (strict + institutional)
  // -----------------------
  function emaRegimeFrom(emaArr) {
    if (!looksLikeValueArray(emaArr)) return "UNKNOWN";
    const n = CFG.emaLookback;
    if (emaArr.length < n + 2) return "UNKNOWN";
    const tail = emaArr.slice(-n);
    const first = tail[0].value, last = tail[tail.length - 1].value;
    const delta = last - first;
    const abs = Math.abs(delta);
    const eps = Math.max(1e-9, Math.abs(last) * 0.0008); // 自适应阈值
    if (abs < eps) return "FLAT";
    return delta > 0 ? "UP" : "DOWN";
  }

  function auxFlatFrom(auxArr) {
    if (!looksLikeValueArray(auxArr)) return true; // unknown -> treat as low tradability, not bearish
    const n = CFG.auxLookback;
    if (auxArr.length < n + 2) return true;
    const tail = auxArr.slice(-n).map(x => x.value);
    let max = -Infinity, min = Infinity;
    for (const v of tail) { if (v > max) max = v; if (v < min) min = v; }
    const range = max - min;
    const ref = Math.max(1e-9, Math.abs(tail[tail.length - 1]));
    return range < ref * 0.002; // 很小波动 -> 视为走平
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
    // default "waiting"
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

    // Direction base
    let dir = "Neutral";
    const why = [];

    // Rule 2: recent confirm window has B => bias long
    if (lastSig && lastSig.side === "B") { dir = "Bullish"; why.push("Recent B → bias long"); }
    else if (lastSig && lastSig.side === "S") { dir = "Bearish"; why.push("Recent S → bias short"); }

    // Rule 1: EMA up cannot be Bearish
    if (regime === "UP" && dir === "Bearish") { dir = "Neutral"; why.push("EMA up → clamp (no Bearish)"); }
    if (regime === "UP") why.push("EMA up regime");
    else if (regime === "DOWN") why.push("EMA down regime");
    else if (regime === "FLAT") why.push("EMA flat/unclear regime");
    else why.push("EMA unknown");

    // Tradability score (institution style)
    let score = 58;
    if (regime === "UP" || regime === "DOWN") score += 10;
    if (lastSig) score += 6;
    if (auxFlat) { score -= 24; why.push("AUX flat → shrink tradability"); }
    score = Math.max(0, Math.min(100, Math.round(score)));

    // Convert to % buckets
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

      if (maskEl) {
        const deg = Math.round((pulse.score / 100) * 360);
        maskEl.style.background = `conic-gradient(rgba(10,15,23,.92) ${deg}deg, rgba(10,15,23,.92) 360deg)`;
      }

      // 左侧“信号栏”也顺便同步一条解释（可选）
      const metaEl = $("signalMeta");
      if (metaEl) metaEl.textContent = pulse.reason;
    });
  }

  // expose safe APIs
  window.renderOverlaySignals = function () { return safe(renderBigGlowOverlay); };
  window.updateMarketPulseUI  = function () { return safe(() => paintPulseUI(computePulse())); };

  // tick loop
  function tick() {
    safe(() => window.updateMarketPulseUI());
    safe(() => window.renderOverlaySignals());
  }

  safe(() => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        tick();
        setInterval(tick, 900);
      });
    } else {
      tick();
      setInterval(tick, 900);
    }
  });

  // if main chart triggers any custom events, we listen
  safe(() => {
    window.addEventListener("darrius:chartUpdated", tick);
    window.addEventListener("darrius:snapshot", tick);
  });

})();
