/* =========================================================
 * DarriusAI · Chart Core (FINAL INTEGRATED)
 * File: darrius-frontend/js/chart.core.js
 *
 * What this fixes (your core requirement):
 *  - Only TWO indicators on chart:
 *      1) EMA (color-flip via 2 series + EMPTY_VALUE => value:null)
 *      2) AUX (one series)
 *  - When price ABOVE EMA: show RED EMA, hide GREEN EMA
 *    When price BELOW EMA: show GREEN EMA, hide RED EMA
 *  - Hide = EMPTY_VALUE (LightweightCharts => value: null)
 *  - Add "bridge stitch" on switch (like your x+1 logic) to avoid gaps
 *  - Keep markers + overlay (B yellow, S white)
 *  - Alpaca OHLC via backend proxy (NO KEY on front-end)
 *  - Demo fallback always safe
 *
 * Public:
 *   window.ChartCore = { init, load, applyToggles, exportPNG }
 * ========================================================= */

(function () {
  "use strict";

  /* -----------------------------
   * Utilities
   * ----------------------------- */
  function $(id) { return document.getElementById(id); }

  function log() { if (window.console) console.log.apply(console, arguments); }

  function getApiBase() {
    // boot.js or index.html can set window.API_BASE
    // If empty => relative calls (same-origin proxy setups)
    return (window.API_BASE || "").trim() || "";
  }

  function getUiSymbol() {
    return (($("symbol")?.value || "BTCUSDT") + "").trim().toUpperCase();
  }

  function getUiTf() {
    return (($("tf")?.value || "1d") + "").trim();
  }

  /* -----------------------------
   * Config
   * ----------------------------- */
  const DEFAULT_BARS = 260;

  const TF_PARAMS = {
    "5m":  { ema: 8,  aux: 20, cooldown: 10 },
    "15m": { ema: 9,  aux: 21, cooldown: 12 },
    "30m": { ema: 10, aux: 24, cooldown: 14 },
    "1h":  { ema: 10, aux: 26, cooldown: 16 },
    "4h":  { ema: 12, aux: 30, cooldown: 18 },
    "1d":  { ema: 10, aux: 21, cooldown: 14 },
    "1w":  { ema: 8,  aux: 18, cooldown: 10 },
    "1M":  { ema: 6,  aux: 14, cooldown: 8  },
  };

  /* -----------------------------
   * State
   * ----------------------------- */
  let chart = null;
  let candleSeries = null;

  // EMA = 2 series (RED/GREEN), but only ONE is visible per bar by EMPTY_VALUE (null)
  let emaRed = null;
  let emaGreen = null;

  // AUX = one series (yellow)
  let auxSeries = null;

  let containerEl = null;
  let overlayEl = null;

  let CURRENT_BARS = [];
  let CURRENT_SIGS = [];

  /* -----------------------------
   * Demo data (fallback)
   * ----------------------------- */
  function genDemoCandles(n, tf) {
    n = n || DEFAULT_BARS;

    const stepMap = {
      "5m": 300, "15m": 900, "30m": 1800,
      "1h": 3600, "4h": 14400, "1d": 86400,
      "1w": 604800, "1M": 2592000
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
      const drift = Math.sin(i / 170) * 160;

      const open = price;
      const close = open + wave1 + wave2 + wave3 + drift + noise;
      const high = Math.max(open, close) + Math.random() * 220;
      const low  = Math.min(open, close) - Math.random() * 220;

      price = close;

      arr.push({
        time: t,
        open: +open.toFixed(2),
        high: +high.toFixed(2),
        low:  +low.toFixed(2),
        close:+close.toFixed(2),
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
      prev = (prev === null) ? v : (v * k + prev * (1 - k));
      out.push({ time: bars[i].time, value: +prev.toFixed(2) });
    }
    return out;
  }

  /* -----------------------------
   * Your "EMPTY_VALUE" color flip logic
   *
   * Two lines: RedLine, GreenLine
   * - If price ABOVE EMA => RedLine = EMA, GreenLine = EMPTY_VALUE
   * - If price BELOW EMA => GreenLine = EMA, RedLine = EMPTY_VALUE
   *
   * Plus "bridge stitch" on switch like:
   *   if (trend[x]>0) { Up[x]=...; if(trend[x+1]<0) Up[x+1]=...; Dn[x]=EMPTY; }
   *   if (trend[x]<0) { Dn[x]=...; if(trend[x+1]>0) Dn[x+1]=...; Up[x]=EMPTY; }
   *
   * In LightweightCharts, EMPTY_VALUE => value:null
   * ----------------------------- */
  function buildColorFlipEmaSeries(bars, emaArr) {
    const red = [];
    const green = [];

    // trend[i] = +1 if close >= ema, else -1
    const trend = new Array(emaArr.length);

    for (let i = 0; i < emaArr.length; i++) {
      const e = emaArr[i]?.value;
      const c = bars[i]?.close;
      trend[i] = (c >= e) ? 1 : -1;
    }

    for (let i = 0; i < emaArr.length; i++) {
      const t = emaArr[i].time;
      const v = emaArr[i].value;

      if (trend[i] > 0) {
        // Price above EMA => show RED, hide GREEN
        red.push({ time: t, value: v });
        green.push({ time: t, value: null }); // EMPTY_VALUE

        // bridge stitch to next bar if next trend flips down
        if (i + 1 < emaArr.length && trend[i + 1] < 0) {
          red.push({ time: emaArr[i + 1].time, value: emaArr[i + 1].value });
          // NOTE: green at i+1 will be set by its own branch below
        }
      } else {
        // Price below EMA => show GREEN, hide RED
        green.push({ time: t, value: v });
        red.push({ time: t, value: null }); // EMPTY_VALUE

        // bridge stitch to next bar if next trend flips up
        if (i + 1 < emaArr.length && trend[i + 1] > 0) {
          green.push({ time: emaArr[i + 1].time, value: emaArr[i + 1].value });
          // NOTE: red at i+1 will be set by its own branch above
        }
      }
    }

    // The above "bridge push" may create duplicate timestamps at i+1.
    // LightweightCharts expects monotonic time with unique points per series.
    // So we must de-duplicate by time keeping the last assignment.
    function dedup(series) {
      const m = new Map();
      for (const p of series) m.set(p.time, p.value);
      const out = [];
      for (const [time, value] of m.entries()) out.push({ time, value });
      out.sort((a, b) => a.time - b.time);
      return out;
    }

    return { red: dedup(red), green: dedup(green) };
  }

  /* -----------------------------
   * Signal engine (EMA x AUX cross)
   * ----------------------------- */
  function detectSignals(bars, emaFast, auxSlow, cooldown) {
    const sigs = [];
    let lastIdx = -1e9;

    for (let i = 1; i < bars.length; i++) {
      const prevDiff = emaFast[i - 1].value - auxSlow[i - 1].value;
      const nowDiff  = emaFast[i].value - auxSlow[i].value;

      if (i - lastIdx < cooldown) continue;

      if (prevDiff <= 0 && nowDiff > 0) {
        sigs.push({ time: bars[i].time, price: bars[i].low, side: "B" });
        lastIdx = i;
      } else if (prevDiff >= 0 && nowDiff < 0) {
        sigs.push({ time: bars[i].time, price: bars[i].high, side: "S" });
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
    if (!CURRENT_SIGS || CURRENT_SIGS.length === 0) return;

    const ts = chart.timeScale();
    for (const s of CURRENT_SIGS) {
      const x = ts.timeToCoordinate(s.time);
      const y = candleSeries.priceToCoordinate(s.price);
      if (x == null || y == null) continue;

      const d = document.createElement("div");
      d.className = "sigMark " + (s.side === "B" ? "buy" : "sell");
      d.style.left = x + "px";
      d.style.top = (y + (s.side === "B" ? 14 : -14)) + "px";
      d.textContent = s.side;

      overlayEl.appendChild(d);
    }
  }

  function bindOverlay() {
    if (!chart) return;
    chart.timeScale().subscribeVisibleTimeRangeChange(repaintOverlay);
    chart.timeScale().subscribeVisibleLogicalRangeChange(repaintOverlay);
  }

  /* -----------------------------
   * Toggles: EMA / AUX (UI checkboxes)
   * ----------------------------- */
  function applyToggles() {
    const showEMA = $("tgEMA") ? !!$("tgEMA").checked : true;
    const showAUX = $("tgAux") ? !!$("tgAux").checked : true;

    if (emaRed)   emaRed.applyOptions({ visible: showEMA });
    if (emaGreen) emaGreen.applyOptions({ visible: showEMA });
    if (auxSeries) auxSeries.applyOptions({ visible: showAUX });

    repaintOverlay();
  }

  /* -----------------------------
   * Market data (Alpaca → backend proxy)
   * Endpoint:
   *   GET /api/market/ohlc?symbol=...&tf=...&asset=stock|crypto
   * Response:
   *   { ok:true, bars:[{time,open,high,low,close}, ...] }
   * ----------------------------- */
  async function fetchMarketData(symbol, tf) {
    const sym = (symbol || "").trim().toUpperCase();
    const timeframe = (tf || "1d").trim();

    const isCrypto =
      sym.includes("/") || sym.endsWith("USDT") || sym.endsWith("USDC") || sym.endsWith("USD");
    const asset = isCrypto ? "crypto" : "stock";

    try {
      const base = getApiBase();
      const path =
        `/api/market/ohlc?symbol=${encodeURIComponent(sym)}` +
        `&tf=${encodeURIComponent(timeframe)}` +
        `&asset=${encodeURIComponent(asset)}`;

      const url = base ? `${base}${path}` : path;

      const resp = await fetch(url, { method: "GET" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);

      const data = await resp.json();
      if (!data || data.ok !== true || !Array.isArray(data.bars) || data.bars.length === 0) {
        throw new Error("Invalid payload");
      }

      // sanitize bars to numbers
      const bars = data.bars.map((b) => ({
        time: Number(b.time),
        open: +b.open,
        high: +b.high,
        low:  +b.low,
        close:+b.close,
      }));

      return bars;
    } catch (e) {
      log("[chart] Market data failed -> demo fallback:", e.message || e);
      return genDemoCandles(DEFAULT_BARS, timeframe);
    }
  }

  /* -----------------------------
   * Load & render
   * - Supports no-args call: load() reads UI
   * ----------------------------- */
  async function load(symbol, tf) {
    if (!chart || !candleSeries) throw new Error("Chart not initialized. Call ChartCore.init() first.");

    const sym = (symbol || getUiSymbol()).trim().toUpperCase();
    const timeframe = (tf || getUiTf()).trim() || "1d";

    const bars = await fetchMarketData(sym, timeframe);
    CURRENT_BARS = bars;

    const prm = TF_PARAMS[timeframe] || TF_PARAMS["1d"];

    const emaArr = calcEMA(bars, prm.ema);
    const auxArr = calcEMA(bars, prm.aux);

    const flip = buildColorFlipEmaSeries(bars, emaArr);

    candleSeries.setData(bars);
    emaRed.setData(flip.red);
    emaGreen.setData(flip.green);
    auxSeries.setData(auxArr);

    // signals
    const sigs = detectSignals(bars, emaArr, auxArr, prm.cooldown);
    CURRENT_SIGS = sigs;

    // markers colors: B yellow, S white
    candleSeries.setMarkers(
      sigs.map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#FFD400" : "#FFFFFF",
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: s.side,
      }))
    );

    applyToggles();
    repaintOverlay();

    // top text
    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);
    if ($("hintText")) $("hintText").textContent = `Loaded · 已加载（TF=${timeframe} · sigs=${sigs.length}）`;
  }

  /* -----------------------------
   * Export PNG
   * ----------------------------- */
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

  /* -----------------------------
   * Init
   * ----------------------------- */
  function init(opts) {
    opts = opts || {};
    const containerId = opts.containerId || "chart";
    const overlayId = opts.overlayId || "sigOverlay";

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
      upColor: "#2BE2A6",
      downColor: "#FF5A5A",
      wickUpColor: "#2BE2A6",
      wickDownColor: "#FF5A5A",
      borderVisible: false,
    });

    // EMA (RED/GREEN) — IMPORTANT: hide price line & last value label to avoid "extra line" feeling
    emaRed = chart.addLineSeries({
      color: "#FF5A5A",            // red
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    emaGreen = chart.addLineSeries({
      color: "#2BE2A6",            // green
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // AUX (yellow)
    auxSeries = chart.addLineSeries({
      color: "rgba(255,184,108,.85)",
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

    try { new ResizeObserver(resize).observe(containerEl); } catch (_) {}
    window.addEventListener("resize", resize);
    resize();

    // default auto load (do not break your existing boot/index)
    if (opts.autoLoad !== false) {
      load().catch((e) => log("[chart] initial load failed:", e.message || e));
    }
  }

  /* -----------------------------
   * Public API
   * ----------------------------- */
  window.ChartCore = { init, load, applyToggles, exportPNG };
})();
