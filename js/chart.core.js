/* =========================================================================
 * DarriusAI - chart.core.js (PRODUCTION FROZEN - STABLE)
 * Version: 2026-01-19-r1
 *
 * Guarantees (DO NOT TOUCH billing/subscription):
 *  1) Stable chart load: never blank because one endpoint fails
 *  2) Candles colored by TREND:
 *      - trendUp (EMA >= AUX) => all green
 *      - trendDown           => all red
 *  3) EMA: single yellow line (default period=20, configurable)
 *  4) AUX: single white line, implemented from your MQL logic:
 *      vect[x] = 2*WMA(x,p/2) - WMA(x,p)
 *      AUX    = SMA(vect, sqrt(p))   (method=SMA)
 *  5) B/S signals upgraded:
 *      - cross + inflection confirmation (AUX slope flip)
 *      - debounced (min bars between signals)
 *
 * Notes:
 *  - Markers font size is limited by LightweightCharts; we use brighter colors
 *    and "BUY/SELL" text to appear larger.
 * ========================================================================= */

(() => {
  "use strict";

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);
  const qs = (sel) => document.querySelector(sel);

  // -----------------------------
  // API base (keep your existing)
  // -----------------------------
  const API_BASE =
    (window.DARRIUS_API_BASE && String(window.DARRIUS_API_BASE)) ||
    (window._API_BASE_ && String(window._API_BASE_)) ||
    (window.API_BASE && String(window.API_BASE)) ||
    "https://darrius-api.onrender.com";

  // Verified best endpoint
  const BARS_ENDPOINTS = ["/api/market/bars"]; // keep minimal & stable

  // Optional signals endpoints (backend if you expose later)
  const SIGS_ENDPOINTS = ["/api/market/sigs", "/api/market/signals"];

  // -----------------------------
  // Params (you can expose UI later)
  // -----------------------------
  const PARAMS = {
    emaPeriod: 20,     // yellow EMA
    auxPeriod: 40,     // white AUX (your method)
    auxMethod: "SMA",  // method=3 in your old comment, but you said SMA -> use SMA
    minBarsBetweenSignals: 6, // debounce
  };

  // -----------------------------
  // State
  // -----------------------------
  let containerEl = null;
  let chart = null;
  let candleSeries = null;
  let emaSeries = null;
  let auxSeries = null;

  // toggles (default true)
  let showEMA = true;
  let showAUX = true;

  // -----------------------------
  // Utils
  // -----------------------------
  function log(...args) {
    console.log("[ChartCore]", ...args);
  }

  function safeText(el, txt) {
    const node = typeof el === "string" ? $(el) : el;
    if (node) node.textContent = txt;
  }

  function stripTrailingSlash(s) {
    return String(s || "").replace(/\/+$/, "");
  }

  function toUnixTime(t) {
    if (t == null) return null;

    if (typeof t === "number") {
      // ms -> s
      if (t > 2e10) return Math.floor(t / 1000);
      return t;
    }

    if (typeof t === "string") {
      const ms = Date.parse(t);
      if (!Number.isFinite(ms)) return null;
      return Math.floor(ms / 1000);
    }

    // LightweightCharts business day object passthrough
    if (typeof t === "object" && t.year && t.month && t.day) return t;

    return null;
  }

  function isFiniteNumber(x) {
    return typeof x === "number" && Number.isFinite(x);
  }

  // -----------------------------
  // UI readers (compatible with your page)
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
    return (v || "BTCUSDT").trim().toUpperCase();
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
  // Robust fetch
  // -----------------------------
  async function fetchJson(url) {
    const r = await fetch(url, { method: "GET", credentials: "omit" });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      const err = new Error(HTTP ${r.status} for ${url});
      err.status = r.status;
      err.body = text;
      throw err;
    }
    return r.json();
  }

  function normalizeBars(payload) {
    const raw =
      Array.isArray(payload) ? payload :
      Array.isArray(payload?.bars) ? payload.bars :
      Array.isArray(payload?.data) ? payload.data :
      Array.isArray(payload?.ohlcv) ? payload.ohlcv :
      [];

    const bars = (raw || [])
      .map((b) => {
        const time = toUnixTime(b.time ?? b.t ?? b.timestamp ?? b.ts ?? b.date);
        const open = Number(b.open ?? b.o ?? b.Open);
        const high = Number(b.high ?? b.h ?? b.High);
        const low  = Number(b.low  ?? b.l ?? b.Low);
        const close= Number(b.close?? b.c ?? b.Close);

        if (!time) return null;
        if (![open, high, low, close].every(Number.isFinite)) return null;

        // extra safety: avoid 0/NaN spikes
        if (high <= 0 || low <= 0 || close <= 0) return null;

        return { time, open, high, low, close };
      })
      .filter(Boolean);

    // sort by time asc to keep chart stable
    bars.sort((a, b) => (a.time > b.time ? 1 : -1));
    return bars;
  }

  async function fetchBars(symbol, tf) {
    const base = stripTrailingSlash(API_BASE);
    const q = symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)};

    let lastErr = null;

    for (const p of BARS_ENDPOINTS) {
      const url = ${base}${p}?${q};
      try {
        const payload = await fetchJson(url);
        const bars = normalizeBars(payload);
        if (bars.length) return { payload, bars, urlUsed: url };
        lastErr = new Error(bars empty from ${url});
      } catch (e) {
        lastErr = e;
      }
    }

    throw new Error(bars_failed: ${lastErr?.message || lastErr});
  }

  function normalizeSignals(payload) {
    const raw = payload?.sigs || payload?.signals || payload?.data?.sigs || payload?.data?.signals || [];
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

  async function fetchOptionalSignals(symbol, tf) {
    const base = stripTrailingSlash(API_BASE);
    const q = symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)};
    for (const p of SIGS_ENDPOINTS) {
      const url = ${base}${p}?${q};
      try {
        const payload = await fetchJson(url);
        return normalizeSignals(payload);
      } catch (_) {
        // silent
      }
    }
    return [];
  }

  // -----------------------------
  // Indicators
  // -----------------------------
  function computeEMAFromBars(bars, period) {
    if (!bars.length) return [];
    const k = 2 / (period + 1);
    let ema = null;
    const out = new Array(bars.length);

    for (let i = 0; i < bars.length; i++) {
      const c = bars[i].close;
      ema = ema == null ? c : (c * k + ema * (1 - k));
      out[i] = ema;
    }
    return out;
  }

  // Weighted Moving Average (WMA) on series values, using "series index" as in MQL (ArraySetAsSeries=true)
  // We'll compute in normal order and carefully align.
  function wma(values, period) {
    const n = values.length;
    if (period <= 1) return values.slice();

    const out = new Array(n).fill(null);
    const denom = (period * (period + 1)) / 2;

    for (let i = 0; i < n; i++) {
      let num = 0;
      let w = 1;
      // use last 'period' values ending at i
      const start = i - period + 1;
      if (start < 0) continue;

      for (let j = start; j <= i; j++) {
        num += values[j] * w;
        w += 1;
      }
      out[i] = num / denom;
    }
    return out;
  }

  function sma(values, period) {
    const n = values.length;
    if (period <= 1) return values.slice();

    const out = new Array(n).fill(null);
    let sum = 0;

    for (let i = 0; i < n; i++) {
      const v = values[i];
      sum += v;

      if (i >= period) {
        sum -= values[i - period];
      }

      if (i >= period - 1) {
        out[i] = sum / period;
      }
    }
    return out;
  }

  // AUX implementation from your MQL logic:
  // p = sqrt(period)
  // vect = 2*WMA(close, period/2) - WMA(close, period)
  // AUX = SMA(vect, p)
  function computeAUXFromBars(bars, period) {
    const closes = bars.map(b => b.close);
    const half = Math.max(1, Math.floor(period / 2));
    const p = Math.max(1, Math.floor(Math.sqrt(period)));

    const w1 = wma(closes, half);
    const w2 = wma(closes, period);

    const vect = closes.map((_, i) => {
      if (!isFiniteNumber(w1[i]) || !isFiniteNumber(w2[i])) return null;
      return 2 * w1[i] - w2[i];
    });

    // SMA on vect (skip nulls by turning into 0 would be wrong; we keep null until enough real values)
    // Build a dense array for sma: use 0 for null but track validity count.
    const dense = new Array(vect.length).fill(0);
    const valid = new Array(vect.length).fill(false);
    for (let i = 0; i < vect.length; i++) {
      if (isFiniteNumber(vect[i])) {
        dense[i] = vect[i];
        valid[i] = true;
      }
    }

    const out = new Array(vect.length).fill(null);
    // manual SMA that requires all p points valid
    for (let i = 0; i < vect.length; i++) {
      const start = i - p + 1;
      if (start < 0) continue;
      let ok = true;
      let sum = 0;
      for (let j = start; j <= i; j++) {
        if (!valid[j]) { ok = false; break; }
        sum += dense[j];
      }
      if (ok) out[i] = sum / p;
    }
    return out;
  }

  // -----------------------------
  // B/S: cross + inflection confirmation (AUX slope flip)
  // -----------------------------
  function generateSignalsCrossInflection(bars, emaArr, auxArr) {
    const sigs = [];
    const n = bars.length;
    if (n < 5) return sigs;

    let lastSigIndex = -99999;

    // helper: slope
    const slope = (arr, i) => {
      if (i <= 0) return 0;
      if (!isFiniteNumber(arr[i]) || !isFiniteNumber(arr[i - 1])) return 0;
      return arr[i] - arr[i - 1];
    };

    for (let i = 2; i < n; i++) {
      const ema0 = emaArr[i - 1], ema1 = emaArr[i];
      const aux0 = auxArr[i - 1], aux1 = auxArr[i];

      if (![ema0, ema1, aux0, aux1].every(isFiniteNumber)) continue;

      const prevDiff = ema0 - aux0;
      const currDiff = ema1 - aux1;

      const crossedUp = prevDiff <= 0 && currDiff > 0;
      const crossedDown = prevDiff >= 0 && currDiff < 0;

      const auxSlope0 = slope(auxArr, i - 1);
      const auxSlope1 = slope(auxArr, i);

      // inflection confirmation:
      // - BUY: cross up AND AUX slope flips to >=0
      // - SELL: cross down AND AUX slope flips to <=0
      const auxTurnUp = auxSlope0 < 0 && auxSlope1 >= 0;
      const auxTurnDown = auxSlope0 > 0 && auxSlope1 <= 0;

      if (i - lastSigIndex < PARAMS.minBarsBetweenSignals) continue;

      if (crossedUp && auxTurnUp) {
        sigs.push({ time: bars[i].time, side: "B" });
        lastSigIndex = i;
      } else if (crossedDown && auxTurnDown) {
        sigs.push({ time: bars[i].time, side: "S" });
        lastSigIndex = i;
      }
    }

    return sigs;
  }

  // -----------------------------
  // Markers (brighter + larger text illusion)
  // -----------------------------
  function applyMarkers(sigs) {
    if (!candleSeries) return;
    const arr = Array.isArray(sigs) ? sigs : [];
    candleSeries.setMarkers(
      arr.map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#FFD400" : "#FFFFFF", // bright
        shape: s.side === "B" ? "circle" : "circle",   // circle is more visible
        text: s.side === "B" ? "BUY" : "SELL",         // appears larger than single letter
      }))
    );
  }

  // -----------------------------
  // Trend-based candle recolor
  // -----------------------------
  function colorCandlesByTrend(bars, emaArr, auxArr) {
    const colored = new Array(bars.length);
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const ema = emaArr[i];
      const aux = auxArr[i];

      // fallback: if indicator not ready, keep original candle coloring by close/open
      let up = b.close >= b.open;

      if (isFiniteNumber(ema) && isFiniteNumber(aux)) {
        up = ema >= aux; // your rule
      }

      const upColor = "#2BE2A6";
      const downColor = "#FF5A5A";

      colored[i] = {
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        color: up ? upColor : downColor,
        wickColor: up ? upColor : downColor,
        borderColor: up ? upColor : downColor,
      };
    }
    return colored;
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
  // Load
  // -----------------------------
  async function load() {
    if (!chart || !candleSeries) return;

    const sym = getUiSymbol();
    const tf = getUiTf();

    safeText("hintText", "Loading...");

    let pack;
    try {
      pack = await fetchBars(sym, tf);
    } catch (e) {
      log("load failed:", e);
      safeText("hintText", 加载失败：${e.message || e});
      // IMPORTANT: do not crash the whole page
      return null;
    }

    const { payload, bars, urlUsed } = pack;

    if (!bars.length) {
      safeText("hintText", "bars为空：后端未返回有效K线");
      return null;
    }

    // compute indicators
    const emaArr = computeEMAFromBars(bars, PARAMS.emaPeriod);
    const auxArr = computeAUXFromBars(bars, PARAMS.auxPeriod);

    // Candles: trend-based coloring
    const colored = colorCandlesByTrend(bars, emaArr, auxArr);
    candleSeries.setData(colored);

    // EMA yellow single line
    emaSeries.setData(
      bars.map((b, i) => ({
        time: b.time,
        value: isFiniteNumber(emaArr[i]) ? emaArr[i] : null,
      }))
    );

    // AUX white single line
    auxSeries.setData(
      bars.map((b, i) => ({
        time: b.time,
        value: isFiniteNumber(auxArr[i]) ? auxArr[i] : null,
      }))
    );

    // B/S signals:
    // 1) if backend gives sigs, use them
    // 2) else generate on front-end using cross+inflection rule
    let sigs = normalizeSignals(payload);
    if (!sigs.length) {
      // Try optional backend endpoints (silent)
      sigs = await fetchOptionalSignals(sym, tf);
    }
    if (!sigs.length) {
      // Front-end generation (your upgraded rule)
      sigs = generateSignalsCrossInflection(bars, emaArr, auxArr);
    }
    applyMarkers(sigs);

    // Fit
    chart.timeScale().fitContent();

    // UI
    const last = bars[bars.length - 1];
    safeText("symText", sym);
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

    safeText("hintText", Loaded · 已加载（TF=${tf} · sigs=${sigs.length}）);
    applyToggles();

    return { ok: true, urlUsed, bars: bars.length, sigs: sigs.length };
  }

  // -----------------------------
  // Export PNG (if available)
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
  // Init (idempotent)
  // -----------------------------
  function init(opts) {
    opts = opts || {};
    const containerId = opts.containerId || "chart";
    containerEl = $(containerId);

    if (!containerEl) throw new Error("Chart container missing: #" + containerId);
    if (!window.LightweightCharts) throw new Error("LightweightCharts missing");

    if (chart) return; // idempotent

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

    // Candles: base options (per-bar color applied by setData)
    candleSeries = chart.addCandlestickSeries({
      upColor: "#2BE2A6",
      downColor: "#FF5A5A",
      wickUpColor: "#2BE2A6",
      wickDownColor: "#FF5A5A",
      borderVisible: false,
    });

    // EMA yellow
    emaSeries = chart.addLineSeries({
      color: "#FFD400",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // AUX white
    auxSeries = chart.addLineSeries({
      color: "#FFFFFF",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // Resize
    const resize = () => {
      const r = containerEl.getBoundingClientRect();
      chart.applyOptions({
        width: Math.max(1, Math.floor(r.width)),
        height: Math.max(1, Math.floor(r.height)),
      });
    };

    try {
      new ResizeObserver(resize).observe(containerEl);
    } catch (_) {
      window.addEventListener("resize", resize);
    }
    resize();

    // Bind toggles if present
    $("toggleEMA")?.addEventListener("change", applyToggles);
    $("emaToggle")?.addEventListener("change", applyToggles);
    $("emaCheck")?.addEventListener("change", applyToggles);

    $("toggleAUX")?.addEventListener("change", applyToggles);
    $("auxToggle")?.addEventListener("change", applyToggles);
    $("auxCheck")?.addEventListener("change", applyToggles);

    // Load button (if exists)
    $("loadBtn")?.addEventListener("click", () => load().catch(() => {}));

    // Auto load
    if (opts.autoLoad !== false) {
      load().catch((e) => log("initial load failed:", e));
    }
  }

  // Expose
  window.ChartCore = { init, load, applyToggles, exportPNG, PARAMS };
})();
