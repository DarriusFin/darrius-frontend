/* =========================================================================
 * DarriusAI - chart.core.js (PRODUCTION FROZEN) v2026.01.19e
 *
 * Preset 2 (Institutional / Cleaner):
 *  - EMA = 14
 *  - AUX = 40 (confidential HMA-like)
 *  - Confirm window = 3
 *  - Candle colors by EMA trend (stable, institutional)
 *      UP  if EMA slope >= 0
 *      DOWN if EMA slope < 0
 *  - B/S labels: HTML Overlay (BIG + GLOW) for instant visibility
 *  - Optional arrow markers kept (no tiny text dependency)
 *
 * Guarantees:
 *  1) NO BLANK CHART from wrong endpoints: bars must be non-empty
 *  2) NO bottom spikes: line points are {time, value: finite} or {time, value: null}
 *  3) EMA yellow, AUX white
 *  4) NO billing/subscription touch
 * ========================================================================= */

(() => {
  "use strict";

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);
  const qs = (sel) => document.querySelector(sel);

  // -----------------------------
  // Config
  // -----------------------------
  const DEFAULT_API_BASE =
    (window.DARRIUS_API_BASE && String(window.DARRIUS_API_BASE)) ||
    (window._API_BASE_ && String(window._API_BASE_)) ||
    (window.API_BASE && String(window.API_BASE)) ||
    "https://darrius-api.onrender.com";

  const BARS_PATH_CANDIDATES = [
    "/api/market/bars",
    "/api/bars",
    "/bars",
    "/api/ohlcv",
    "/ohlcv",
    "/api/ohlc",
    "/ohlc",
    "/api/market/ohlcv",
    "/market/ohlcv",
    "/api/market/ohlc",
    "/market/ohlc",
  ];

  const SIGS_PATH_CANDIDATES = [
    "/api/market/sigs",
    "/api/market/signals",
    "/api/sigs",
    "/api/signals",
    "/sigs",
    "/signals",
  ];

  // -----------------------------
  // Indicator params (Preset 2)
  // -----------------------------
  const EMA_PERIOD = 14;
  const AUX_PERIOD = 40;
  const AUX_METHOD = "SMA";
  const CONFIRM_WINDOW = 3;

  // Candle colors (trend based)
  const UP_COLOR = "#2BE2A6";
  const DOWN_COLOR = "#FF5A5A";

  // Overlay label style (BIG + GLOW)
  const OVERLAY_FONT_PX = 18;
  const OVERLAY_FONT_WEIGHT = 900;
  const OVERLAY_GLOW_PX = 14;

  // Label offset so it doesn't sit on wick
  const LABEL_PAD_PX = 14;

  // -----------------------------
  // State
  // -----------------------------
  let containerEl = null;
  let chart = null;
  let candleSeries = null;

  let emaSeries = null; // yellow
  let auxSeries = null; // white

  let showEMA = true;
  let showAUX = true;

  // Overlay
  let overlayLayer = null;
  const overlayEnabled = true;
  const markerEnabled = true;

  // Cached current data for overlay placement
  let _lastBars = [];
  let _lastSigs = [];
  let _barByTimeKey = new Map();

  // -----------------------------
  // UI readers
  // -----------------------------
  function getUiSymbol() {
    const el =
      $("symbolInput") ||
      $("symInput") ||
      $("symbol") ||
      qs('input[name="symbol"]') ||
      qs("#symbol") ||
      qs("#sym");
    const v = el && (el.value || el.textContent);
    return (v || "BTCUSDT").trim();
  }

  function getUiTf() {
    const el =
      $("tfSelect") ||
      $("timeframeSelect") ||
      $("tf") ||
      qs('select[name="timeframe"]') ||
      qs("#timeframe");
    const v = el && (el.value || el.textContent);
    return (v || "1d").trim();
  }

  // -----------------------------
  // Fetch helpers
  // -----------------------------
  async function fetchJson(url) {
    const r = await fetch(url, { method: "GET", credentials: "omit" });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      const err = new Error("HTTP " + r.status);
      err.status = r.status;
      err.body = text;
      throw err;
    }
    return r.json();
  }

  function toUnixTime(t) {
    if (t == null) return null;

    if (typeof t === "number") {
      if (t > 2e10) return Math.floor(t / 1000);
      return t;
    }

    if (typeof t === "string") {
      const ms = Date.parse(t);
      if (!Number.isFinite(ms)) return null;
      return Math.floor(ms / 1000);
    }

    // BusinessDay object
    if (typeof t === "object" && t.year && t.month && t.day) return t;

    return null;
  }

  function timeKey(t) {
    return typeof t === "object" ? (t.year + "-" + t.month + "-" + t.day) : String(t);
  }

  function normalizeBars(payload) {
    const raw =
      Array.isArray(payload) ? payload :
      Array.isArray(payload?.bars) ? payload.bars :
      Array.isArray(payload?.ohlcv) ? payload.ohlcv :
      Array.isArray(payload?.data) ? payload.data :
      [];

    const bars = (raw || [])
      .map((b) => {
        const time = toUnixTime(b.time ?? b.t ?? b.timestamp ?? b.ts ?? b.date);
        const open = Number(b.open ?? b.o ?? b.Open);
        const high = Number(b.high ?? b.h ?? b.High);
        const low  = Number(b.low  ?? b.l ?? b.Low);
        const close= Number(b.close?? b.c ?? b.Close);

        if (time == null) return null;
        if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
        return { time, open, high, low, close };
      })
      .filter(Boolean);

    bars.sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));

    // de-dup time
    const out = [];
    let lastK = null;
    for (const b of bars) {
      const k = timeKey(b.time);
      if (k === lastK) continue;
      lastK = k;
      out.push(b);
    }
    return out;
  }

  function normalizeSignals(payload) {
    const raw =
      payload?.sigs ||
      payload?.signals ||
      payload?.data?.sigs ||
      payload?.data?.signals ||
      [];
    if (!Array.isArray(raw)) return [];
    return raw
      .map((s) => {
        const time = toUnixTime(s.time ?? s.t ?? s.timestamp ?? s.ts ?? s.date);
        const side = String(s.side ?? s.type ?? s.action ?? "").toUpperCase();
        if (time == null || (side !== "B" && side !== "S")) return null;
        return { time, side };
      })
      .filter(Boolean);
  }

  async function fetchBarsPack(sym, tf) {
    const apiBase = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");
    const q = "symbol=" + encodeURIComponent(sym) + "&tf=" + encodeURIComponent(tf);

    let lastErr = null;
    for (const p of BARS_PATH_CANDIDATES) {
      const url = apiBase + p + "?" + q;
      try {
        const payload = await fetchJson(url);
        const bars = normalizeBars(payload);
        if (bars.length) return { payload, bars, urlUsed: url };
        lastErr = new Error("bars empty from " + url);
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error("All bars endpoints failed. Last error: " + (lastErr?.message || String(lastErr)));
  }

  async function fetchOptionalSignals(sym, tf) {
    const apiBase = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");
    const q = "symbol=" + encodeURIComponent(sym) + "&tf=" + encodeURIComponent(tf);

    for (const p of SIGS_PATH_CANDIDATES) {
      const url = apiBase + p + "?" + q;
      try {
        const payload = await fetchJson(url);
        return normalizeSignals(payload);
      } catch (_) {}
    }
    return [];
  }

  // -----------------------------
  // Math: EMA / SMA / WMA / MA-on-array
  // -----------------------------
  function ema(values, period) {
    const k = 2 / (period + 1);
    let e = null;
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) { out[i] = NaN; continue; }
      e = e == null ? v : v * k + e * (1 - k);
      out[i] = e;
    }
    return out;
  }

  function smaAt(values, endIdx, period) {
    const start = endIdx - period + 1;
    if (start < 0) return NaN;
    let sum = 0;
    for (let i = start; i <= endIdx; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) return NaN;
      sum += v;
    }
    return sum / period;
  }

  function wmaAt(values, endIdx, period) {
    const start = endIdx - period + 1;
    if (start < 0) return NaN;
    let num = 0;
    let den = 0;
    for (let i = start; i <= endIdx; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) return NaN;
      const w = i - start + 1;
      num += v * w;
      den += w;
    }
    return den ? (num / den) : NaN;
  }

  function maOnArray(values, period, method) {
    const m = String(method || "SMA").toUpperCase();
    const out = new Array(values.length).fill(NaN);

    if (period <= 1) {
      for (let i = 0; i < values.length; i++) out[i] = values[i];
      return out;
    }

    if (m === "EMA") {
      const k = 2 / (period + 1);
      let e = null;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) { out[i] = NaN; continue; }
        e = e == null ? v : v * k + e * (1 - k);
        out[i] = e;
      }
      return out;
    }

    if (m === "WMA") {
      for (let i = 0; i < values.length; i++) out[i] = wmaAt(values, i, period);
      return out;
    }

    for (let i = 0; i < values.length; i++) out[i] = smaAt(values, i, period);
    return out;
  }

  function buildLinePoints(bars, values) {
    const pts = new Array(bars.length);
    for (let i = 0; i < bars.length; i++) {
      const t = bars[i].time;
      const v = values[i];
      pts[i] = { time: t, value: Number.isFinite(v) ? v : null };
    }
    return pts;
  }

  // -----------------------------
  // AUX per your algorithm (HMA-like)
  // -----------------------------
  function computeAuxByYourAlgo(closes, period, method) {
    const n = Math.max(2, Math.floor(period || 40));
    const half = Math.max(1, Math.floor(n / 2));
    const p = Math.max(1, Math.round(Math.sqrt(n))); // sqrt(period)

    const vect = new Array(closes.length).fill(NaN);
    for (let i = 0; i < closes.length; i++) {
      const w1 = wmaAt(closes, i, half);
      const w2 = wmaAt(closes, i, n);
      if (!Number.isFinite(w1) || !Number.isFinite(w2)) vect[i] = NaN;
      else vect[i] = 2 * w1 - w2;
    }

    return maOnArray(vect, p, method || "SMA");
  }

  function computeTrendFromSeries(vals) {
    // trend[i] = sign(vals[i] - vals[i-1]); hold last on NaN/equal
    const trend = new Array(vals.length).fill(0);
    let last = 0;
    for (let i = 1; i < vals.length; i++) {
      const a0 = vals[i - 1];
      const a1 = vals[i];
      if (!Number.isFinite(a0) || !Number.isFinite(a1)) {
        trend[i] = last;
        continue;
      }
      if (a1 > a0) last = 1;
      else if (a1 < a0) last = -1;
      trend[i] = last;
    }
    trend[0] = trend[1] || 0;
    return trend;
  }

  // -----------------------------
  // Candles colored by EMA trend (Preset 2)
  // -----------------------------
  function colorizeBarsByEmaTrend(bars, emaVals) {
    const t = computeTrendFromSeries(emaVals);
    return bars.map((b, i) => {
      const up = (t[i] ?? 0) >= 0;
      const c = up ? UP_COLOR : DOWN_COLOR;
      return {
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        color: c,
        wickColor: c,
        borderColor: c,
      };
    });
  }

  // -----------------------------
  // B/S: CROSS + INFLECTION CONFIRM (with confirm window = 3)
  // -----------------------------
  function computeSignalsCrossPlusInflection(bars, emaPts, auxPts, confirmWindow) {
    const n = bars.length;
    if (n < 5) return [];

    const emaV = emaPts.map((p) => p.value);
    const auxV = auxPts.map((p) => p.value);
    const auxTrend = computeTrendFromSeries(auxV);

    const cw = Math.max(0, Math.floor(confirmWindow ?? 3));
    const sigs = [];
    const usedKey = new Set();

    function addSig(i, side) {
      const t = bars[i].time;
      const key = timeKey(t) + ":" + side;
      if (usedKey.has(key)) return;
      usedKey.add(key);
      sigs.push({ time: t, side });
    }

    function findConfirmIndex(startIdx, wantTrend) {
      for (let j = startIdx; j <= Math.min(n - 1, startIdx + cw); j++) {
        const prev = auxTrend[j - 1];
        const curr = auxTrend[j];
        if (wantTrend > 0) {
          if (prev <= 0 && curr > 0) return j;
        } else {
          if (prev >= 0 && curr < 0) return j;
        }
      }
      return -1;
    }

    for (let i = 1; i < n; i++) {
      const e0 = emaV[i - 1], e1 = emaV[i];
      const a0 = auxV[i - 1], a1 = auxV[i];
      if (!Number.isFinite(e0) || !Number.isFinite(e1) || !Number.isFinite(a0) || !Number.isFinite(a1)) continue;

      const crossUp = (e0 <= a0 && e1 > a1);
      const crossDn = (e0 >= a0 && e1 < a1);

      if (crossUp) {
        const k = findConfirmIndex(i, +1);
        if (k >= 0) addSig(k, "B");
      } else if (crossDn) {
        const k = findConfirmIndex(i, -1);
        if (k >= 0) addSig(k, "S");
      }
    }

    sigs.sort((x, y) => (x.time > y.time ? 1 : x.time < y.time ? -1 : 0));
    return sigs;
  }

  // -----------------------------
  // Markers (small arrows) - optional
  // -----------------------------
  function applyMarkers(sigs) {
    if (!candleSeries || !markerEnabled) return;
    const arr = Array.isArray(sigs) ? sigs : [];
    candleSeries.setMarkers(
      arr.map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#FFD400" : "#FFFFFF",
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: "",
      }))
    );
  }

  // -----------------------------
  // Overlay labels (BIG + GLOW)
  // -----------------------------
  function ensureOverlayLayer() {
    if (!containerEl) return null;
    if (overlayLayer) return overlayLayer;

    const cs = window.getComputedStyle(containerEl);
    if (cs.position === "static") {
      containerEl.style.position = "relative";
    }

    overlayLayer = document.createElement("div");
    overlayLayer.setAttribute("data-darrius-overlay", "signals");
    overlayLayer.style.position = "absolute";
    overlayLayer.style.left = "0";
    overlayLayer.style.top = "0";
    overlayLayer.style.right = "0";
    overlayLayer.style.bottom = "0";
    overlayLayer.style.pointerEvents = "none";
    overlayLayer.style.zIndex = "6";
    containerEl.appendChild(overlayLayer);
    return overlayLayer;
  }

  function clearOverlay() {
    if (!overlayLayer) return;
    overlayLayer.innerHTML = "";
  }

  function buildBarIndexMap(bars) {
    _barByTimeKey = new Map();
    for (const b of bars) _barByTimeKey.set(timeKey(b.time), b);
  }

  function isTimeInVisibleRange(t) {
    if (!chart) return true;
    const x = chart.timeScale().timeToCoordinate(t);
    return Number.isFinite(x);
  }

  function renderSignalOverlays() {
    if (!overlayEnabled) return;
    if (!chart || !candleSeries || !_lastSigs || !_lastSigs.length) {
      clearOverlay();
      return;
    }

    const layer = ensureOverlayLayer();
    if (!layer) return;

    clearOverlay();

    const maxRender = 250;
    let rendered = 0;

    for (const s of _lastSigs) {
      if (rendered >= maxRender) break;

      const t = s.time;
      if (!isTimeInVisibleRange(t)) continue;

      const b = _barByTimeKey.get(timeKey(t));
      if (!b) continue;

      const x = chart.timeScale().timeToCoordinate(t);
      if (!Number.isFinite(x)) continue;

      const price = s.side === "B" ? b.low : b.high;
      const y = candleSeries.priceToCoordinate(price);
      if (!Number.isFinite(y)) continue;

      const node = document.createElement("div");
      node.textContent = s.side;

      node.style.position = "absolute";
      node.style.left = x + "px";
      node.style.top = y + "px";
      node.style.transform = "translate(-50%, -50%)";
      node.style.fontSize = OVERLAY_FONT_PX + "px";
      node.style.fontWeight = String(OVERLAY_FONT_WEIGHT);
      node.style.letterSpacing = "0.5px";
      node.style.lineHeight = "1";
      node.style.padding = "4px 8px";
      node.style.borderRadius = "10px";

      if (s.side === "B") {
        node.style.color = "#0B0F14";
        node.style.background = "rgba(255, 212, 0, 0.95)";
        node.style.boxShadow =
          "0 0 " + OVERLAY_GLOW_PX + "px rgba(255,212,0,0.85), 0 0 " + (OVERLAY_GLOW_PX + 10) + "px rgba(255,212,0,0.35)";
      } else {
        node.style.color = "#FFFFFF";
        node.style.background = "rgba(255, 90, 90, 0.85)";
        node.style.boxShadow =
          "0 0 " + OVERLAY_GLOW_PX + "px rgba(255,90,90,0.85), 0 0 " + (OVERLAY_GLOW_PX + 10) + "px rgba(255,90,90,0.35)";
      }

      node.style.marginTop = (s.side === "B" ? LABEL_PAD_PX : -LABEL_PAD_PX) + "px";

      layer.appendChild(node);
      rendered++;
    }
  }

  // -----------------------------
  // Toggles
  // -----------------------------
  function applyToggles() {
    const emaChecked = $("toggleEMA")?.checked ?? $("emaToggle")?.checked ?? $("emaCheck")?.checked;
    const auxChecked = $("toggleAUX")?.checked ?? $("auxToggle")?.checked ?? $("auxCheck")?.checked;

    if (typeof emaChecked === "boolean") showEMA = emaChecked;
    if (typeof auxChecked === "boolean") showAUX = auxChecked;

    if (emaSeries) emaSeries.applyOptions({ visible: !!showEMA });
    if (auxSeries) auxSeries.applyOptions({ visible: !!showAUX });
  }

  // -----------------------------
  // Core load
  // -----------------------------
  async function load() {
    if (!chart || !candleSeries) return;

    const sym = getUiSymbol();
    const tf = getUiTf();

    if ($("hintText")) $("hintText").textContent = "Loading...";

    let pack;
    try {
      pack = await fetchBarsPack(sym, tf);
    } catch (e) {
      if ($("hintText")) $("hintText").textContent = "加载失败：" + (e?.message || String(e));
      throw e;
    }

    const { payload, bars } = pack;
    if (!bars || !bars.length) {
      if ($("hintText")) $("hintText").textContent = "加载失败：bars为空";
      return;
    }

    const closes = bars.map((b) => b.close);

    // EMA (yellow)
    const emaVals = ema(closes, EMA_PERIOD);

    // AUX (white) - confidential
    const auxVals = computeAuxByYourAlgo(closes, AUX_PERIOD, AUX_METHOD);

    const emaPts = buildLinePoints(bars, emaVals);
    const auxPts = buildLinePoints(bars, auxVals);

    // Candles colored by EMA trend (Preset 2)
    const coloredBars = colorizeBarsByEmaTrend(bars, emaVals);

    candleSeries.setData(coloredBars);
    if (emaSeries) emaSeries.setData(emaPts);
    if (auxSeries) auxSeries.setData(auxPts);

    // Signals:
    let sigs = normalizeSignals(payload);
    if (!sigs.length) sigs = await fetchOptionalSignals(sym, tf);
    if (!sigs.length) sigs = computeSignalsCrossPlusInflection(bars, emaPts, auxPts, CONFIRM_WINDOW);

    // Cache for overlay
    _lastBars = bars;
    _lastSigs = sigs;
    buildBarIndexMap(bars);

    applyMarkers(sigs);
    renderSignalOverlays();

    chart.timeScale().fitContent();

    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

    if ($("hintText")) {
      $("hintText").textContent =
        "Loaded · 已加载（TF=" + tf + " · bars=" + bars.length + " · sigs=" + sigs.length + ")";
    }

    applyToggles();
    return { urlUsed: pack.urlUsed, bars: bars.length, sigs: sigs.length };
  }

  // -----------------------------
  // Export PNG
  // -----------------------------
  function exportPNG() {
    try {
      if (!chart || typeof chart.takeScreenshot !== "function") {
        alert("当前图表版本不支持导出（takeScreenshot 不可用）。");
        return;
      }
      const canvas = chart.takeScreenshot();
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = "DarriusAI_" + getUiSymbol() + "_" + getUiTf() + ".png";
      a.click();
    } catch (e) {
      alert("导出失败：" + (e?.message || String(e)));
    }
  }

  // -----------------------------
  // Init (idempotent)
  // -----------------------------
  function init(opts) {
    opts = opts || {};
    const containerId = opts.containerId || "chart";

    containerEl = $(containerId);
    if (!containerEl) throw new Error("Chart container missing: #" + containerId);
    if (!window.LightweightCharts) throw new Error("LightweightCharts missing");
    if (chart) return;

    chart = window.LightweightCharts.createChart(containerEl, {
      layout: { background: { color: "transparent" }, textColor: "#EAF0F7" },
      grid: {
        vertLines: { color: "rgba(255,255,255,.04)" },
        horzLines: { color: "rgba(255,255,255,.04)" },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { timeVisible: true, secondsVisible: false, borderVisible: false },
      crosshair: { mode: 1 },
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      borderVisible: false,
    });

    emaSeries = chart.addLineSeries({
      color: "#FFD400",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    auxSeries = chart.addLineSeries({
      color: "#FFFFFF",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    ensureOverlayLayer();

    const resize = () => {
      const r = containerEl.getBoundingClientRect();
      chart.applyOptions({
        width: Math.max(1, Math.floor(r.width)),
        height: Math.max(1, Math.floor(r.height)),
      });
      renderSignalOverlays();
    };

    try {
      new ResizeObserver(resize).observe(containerEl);
    } catch (_) {
      window.addEventListener("resize", resize);
    }
    resize();

    chart.timeScale().subscribeVisibleTimeRangeChange(() => {
      renderSignalOverlays();
    });

    chart.subscribeCrosshairMove(() => {
      renderSignalOverlays();
    });

    $("toggleEMA")?.addEventListener("change", applyToggles);
    $("emaToggle")?.addEventListener("change", applyToggles);
    $("emaCheck")?.addEventListener("change", applyToggles);

    $("toggleAUX")?.addEventListener("change", applyToggles);
    $("auxToggle")?.addEventListener("change", applyToggles);
    $("auxCheck")?.addEventListener("change", applyToggles);

    if (opts.autoLoad !== false) load().catch(() => {});
  }

  window.ChartCore = { init, load, applyToggles, exportPNG };
})();
