/* =========================================================================
 * DarriusAI - chart.core.js (PRODUCTION FROZEN) v2026.01.19
 *
 * Guarantees:
 *  1) NO BLANK CHART from wrong endpoints: prefer /api/market/bars first
 *     - success requires: bars.length > 0
 *  2) NO "bottom spikes": strict NaN/Infinity/0-shape protection
 *     - all line points are either {time, value: finite} or {time, value: null}
 *     - NEVER use {time} without value
 *  3) EMA: single-color (YELLOW) line
 *  4) AUX: single-color (WHITE) line
 *  5) B/S markers:
 *     - Prefer payload embedded sigs/signals
 *     - Else optional second request (/api/market/sigs -> /api/market/signals)
 *     - If still missing => compute locally by EMA/AUX cross (stable fallback)
 *  6) Safe init, safe toggles; NO billing/subscription touch
 * ========================================================================= */

(() => {
  "use strict";

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);
  const qs = (sel) => document.querySelector(sel);

  // -----------------------------
  // Config (IMPORTANT: no syntax tricks)
  // -----------------------------
  const DEFAULT_API_BASE =
    (window.DARRIUS_API_BASE && String(window.DARRIUS_API_BASE)) ||
    (window.__API_BASE__ && String(window.__API_BASE__)) ||
    (window._API_BASE_ && String(window._API_BASE_)) ||
    "https://darrius-api.onrender.com";

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

  const SIGS_PATH_CANDIDATES = [
    "/api/market/sigs",
    "/api/market/signals",
    "/api/sigs",
    "/api/signals",
    "/sigs",
    "/signals",
  ];

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
      // ✅ FIXED: must be a string
      const err = new Error(`HTTP ${r.status}`);
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

    // sort + dedupe by time (safety)
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
    const q = `symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;

    let lastErr = null;
    for (const p of BARS_PATH_CANDIDATES) {
      const url = `${apiBase}${p}?${q}`;
      try {
        const payload = await fetchJson(url);
        const bars = normalizeBars(payload);
        if (bars.length) return { payload, bars, urlUsed: url };
        lastErr = new Error(`bars empty from ${url}`);
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`All bars endpoints failed. Last error: ${lastErr?.message || lastErr}`);
  }

  async function fetchOptionalSignals(sym, tf) {
    const apiBase = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");
    const q = `symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;

    for (const p of SIGS_PATH_CANDIDATES) {
      const url = `${apiBase}${p}?${q}`;
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
  // Indicators (EMA + AUX)
  // -----------------------------
  function ema(values, period) {
    const k = 2 / (period + 1);
    let e = null;
    const out = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      e = e == null ? v : v * k + e * (1 - k);
      out.push(e);
    }
    return out;
  }

  function buildLinePoints(bars, values) {
    // Strict: finite => value, else null gap.
    const pts = [];
    for (let i = 0; i < bars.length; i++) {
      const t = bars[i].time;
      const v = values[i];
      pts.push({ time: t, value: Number.isFinite(v) ? v : null });
    }
    return pts;
  }

  // -----------------------------
  // Local B/S fallback by EMA-AUX cross
  // (you can later replace with your “EMA与AUX交叉+拐点确认”更复杂规则)
  // -----------------------------
  function computeSignalsFromCross(bars, emaPts, auxPts) {
    if (!bars?.length) return [];
    const sigs = [];
    let prevDiff = null;

    for (let i = 0; i < bars.length; i++) {
      const e = emaPts[i]?.value;
      const a = auxPts[i]?.value;
      if (!Number.isFinite(e) || !Number.isFinite(a)) {
        prevDiff = null;
        continue;
      }
      const diff = e - a;
      if (prevDiff == null) {
        prevDiff = diff;
        continue;
      }
      if (prevDiff <= 0 && diff > 0) sigs.push({ time: bars[i].time, side: "B" });
      if (prevDiff >= 0 && diff < 0) sigs.push({ time: bars[i].time, side: "S" });
      prevDiff = diff;
    }
    return sigs;
  }

  // -----------------------------
  // Markers (note: LightweightCharts markers have NO fontSize option)
  // -----------------------------
  function applyMarkers(sigs) {
    if (!candleSeries) return;
    const arr = Array.isArray(sigs) ? sigs : [];
    candleSeries.setMarkers(
      arr.map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        // make them obvious
        color: s.side === "B" ? "#FFD400" : "#FFFFFF",
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: s.side, // font size is not configurable in this API
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
      if ($("hintText")) $("hintText").textContent = `加载失败：${e.message || e}`;
      throw e;
    }

    const { payload, bars } = pack;

    // Candles
    candleSeries.setData(bars);

    // Build EMA (yellow) & AUX (white)
    const closes = bars.map((b) => b.close);

    // EMA period: 20 (you can adjust)
    const emaVals = ema(closes, 20);

    // AUX: here use a slower EMA (50) as a stable AUX baseline
    const auxVals = ema(closes, 50);

    const emaPts = buildLinePoints(bars, emaVals);
    const auxPts = buildLinePoints(bars, auxVals);

    // ✅ critical: prevents bottom spikes (never omit value)
    emaSeries.setData(emaPts);
    auxSeries.setData(auxPts);

    // Signals: payload -> optional endpoint -> local cross fallback
    let sigs = normalizeSignals(payload);
    if (!sigs.length) sigs = await fetchOptionalSignals(sym, tf);
    if (!sigs.length) sigs = computeSignalsFromCross(bars, emaPts, auxPts);

    applyMarkers(sigs);

    chart.timeScale().fitContent();

    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

    if ($("hintText")) $("hintText").textContent = `Loaded · 已加载（TF=${tf} · sigs=${sigs.length}）`;

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
      a.download = `DarriusAI_${getUiSymbol()}_${getUiTf()}.png`;
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

    // ✅ K线：涨绿跌红
    candleSeries = chart.addCandlestickSeries({
      upColor: "#2BE2A6",
      downColor: "#FF5A5A",
      wickUpColor: "#2BE2A6",
      wickDownColor: "#FF5A5A",
      borderVisible: false,
    });

    // ✅ EMA：黄线
    emaSeries = chart.addLineSeries({
      color: "#FFD400",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // ✅ AUX：白线
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

    // bind toggles
    $("toggleEMA")?.addEventListener("change", applyToggles);
    $("emaToggle")?.addEventListener("change", applyToggles);
    $("emaCheck")?.addEventListener("change", applyToggles);

    $("toggleAUX")?.addEventListener("change", applyToggles);
    $("auxToggle")?.addEventListener("change", applyToggles);
    $("auxCheck")?.addEventListener("change", applyToggles);

    if (opts.autoLoad !== false) {
      load().catch(() => {});
    }
  }

  window.ChartCore = { init, load, applyToggles, exportPNG };
})();
