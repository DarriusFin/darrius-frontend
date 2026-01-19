/* =========================================================
 * DarriusAI · Chart Core (FINAL INTEGRATED COVER VERSION)
 * File: js/chart.core.js
 *
 * Goals FIXED:
 *  - Only 2 MAs on screen: EMA (color-changing) + AUX (yellow)
 *  - No extra "3rd line" illusion (disable priceLine/lastValue labels on MA series)
 *  - Fix abnormal stock scaling (e.g., NVDA 227221 -> auto /100)
 *  - Filter invalid bars to remove huge lower wicks to 0
 *  - Markers: B yellow / S white, smaller text
 *  - Overlay: optional, smaller and aligned with markers
 *  - Alpaca OHLC via backend proxy, demo fallback safe
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

  function isLikelyCryptoSymbol(sym) {
    sym = (sym || "").toUpperCase();
    return (
      sym.includes("/") ||
      sym.endsWith("USDT") ||
      sym.endsWith("USDC") ||
      sym.endsWith("USD") ||
      sym.endsWith("PERP")
    );
  }

  function num(x) {
    const v = Number(x);
    return Number.isFinite(v) ? v : NaN;
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

  // EMA split series (one EMA visually)
  let emaSeriesUp = null;
  let emaSeriesDown = null;

  // AUX
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
      const drift = Math.sin(i / 170) * 160;

      const open = price;
      const close = open + wave1 + wave2 + wave3 + drift + noise;
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
      out.push({ time: bars[i].time, value: +prev.toFixed(2) });
    }
    return out;
  }

  /* -----------------------------
   * EMA color split (up / down)
   * IMPORTANT: For gaps, use "whitespace" points: {time} only
   * ----------------------------- */
  function splitEMABySlope(emaArr) {
    const up = [];
    const down = [];

    for (let i = 0; i < emaArr.length; i++) {
      const cur = emaArr[i];
      const prev = emaArr[i - 1];

      if (!prev) {
        up.push(cur);
        down.push({ time: cur.time }); // gap
        continue;
      }

      if (cur.value >= prev.value) {
        up.push(cur);
        down.push({ time: cur.time }); // gap
      } else {
        down.push(cur);
        up.push({ time: cur.time }); // gap
      }
    }

    return { up, down };
  }

  /* -----------------------------
   * Signal engine (EMA x AUX cross) + cooldown
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

    return sigs.slice(-30);
  }

  /* -----------------------------
   * Overlay (BIG B / S) — smaller to avoid blocking
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
      d.style.top = (y + (s.side === "B" ? 10 : -10)) + "px";

      // smaller font than before
      d.style.fontSize = "12px";
      d.style.width = "22px";
      d.style.height = "22px";
      d.style.lineHeight = "22px";

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
   * Normalize + validate bars
   *  - Remove bad bars (0/NaN/high<low/duplicate time)
   *  - Fix stock scaling if values look like cents (NVDA 227221 -> 2272.21 or 227.221)
   *    Here we apply: if NOT crypto and typical close > 10000 => divide by 100
   * ----------------------------- */
  function sanitizeBars(rawBars, symbol) {
    const sym = (symbol || "").toUpperCase();
    const crypto = isLikelyCryptoSymbol(sym);

    // build cleaned
    const cleaned = [];
    const seen = new Set();

    for (const b of rawBars || []) {
      const t = Math.floor(num(b.time));
      if (!Number.isFinite(t) || t <= 0) continue;
      if (seen.has(t)) continue;

      let o = num(b.open);
      let h = num(b.high);
      let l = num(b.low);
      let c = num(b.close);

      if (![o, h, l, c].every(Number.isFinite)) continue;
      if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
      if (h < l) continue;

      cleaned.push({ time: t, open: o, high: h, low: l, close: c });
      seen.add(t);
    }

    if (cleaned.length < 10) return cleaned;

    // detect scale for stocks
    if (!crypto) {
      // Use median close
      const closes = cleaned.map((x) => x.close).sort((a, b) => a - b);
      const med = closes[Math.floor(closes.length / 2)];

      // If median is huge for a stock, it is almost certainly scaled (cents etc.)
      // NVDA 227221 -> med > 10000 (true)
      if (med > 10000) {
        const factor = 100; // safest default; avoids over-shrinking crypto
        for (const x of cleaned) {
          x.open = +(x.open / factor).toFixed(4);
          x.high = +(x.high / factor).toFixed(4);
          x.low = +(x.low / factor).toFixed(4);
          x.close = +(x.close / factor).toFixed(4);
        }
      }
    }

    // final pass: remove weird spikes (low too far from close)
    // (prevents "needle to zero" even if backend sends extreme low)
    const closes2 = cleaned.map((x) => x.close).sort((a, b) => a - b);
    const med2 = closes2[Math.floor(closes2.length / 2)];
    const floor = med2 * 0.02; // allow drawdowns but block absurd 0-like
    for (const x of cleaned) {
      if (x.low < floor) x.low = floor;
      if (x.high < x.low) x.high = x.low;
    }

    return cleaned;
  }

  /* -----------------------------
   * Market data (backend proxy)
   * Endpoint:
   *  GET /api/market/ohlc?symbol=...&tf=...&asset=stock|crypto
   * ----------------------------- */
  async function fetchMarketData(symbol, tf) {
    const sym = (symbol || "").trim().toUpperCase();
    const timeframe = (tf || "1d").trim();
    const asset = isLikelyCryptoSymbol(sym) ? "crypto" : "stock";

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

      const mapped = data.bars.map((b) => ({
        time: num(b.time),
        open: num(b.open),
        high: num(b.high),
        low: num(b.low),
        close: num(b.close),
      }));

      const clean = sanitizeBars(mapped, sym);
      if (!clean || clean.length === 0) throw new Error("No valid bars after sanitize");

      return clean;
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
    const split = splitEMABySlope(emaArr);

    candleSeries.setData(bars);
    emaSeriesUp.setData(split.up);
    emaSeriesDown.setData(split.down);
    auxSeries.setData(auxArr);

    // signals
    const sigs = detectSignals(bars, emaArr, auxArr, prm.cooldown);
    CURRENT_SIGS = sigs;

    // markers per your request: B yellow, S white, smaller text
    candleSeries.setMarkers(
      sigs.map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#FFD400" : "#FFFFFF",
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: s.side, // small label; overlay handles bigger bubble
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
      // keep candle price line ok
      priceLineVisible: true,
      lastValueVisible: true,
    });

    // EMA split series (visual ONE EMA with color change)
    // IMPORTANT: disable priceLine + lastValue to avoid "extra lines" illusion
    emaSeriesUp = chart.addLineSeries({
      color: "#2BE2A6",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    emaSeriesDown = chart.addLineSeries({
      color: "#FF5A5A",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    // AUX (yellow) — also disable labels unless you really want them
    auxSeries = chart.addLineSeries({
      color: "rgba(255,184,108,.85)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
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

    // IMPORTANT: default auto load (do not break existing boot/index)
    if (opts.autoLoad !== false) {
      load().catch((e) => log("[chart] initial load failed:", e.message || e));
    }
  }

  window.ChartCore = { init, load, applyToggles, exportPNG };
})();
