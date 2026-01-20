/* darrius-frontend/js/market.pulse.js
 * UI-only layer:
 * - derive Market Pulse from main-chart snapshot (best-effort)
 * - render B/S markers (best-effort) WITHOUT touching chart.core.js
 * - absolutely never throw
 */
(function () {
  "use strict";

  function safe(fn) {
    try { return fn(); } catch (e) { /* swallow */ return undefined; }
  }

  function $(id) { return document.getElementById(id); }

  // ---------- 1) Detect chart / series / snapshot (best-effort) ----------
  function detectChart() {
    // common names you may have
    return (
      window.__DARRIUS_CHART__ ||
      window.DARRIUS_CHART ||
      window.chart ||
      window._chart ||
      null
    );
  }

  function detectCandleSeries() {
    // common names you may have
    const direct =
      window.__DARRIUS_CANDLE_SERIES__ ||
      window.candlestickSeries ||
      window.candleSeries ||
      window.mainSeries ||
      window.seriesCandles ||
      window._candleSeries ||
      null;
    if (direct && typeof direct.setMarkers === "function") return direct;

    // heuristic: scan window keys for an object that looks like a series
    return safe(() => {
      for (const k in window) {
        const v = window[k];
        if (!v || typeof v !== "object") continue;
        // series usually has priceScale() and setData() or setMarkers()
        if (typeof v.priceScale === "function" && (typeof v.setData === "function" || typeof v.setMarkers === "function")) {
          if (typeof v.setMarkers === "function") return v;
        }
      }
      return null;
    }) || null;
  }

  function detectSnapshot() {
    // try many possible snapshot locations/names
    const s =
      window.__DARRIUS_CHART_STATE__ ||
      window.__DARRIUS_SNAPSHOT__ ||
      window.DARRIUS_SNAPSHOT ||
      window.__chartSnapshot ||
      null;

    // optional getter-based exports (if chart.core.js ever exposes a function)
    if (!s) {
      const alt = safe(() => {
        if (window.DarriusChartCore && typeof window.DarriusChartCore.getSnapshot === "function") {
          return window.DarriusChartCore.getSnapshot();
        }
        if (window.chartCore && typeof window.chartCore.getSnapshot === "function") {
          return window.chartCore.getSnapshot();
        }
        return null;
      });
      return alt || null;
    }
    return s;
  }

  // ---------- 2) Market Pulse (derived only) ----------
  // Your discipline rules (hard constraints):
  // - If EMA regime is UP -> pulse cannot be Bearish.
  // - If recent confirm window has valid B -> direction must bias to Bullish.
  // - If AUX flat/unclear -> tradability shrinks (not bearish).
  function computePulse(snapshot) {
    // Default: conservative "derived only / waiting"
    const out = {
      label: "Neutral",
      score: 0,           // 0..100 tradability
      bull: 0,
      bear: 0,
      neu: 100,
      netInflow: "—",
      reason: "Derived only · waiting for snapshot",
    };

    if (!snapshot || typeof snapshot !== "object") return out;

    // We support multiple snapshot shapes.
    // Try to locate signals, emaRegime, auxSlope, etc.
    const emaRegime =
      snapshot.emaRegime ||
      snapshot.trendRegime ||
      snapshot.regime ||
      null; // "UP" | "DOWN" | "FLAT" (best effort)

    const confirmWindow = Number(snapshot.confirmWindow || snapshot.confirm || 3) || 3;

    const signals =
      snapshot.signals ||
      snapshot.bsSignals ||
      snapshot.markers ||
      [];

    // take last confirmWindow signals that are "confirmed"
    const recent = Array.isArray(signals) ? signals.slice(-Math.max(1, confirmWindow * 2)) : [];

    const lastConfirmed = (arr) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        const s = arr[i];
        if (!s) continue;
        // accept s.side or s.type, and allow confirmed flags
        const side = (s.side || s.type || s.signal || "").toString().toUpperCase();
        const ok = (s.confirmed === true) || (s.isConfirmed === true) || (s.confirm === true) || (s.confirmed == null);
        if ((side === "B" || side === "BUY" || side === "S" || side === "SELL") && ok) return { side, s };
      }
      return null;
    };

    const last = lastConfirmed(recent);

    // AUX stability / smoothness (best-effort)
    // If snapshot has auxSlope or auxFlat flag, use it; otherwise infer "unknown" -> treat as low tradability, not bearish
    const auxFlat =
      snapshot.auxFlat === true ||
      snapshot.auxIsFlat === true ||
      (typeof snapshot.auxSlope === "number" && Math.abs(snapshot.auxSlope) < 1e-9) ||
      false;

    // EMA flip frequency (best-effort)
    const emaChop =
      snapshot.emaChop === true ||
      snapshot.emaFrequentFlip === true ||
      false;

    // --- Determine direction with hard rules ---
    let dir = "Neutral"; // Bullish | Neutral | Bearish
    let reason = [];

    // Rule 2: if last confirmed is B within confirm window -> bias bullish
    if (last && (last.side === "B" || last.side === "BUY")) {
      dir = "Bullish";
      reason.push("Recent confirmed B → bias long");
    } else if (last && (last.side === "S" || last.side === "SELL")) {
      dir = "Bearish";
      reason.push("Recent confirmed S → bias short");
    }

    // Rule 1: EMA green/up cannot be Bearish
    const regime = (emaRegime || "").toString().toUpperCase();
    if (regime === "UP" || regime === "BULL" || regime === "GREEN") {
      if (dir === "Bearish") {
        dir = "Neutral";
        reason.push("EMA up → cannot be Bearish (clamped to Neutral)");
      } else {
        reason.push("EMA up regime");
      }
    } else if (regime === "DOWN" || regime === "BEAR" || regime === "RED") {
      reason.push("EMA down regime");
    } else if (regime) {
      reason.push("EMA flat/unclear regime");
    } else {
      reason.push("EMA regime unknown");
    }

    // --- Tradability score (0..100) ---
    // Institution-style: uncertainty = low participation, NOT bearish.
    let score = 55;

    // increase if regime clear + not choppy
    if (regime === "UP" || regime === "DOWN") score += 10;
    if (emaChop) score -= 18;

    // AUX flat reduces tradability (Rule 3)
    if (auxFlat) score -= 22;

    // recent confirmed signal adds some tradability (but not too much)
    if (last) score += 8;

    // clamp
    score = Math.max(0, Math.min(100, Math.round(score)));

    // Convert score into bull/bear/neutral percents (UI-friendly)
    // We keep it simple and consistent:
    // - Direction controls which side gets most of the "active" share.
    // - Neutral always keeps a base.
    let bull = 0, bear = 0, neu = 100;

    const active = Math.round(score * 0.9);         // active confidence bucket
    const baseNeutral = 100 - active;               // uncertainty bucket (institution style)
    neu = baseNeutral;

    if (dir === "Bullish") {
      bull = Math.round(active * 0.75);
      bear = active - bull;
    } else if (dir === "Bearish") {
      bear = Math.round(active * 0.75);
      bull = active - bear;
    } else {
      // Neutral: split active evenly (or keep small directional)
      bull = Math.round(active * 0.5);
      bear = active - bull;
    }

    out.label = dir;
    out.score = score;
    out.bull = bull;
    out.bear = bear;
    out.neu = neu;
    out.reason = reason.join(" · ");

    // optional: if snapshot has any flow metric
    out.netInflow = (snapshot.netInflow != null) ? String(snapshot.netInflow) : "—";

    // Final hard constraints again (safety)
    if (regime === "UP" && out.label === "Bearish") out.label = "Neutral";

    return out;
  }

  function paintGauge(pulse) {
    const scoreEl = $("pulseScore");
    const bullEl = $("bullPct");
    const bearEl = $("bearPct");
    const neuEl  = $("neuPct");
    const inflowEl = $("netInflow");
    const maskEl = $("pulseGaugeMask");

    if (!scoreEl || !maskEl) return;

    // Score number
    scoreEl.textContent = (pulse && typeof pulse.score === "number") ? String(pulse.score) : "—";

    if (bullEl) bullEl.textContent = pulse ? (pulse.bull + "%") : "—";
    if (bearEl) bearEl.textContent = pulse ? (pulse.bear + "%") : "—";
    if (neuEl)  neuEl.textContent  = pulse ? (pulse.neu  + "%") : "—";
    if (inflowEl) inflowEl.textContent = pulse ? String(pulse.netInflow) : "—";

    // Gauge mask: we show "tradability" as filled portion.
    const score = pulse && typeof pulse.score === "number" ? pulse.score : 0;
    const deg = Math.round((score / 100) * 360);

    // Conic mask trick: first segment = transparent hole, second = dark ring
    // We keep color in CSS ring, and mask by dark overlay.
    maskEl.style.background = `conic-gradient(rgba(10,15,23,.92) ${deg}deg, rgba(10,15,23,.92) 360deg)`;

    // Optional: update label under gauge (Sentiment/Tradability)
    const lbl = document.querySelector("#pulseGauge .gaugeCenter .lbl");
    if (lbl) lbl.textContent = "Tradability";

    // Optional: tag text
    const tag = $("pulseTag");
    if (tag) tag.textContent = "LIVE";

    // Optional: small status badge
    const statusText = $("statusText");
    if (statusText && pulse) {
      statusText.textContent = `Ready · Pulse: ${pulse.label} (${pulse.score}%)`;
    }
  }

  // ---------- 3) Restore B/S markers (best-effort) ----------
  function normalizeSignals(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return [];
    const arr = snapshot.signals || snapshot.bsSignals || snapshot.markers || snapshot.BS || [];
    if (!Array.isArray(arr)) return [];
    // normalize to { time, side, price }
    return arr.map(s => {
      const sideRaw = (s.side || s.type || s.signal || s.text || "").toString().toUpperCase();
      const side = (sideRaw === "BUY") ? "B" : (sideRaw === "SELL") ? "S" : (sideRaw === "B" || sideRaw === "S") ? sideRaw : null;
      const time = s.time ?? s.t ?? s.timestamp ?? null;
      const price = s.price ?? s.p ?? s.value ?? null;
      const confirmed = (s.confirmed === true) || (s.isConfirmed === true) || (s.confirm === true) || (s.confirmed == null);
      return { time, side, price, confirmed };
    }).filter(x => x.side && x.time != null);
  }

  // Preferred: use LightweightCharts series markers (stable, no CSS dependency)
  function renderMarkersOnSeries(series, signals) {
    if (!series || typeof series.setMarkers !== "function") return false;
    if (!Array.isArray(signals) || signals.length === 0) {
      // clear markers if no signals (optional)
      safe(() => series.setMarkers([]));
      return true;
    }

    const markers = signals
      .filter(s => s && s.confirmed !== false)
      .map(s => ({
        time: s.time,
        position: (s.side === "B") ? "belowBar" : "aboveBar",
        color: (s.side === "B") ? "#2BE2A6" : "#FF5A5A",
        shape: (s.side === "B") ? "circle" : "circle",
        text: s.side
      }));

    safe(() => series.setMarkers(markers));
    return true;
  }

  // Fallback: DOM overlay (needs chart + series coordinate functions)
  function renderDomOverlay(chart, series, signals) {
    const overlay = $("sigOverlay");
    if (!overlay) return false;

    // clear
    overlay.innerHTML = "";
    if (!chart || !series || !signals || signals.length === 0) return false;

    const timeScale = safe(() => chart.timeScale && chart.timeScale()) || null;
    const priceScale = safe(() => series.priceScale && series.priceScale()) || null;

    if (!timeScale || !priceScale) return false;
    if (typeof timeScale.timeToCoordinate !== "function") return false;
    if (typeof priceScale.priceToCoordinate !== "function") return false;

    // draw a limited number to keep clean
    const maxDraw = 120;
    const tail = signals.slice(-maxDraw);

    for (const s of tail) {
      const x = safe(() => timeScale.timeToCoordinate(s.time));
      const y = safe(() => priceScale.priceToCoordinate(s.price));
      if (x == null || y == null || !isFinite(x) || !isFinite(y)) continue;

      const div = document.createElement("div");
      div.className = "sigMark " + (s.side === "B" ? "buy" : "sell");
      div.textContent = s.side;
      div.style.left = x + "px";
      div.style.top = y + "px";
      overlay.appendChild(div);
    }
    return true;
  }

  // Public safe APIs requested earlier
  function renderOverlaySignals() {
    safe(() => {
      const snap = detectSnapshot();
      const sigs = normalizeSignals(snap);

      // 1) best: series markers
      const series = detectCandleSeries();
      if (series && renderMarkersOnSeries(series, sigs)) return;

      // 2) fallback: DOM overlay (only if we can locate chart+series)
      const chart = detectChart();
      const anySeries = series || detectCandleSeries();
      renderDomOverlay(chart, anySeries, sigs);
    });
  }

  function updateMarketPulseUI() {
    safe(() => {
      const snap = detectSnapshot();
      const pulse = computePulse(snap);
      paintGauge(pulse);

      // Also update left "signal box" (optional, safe)
      safe(() => {
        const sigs = normalizeSignals(snap);
        const last = sigs.length ? sigs[sigs.length - 1] : null;
        const sideEl = $("signalSide");
        const metaEl = $("signalMeta");
        const pxEl = $("signalPx");
        const tfEl = $("signalTf");
        const rowEl = $("signalRow");

        if (!sideEl || !metaEl || !rowEl) return;

        if (!last) {
          sideEl.textContent = "Waiting…";
          metaEl.textContent = "Waiting for confirmation…\n等待确认…";
          if (pxEl) pxEl.textContent = "—";
          if (tfEl) tfEl.textContent = "TF: —";
          rowEl.classList.remove("buy","sell");
          rowEl.classList.add("neutral");
          return;
        }

        const isBuy = last.side === "B";
        sideEl.textContent = isBuy ? "BUY / B" : "SELL / S";
        metaEl.textContent = (pulse ? pulse.reason : "Derived only");
        if (pxEl) pxEl.textContent = (last.price != null) ? String(last.price) : "—";
        if (tfEl) tfEl.textContent = snap && snap.tf ? ("TF: " + snap.tf) : "TF: —";

        rowEl.classList.remove("neutral","buy","sell");
        rowEl.classList.add(isBuy ? "buy" : "sell");
      });
    });
  }

  // expose globals (as you要求的“绝对不抛错安全区”)
  window.renderOverlaySignals = function () { return safe(renderOverlaySignals); };
  window.updateMarketPulseUI  = function () { return safe(updateMarketPulseUI); };

  // automatic refresh loop (safe)
  function tick() {
    safe(() => updateMarketPulseUI());
    safe(() => renderOverlaySignals());
  }

  // start after DOM ready
  safe(() => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        tick();
        setInterval(tick, 1200);
      });
    } else {
      tick();
      setInterval(tick, 1200);
    }
  });

  // if chart.core.js dispatches events, we listen (optional)
  safe(() => {
    window.addEventListener("darrius:chartUpdated", tick);
    window.addEventLis
