/* =========================================================
 * DarriusAI · Chart Core (INTEGRATED STABLE VERSION)
 * File: js/chart.core.js
 * Role:
 *  - Candlestick chart (Lightweight-Charts)
 *  - EMA color-changing (green up / red down) via split series with proper gaps
 *  - AUX line
 *  - Signal engine (EMA x AUX cross + mild swing filter)
 *  - Markers + overlay
 *  - Alpaca OHLC via backend proxy (NO KEY on front-end)
 *  - Demo fallback (safe)
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

  function isCryptoSymbol(sym) {
    const s = (sym || "").toUpperCase();
    return (
      s.includes("/") ||
      s.endsWith("USDT") ||
      s.endsWith("USDC") ||
      s.endsWith("USD") ||
      s === "BTC" ||
      s === "ETH"
    );
  }

  /* -----------------------------
   * Config
   * ----------------------------- */
  const DEFAULT_BARS = 260;

  // Note: these are internal params
  const TF_PARAMS = {
    "5m": { ema: 8, aux: 20, cooldown: 10, swingLookback: 6 },
    "15m": { ema: 9, aux: 21, cooldown: 12, swingLookback: 7 },
    "30m": { ema: 10, aux: 24, cooldown: 14, swingLookback: 8 },
    "1h": { ema: 10, aux: 26, cooldown: 16, swingLookback: 9 },
    "4h": { ema: 12, aux: 30, cooldown: 18, swingLookback: 10 },
    "1d": { ema: 10, aux: 21, cooldown: 14, swingLookback: 8 },
    "1w": { ema: 8, aux: 18, cooldown: 10, swingLookback: 6 },
    "1M": { ema: 6, aux: 14, cooldown: 8, swingLookback: 5 },
  };

  /* -----------------------------
   * State
   * ----------------------------- */
  let chart = null;
  let candleSeries = null;

  // EMA split series (visually ONE EMA that changes color)
  let emaSeriesUp = null;
  let emaSeriesDown = null;

  // AUX
  let auxSeries = null;

  let CURRENT_BARS = [];
  let CURRENT_SIGS = [];

  let containerEl = null;
  let overlayEl = null;

  /* -----------------------------
   * Inject overlay style (so you don't chase CSS files)
   * ----------------------------- */
  function ensureOverlayStyle() {
    if (document.getElementById("daiChartCoreStyle")) return;
    const style = document.createElement("style");
    style.id = "daiChartCoreStyle";
    style.textContent = `
      #sigOverlay{ position:absolute; inset:0; pointer-events:none; }
      .sigMark{
        position:absolute;
        transform: translate(-50%, -50%);
        font-weight: 800;
        font-size: 11px;     /* <- smaller as you asked */
        line-height: 1;
        padding: 4px 6px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,.12);
        backdrop-filter: blur(2px);
        box-shadow: 0 6px 18px rgba(0,0,0,.35);
      }
      .sigMark.buy{ background: rgba(255, 212, 0, .92); color:#111; }
      .sigMark.sell{ background: rgba(255,255,255,.92); color:#111; }
    `;
    document.head.appendChild(style);
  }

  /* -----------------------------
   * Demo data (fallback)
   * - Different starting price for stock/crypto to look "real"
   * ----------------------------- */
  function genDemoCandles(n, tf, asset) {
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

    // crypto starts high; stock starts in a few hundred range
    let price = asset === "stock" ? 480 : 67000;

    const arr = [];
    for (let i = 0; i < n; i++) {
      const wave1 = Math.sin(i / 14) * (asset === "stock" ? 2.2 : 220);
      const wave2 = Math.sin(i / 33) * (asset === "stock" ? 4.2 : 420);
      const wave3 = Math.sin(i / 85) * (asset === "stock" ? 7.0 : 700);
      const noise = (Math.random() - 0.5) * (asset === "stock" ? 2.6 : 260);
      const drift = Math.sin(i / 170) * (asset === "stock" ? 1.6 : 160);

      const open = price;
      const close = open + wave1 + wave2 + wave3 + drift + noise;
      const high = Math.max(open, close) + Math.random() * (asset === "stock" ? 2.2 : 220);
      const low = Math.min(open, close) - Math.random() * (asset === "stock" ? 2.2 : 220);

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
   * Normalize bars
   * - time: ms -> sec
   * - price: cents -> dollars (heuristic for stock)
   * - sanitize numeric fields
   * ----------------------------- */
  function normalizeBars(bars, asset) {
    if (!Array.isArray(bars) || bars.length === 0) return [];

    // time normalize
    let timeSample = Number(bars[Math.min(3, bars.length - 1)]?.time);
    const timeIsMs = Number.isFinite(timeSample) && timeSample > 1e12;

    const out = bars
      .map((b) => {
        const t0 = Number(b.time);
        const t = timeIsMs ? Math.floor(t0 / 1000) : Math.floor(t0);
        const o = Number(b.open);
        const h = Number(b.high);
        const l = Number(b.low);
        const c = Number(b.close);
        if (![t, o, h, l, c].every(Number.isFinite)) return null;
        return { time: t, open: o, high: h, low: l, close: c };
      })
      .filter(Boolean);

    if (out.length === 0) return [];

    // stock price scaling heuristic
    if (asset === "stock") {
      const closes = out.map((x) => x.close).slice(-60);
      closes.sort((a, b) => a - b);
      const median = closes[Math.floor(closes.length / 2)];

      // If absurdly large, likely cents (x100) or something similar
      // Keep scaling down until within a sane stock range (< 5000)
      let factor = 1;
      while (median / factor > 5000) factor *= 10;

      // common cents case: 225000 -> /1000 or /100; this loop handles both.
      if (factor > 1) {
        for (const b of out) {
          b.open = b.open / factor;
          b.high = b.high / factor;
          b.low = b.low / factor;
          b.close = b.close / factor;
        }
      }
    }

    // Ensure high/low sanity
    for (const b of out) {
      const hi = Math.max(b.open, b.close, b.high);
      const lo = Math.min(b.open, b.close, b.low);
      b.high = hi;
      b.low = lo;
    }

    return out;
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
      out.push({ time: bars[i].time, value: +prev.toFixed(4) });
    }
    return out;
  }

  /* -----------------------------
   * EMA color split (up / down) with PROPER gaps
   * - IMPORTANT: to create gaps in Lightweight-Charts line series:
   *   use {time} (no 'value' key), NOT value:null
   * ----------------------------- */
  function splitEMABySlope(emaArr) {
    const up = [];
    const down = [];

    for (let i = 0; i < emaArr.length; i++) {
      const cur = emaArr[i];
      const prev = emaArr[i - 1];

      if (!prev) {
        up.push({ time: cur.time, value: cur.value });
        down.push({ time: cur.time }); // gap
        continue;
      }

      if (cur.value >= prev.value) {
        up.push({ time: cur.time, value: cur.value });
        down.push({ time: cur.time }); // gap
      } else {
        down.push({ time: cur.time, value: cur.value });
        up.push({ time: cur.time }); // gap
      }
    }

    return { up, down };
  }

  /* -----------------------------
   * Signal engine
   * - Base: EMA x AUX cross
   * - Add a mild swing filter (past-only) to avoid random B/S
   * ----------------------------- */
  function detectSignals(bars, emaFast, auxSlow, cooldown, swingLookback) {
    const sigs = [];
    let lastIdx = -1e9;

    const L = Math.max(3, Number(swingLookback) || 8);

    function isLocalLow(i) {
      const from = Math.max(0, i - L + 1);
      let mn = Infinity;
      for (let k = from; k <= i; k++) mn = Math.min(mn, bars[k].low);
      // require this bar to be near recent min + bullish close
      return bars[i].low <= mn * 1.0005 && bars[i].close >= bars[i].open;
    }

    function isLocalHigh(i) {
      const from = Math.max(0, i - L + 1);
      let mx = -Infinity;
      for (let k = from; k <= i; k++) mx = Math.max(mx, bars[k].high);
      return bars[i].high >= mx * 0.9995 && bars[i].close <= bars[i].open;
    }

    for (let i = 1; i < bars.length; i++) {
      const prevDiff = emaFast[i - 1].value - auxSlow[i - 1].value;
      const nowDiff = emaFast[i].value - auxSlow[i].value;

      if (i - lastIdx < cooldown) continue;

      // Buy: cross up + mild local-low filter
      if (prevDiff <= 0 && nowDiff > 0 && isLocalLow(i)) {
        sigs.push({ time: bars[i].time, price: bars[i].low, side: "B" });
        lastIdx = i;
      }

      // Sell: cross down + mild local-high filter
      if (prevDiff >= 0 && nowDiff < 0 && isLocalHigh(i)) {
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
   * Toggles: EMA / AUX
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
   * Market data (backend proxy)
   * Endpoint expected:
   *  GET /api/market/ohlc?symbol=...&tf=...&asset=stock|crypto
   * Response:
   *  { ok:true, bars:[{time,open,high,low,close}, ...] }
   * ----------------------------- */
  async function fetchMarketData(symbol, tf) {
    const sym = (symbol || "").trim().toUpperCase();
    const timeframe = (tf || "1d").trim() || "1d";

    const asset = isCryptoSymbol(sym) ? "crypto" : "stock";

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

      const raw = data.bars.map((b) => ({
        time: Number(b.time),
        open: Number(b.open),
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
      }));

      const norm = normalizeBars(raw, asset);
      if (!norm.length) throw new Error("Normalized bars empty");

      return { bars: norm, asset, isFallback: false, fallbackNote: "" };
    } catch (e) {
      const note = e && e.message ? e.message : String(e);
      log("[chart] Market data failed -> demo fallback:", note);

      const demo = genDemoCandles(DEFAULT_BARS, timeframe, asset);
      return { bars: demo, asset, isFallback: true, fallbackNote: note };
    }
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

    CURRENT_BARS = bars;

    const emaArr = calcEMA(bars, prm.ema);
    const auxArr = calcEMA(bars, prm.aux);
    const split = splitEMABySlope(emaArr);

    candleSeries.setData(bars);

    // EMA (ONLY one visible at a time due to proper gaps)
    emaSeriesUp.setData(split.up);
    emaSeriesDown.setData(split.down);

    // AUX
    auxSeries.setData(auxArr);

    // signals
    const sigs = detectSignals(bars, emaArr, auxArr, prm.cooldown, prm.swingLookback);
    CURRENT_SIGS = sigs;

    // Markers: B yellow, S white (as you required)
    candleSeries.setMarkers(
      sigs.map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#FFD400" : "#FFFFFF",
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: "", // keep markers clean; big letter uses overlay (more controllable)
      }))
    );

    applyToggles();
    repaintOverlay();

    // top text
    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

    const fb = res.isFallback ? ` · DEMO (fallback: ${res.fallbackNote})` : " · LIVE";
    if ($("hintText")) $("hintText").textContent = `Loaded · 已加载（TF=${timeframe} · sigs=${sigs.length}）${fb}`;
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
    const containerId = opts.containerId || opts.chartElId || "chart";
    const overlayId = opts.overlayId || opts.overlayElId || "sigOverlay";

    containerEl = $(containerId);
    overlayEl = $(overlayId);

    ensureOverlayStyle();

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

    // EMA split series (priceLineVisible/lastValueVisible disabled to avoid clutter)
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

    // AUX (only one line)
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

    // Resize observers
    try {
      new ResizeObserver(resize).observe(containerEl);
    } catch (_) {
      window.addEventListener("resize", resize);
    }
    window.addEventListener("resize", resize);

    resize();

    // Default auto load (only opt-out when explicitly autoLoad:false)
    if (opts.autoLoad !== false) {
      load().catch((e) => log("[chart] initial load failed:", e.message || e));
    }
  }

  /* -----------------------------
   * Public API
   * ----------------------------- */
  window.ChartCore = {
    init,
    load,
    applyToggles,
    exportPNG,
  };
})();
