/* =========================================================
 * DarriusAI - chart.core.js (Integrated, Idempotent Init)
 * Build: 2026-01-19 (fix: duplicate init, null-gaps EMA split)
 * ========================================================= */
(() => {
  "use strict";

  // ---------------- DOM helpers ----------------
  const $ = (id) => document.getElementById(id);
  const log = (...args) => console.log("[ChartCore]", ...args);

  // ---------------- State ----------------
  let chart = null;
  let candleSeries = null;

  // EMA split series (green/red). Only one should be visible per segment.
  let emaUp = null;
  let emaDown = null;

  // AUX (single line)
  let auxSeries = null;

  // Remember last load opts (symbol/tf/apiBase)
  let LAST_OPTS = null;

  // Keep last signals
  let CURRENT_SIGS = [];

  // ---------------- Config ----------------
  const COLORS = {
    candleUp: "#2BE2A6",
    candleDown: "#FF5A5A",
    emaUp: "#2BE2A6",
    emaDown: "#FF5A5A",
    aux: "rgba(255,184,108,.85)",
  };

  // IMPORTANT: use null (not NaN) as "EMPTY_VALUE" equivalent for LightweightCharts gaps
  const GAP = null;

  // ---------------- UI helpers ----------------
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

  function isCheckedAny(ids) {
    for (const id of ids) {
      const el = $(id);
      if (el && el.checked) return true;
    }
    return false;
  }

  function safeNum(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }

  // ---------------- Math: EMA ----------------
  function calcEMA(values, period) {
    const p = Math.max(1, Number(period) || 20);
    const k = 2 / (p + 1);
    const out = new Array(values.length).fill(GAP);
    let ema = null;

    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) {
        out[i] = GAP;
        continue;
      }
      if (ema == null) ema = v;
      else ema = v * k + ema * (1 - k);
      out[i] = ema;
    }
    return out;
  }

  /**
   * Build "color-switch EMA" as TWO series using GAP=null,
   * so visually only one line is present at any time.
   *
   * Trend rule (you can replace later):
   *   close >= ema ? +1 : -1
   *
   * Bridge at switch point so the line doesn't break.
   * Bridge width = 1 bar (prev+current).
   */
  function buildColorSwitchEMA(bars, emaArr) {
    const up = [];
    const down = [];

    let prevTrend = 0;

    for (let i = 0; i < bars.length; i++) {
      const t = bars[i].time;
      const close = safeNum(bars[i].close);
      const ema = safeNum(emaArr[i]);

      if (close == null || ema == null) {
        up.push({ time: t, value: GAP });
        down.push({ time: t, value: GAP });
        continue;
      }

      const trend = close >= ema ? 1 : -1;

      // default: only one side shows
      let upVal = trend > 0 ? ema : GAP;
      let dnVal = trend < 0 ? ema : GAP;

      // Bridge at switch
      if (i > 0 && prevTrend !== 0 && trend !== prevTrend) {
        // previous point: show both
        const tPrev = bars[i - 1].time;
        const emaPrev = safeNum(emaArr[i - 1]);
        if (emaPrev != null) {
          up[i - 1] = { time: tPrev, value: emaPrev };
          down[i - 1] = { time: tPrev, value: emaPrev };
        }
        // current point: show both
        upVal = ema;
        dnVal = ema;
      }

      up.push({ time: t, value: upVal });
      down.push({ time: t, value: dnVal });

      prevTrend = trend;
    }

    return { up, down };
  }

  // ---------------- Markers ----------------
  function applyMarkers(sigs) {
    if (!candleSeries) return;

    const markers = (sigs || []).map((s) => ({
      time: s.time,
      position: s.side === "B" ? "belowBar" : "aboveBar",
      color: s.side === "B" ? "#FFD400" : "#FFFFFF",
      shape: s.side === "B" ? "arrowUp" : "arrowDown",
      text: s.side,
    }));

    candleSeries.setMarkers(markers);
  }

  // ---------------- Toggles ----------------
  function applyToggles() {
    if (!emaUp || !emaDown || !auxSeries) return;

    const showEma = isCheckedAny(["toggleEMA", "emaToggle", "EMA"]);
    const showAux = isCheckedAny(["toggleAUX", "auxToggle", "AUX"]);

    emaUp.applyOptions({ visible: !!showEma });
    emaDown.applyOptions({ visible: !!showEma });
    auxSeries.applyOptions({ visible: !!showAux });
  }

  // ---------------- Fetch ----------------
  async function fetchJSON(url) {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  function resolveApiBase(opts) {
    return (opts && opts.apiBase) || window.API_BASE || "";
  }

  function normalizeBars(raw) {
    const arr = Array.isArray(raw) ? raw : (raw && raw.bars) || [];
    return arr
      .map((b) => ({
        time: b.time, // MUST match your backend format
        open: Number(b.open),
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
      }))
      .filter((b) => b.time != null);
  }

  function normalizeLine(raw, key) {
    if (raw && Array.isArray(raw[key])) return raw[key].map((x) => Number(x));
    return null;
  }

  // ---------------- Core load ----------------
  async function load(opts) {
    opts = opts || {};
    LAST_OPTS = { ...LAST_OPTS, ...opts };

    const sym = (opts.symbol || getUiSymbol()).trim();
    const tf = (opts.timeframe || getUiTf()).trim();
    const apiBase = resolveApiBase(opts);

    const ohlcUrl = `${apiBase}/api/ohlc?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;
    const sigUrl = `${apiBase}/api/sigs?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;

    // ----- OHLC -----
    const rawOhlc = await fetchJSON(ohlcUrl);
    const bars = normalizeBars(rawOhlc);
    if (!bars.length) throw new Error(`No bars returned for ${sym} ${tf}`);

    candleSeries.setData(bars);

    // ----- EMA/AUX -----
    const emaFromApi = normalizeLine(rawOhlc, "ema");
    const auxFromApi = normalizeLine(rawOhlc, "aux");

    const EMA_PERIOD = Number(window.EMA_PERIOD || 20);
    const closes = bars.map((b) => safeNum(b.close));
    const emaArr =
      emaFromApi && emaFromApi.length === bars.length ? emaFromApi : calcEMA(closes, EMA_PERIOD);

    // KEY: split EMA with GAP=null, so only one line shows
    const split = buildColorSwitchEMA(bars, emaArr);
    emaUp.setData(split.up);
    emaDown.setData(split.down);

    // AUX (only if aligned data exists)
    if (auxFromApi && auxFromApi.length === bars.length) {
      const auxData = bars.map((b, i) => ({
        time: b.time,
        value: Number.isFinite(Number(auxFromApi[i])) ? Number(auxFromApi[i]) : GAP,
      }));
      auxSeries.setData(auxData);
    } else {
      auxSeries.setData([]);
    }

    // ----- SIGS (optional) -----
    let sigs = [];
    try {
      const rawS = await fetchJSON(sigUrl);
      sigs = (rawS && rawS.sigs) || [];
    } catch (e) {
      sigs = [];
    }

    CURRENT_SIGS = sigs;
    applyMarkers(sigs);

    applyToggles();

    // top hint
    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);
    if ($("hintText"))
      $("hintText").textContent = `Loaded · 已加载（TF=${tf} · sigs=${sigs.length}） · Build 2026-01-19`;
  }

  // ---------------- Export PNG ----------------
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

  // ---------------- Destroy (critical) ----------------
  function destroyChart() {
    try {
      if (chart) {
        // remove series (safe)
        if (candleSeries) chart.removeSeries(candleSeries);
        if (emaUp) chart.removeSeries(emaUp);
        if (emaDown) chart.removeSeries(emaDown);
        if (auxSeries) chart.removeSeries(auxSeries);
        candleSeries = emaUp = emaDown = auxSeries = null;

        chart.remove();
        chart = null;
      }
    } catch (e) {
      // ignore
    }
  }

  // ---------------- Init (idempotent) ----------------
  function init(opts) {
    opts = opts || {};
    LAST_OPTS = { ...opts };

    const containerId = opts.containerId || "chart";
    const containerEl = $(containerId);

    if (!containerEl || !window.LightweightCharts) {
      throw new Error("Chart container or lightweight-charts missing");
    }

    // CRITICAL: avoid duplicated init/duplicated series overlay
    destroyChart();

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

    // EMA split series (only one visible at a time by GAP)
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

    // AUX
    auxSeries = chart.addLineSeries({
      color: COLORS.aux,
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
      chart.timeScale().fitContent();
    };

    try {
      new ResizeObserver(resize).observe(containerEl);
    } catch (_) {}
    window.addEventListener("resize", resize);
    resize();

    if (opts.autoLoad !== false) {
      load(opts).catch((e) => log("initial load failed:", e.message || e));
    }
  }

  window.ChartCore = { init, load, applyToggles, exportPNG, destroyChart };
})();
