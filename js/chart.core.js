/* =========================================================
 * DarriusAI - chart.core.js (Integrated)
 * Goal:
 *  - Candles
 *  - EMA color-switch (2 series, but only ONE visible at a time via NaN gaps)
 *  - AUX single line
 *  - B/S markers
 *  - Toggles
 * ========================================================= */
(() => {
  "use strict";

  // ---------- DOM helpers ----------
  const $ = (id) => document.getElementById(id);
  const log = (...args) => console.log(...args);

  // ---------- State ----------
  let chart = null;
  let candleSeries = null;

  // EMA split series (green/red) but only one shows at a time
  let emaUp = null;
  let emaDown = null;

  // AUX
  let auxSeries = null;

  // overlay (optional)
  let containerEl = null;
  let overlayEl = null;

  // keep last sigs for export/share overlay usage
  let CURRENT_SIGS = [];

  // ---------- Config ----------
  const COLORS = {
    candleUp: "#2BE2A6",
    candleDown: "#FF5A5A",
    emaUp: "#2BE2A6",
    emaDown: "#FF5A5A",
    aux: "rgba(255,184,108,.85)",
  };

  const DEFAULTS = {
    containerId: "chart",
    overlayId: "sigOverlay",
    // endpoints: keep compatible with your existing backend routes
    // will call: `${apiBase}/api/ohlc?symbol=...&tf=...`
    // and:      `${apiBase}/api/sigs?symbol=...&tf=...`
    apiBase: "",
    autoLoad: true,
  };

  // ---------- Utilities ----------
  function getUiSymbol() {
    const el = $("symInput") || $("symbolInput") || $("symbol");
    const v = el ? (el.value || el.textContent || "").trim() : "";
    return v || "BTCUSDT";
  }

  function getUiTf() {
    const el = $("tfInput") || $("timeframeInput") || $("timeframe");
    const v = el ? (el.value || el.textContent || "").trim() : "";
    return v || "1d";
  }

  function isChecked(id) {
    const el = $(id);
    return !!(el && el.checked);
  }

  function safeNum(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : NaN;
  }

  // Simple EMA (single array)
  function calcEMA(values, period) {
    const p = Math.max(1, Number(period) || 20);
    const k = 2 / (p + 1);
    const out = new Array(values.length).fill(NaN);
    let ema = NaN;

    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) {
        out[i] = NaN;
        continue;
      }
      if (!Number.isFinite(ema)) {
        ema = v; // seed
      } else {
        ema = v * k + ema * (1 - k);
      }
      out[i] = ema;
    }
    return out;
  }

  /**
   * Build "color-switch EMA" using NaN gaps (LightweightCharts equivalent of EMPTY_VALUE)
   * Trend rule: close >= ema ? +1 : -1
   * Bridge at switch to avoid discontinuity.
   */
  function buildColorSwitchEMA(bars, emaArr) {
    const up = [];
    const down = [];

    let prevTrend = 0;

    for (let i = 0; i < bars.length; i++) {
      const t = bars[i].time;
      const close = safeNum(bars[i].close);
      const ema = safeNum(emaArr[i]);

      // If ema not ready, hide both
      if (!Number.isFinite(ema) || !Number.isFinite(close)) {
        up.push({ time: t, value: NaN });
        down.push({ time: t, value: NaN });
        continue;
      }

      const trend = close >= ema ? 1 : -1;

      // default: only one side shows
      let upVal = trend > 0 ? ema : NaN;
      let dnVal = trend < 0 ? ema : NaN;

      // Bridge at switch: set BOTH at boundary points (i-1 and i)
      if (i > 0 && prevTrend !== 0 && trend !== prevTrend) {
        // make previous point show on both
        const tPrev = bars[i - 1].time;
        const emaPrev = safeNum(emaArr[i - 1]);

        if (Number.isFinite(emaPrev)) {
          up[i - 1] = { time: tPrev, value: emaPrev };
          down[i - 1] = { time: tPrev, value: emaPrev };
        }
        // make current point show on both
        upVal = ema;
        dnVal = ema;
      }

      up.push({ time: t, value: upVal });
      down.push({ time: t, value: dnVal });

      prevTrend = trend;
    }

    return { up, down };
  }

  // ---------- Markers ----------
  function applyMarkers(sigs) {
    if (!candleSeries) return;

    // Use your requested colors:
    // B yellow, S white
    const markers = (sigs || []).map((s) => ({
      time: s.time,
      position: s.side === "B" ? "belowBar" : "aboveBar",
      color: s.side === "B" ? "#FFD400" : "#FFFFFF",
      shape: s.side === "B" ? "arrowUp" : "arrowDown",
      text: s.side,
    }));

    candleSeries.setMarkers(markers);
  }

  // ---------- Toggles ----------
  function applyToggles() {
    if (!emaUp || !emaDown || !auxSeries) return;

    const showEma = isChecked("toggleEMA") || isChecked("emaToggle") || isChecked("EMA");
    const showAux = isChecked("toggleAUX") || isChecked("auxToggle") || isChecked("AUX");

    emaUp.applyOptions({ visible: !!showEma });
    emaDown.applyOptions({ visible: !!showEma });
    auxSeries.applyOptions({ visible: !!showAux });
  }

  // ---------- Overlay (optional, safe no-op) ----------
  function bindOverlay() {
    // keep as no-op unless you already have overlay canvas logic
    // (not required for core chart)
  }
  function repaintOverlay() {
    // no-op
  }

  // ---------- Fetch ----------
  async function fetchJSON(url) {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  function resolveApiBase(opts) {
    // Prefer explicit opts.apiBase, then window.API_BASE, then empty (same origin)
    return (opts && opts.apiBase) || window.API_BASE || "";
  }

  /**
   * Expected backend JSON formats:
   *  - /api/ohlc -> { bars: [{time,open,high,low,close}, ...], ema?:[], aux?:[] }
   *  - /api/sigs -> { sigs: [{time, side:"B"|"S"}, ...] }
   * If your backend differs, adjust mapping in normalizeBars/normalizeSeries below.
   */
  function normalizeBars(raw) {
    const arr = Array.isArray(raw) ? raw : (raw && raw.bars) || [];
    return arr
      .map((b) => ({
        time: b.time, // should already be unix seconds or business day; keep your current format
        open: Number(b.open),
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
      }))
      .filter((b) => b.time != null);
  }

  function normalizeLine(raw, key) {
    // accept raw[key] as array of numbers aligned with bars
    if (raw && Array.isArray(raw[key])) return raw[key].map((x) => Number(x));
    return null;
  }

  // ---------- Core load ----------
  async function load(opts) {
    opts = opts || {};
    const sym = (opts.symbol || getUiSymbol()).trim();
    const tf = (opts.timeframe || getUiTf()).trim();
    const apiBase = resolveApiBase(opts);

    const ohlcUrl = `${apiBase}/api/ohlc?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;
    const sigUrl = `${apiBase}/api/sigs?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;

    let bars = [];
    let sigs = [];

    // --- Fetch OHLC ---
    let rawOhlc = null;
    try {
      rawOhlc = await fetchJSON(ohlcUrl);
    } catch (e) {
      log("[chart] ohlc fetch failed:", e.message || e);
      rawOhlc = null;
    }

    bars = normalizeBars(rawOhlc);
    if (!bars.length) {
      // avoid blank chart
      throw new Error(`No bars returned for ${sym} ${tf}`);
    }

    // --- Fetch SIGS (optional) ---
    try {
      const rawS = await fetchJSON(sigUrl);
      sigs = (rawS && rawS.sigs) || [];
    } catch (e) {
      // not fatal
      sigs = [];
    }

    // ---------- Render candles ----------
    candleSeries.setData(bars);

    // ---------- EMA / AUX ----------
    // If backend already gives EMA/AUX arrays aligned with bars, use them; else compute EMA locally.
    const emaFromApi = normalizeLine(rawOhlc, "ema");
    const auxFromApi = normalizeLine(rawOhlc, "aux");

    // Period (optional). If you have a UI control, wire it here.
    const EMA_PERIOD = Number((window.EMA_PERIOD || 20));

    const closes = bars.map((b) => safeNum(b.close));
    const emaArr = emaFromApi && emaFromApi.length === bars.length ? emaFromApi : calcEMA(closes, EMA_PERIOD);

    // Build NaN-gap split series (THIS is the critical fix)
    const split = buildColorSwitchEMA(bars, emaArr);
    emaUp.setData(split.up);
    emaDown.setData(split.down);

    // AUX: if API aligned, use; else hide (or compute your own)
    if (auxFromApi && auxFromApi.length === bars.length) {
      const auxData = bars.map((b, i) => ({ time: b.time, value: Number(auxFromApi[i]) }));
      auxSeries.setData(auxData);
    } else {
      // keep empty unless your system computes it elsewhere
      auxSeries.setData([]);
    }

    // ---------- Markers ----------
    CURRENT_SIGS = sigs;
    applyMarkers(sigs);

    // ---------- Apply toggles ----------
    applyToggles();
    repaintOverlay();

    // ---------- Top text ----------
    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);
    if ($("hintText")) $("hintText").textContent = `Loaded · 已加载（TF=${tf} · sigs=${sigs.length}）`;
  }

  // ---------- Export PNG ----------
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

  // ---------- Init ----------
  function init(opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    const containerId = opts.containerId || DEFAULTS.containerId;
    const overlayId = opts.overlayId || DEFAULTS.overlayId;

    containerEl = $(containerId);
    overlayEl = $(overlayId);

    if (!containerEl || !window.LightweightCharts) {
      throw new Error("Chart container or lightweight-charts missing");
    }

    chart = LightweightCharts.createChart(containerEl, {
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
      upColor: COLORS.candleUp,
      downColor: COLORS.candleDown,
      wickUpColor: COLORS.candleUp,
      wickDownColor: COLORS.candleDown,
      borderVisible: false,
    });

    // EMA split series (IMPORTANT: use NaN gaps, and hide last price line)
    emaUp = chart.addLineSeries({
      color: COLORS.emaUp,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    emaDown = chart.addLineSeries({
      color: COLORS.emaDown,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // AUX single line
    auxSeries = chart.addLineSeries({
      color: COLORS.aux,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    bindOverlay();

    const resize = () => {
      const r = containerEl.getBoundingClientRect();
      chart.applyOptions({
        width: Math.max(1, Math.floor(r.width)),
        height: Math.max(1, Math.floor(r.height)),
      });
      chart.timeScale().fitContent();
      repaintOverlay();
    };

    try {
      new ResizeObserver(resize).observe(containerEl);
    } catch (_) {}
    window.addEventListener("resize", resize);
    resize();

    // default auto load
    if (opts.autoLoad !== false) {
      load(opts).catch((e) => log("[chart] initial load failed:", e.message || e));
    }
  }

  window.ChartCore = { init, load, applyToggles, exportPNG };
})();
