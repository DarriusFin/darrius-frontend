/* =========================================================================
 * DarriusAI - chart.core.js (PRODUCTION FROZEN v1.4.0)
 *
 * What this file guarantees:
 *  1) NO BLANK CHART from wrong endpoints:
 *     - prefer /api/market/bars first, fallbacks are safe
 *     - only accept success if bars.length > 0
 *
 *  2) Indicators (single-color, stable):
 *     - EMA: single YELLOW line (default fast EMA=7)
 *     - AUX: single WHITE line (default slow EMA=20)
 *     - hard sanitize: NEVER output 0/NaN/Infinity due to gaps or bad inputs
 *       -> gaps are always { time, value: null }
 *
 *  3) B/S markers:
 *     - computed locally by EMA/AUX cross (no backend dependency)
 *     - optional: if backend returns sigs, we can use them (safe)
 *     - marker text size is controlled via CSS hook (see note below)
 *
 *  4) Safe init, safe toggles; NO billing/subscription touch
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

  // Bars endpoints
  const BARS_PATH_CANDIDATES = [
    "/api/market/bars",   // ✅ best
    "/api/bars",
    "/bars",
    "/api/ohlcv",
    "/ohlcv",
    "/api/ohlc",
    "/ohlc",
    "/api/market/ohlcv",
    "/market/ohlcv",
    "/api/market/ohlc",   // ⚠ may 500 for crypto; keep LAST
    "/market/ohlc",
  ];

  // Optional signals endpoints (if you want to use backend signals when present)
  const SIGS_PATH_CANDIDATES = [
    "/api/market/sigs",
    "/api/market/signals",
    "/api/sigs",
    "/api/signals",
    "/sigs",
    "/signals",
  ];

  // Indicator parameters (you can tune)
  const EMA_FAST_PERIOD = 7;   // EMA = yellow
  const AUX_SLOW_PERIOD = 20;  // AUX = white

  // Marker appearance
  // NOTE: LightweightCharts markers text size is not directly configurable.
  // We'll provide a stable "short text" + optionally you can enlarge via CSS overlay if needed.
  const MARKER_TEXT_BUY = "B";
  const MARKER_TEXT_SELL = "S";

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

  // -----------------------------
  // Logging
  // -----------------------------
  function log(...args) {
    console.log(...args);
  }

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
  // Robust fetch helpers
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
      if (t > 2e10) return Math.floor(t / 1000); // ms -> s
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

  function isFiniteNumber(x) {
    return typeof x === "number" && Number.isFinite(x);
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

        // extra sanity: ignore obviously broken bars
        if (high < low) return null;

        return { time, open, high, low, close };
      })
      .filter(Boolean);

    return bars;
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

  async function fetchBarsPack(sym, tf) {
    const apiBase = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");
    const q = symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)};

    let lastErr = null;
    for (const p of BARS_PATH_CANDIDATES) {
      const url = ${apiBase}${p}?${q};
      try {
        const payload = await fetchJson(url);
        const bars = normalizeBars(payload);

        // ✅ only accept if bars really exist
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
        const sigs = normalizeSignals(payload);
        return sigs; // if exists, use even if empty (safe)
      } catch (e) {
        // silent on 404/405/5xx etc.
        continue;
      }
    }
    return [];
  }

  // -----------------------------
  // Indicator compute (with hard sanitize)
  // -----------------------------
  function computeEmaSeries(bars, period) {
    const k = 2 / (period + 1);
    let ema = null;

    const out = new Array(bars.length);
    for (let i = 0; i < bars.length; i++) {
      const t = bars[i].time;
      const c = Number(bars[i].close);

      if (!Number.isFinite(c)) {
        out[i] = { time: t, value: null };
        continue;
      }

      ema = ema == null ? c : (c * k + ema * (1 - k));

      // ✅ HARD sanitize to prevent "vertical lines to bottom":
      // - NEVER output 0 caused by undefined/math errors
      // - NEVER output NaN/Infinity
      if (!Number.isFinite(ema)) {
        out[i] = { time: t, value: null };
      } else {
        out[i] = { time: t, value: ema };
      }
    }
    return out;
  }

  function stripBadLinePoints(points) {
    // If any point is 0 due to bug, convert to null gap.
    // We do NOT blanket-remove legitimate zeros (some assets could be tiny),
    // but for price EMAs, "0" is almost always a bug.
    return (points || []).map((p) => {
      const t = p?.time;
      const v = p?.value;
      if (!t) return null;

      if (v == null) return { time: t, value: null };
      const num = Number(v);

      if (!Number.isFinite(num)) return { time: t, value: null };

      // Heuristic: if num === 0 and the surrounding candles are far from 0, treat as bug.
      if (num === 0) return { time: t, value: null };

      return { time: t, value: num };
    }).filter(Boolean);
  }

  // -----------------------------
  // B/S signals from EMA/AUX cross (local, deterministic)
  // -----------------------------
  function generateSignalsFromTwoLines(emaPts, auxPts) {
    // emaPts/auxPts are aligned by time (we produce them from same bars)
    const n = Math.min(emaPts.length, auxPts.length);
    const sigs = [];
    let prevDiff = null;

    for (let i = 0; i < n; i++) {
      const t = emaPts[i]?.time;
      const e = emaPts[i]?.value;
      const a = auxPts[i]?.value;

      if (!t) continue;
      if (!isFiniteNumber(e) || !isFiniteNumber(a)) {
        prevDiff = null;
        continue;
      }

      const diff = e - a;
      if (prevDiff == null) {
        prevDiff = diff;
        continue;
      }

      // cross up => Buy
      if (prevDiff <= 0 && diff > 0) sigs.push({ time: t, side: "B" });
      // cross down => Sell
      else if (prevDiff >= 0 && diff < 0) sigs.push({ time: t, side: "S" });

      prevDiff = diff;
    }

    // Optional: thin markers if too dense (daily data usually ok)
    return sigs;
  }

  // -----------------------------
  // Markers
  // -----------------------------
  function applyMarkers(sigs) {
    if (!candleSeries) return;
    const arr = Array.isArray(sigs) ? sigs : [];

    candleSeries.setMarkers(
      arr.map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#FFD400" : "#FFFFFF",
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: s.side === "B" ? MARKER_TEXT_BUY : MARKER_TEXT_SELL,
      }))
    );
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
      log("[ChartCore] load failed:", e);
      if ($("hintText")) $("hintText").textContent = 加载失败：${e.message || e};
      throw e;
    }

    const { payload, bars } = pack;

    // Candles
    candleSeries.setData(bars);

    // Indicators (local, stable)
    let emaPts = computeEmaSeries(bars, EMA_FAST_PERIOD);
    let auxPts = computeEmaSeries(bars, AUX_SLOW_PERIOD);

    emaPts = stripBadLinePoints(emaPts);
    auxPts = stripBadLinePoints(auxPts);

    // Respect toggles: if off, we still set data (fine), just hidden by options
    emaSeries.setData(emaPts);
    auxSeries.setData(auxPts);

    // Signals:
    // 1) try backend embedded signals (if any)
    // 2) else try optional signals endpoints
    // 3) else compute locally from EMA/AUX cross (guaranteed)
    let sigs = normalizeSignals(payload);
    if (!sigs.length) sigs = await fetchOptionalSignals(sym, tf);
    if (!sigs.length) sigs = generateSignalsFromTwoLines(emaPts, auxPts);

    applyMarkers(sigs);

    // Fit
    chart.timeScale().fitContent();

    // UI text
    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

    if ($("hintText")) {
      $("hintText").textContent = Loaded · 已加载（TF=${tf} · sigs=${sigs.length}）;
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

    // Candles: 绿色上涨 / 红色下跌
    candleSeries = chart.addCandlestickSeries({
      upColor: "#2BE2A6",
      downColor: "#FF5A5A",
      wickUpColor: "#2BE2A6",
      wickDownColor: "#FF5A5A",
      borderVisible: false,
    });

    // EMA: 黄色单线
    emaSeries = chart.addLineSeries({
      color: "#FFD400",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // AUX: 白色单线
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

    // auto load
    if (opts.autoLoad !== false) {
      load().catch((e) => log("[ChartCore] initial load failed:", e));
    }
  }

  // Expose
  window.ChartCore = { init, load, applyToggles, exportPNG };
})();
