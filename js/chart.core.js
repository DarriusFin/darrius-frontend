/* =========================================================
 * DarriusAI · Chart Core (INTEGRATED STABLE VERSION)
 * File: js/chart.core.js
 *
 * Fixes:
 *  - EXACTLY 2 visual lines: EMA(color-switch as ONE line) + AUX
 *  - TRUE "EMPTY_VALUE" using WhitespaceData {time} (prevents vertical spikes)
 *  - Disable priceLine/lastValue lines on EMA/AUX (prevents "3rd line" illusion)
 *  - Robust backend endpoint fallback: /api/market/ohlc -> /api/ohlcv -> /api/ohlc
 *  - Stable markers + overlay (never “丢 B/S”)
 *  - Candles: up green, down red
 *
 * Public:
 *  window.ChartCore = { init, load, applyToggles, exportPNG }
 * ========================================================= */

(function () {
  "use strict";

  /* -----------------------------
   * Utilities
   * ----------------------------- */
  function $(id) {
    return document.getElementById(id);
  }

  function log() {
    if (window.console) console.log.apply(console, arguments);
  }

  function getApiBase() {
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

  // If your backend supports more, you can adjust here.
  const TF_PARAMS = {
    "5m": { ema: 8, aux: 20, cooldown: 10, pivotLookback: 2 },
    "15m": { ema: 9, aux: 21, cooldown: 12, pivotLookback: 2 },
    "30m": { ema: 10, aux: 24, cooldown: 14, pivotLookback: 2 },
    "1h": { ema: 10, aux: 26, cooldown: 16, pivotLookback: 2 },
    "4h": { ema: 12, aux: 30, cooldown: 18, pivotLookback: 2 },
    "1d": { ema: 10, aux: 21, cooldown: 14, pivotLookback: 3 },
    "1w": { ema: 8, aux: 18, cooldown: 10, pivotLookback: 3 },
    "1M": { ema: 6, aux: 14, cooldown: 8, pivotLookback: 3 },
  };

  /* -----------------------------
   * State
   * ----------------------------- */
  let chart = null;
  let candleSeries = null;

  // EMA is implemented as 2 line series (up/down segments),
  // but visually it MUST look like ONE line (color switch).
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
  function genDemoCandles(n, tf, basePrice) {
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
    let price = Number(basePrice || 300); // stock-like default

    const arr = [];
    for (let i = 0; i < n; i++) {
      const wave1 = Math.sin(i / 14) * (price * 0.006);
      const wave2 = Math.sin(i / 33) * (price * 0.012);
      const wave3 = Math.sin(i / 85) * (price * 0.02);
      const noise = (Math.random() - 0.5) * (price * 0.01);
      const drift = Math.sin(i / 170) * (price * 0.008);

      const open = price;
      const close = Math.max(1, open + wave1 + wave2 + wave3 + drift + noise);
      const high = Math.max(open, close) + Math.random() * (price * 0.01);
      const low = Math.min(open, close) - Math.random() * (price * 0.01);

      price = close;

      arr.push({
        time: t,
        open: +open.toFixed(2),
        high: +high.toFixed(2),
        low: +Math.max(0.01, low).toFixed(2),
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
      const v = Number(bars[i].close);
      prev = prev === null ? v : v * k + prev * (1 - k);
      out.push({ time: bars[i].time, value: +prev.toFixed(6) });
    }
    return out;
  }

  /* -----------------------------
   * EMA color switch using TRUE "EMPTY_VALUE"
   * Rule (your “秘籍”逻辑升级版):
   *  - price >= EMA => show UP segment (green)
   *  - price <  EMA => show DOWN segment (red)
   *
   * IMPORTANT:
   *  - Use WhitespaceData {time} to hide (prevents vertical spikes to 0)
   * ----------------------------- */
  function splitEMAByPrice(emaArr, bars) {
    const up = [];
    const down = [];

    for (let i = 0; i < emaArr.length; i++) {
      const t = emaArr[i].time;
      const emaV = Number(emaArr[i].value);
      const px = Number(bars[i]?.close);

      const isUp = px >= emaV;

      if (isUp) {
        up.push({ time: t, value: emaV });
        down.push({ time: t }); // EMPTY_VALUE
      } else {
        down.push({ time: t, value: emaV });
        up.push({ time: t }); // EMPTY_VALUE
      }
    }
    return { up, down };
  }

  /* -----------------------------
   * Small pivot confirm (improves B/S realism a bit)
   * ----------------------------- */
  function isLocalMin(bars, i, lb) {
    const lo = bars[i].low;
    for (let k = 1; k <= lb; k++) {
      if (bars[i - k] && bars[i - k].low < lo) return false;
      if (bars[i + k] && bars[i + k].low < lo) return false;
    }
    return true;
  }

  function isLocalMax(bars, i, lb) {
    const hi = bars[i].high;
    for (let k = 1; k <= lb; k++) {
      if (bars[i - k] && bars[i - k].high > hi) return false;
      if (bars[i + k] && bars[i + k].high > hi) return false;
    }
    return true;
  }

  /* -----------------------------
   * Signal engine: EMA x AUX cross + light pivot confirm
   * ----------------------------- */
  function detectSignals(bars, emaFast, auxSlow, cooldown, pivotLookback) {
    const sigs = [];
    let lastIdx = -1e9;

    const lb = Math.max(1, Number(pivotLookback || 2));

    for (let i = 2; i < bars.length - 2; i++) {
      const prevDiff = Number(emaFast[i - 1].value) - Number(auxSlow[i - 1].value);
      const nowDiff = Number(emaFast[i].value) - Number(auxSlow[i].value);

      if (i - lastIdx < cooldown) continue;

      // Cross up => BUY (prefer local min)
      if (prevDiff <= 0 && nowDiff > 0) {
        if (isLocalMin(bars, i, lb)) {
          sigs.push({ time: bars[i].time, price: bars[i].low, side: "B" });
          lastIdx = i;
        }
      }

      // Cross down => SELL (prefer local max)
      if (prevDiff >= 0 && nowDiff < 0) {
        if (isLocalMax(bars, i, lb)) {
          sigs.push({ time: bars[i].time, price: bars[i].high, side: "S" });
          lastIdx = i;
        }
      }
    }

    return sigs.slice(-40);
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

    if (emaSeriesUp) emaSeriesUp.applyOptions({ visible: showEMA });
    if (emaSeriesDown) emaSeriesDown.applyOptions({ visible: showEMA });
    if (auxSeries) auxSeries.applyOptions({ visible: showAUX });

    repaintOverlay();
  }

  /* -----------------------------
   * Market data fetch (robust endpoint fallback)
   * Expected bar: {time, open, high, low, close}
   * ----------------------------- */
  async function tryFetchJson(url) {
    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return await resp.json();
  }

  function normalizeBars(payload) {
    // Supports:
    //  - { ok:true, bars:[...] }
    //  - { bars:[...] }
    //  - [...]
    const bars = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.bars)
      ? payload.bars
      : payload?.data && Array.isArray(payload.data)
      ? payload.data
      : null;

    if (!bars || bars.length === 0) return null;

    const out = [];
    for (const b of bars) {
      const t = Number(b.time ?? b.t ?? b.timestamp);
      const o = Number(b.open ?? b.o);
      const h = Number(b.high ?? b.h);
      const l = Number(b.low ?? b.l);
      const c = Number(b.close ?? b.c);
      if (!isFinite(t) || !isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
      out.push({ time: t, open: o, high: h, low: l, close: c });
    }
    return out.length ? out : null;
  }

  async function fetchMarketData(symbol, tf) {
    const sym = (symbol || "").trim().toUpperCase();
    const timeframe = (tf || "1d").trim() || "1d";

    // crude crypto detection (backend can ignore)
    const isCrypto =
      sym.includes("/") ||
      sym.endsWith("USDT") ||
      sym.endsWith("USDC") ||
      sym.endsWith("USD");

    const asset = isCrypto ? "crypto" : "stock";

    const base = getApiBase();
    const mk = (path) => (base ? `${base}${path}` : path);

    // IMPORTANT: try multiple endpoints to match your backend reality
    const candidates = [
      mk(`/api/market/ohlc?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(timeframe)}&asset=${encodeURIComponent(asset)}`),
      mk(`/api/ohlcv?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(timeframe)}&asset=${encodeURIComponent(asset)}`),
      mk(`/api/ohlc?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(timeframe)}&asset=${encodeURIComponent(asset)}`),
      mk(`/api/ohlcv?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(timeframe)}`),
      mk(`/api/ohlc?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(timeframe)}`),
    ];

    let lastErr = "";
    for (const url of candidates) {
      try {
        const data = await tryFetchJson(url);
        const bars = normalizeBars(data);
        if (bars && bars.length) {
          return { bars, source: "LIVE", note: "" };
        }
        lastErr = "Invalid payload";
      } catch (e) {
        lastErr = (e && e.message) ? e.message : String(e);
      }
    }

    // fallback demo (scale by likely asset)
    const demoBase = isCrypto ? 70000 : 300;
    const demo = genDemoCandles(DEFAULT_BARS, timeframe, demoBase);
    return { bars: demo, source: "DEMO", note: `fallback: ${lastErr}` };
  }

  /* -----------------------------
   * Load & render
   * ----------------------------- */
  async function load(symbol, tf) {
    if (!chart || !candleSeries) {
      throw new Error("Chart not initialized. Call ChartCore.init() first.");
    }

    const sym = (symbol || getUiSymbol()).trim().toUpperCase();
    const timeframe = (tf || getUiTf()).trim() || "1d";

    const prm = TF_PARAMS[timeframe] || TF_PARAMS["1d"];

    const res = await fetchMarketData(sym, timeframe);
    const bars = res.bars;

    if (!bars || !bars.length) {
      throw new Error("No bars returned");
    }

    CURRENT_BARS = bars;

    // indicators
    const emaArr = calcEMA(bars, prm.ema);
    const auxArr = calcEMA(bars, prm.aux);
    const split = splitEMAByPrice(emaArr, bars);

    // set data
    candleSeries.setData(bars);
    emaSeriesUp.setData(split.up);
    emaSeriesDown.setData(split.down);
    auxSeries.setData(auxArr);

    // signals
    const sigs = detectSignals(bars, emaArr, auxArr, prm.cooldown, prm.pivotLookback);
    CURRENT_SIGS = sigs;

    // Marker colors (as per your preference earlier):
    // B yellow, S white
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

    // top texts
    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

    const tag = res.source === "LIVE" ? "LIVE" : `DEMO (${res.note})`;
    if ($("hintText")) $("hintText").textContent = `Loaded · 已加载（TF=${timeframe} · sigs=${sigs.length}） · ${tag}`;
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

    // Candles: up green, down red (your final requirement)
    candleSeries = chart.addCandlestickSeries({
      upColor: "#2BE2A6",
      downColor: "#FF5A5A",
      wickUpColor: "#2BE2A6",
      wickDownColor: "#FF5A5A",
      borderVisible: false,
    });

    // EMA split series (visually ONE line)
    // IMPORTANT: disable priceLine/lastValue to avoid “extra horizontal lines”
    emaSeriesUp = chart.addLineSeries({
      color: "#2BE2A6",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    emaSeriesDown = chart.addLineSeries({
      color: "#FF5A5A",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // AUX (one line)
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

    try {
      new ResizeObserver(resize).observe(containerEl);
    } catch (_) {
      window.addEventListener("resize", resize);
    }
    window.addEventListener("resize", resize);
    resize();

    // default auto load (do not break boot/index)
    if (opts.autoLoad !== false) {
      load().catch((e) => log("[chart] initial load failed:", e.message || e));
    }
  }

  window.ChartCore = {
    init,
    load,
    applyToggles,
    exportPNG,
  };
})();
