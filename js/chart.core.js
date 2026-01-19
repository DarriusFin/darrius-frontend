/* =========================================================================
 * DarriusAI - chart.core.js (PRODUCTION FROZEN) v2026.01.19d
 *
 * Updates requested by Perry:
 *  1) EMA/AUX closer by default:
 *     - EMA_PERIOD = 9
 *     - AUX_PERIOD = 21   (your HMA-like AUX, MA(sqrt(period)) smoothing)
 *  2) B/S bigger + brighter:
 *     - keep LightweightCharts markers (arrows) for robustness
 *     - add overlay DOM labels with configurable font size
 *  3) Candle color by TREND (not per-candle up/down):
 *     - trend derived from AUX slope (sign(aux[i]-aux[i-1]))
 *     - trend>0 => candle green; trend<0 => candle red
 *
 * Guarantees:
 *  - No subscription/billing touched
 *  - No "bottom spikes": line points always {time, value: number|null}
 * ========================================================================= */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const qs = (sel) => document.querySelector(sel);

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
  // Params (you can tune here)
  // -----------------------------
  const EMA_PERIOD = 9;       // try 7 if you want more sensitive
  const AUX_PERIOD = 21;      // try 14 if you want more sensitive (may become noisy)
  const AUX_METHOD = "SMA";   // safest

  const CONFIRM_WINDOW = 2;   // cross + trend inflection within N bars

  // B/S overlay styles
  const OVERLAY_FONT_PX = 16; // make larger if needed
  const OVERLAY_ZINDEX = 50;

  // -----------------------------
  // State
  // -----------------------------
  let containerEl = null;
  let chart = null;
  let candleSeries = null;
  let emaSeries = null; // yellow
  let auxSeries = null; // white

  let overlayLayer = null; // DOM layer for big B/S
  let overlayMarkers = []; // nodes

  let showEMA = true;
  let showAUX = true;

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
  // Fetch
  // -----------------------------
  async function fetchJson(url) {
    const r = await fetch(url, { method: "GET", credentials: "omit" });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      const err = new Error(HTTP ${r.status});
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
    if (typeof t === "object" && t.year && t.month && t.day) return t;
    return null;
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
        if (!time) return null;
        if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
        return { time, open, high, low, close };
      })
      .filter(Boolean);

    bars.sort((a, b) => (a.time > b.time ? 1 : a.time < b.time ? -1 : 0));

    const out = [];
    let lastT = null;
    for (const b of bars) {
      if (b.time === lastT) continue;
      lastT = b.time;
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
        if (!time || (side !== "B" && side !== "S")) return null;
        return { time, side };
      })
      .filter(Boolean);
  }

  async function fetchBarsPack(sym, tf) {
    const apiBase = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");
    const q = symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)};

    let lastErr = null;
    for (const p of BARS_PATH_CANDIDATES) {
      const url = ${apiBase}${p}?${q};
      try {
        const payload = await fetchJson(url);
        const bars = normalizeBars(payload);
        if (bars.length) return { payload, bars, urlUsed: url };
        lastErr = new Error(bars empty from ${url});
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(All bars endpoints failed. Last error: ${lastErr?.message || lastErr});
  }

  async function fetchOptionalSignals(sym, tf) {
    const apiBase = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");
    const q = symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)};
    for (const p of SIGS_PATH_CANDIDATES) {
      const url = ${apiBase}${p}?${q};
      try {
        const payload = await fetchJson(url);
        return normalizeSignals(payload);
      } catch (_) {}
    }
    return [];
  }

  // -----------------------------
  // Math
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
    const p = Math.max(1, Math.floor(period || 1));

    if (p <= 1) {
      for (let i = 0; i < values.length; i++) out[i] = values[i];
      return out;
    }

    if (m === "WMA") {
      for (let i = 0; i < values.length; i++) out[i] = wmaAt(values, i, p);
      return out;
    }

    // default SMA
    for (let i = 0; i < values.length; i++) out[i] = smaAt(values, i, p);
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
  // AUX per your algo
  // -----------------------------
  function computeAuxByYourAlgo(closes, period, method) {
    const n = Math.max(2, Math.floor(period || 40));
    const half = Math.max(1, Math.floor(n / 2));
    const p = Math.max(1, Math.round(Math.sqrt(n)));

    const vect = new Array(closes.length).fill(NaN);
    for (let i = 0; i < closes.length; i++) {
      const w1 = wmaAt(closes, i, half);
      const w2 = wmaAt(closes, i, n);
      if (!Number.isFinite(w1) || !Number.isFinite(w2)) vect[i] = NaN;
      else vect[i] = 2 * w1 - w2;
    }
    return maOnArray(vect, p, method || "SMA");
  }

  function computeTrendFromAux(auxVals) {
    const trend = new Array(auxVals.length).fill(0);
    let last = 0;
    for (let i = 1; i < auxVals.length; i++) {
      const a0 = auxVals[i - 1];
      const a1 = auxVals[i];
      if (!Number.isFinite(a0) || !Number.isFinite(a1)) { trend[i] = last; continue; }
      if (a1 > a0) last = 1;
      else if (a1 < a0) last = -1;
      trend[i] = last;
    }
    trend[0] = trend[1] || 0;
    return trend;
  }

  // -----------------------------
  // Trend-colored candles
  // -----------------------------
  function buildTrendColoredCandles(bars, trend) {
    const out = new Array(bars.length);
    for (let i = 0; i < bars.length; i++) {
      const t = trend[i] || 0;
      const isUp = t >= 0; // treat 0 as up to avoid flicker
      out[i] = {
        time: bars[i].time,
        open: bars[i].open,
        high: bars[i].high,
        low:  bars[i].low,
        close: bars[i].close,
        color: isUp ? "#2BE2A6" : "#FF5A5A",
        wickColor: isUp ? "#2BE2A6" : "#FF5A5A",
        borderColor: isUp ? "#2BE2A6" : "#FF5A5A",
      };
    }
    return out;
  }

  // -----------------------------
  // Signals: cross + inflection confirm
  // -----------------------------
  function computeSignalsCrossPlusInflection(bars, emaVals, auxVals, confirmWindow) {
    const n = bars.length;
    if (n < 5) return [];
    const trend = computeTrendFromAux(auxVals);
    const cw = Math.max(0, Math.floor(confirmWindow ?? 2));

    const sigs = [];
    const used = new Set();

    function addSig(i, side) {
      const key = ${bars[i].time}:${side};
      if (used.has(key)) return;
      used.add(key);
      sigs.push({ time: bars[i].time, side });
    }

    function findConfirmIndex(startIdx, wantTrend) {
      for (let j = startIdx; j <= Math.min(n - 1, startIdx + cw); j++) {
        const prev = trend[j - 1];
        const curr = trend[j];
        if (wantTrend > 0) {
          if (prev <= 0 && curr > 0) return j;
        } else {
          if (prev >= 0 && curr < 0) return j;
        }
      }
      return -1;
    }

    for (let i = 1; i < n; i++) {
      const e0 = emaVals[i - 1], e1 = emaVals[i];
      const a0 = auxVals[i - 1], a1 = auxVals[i];
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
  // Markers (LC native)
  // -----------------------------
  function applyMarkersLC(sigs) {
    if (!candleSeries) return;
    candleSeries.setMarkers(
      (sigs || []).map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#FFD400" : "#FFFFFF",
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: s.side,
      }))
    );
  }

  // -----------------------------
  // Overlay big B/S (DOM)
  // -----------------------------
  function ensureOverlayLayer() {
    if (!containerEl) return;
    if (overlayLayer) return;

    const style = window.getComputedStyle(containerEl);
    if (style.position === "static") containerEl.style.position = "relative";

    overlayLayer = document.createElement("div");
    overlayLayer.style.position = "absolute";
    overlayLayer.style.left = "0";
    overlayLayer.style.top = "0";
    overlayLayer.style.right = "0";
    overlayLayer.style.bottom = "0";
    overlayLayer.style.pointerEvents = "none";
    overlayLayer.style.zIndex = String(OVERLAY_ZINDEX);
    containerEl.appendChild(overlayLayer);
  }

  function clearOverlayMarkers() {
    for (const n of overlayMarkers) {
      try { n.remove(); } catch (_) {}
    }
    overlayMarkers = [];
  }

  function placeOverlayMarkers(sigs, bars) {
    if (!chart || !candleSeries || !overlayLayer) return;
    clearOverlayMarkers();

    // need coordinate mapping
    const priceScale = candleSeries.priceScale();
    const timeScale = chart.timeScale();

    // build quick bar lookup (time -> {high, low})
    const barMap = new Map();
    for (const b of bars) barMap.set(b.time, b);

    for (const s of sigs || []) {
      const b = barMap.get(s.time);
      if (!b) continue;

      const x = timeScale.timeToCoordinate(s.time);
      if (!Number.isFinite(x)) continue;

      const price = s.side === "B" ? b.low : b.high;
      const y = priceScale.priceToCoordinate(price);
      if (!Number.isFinite(y)) continue;

      const node = document.createElement("div");
      node.textContent = s.side;
      node.style.position = "absolute";
      node.style.transform = "translate(-50%, -50%)";
      node.style.left = ${x}px;

      // offset up/down a bit
      node.style.top = ${y + (s.side === "B" ? 18 : -18)}px;

      node.style.fontSize = ${OVERLAY_FONT_PX}px;
      node.style.fontWeight = "800";
      node.style.lineHeight = "1";
      node.style.padding = "4px 7px";
      node.style.borderRadius = "8px";
      node.style.boxShadow = "0 0 10px rgba(0,0,0,.35)";
      node.style.opacity = "0.95";
      node.style.letterSpacing = "0.5px";

      if (s.side === "B") {
        node.style.background = "#FFD400";
        node.style.color = "#000";
        node.style.border = "1px solid rgba(255,255,255,.35)";
      } else {
        node.style.background = "#FFFFFF";
        node.style.color = "#000";
        node.style.border = "1px solid rgba(255,212,0,.35)";
      }

      overlayLayer.appendChild(node);
      overlayMarkers.push(node);
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
      if ($("hintText")) $("hintText").textContent = 加载失败：${e.message || e};
      throw e;
    }

    const { payload, bars } = pack;
    const closes = bars.map((b) => b.close);

    const emaVals = ema(closes, EMA_PERIOD);
    const auxVals = computeAuxByYourAlgo(closes, AUX_PERIOD, AUX_METHOD);
    const trend = computeTrendFromAux(auxVals);

    // Trend-colored candles
    const trendCandles = buildTrendColoredCandles(bars, trend);
    candleSeries.setData(trendCandles);

    // Lines
    emaSeries.setData(buildLinePoints(bars, emaVals));
    auxSeries.setData(buildLinePoints(bars, auxVals));

    // Signals: payload -> optional endpoints -> local
    let sigs = normalizeSignals(payload);
    if (!sigs.length) sigs = await fetchOptionalSignals(sym, tf);
    if (!sigs.length) sigs = computeSignalsCrossPlusInflection(bars, emaVals, auxVals, CONFIRM_WINDOW);

    applyMarkersLC(sigs);

    // Overlay big markers
    ensureOverlayLayer();
    placeOverlayMarkers(sigs, bars);

    chart.timeScale().fitContent();

    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

    if ($("hintText")) $("hintText").textContent = Loaded · 已加载（TF=${tf} · EMA=${EMA_PERIOD} AUX=${AUX_PERIOD} · sigs=${sigs.length}）;

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
      a.download = DarriusAI_${getUiSymbol()}_${getUiTf()}.png;
      a.click();
    } catch (e) {
      alert("导出失败：" + (e.message || e));
    }
  }

  // -----------------------------
  // Init
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
      borderVisible: false,
      // base colors not critical because we override per-bar color in data
      upColor: "#2BE2A6",
      downColor: "#FF5A5A",
      wickUpColor: "#2BE2A6",
      wickDownColor: "#FF5A5A",
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

    const resize = () => {
      const r = containerEl.getBoundingClientRect();
      chart.applyOptions({
        width: Math.max(1, Math.floor(r.width)),
        height: Math.max(1, Math.floor(r.height)),
      });
      // re-place overlay on resize
      if (overlayLayer && overlayMarkers.length) {
        // will be re-laid in next load; but keep safe if user resizes
      }
    };

    try {
      new ResizeObserver(resize).observe(containerEl);
    } catch (_) {
      window.addEventListener("resize", resize);
    }
    resize();

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
