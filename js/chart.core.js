/* =========================================================
 * DarriusAI · Chart Core
 * File: js/chart.core.js
 * Role:
 *  - Candlestick chart
 *  - EMA (green up / red down)
 *  - AUX line
 *  - Signal engine (EMA x AUX cross)
 *  - Markers + big overlay
 *  - Alpaca OHLC via backend proxy
 *  - Demo fallback (always safe)
 * ========================================================= */

(function () {
  "use strict";

  /* -----------------------------
   * Utilities
   * ----------------------------- */
  function $(id) {
    return document.getElementById(id);
  }

  function clamp(x, a, b) {
    return Math.max(a, Math.min(b, x));
  }

  function log() {
    if (window.console) {
      console.log.apply(console, arguments);
    }
  }

  /* -----------------------------
   * Config
   * ----------------------------- */
  const DEFAULT_BARS = 260;

  const TF_PARAMS = {
    "5m": { ema: 8, aux: 20, cooldown: 10 },
    "15m": { ema: 9, aux: 21, cooldown: 12 },
    "30m": { ema: 10, aux: 24, cooldown: 14 },
    "1h": { ema: 10, aux: 26, cooldown: 16 },
    "4h": { ema: 12, aux: 30, cooldown: 18 },
    "1d": { ema: 10, aux: 21, cooldown: 14 },
    "1w": { ema: 8, aux: 18, cooldown: 10 },
    "1M": { ema: 6, aux: 14, cooldown: 8 },
  };

  /* -----------------------------
   * State
   * ----------------------------- */
  let chart = null;
  let candleSeries = null;
  let emaSeriesUp = null;
  let emaSeriesDown = null;
  let auxSeries = null;

  let CURRENT_BARS = [];
  let CURRENT_SIGS = [];

  let containerEl = null;
  let overlayEl = null;

  /* -----------------------------
   * Demo data (fallback)
   * ----------------------------- */
  function genDemoCandles(n, tf) {
    n = n || DEFAULT_BARS;

    const stepMap = {
      "5m": 300,
      "15m": 900,
      "30m": 1800,
      "1h": 3600,
      "4h": 14400,
      "1d": 86400,
      "1w": 604800,
      "1M": 2592000,
    };

    const step = stepMap[tf] || 86400;
    const now = Math.floor(Date.now() / 1000);

    let t = now - n * step;
    let price = 67000;

    const arr = [];

    for (let i = 0; i < n; i++) {
      const wave1 = Math.sin(i / 14) * 220;
      const wave2 = Math.sin(i / 33) * 420;
      const wave3 = Math.sin(i / 85) * 700;
      const noise = (Math.random() - 0.5) * 260;

      const open = price;
      const close = open + wave1 + wave2 + wave3 + noise;
      const high = Math.max(open, close) + Math.random() * 220;
      const low = Math.min(open, close) - Math.random() * 220;

      price = close;

      arr.push({
        time: t,
        open: +open.toFixed(2),
        high: +high.toFixed(2),
        low: +low.toFixed(2),
        close: +close.toFixed(2),
      });

      t += step;
    }

    return arr;
  }

  /* -----------------------------
   * EMA
   * ----------------------------- */
  function calcEMA(bars, period) {
    const p = Math.max(2, Number(period) || 10);
    const k = 2 / (p + 1);

    let prev = null;
    const out = [];

    for (let i = 0; i < bars.length; i++) {
      const v = bars[i].close;
      prev = prev === null ? v : v * k + prev * (1 - k);
      out.push({
        time: bars[i].time,
        value: +prev.toFixed(2),
      });
    }

    return out;
  }

  /* -----------------------------
   * EMA color split (up / down)
   * ----------------------------- */
  function splitEMABySlope(emaArr) {
    const up = [];
    const down = [];

    for (let i = 0; i < emaArr.length; i++) {
      const cur = emaArr[i];
      const prev = emaArr[i - 1];

      if (!prev) {
        up.push(cur);
        down.push({ time: cur.time, value: null });
        continue;
      }

      if (cur.value >= prev.value) {
        up.push(cur);
        down.push({ time: cur.time, value: null });
      } else {
        down.push(cur);
        up.push({ time: cur.time, value: null });
      }
    }

    return { up, down };
  }

  /* -----------------------------
   * Signal engine (EMA x AUX)
   * ----------------------------- */
  function detectSignals(bars, emaFast, auxSlow, cooldown) {
    const sigs = [];
    let lastIdx = -1e9;

    for (let i = 1; i < bars.length; i++) {
      const prevDiff = emaFast[i - 1].value - auxSlow[i - 1].value;
      const nowDiff = emaFast[i].value - auxSlow[i].value;

      if (i - lastIdx < cooldown) continue;

      if (prevDiff <= 0 && nowDiff > 0) {
        sigs.push({
          time: bars[i].time,
          price: bars[i].low,
          side: "B",
        });
        lastIdx = i;
      } else if (prevDiff >= 0 && nowDiff < 0) {
        sigs.push({
          time: bars[i].time,
          price: bars[i].high,
          side: "S",
        });
        lastIdx = i;
      }
    }

    return sigs.slice(-30);
  }

  /* -----------------------------
   * Overlay (BIG B / S)
   * ----------------------------- */
  function repaintOverlay() {
    if (!overlayEl || !chart || !candleSeries) return;

    overlayEl.innerHTML = "";

    const ts = chart.timeScale();

    CURRENT_SIGS.forEach((s) => {
      const x = ts.timeToCoordinate(s.time);
      const y = candleSeries.priceToCoordinate(s.price);

      if (x == null || y == null) return;

      const d = document.createElement("div");
      d.className = "sigMark " + (s.side === "B" ? "buy" : "sell");
      d.style.left = x + "px";
      d.style.top = (y + (s.side === "B" ? 14 : -14)) + "px";
      d.textContent = s.side;

      overlayEl.appendChild(d);
    });
  }

  function bindOverlay() {
    if (!chart) return;
    chart.timeScale().subscribeVisibleTimeRangeChange(repaintOverlay);
    chart.timeScale().subscribeVisibleLogicalRangeChange(repaintOverlay);
  }

  /* -----------------------------
   * Market data (Alpaca → backend)
   * ----------------------------- */
  async function fetchMarketData(symbol, tf) {
    const sym = (symbol || "").trim().toUpperCase();
    const isCrypto =
      sym.includes("/") ||
      sym.endsWith("USDT") ||
      sym.endsWith("USD") ||
      sym.endsWith("USDC");

    const asset = isCrypto ? "crypto" : "stock";

    try {
      const url =
        window.API_BASE +
        `/api/market/ohlc?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(
          tf
        )}&asset=${asset}`;

      const resp = await fetch(url);
      if (!resp.ok) throw new Error("HTTP " + resp.status);

      const data = await resp.json();
      if (!data || !data.ok || !Array.isArray(data.bars)) {
        throw new Error("Invalid payload");
      }

      return data.bars.map((b) => ({
        time: b.time,
        open: +b.open,
        high: +b.high,
        low: +b.low,
        close: +b.close,
      }));
    } catch (e) {
      log("[chart] Alpaca failed, fallback demo:", e.message);
      return genDemoCandles(DEFAULT_BARS, tf);
    }
  }

  /* -----------------------------
   * Load & render
   * ----------------------------- */
  async function load(symbol, tf) {
    const bars = await fetchMarketData(symbol, tf);
    CURRENT_BARS = bars;

    const prm = TF_PARAMS[tf] || TF_PARAMS["1d"];

    const emaArr = calcEMA(bars, prm.ema);
    const auxArr = calcEMA(bars, prm.aux);

    const split = splitEMABySlope(emaArr);

    candleSeries.setData(bars);
    emaSeriesUp.setData(split.up);
    emaSeriesDown.setData(split.down);
    auxSeries.setData(auxArr);

    const sigs = detectSignals(bars, emaArr, auxArr, prm.cooldown);
    CURRENT_SIGS = sigs;

    candleSeries.setMarkers(
      sigs.map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#2BE2A6" : "#FF5A5A",
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: s.side,
      }))
    );

    repaintOverlay();
  }

  /* -----------------------------
   * Init
   * ----------------------------- */
  function init(opts) {
    opts = opts || {};
    containerEl = $(opts.containerId || "chart");
    overlayEl = $(opts.overlayId || "sigOverlay");

    if (!containerEl || !window.LightweightCharts) {
      throw new Error("Chart container or lib missing");
    }

    chart = LightweightCharts.createChart(containerEl, {
      layout: {
        background: { color: "transparent" },
        textColor: "#EAF0F7",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,.04)" },
        horzLines: { color: "rgba(255,255,255,.04)" },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { timeVisible: true, borderVisible: false },
      crosshair: { mode: 1 },
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: "#2BE2A6",
      downColor: "#FF5A5A",
      wickUpColor: "#2BE2A6",
      wickDownColor: "#FF5A5A",
      borderVisible: false,
    });

    emaSeriesUp = chart.addLineSeries({
      color: "#2BE2A6",
      lineWidth: 2,
    });

    emaSeriesDown = chart.addLineSeries({
      color: "#FF5A5A",
      lineWidth: 2,
    });

    auxSeries = chart.addLineSeries({
      color: "rgba(255,184,108,.85)",
      lineWidth: 2,
    });

    bindOverlay();

    const resize = () => {
      const r = containerEl.getBoundingClientRect();
      chart.applyOptions({
        width: Math.floor(r.width),
        height: Math.floor(r.height),
      });
      chart.timeScale().fitContent();
      repaintOverlay();
    };

    new ResizeObserver(resize).observe(containerEl);
    window.addEventListener("resize", resize);

    resize();
  }

  /* -----------------------------
   * Public API
   * ----------------------------- */
  window.ChartCore = {
    init,
    load,
  };
})();
