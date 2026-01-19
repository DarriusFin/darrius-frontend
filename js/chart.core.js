/* =========================================================
 * DarriusAI · Chart Core (FINAL INTEGRATED COVER)
 * File: js/chart.core.js
 * Goals (per Perry):
 *  - Candles: green=up, red=down
 *  - Exactly TWO indicators on chart:
 *      1) EMA color-switch (green when EMA rising, red when EMA falling)
 *         Implementation: 2 line series + null to hide => visually ONE line
 *      2) AUX line (yellow)
 *  - Signals: B/S markers + optional overlay
 *  - Data: backend proxy /api/market/ohlc, demo fallback safe
 *
 * Public:
 *  window.ChartCore = { init, load, applyToggles, exportPNG }
 * ========================================================= */

(function () {
  "use strict";

  /* -----------------------------
   * Utilities
   * ----------------------------- */
  function $(id) { return document.getElementById(id); }

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

  function num(x) {
    const v = Number(x);
    return Number.isFinite(v) ? v : null;
  }

  /* -----------------------------
   * Config
   * ----------------------------- */
  const DEFAULT_BARS = 260;

  // Your tuned params placeholder (you can adjust later)
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

  // EMA color-switch: two series but only one visible segment at a time
  let emaUp = null;     // green segment
  let emaDown = null;   // red segment

  // AUX
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
    let price = 100;

    const arr = [];
    for (let i = 0; i < n; i++) {
      const wave1 = Math.sin(i / 14) * 2.2;
      const wave2 = Math.sin(i / 33) * 4.2;
      const wave3 = Math.sin(i / 85) * 7.0;
      const noise = (Math.random() - 0.5) * 2.6;
      const drift = Math.sin(i / 170) * 1.6;

      const open = price;
      const close = open + wave1 + wave2 + wave3 + drift + noise;
      const high = Math.max(open, close) + Math.random() * 2.2;
      const low = Math.min(open, close) - Math.random() * 2.2;

      price = close;

      arr.push({
        time: t,
        open: +open.toFixed(4),
        high: +high.toFixed(4),
        low: +low.toFixed(4),
        close: +close.toFixed(4),
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

  /* ---------------------------------------------------------
   * EMA color-switch (YOUR "EMPTY_VALUE" logic)
   * - Uptrend[x] = EMA[x], Dntrend[x] = null (hide)
   * - Downtrend[x] = EMA[x], Uptrend[x] = null (hide)
   * - We use EMA SLOPE (rising vs falling) as trend
   *   => green = rising, red = falling
   * --------------------------------------------------------- */
  function buildColorSwitchEMA(emaArr) {
    const up = [];
    const dn = [];

    for (let i = 0; i < emaArr.length; i++) {
      const cur = emaArr[i];
      const prev = emaArr[i - 1];

      if (!prev) {
        // start: default to "up" so it draws immediately
        up.push(cur);
        dn.push({ time: cur.time, value: null });
        continue;
      }

      const rising = cur.value >= prev.value;

      if (rising) {
        up.push(cur);
        dn.push({ time: cur.time, value: null }); // EMPTY_VALUE
      } else {
        dn.push(cur);
        up.push({ time: cur.time, value: null }); // EMPTY_VALUE
      }

      // Optional: bridge one point on regime change (like your x+1 trick)
      // This makes color switching visually continuous.
      // If previous was falling and now rising -> keep dn at prev point
      // If previous was rising and now falling -> keep up at prev point
      // NOTE: lightweight-charts already handles null gaps well, but bridge helps.
      const prevRising = prev.value >= (emaArr[i - 2]?.value ?? prev.value);
      if (i >= 2 && prevRising !== rising) {
        // On change, put previous point in both to reduce "gap" perception
        const p = emaArr[i - 1];
        if (rising) {
          dn[dn.length - 2] = { time: p.time, value: p.value };
        } else {
          up[up.length - 2] = { time: p.time, value: p.value };
        }
      }
    }

    return { up, dn };
  }

  /* -----------------------------
   * Signals (EMA x AUX cross)
   * ----------------------------- */
  function detectSignals(bars, emaFast, auxSlow, cooldown) {
    const sigs = [];
    let lastIdx = -1e9;

    for (let i = 1; i < bars.length; i++) {
      const prevDiff = emaFast[i - 1].value - auxSlow[i - 1].value;
      const nowDiff = emaFast[i].value - auxSlow[i].value;

      if (i - lastIdx < cooldown) continue;

      if (prevDiff <= 0 && nowDiff > 0) {
        sigs.push({ time: bars[i].time, price: bars[i].low, side: "B" });
        lastIdx = i;
      } else if (prevDiff >= 0 && nowDiff < 0) {
        sigs.push({ time: bars[i].time, price: bars[i].high, side: "S" });
        lastIdx = i;
      }
    }
    return sigs.slice(-40);
  }

  /* -----------------------------
   * Overlay (optional big B/S)
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

    if (emaUp) emaUp.applyOptions({ visible: showEMA });
    if (emaDown) emaDown.applyOptions({ visible: showEMA });
    if (auxSeries) auxSeries.applyOptions({ visible: showAUX });

    repaintOverlay();
  }

  /* -----------------------------
   * Market data fetch
   * Endpoint:
   *  GET /api/market/ohlc?symbol=...&tf=...&asset=stock|crypto
   * Response:
   *  { ok:true, bars:[{time,open,high,low,close}, ...] }
   * ----------------------------- */
  async function fetchMarketData(symbol, tf) {
    const sym = (symbol || "").trim().toUpperCase();
    const timeframe = (tf || "1d").trim();

    const isCrypto =
      sym.includes("/") ||
      sym.endsWith("USDT") ||
      sym.endsWith("USDC") ||
      sym.endsWith("USD");

    const asset = isCrypto ? "crypto" : "stock";

    const base = getApiBase();
    const path =
      `/api/market/ohlc?symbol=${encodeURIComponent(sym)}` +
      `&tf=${encodeURIComponent(timeframe)}` +
      `&asset=${encodeURIComponent(asset)}`;
    const url = base ? `${base}${path}` : path;

    try {
      const resp = await fetch(url, { method: "GET" });
      if (!resp.ok) throw new Error("HTTP " + resp.status);

      const data = await resp.json();
      if (!data || data.ok !== true || !Array.isArray(data.bars) || data.bars.length < 20) {
        throw new Error("Invalid payload");
      }

      // Normalize strictly: time must be seconds int; OHLC must be finite numbers
      const out = [];
      for (const b of data.bars) {
        const t = Number(b.time);
        const o = num(b.open);
        const h = num(b.high);
        const l = num(b.low);
        const c = num(b.close);

        if (!Number.isFinite(t) || !o || !h || !l || !c) continue;

        // If backend accidentally returns ms timestamps, convert
        const timeSec = t > 3e10 ? Math.floor(t / 1000) : Math.floor(t);

        out.push({
          time: timeSec,
          open: o,
          high: h,
          low: l,
          close: c,
        });
      }

      if (out.length < 20) throw new Error("Not enough valid bars");

      // Sort by time to avoid weird shapes
      out.sort((a, b) => a.time - b.time);

      return out;
    } catch (e) {
      log("[chart] Market data failed -> demo fallback:", e.message || e);
      return genDemoCandles(DEFAULT_BARS, timeframe);
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

    const bars = await fetchMarketData(sym, timeframe);
    CURRENT_BARS = bars;

    const prm = TF_PARAMS[timeframe] || TF_PARAMS["1d"];

    const emaArr = calcEMA(bars, prm.ema);
    const auxArr = calcEMA(bars, prm.aux);
    const sw = buildColorSwitchEMA(emaArr);

    candleSeries.setData(bars);

    // IMPORTANT:
    // This is your "EMPTY_VALUE" effect: we hide the other color by null.
    emaUp.setData(sw.up);
    emaDown.setData(sw.dn);

    auxSeries.setData(auxArr);

    // Signals
    const sigs = detectSignals(bars, emaArr, auxArr, prm.cooldown);
    CURRENT_SIGS = sigs;

    candleSeries.setMarkers(
      sigs.map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#FFD400" : "#FFFFFF",  // B yellow, S white
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: s.side,
      }))
    );

    applyToggles();
    repaintOverlay();

    // Top texts if present
    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);
    if ($("hintText")) $("hintText").textContent = `Loaded · 已加载（TF=${timeframe} · sigs=${sigs.length}）`;

    // Fit after data load to avoid "empty chart"
    chart.timeScale().fitContent();
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

    // Candles: green=up, red=down (your requirement)
    candleSeries = chart.addCandlestickSeries({
      upColor: "#2BE2A6",
      downColor: "#FF5A5A",
      wickUpColor: "#2BE2A6",
      wickDownColor: "#FF5A5A",
      borderVisible: false,
      priceLineVisible: true,
      lastValueVisible: true,
    });

    // EMA color-switch (visually ONE line)
    // IMPORTANT: turn off priceLine/lastValue to avoid "looks like extra lines"
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

    // AUX (single yellow line, also no priceLine/lastValue)
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
      repaintOverlay();
    };

    try {
      new ResizeObserver(resize).observe(containerEl);
    } catch (_) {
      window.addEventListener("resize", resize);
    }
    window.addEventListener("resize", resize);

    resize();

    // Auto load by default
    if (opts.autoLoad !== false) {
      load().catch((e) => log("[chart] initial load failed:", e.message || e));
    }
  }

  /* -----------------------------
   * Public API
   * ----------------------------- */
  window.ChartCore = { init, load, applyToggles, exportPNG };
})();
