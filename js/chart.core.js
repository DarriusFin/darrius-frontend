/* =========================================================
 * DarriusAI - chart.core.js (Integrated, Robust Init)
 * Goal:
 *  - Candles: green up / red down (default)
 *  - EMA "color-changing" visually ONE line:
 *      implemented as two line series (emaUp / emaDown)
 *      with mutual-exclusive values (null == EMPTY_VALUE)
 *      + bridge points at flips to avoid gaps / parallel lines
 *  - AUX optional (fixed color)
 *  - Markers B/S optional
 *  - Robust init: avoid blank chart due to 0-size container or double init
 * ========================================================= */

(() => {
  "use strict";

  // -----------------------------
  // Helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);

  const log = (...a) => console.log("[ChartCore]", ...a);
  const warn = (...a) => console.warn("[ChartCore]", ...a);
  const err = (...a) => console.error("[ChartCore]", ...a);

  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  // LightweightCharts expects:
  //  - time: unix seconds OR { year, month, day }
  const normalizeTime = (t) => {
    if (t == null) return null;

    // already object
    if (typeof t === "object" && t.year && t.month && t.day) return t;

    // unix seconds or ms
    if (typeof t === "number") {
      if (t > 1e12) return Math.floor(t / 1000);
      if (t > 1e9) return Math.floor(t);
      return t;
    }

    // ISO date string
    if (typeof t === "string") {
      // "YYYY-MM-DD" (preferred)
      const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return { year: +m[1], month: +m[2], day: +m[3] };

      const d = new Date(t);
      if (!isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
    }

    return null;
  };

  // Try to locate UI elements without breaking your existing ids
  function getUiSymbol() {
    if (typeof window.getUiSymbol === "function") return window.getUiSymbol();
    return (
      ($("symInput") && $("symInput").value) ||
      ($("symbol") && $("symbol").value) ||
      ($("uiSymbol") && $("uiSymbol").value) ||
      "BTCUSDT"
    );
  }

  function getUiTf() {
    if (typeof window.getUiTf === "function") return window.getUiTf();
    return (
      ($("tfInput") && $("tfInput").value) ||
      ($("timeframe") && $("timeframe").value) ||
      ($("uiTf") && $("uiTf").value) ||
      "1d"
    );
  }

  function getToggleChecked(names) {
    for (const id of names) {
      const el = $(id);
      if (el && typeof el.checked === "boolean") return !!el.checked;
    }
    return true; // default ON if not found
  }

  // -----------------------------
  // State
  // -----------------------------
  let chart = null;
  let candleSeries = null;

  // EMA split series (visually one EMA)
  let emaUp = null;
  let emaDown = null;

  // AUX
  let auxSeries = null;

  let containerEl = null;
  let overlayEl = null;

  let _inited = false;
  let _loading = false;

  // Keep latest loaded data for overlay/markers/etc
  let CURRENT_BARS = [];
  let CURRENT_SIGS = [];

  // -----------------------------
  // EMA split (EMPTY_VALUE logic)
  // -----------------------------
  function buildSplitEmaSeries(bars, emaValues, trendMode = "price_vs_ema") {
    // trendMode:
    //  - "price_vs_ema": close >= ema => up, else down

    const n = Math.min(bars.length, emaValues.length);
    const up = new Array(n);
    const dn = new Array(n);

    const trend = new Array(n);

    for (let i = 0; i < n; i++) {
      const t = normalizeTime(bars[i].time);
      const ema = toNum(emaValues[i]);

      if (t == null || ema == null) {
        up[i] = { time: bars[i].time, value: null };
        dn[i] = { time: bars[i].time, value: null };
        trend[i] = 0;
        continue;
      }

      let tr = 0;
      if (trendMode === "price_vs_ema") {
        const c = toNum(bars[i].close);
        tr = c != null && c >= ema ? 1 : -1;
      } else {
        const c = toNum(bars[i].close);
        tr = c != null && c >= ema ? 1 : -1;
      }

      trend[i] = tr;

      // EMPTY_VALUE = null
      up[i] = { time: t, value: tr > 0 ? ema : null };
      dn[i] = { time: t, value: tr < 0 ? ema : null };
    }

    // Bridge points at flips (your MT logic):
    // if trend[x]>0 and trend[x+1]<0 then Uptrend[x+1]=ema[x+1]
    // if trend[x]<0 and trend[x+1]>0 then Dntrend[x+1]=ema[x+1]
    // Additionally, set the opposite series at x with ema[x] so the segment visually meets cleanly.
    for (let i = 0; i < n - 1; i++) {
      if (trend[i] === 0 || trend[i + 1] === 0) continue;
      if (trend[i] > 0 && trend[i + 1] < 0) {
        // up -> down flip
        const emaNext = toNum(emaValues[i + 1]);
        const emaNow = toNum(emaValues[i]);
        const tNext = normalizeTime(bars[i + 1].time);
        const tNow = normalizeTime(bars[i].time);

        if (emaNext != null && tNext != null) up[i + 1] = { time: tNext, value: emaNext }; // force one-point
        if (emaNow != null && tNow != null) dn[i] = { time: tNow, value: emaNow }; // meet at boundary
      } else if (trend[i] < 0 && trend[i + 1] > 0) {
        // down -> up flip
        const emaNext = toNum(emaValues[i + 1]);
        const emaNow = toNum(emaValues[i]);
        const tNext = normalizeTime(bars[i + 1].time);
        const tNow = normalizeTime(bars[i].time);

        if (emaNext != null && tNext != null) dn[i + 1] = { time: tNext, value: emaNext };
        if (emaNow != null && tNow != null) up[i] = { time: tNow, value: emaNow };
      }
    }

    return { up, dn };
  }

  // -----------------------------
  // Toggles
  // -----------------------------
  function applyToggles() {
    if (!chart) return;

    const showEMA = getToggleChecked(["toggleEMA", "chkEMA", "emaToggle", "EMA"]);
    const showAUX = getToggleChecked(["toggleAUX", "chkAUX", "auxToggle", "AUX"]);

    // EMA: both series are one visual indicator
    if (emaUp) emaUp.applyOptions({ visible: !!showEMA });
    if (emaDown) emaDown.applyOptions({ visible: !!showEMA });

    if (auxSeries) auxSeries.applyOptions({ visible: !!showAUX });
  }

  // -----------------------------
  // Data fetching (pluggable)
  // -----------------------------
  function buildDataUrl(sym, tf) {
    // If you already have a builder in other scripts, use it
    if (typeof window.buildDataUrl === "function") return window.buildDataUrl(sym, tf);
    if (typeof window.DARRIUS_BUILD_DATA_URL === "function") return window.DARRIUS_BUILD_DATA_URL(sym, tf);

    // default: same-origin proxy
    return `/api/ohlcv?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} ${r.statusText} @ ${url}\n${txt.slice(0, 300)}`);
    }
    return r.json();
  }

  function normalizeBarsFromResponse(resp) {
    // Accept common shapes:
    //  - resp.bars = [{time, open, high, low, close}]
    //  - resp.data = [...]
    //  - resp = [...]
    const arr = Array.isArray(resp) ? resp : (resp && (resp.bars || resp.data || resp.ohlcv)) || [];
    const bars = [];

    for (const b of arr) {
      const t = normalizeTime(b.time ?? b.t ?? b.ts ?? b.timestamp ?? b.date);
      const o = toNum(b.open ?? b.o);
      const h = toNum(b.high ?? b.h);
      const l = toNum(b.low ?? b.l);
      const c = toNum(b.close ?? b.c);

      if (t == null || o == null || h == null || l == null || c == null) continue;
      bars.push({ time: t, open: o, high: h, low: l, close: c });
    }
    return bars;
  }

  function extractEmaAux(resp, bars) {
    // Allow backend-provided EMA/AUX:
    // resp.ema / resp.emaData etc
    // resp.aux / resp.auxData etc
    const emaArr =
      (resp && (resp.ema || resp.emaData || resp.ema_values || resp.emaValues)) || null;
    const auxArr =
      (resp && (resp.aux || resp.auxData || resp.aux_values || resp.auxValues)) || null;

    // If missing, compute basic EMA(20) and AUX(50) as fallback (won't change your subscription logic)
    function calcEMA(period) {
      const out = new Array(bars.length);
      const k = 2 / (period + 1);
      let prev = null;
      for (let i = 0; i < bars.length; i++) {
        const c = bars[i].close;
        if (prev == null) prev = c;
        else prev = c * k + prev * (1 - k);
        out[i] = prev;
      }
      return out;
    }

    const ema = Array.isArray(emaArr) ? emaArr : calcEMA(20);
    const aux = Array.isArray(auxArr) ? auxArr : calcEMA(50);

    return { ema, aux };
  }

  function extractSignals(resp) {
    // resp.sigs = [{time, side:"B"/"S"}]
    const sigs = (resp && (resp.sigs || resp.signals)) || [];
    if (!Array.isArray(sigs)) return [];
    return sigs
      .map((s) => ({
        time: normalizeTime(s.time ?? s.t ?? s.ts ?? s.date),
        side: (s.side || s.type || "").toUpperCase(),
      }))
      .filter((s) => s.time != null && (s.side === "B" || s.side === "S"));
  }

  // -----------------------------
  // Rendering
  // -----------------------------
  function setMarkers(sigs) {
    if (!candleSeries) return;

    // colors per your request: B yellow, S white
    candleSeries.setMarkers(
      sigs.map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#FFD400" : "#FFFFFF",
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: s.side,
      }))
    );
  }

  function render(bars, emaValues, auxValues, sigs) {
    if (!chart || !candleSeries) return;

    CURRENT_BARS = bars;
    CURRENT_SIGS = sigs;

    candleSeries.setData(bars);

    // EMA split (visual single line)
    const { up, dn } = buildSplitEmaSeries(bars, emaValues, "price_vs_ema");
    emaUp.setData(up);
    emaDown.setData(dn);

    // AUX
    auxSeries.setData(
      bars.map((b, i) => ({
        time: b.time,
        value: toNum(auxValues[i]),
      }))
    );

    setMarkers(sigs);
    applyToggles();

    chart.timeScale().fitContent();
  }

  // -----------------------------
  // Init / Resize (avoid blank)
  // -----------------------------
  function bindResize() {
    if (!containerEl || !chart) return;

    const resize = () => {
      const r = containerEl.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width));
      const h = Math.max(1, Math.floor(r.height));

      chart.applyOptions({ width: w, height: h });
    };

    // Try until container has real size
    const ensure = () => {
      if (!chart || !containerEl) return;
      const r = containerEl.getBoundingClientRect();
      if (r.width < 50 || r.height < 50) {
        requestAnimationFrame(ensure);
        return;
      }
      resize();
      chart.timeScale().fitContent();
    };

    try {
      new ResizeObserver(() => {
        resize();
      }).observe(containerEl);
    } catch (_) {}

    window.addEventListener("resize", resize);
    ensure();
  }

  function init(opts) {
    opts = opts || {};
    if (_inited) return; // idempotent

    const containerId = opts.containerId || "chart";
    containerEl = $(containerId);
    if (!containerEl) throw new Error(`Chart container #${containerId} not found`);

    if (!window.LightweightCharts) throw new Error("LightweightCharts missing");

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
      upColor: "#2BE2A6",       // green up
      downColor: "#FF5A5A",     // red down
      wickUpColor: "#2BE2A6",
      wickDownColor: "#FF5A5A",
      borderVisible: false,
    });

    // EMA split series (visually one line)
    // IMPORTANT: hide price lines/last value to reduce clutter
    emaUp = chart.addLineSeries({
      color: "#2BE2A6",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    emaDown = chart.addLineSeries({
      color: "#FF5A5A",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // AUX fixed color
    auxSeries = chart.addLineSeries({
      color: "rgba(255,184,108,.85)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    bindResize();

    _inited = true;

    // auto load
    if (opts.autoLoad !== false) {
      load().catch((e) => err("initial load failed:", e.message || e));
    }
  }

  // -----------------------------
  // Load
  // -----------------------------
  async function load() {
    if (_loading) return;
    _loading = true;

    try {
      const sym = getUiSymbol();
      const tf = getUiTf();

      const url = buildDataUrl(sym, tf);
      log("loading:", { sym, tf, url });

      const resp = await fetchJson(url);
      const bars = normalizeBarsFromResponse(resp);

      if (!bars.length) {
        warn("No bars returned. Check backend /api/ohlcv response.");
        // still keep chart visible
        candleSeries.setData([]);
        emaUp.setData([]);
        emaDown.setData([]);
        auxSeries.setData([]);
        setMarkers([]);
        return;
      }

      const { ema, aux } = extractEmaAux(resp, bars);
      const sigs = extractSignals(resp);

      render(bars, ema, aux, sigs);

      // top text hooks (optional)
      const last = bars[bars.length - 1];
      if ($("symText")) $("symText").textContent = sym;
      if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);
      if ($("hintText")) $("hintText").textContent = `Loaded · 已加载（TF=${tf} · sigs=${sigs.length}）`;
    } catch (e) {
      err("load failed:", e && e.message ? e.message : e);

      // keep chart created even if data failed
      if ($("hintText")) $("hintText").textContent = `Load failed · 加载失败`;
    } finally {
      _loading = false;
    }
  }

  // -----------------------------
  // Export PNG (if supported)
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
  // Public API
  // -----------------------------
  window.ChartCore = {
    init,
    load,
    applyToggles,
    exportPNG,
  };

  // -----------------------------
  // Auto boot (safe)
  // -----------------------------
  function autoBoot() {
    try {
      if (window.__DARRIUS_CHARTCORE_BOOTED__) return;
      window.__DARRIUS_CHARTCORE_BOOTED__ = true;

      // If your page uses #chart, boot automatically.
      if (document.getElementById("chart") && window.LightweightCharts) {
        init({ containerId: "chart", autoLoad: true });
      }
    } catch (e) {
      err("autoBoot failed:", e.message || e);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoBoot);
  } else {
    autoBoot();
  }
})();
