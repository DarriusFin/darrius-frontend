(() => {
  "use strict";

  /* ============================
   * DOM helpers
   * ============================ */
  const $ = (id) => document.getElementById(id);

  /* ============================
   * Config (FROZEN)
   * ============================ */
  const API_BASE =
    window.DARRIUS_API_BASE ||
    window._API_BASE_ ||
    "https://darrius-api.onrender.com";

  // ✔ VERIFIED working endpoint
  const BARS_ENDPOINT = "/api/market/bars";

  // Optional signal endpoints (silent try)
  const SIGNAL_ENDPOINTS = [
    "/api/market/sigs",
    "/api/market/signals",
  ];

  /* ============================
   * State
   * ============================ */
  let chart, candleSeries;
  let emaUp, emaDown;
  let auxSeries;

  /* ============================
   * Utils
   * ============================ */
  const toSec = (t) =>
    typeof t === "number"
      ? (t > 1e12 ? Math.floor(t / 1000) : t)
      : Math.floor(Date.parse(t) / 1000);

  const fetchJSON = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(HTTP ${r.status});
    return r.json();
  };

  /* ============================
   * EMA compute (fallback)
   * ============================ */
  function computeEMA(bars, period = 20) {
    const k = 2 / (period + 1);
    let ema = null;
    return bars.map((b) => {
      ema = ema === null ? b.close : b.close * k + ema * (1 - k);
      return { time: b.time, value: ema };
    });
  }

  /* ============================
   * ABSOLUTE NO-OVERLAP EMA
   * ============================ */
  function splitEMA(bars, emaPts) {
    const map = new Map(emaPts.map((e) => [e.time, e.value]));
    const up = [];
    const down = [];

    bars.forEach((b) => {
      const ema = map.get(b.time);
      if (!Number.isFinite(ema)) return;

      if (b.close >= ema) {
        up.push({ time: b.time, value: ema });
        down.push({ time: b.time, value: null });
      } else {
        up.push({ time: b.time, value: null });
        down.push({ time: b.time, value: ema });
      }
    });

    return { up, down };
  }

  /* ============================
   * Load BARS
   * ============================ */
  async function loadBars(symbol, tf) {
    const url = ${API_BASE}${BARS_ENDPOINT}?symbol=${symbol}&tf=${tf};
    const data = await fetchJSON(url);

    return data.bars.map((b) => ({
      time: toSec(b.time),
      open: +b.open,
      high: +b.high,
      low: +b.low,
      close: +b.close,
    }));
  }

  /* ============================
   * Load optional signals
   * ============================ */
  async function loadSignals(symbol, tf) {
    for (const ep of SIGNAL_ENDPOINTS) {
      try {
        const url = ${API_BASE}${ep}?symbol=${symbol}&tf=${tf};
        const data = await fetchJSON(url);
        if (Array.isArray(data)) return data;
      } catch (_) {}
    }
    return [];
  }

  /* ============================
   * Core load
   * ============================ */
  async function load() {
    const symbol = $("symbol")?.value || "BTCUSDT";
    const tf = $("timeframe")?.value || "1d";

    const bars = await loadBars(symbol, tf);
    candleSeries.setData(bars);

    const emaPts = computeEMA(bars, 20);
    const split = splitEMA(bars, emaPts);

    emaUp.setData(split.up);
    emaDown.setData(split.down);

    // Optional signals
    const sigs = await loadSignals(symbol, tf);
    candleSeries.setMarkers(
      sigs.map((s) => ({
        time: toSec(s.time),
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#FFD400" : "#FFFFFF",
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: s.side,
      }))
    );

    chart.timeScale().fitContent();
  }

  /* ============================
   * Init (IDEMPOTENT)
   * ============================ */
  function init() {
    if (chart) return;

    const container = $("chart");
    if (!container || !window.LightweightCharts) {
      console.error("Chart container or library missing");
      return;
    }

    chart = LightweightCharts.createChart(container, {
      layout: { background: { color: "transparent" }, textColor: "#EAF0F7" },
      grid: {
        vertLines: { color: "rgba(255,255,255,.04)" },
        horzLines: { color: "rgba(255,255,255,.04)" },
      },
      timeScale: { borderVisible: false },
      rightPriceScale: { borderVisible: false },
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: "#2BE2A6",
      downColor: "#FF5A5A",
      wickUpColor: "#2BE2A6",
      wickDownColor: "#FF5A5A",
      borderVisible: false,
    });

    emaUp = chart.addLineSeries({
      color: "#2BE2A6",
      lineWidth: 2,
      lastValueVisible: false,
    });

    emaDown = chart.addLineSeries({
      color: "#FF5A5A",
      lineWidth: 2,
      lastValueVisible: false,
    });

    auxSeries = chart.addLineSeries({
      color: "rgba(255,184,108,.85)",
      lineWidth: 2,
      visible: false,
    });

    window.addEventListener("resize", () => {
      chart.resize(container.clientWidth, container.clientHeight);
    });

    load().catch(console.error);
  }

  /* ============================
   * Expose
   * ============================ */
  window.ChartCore = {
    init,
    load,
  };
})();
