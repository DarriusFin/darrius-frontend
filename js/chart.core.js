/* =========================================================
 * DarriusAI · Chart Core (FINAL INTEGRATED COVER)
 * File: js/chart.core.js
 * Role:
 *  - Candlestick chart (LightweightCharts)
 *  - EMA (ONE EMA visually, color-changing via split series)
 *  - AUX line
 *  - Signal engine (EMA x AUX cross, stable)
 *  - Markers + BIG overlay (B yellow / S white, smaller font)
 *  - Alpaca/Market OHLC via backend proxy (NO KEY on front-end)
 *  - Demo fallback (always safe)
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

  function setHint(msg) {
    if ($("hintText")) $("hintText").textContent = msg;
  }

  function setHeader(sym, lastClose) {
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && Number.isFinite(lastClose)) {
      $("priceText").textContent = Number(lastClose).toFixed(2);
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

  let LAST_DATA_SOURCE = "unknown"; // "live" | "demo"
  let LAST_ERR = "";

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
   * IMPORTANT:
   * - This MUST be mutually exclusive (null on the other),
   *   so visually it is ONE EMA line with color change.
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
   * Signal engine (EMA x AUX cross)
   * - Stable minimal cross signals
   * - Cooldown avoids dense noise
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
   * Overlay (BIG B / S) — smaller font
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
      d.textContent = s.side;

      // Strong inline style (avoid being overridden by page CSS)
      d.style.position = "absolute";
      d.style.left = x + "px";
      d.style.top = (y + (s.side === "B" ? 14 : -14)) + "px";
      d.style.transform = "translate(-50%, -50%)";
      d.style.zIndex = "9999";

      // smaller one size down
      d.style.fontSize = "12px";
      d.style.lineHeight = "18px";
      d.style.width = "22px";
      d.style.height = "22px";
      d.style.borderRadius = "10px";
      d.style.display = "flex";
      d.style.alignItems = "center";
      d.style.justifyContent = "center";
      d.style.fontWeight = "800";

      d.style.border = "1px solid rgba(0,0,0,.35)";
      d.style.boxShadow = "0 6px 18px rgba(0,0,0,.45)";

      if (s.side === "B") {
        d.style.background = "#FFD400"; // yellow
        d.style.color = "#111";
      } else {
        d.style.background = "#FFFFFF"; // white
        d.style.color = "#111";
      }

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
   * Bars sanitization (CRITICAL FIX)
   * - accepts time/open/high/low/close OR t/o/h/l/c
   * - converts ms -> seconds automatically
   * - filters NaN/0/invalid bars to prevent "wick to 0" disasters
   * ----------------------------- */
  function sanitizeBars(rawBars) {
    const bars = [];
    for (const b of rawBars || []) {
      let t = Number(b.time ?? b.t);
      let o = Number(b.open ?? b.o);
      let h = Number(b.high ?? b.h);
      let l = Number(b.low ?? b.l);
      let c = Number(b.close ?? b.c);

      // ms -> seconds
      if (Number.isFinite(t) && t > 1e12) t = Math.floor(t / 1000);

      if (![t, o, h, l, c].every(Number.isFinite)) continue;

      // fix inverted ranges defensively
      const maxOC = Math.max(o, c);
      const minOC = Math.min(o, c);
      if (h < maxOC) h = maxOC;
      if (l > minOC) l = minOC;

      // reject broken bars (low/high <= 0 usually means parse failure)
      if (l <= 0 || h <= 0) continue;

      bars.push({ time: t, open: o, high: h, low: l, close: c });
    }
    return bars;
  }

  /* -----------------------------
   * Market data via backend proxy
   * Endpoint:
   *  GET /api/market/ohlc?symbol=...&tf=...&asset=stock|crypto
   * Response:
   *  { ok:true, bars:[{time,open,high,low,close}...] }
   *  OR { ok:true, bars:[{t,o,h,l,c}...] }
   * ----------------------------- */
  async function fetchMarketData(symbol, tf) {
    const sym = (symbol || "").trim().toUpperCase();
    const timeframe = (tf || "1d").trim() || "1d";

    // crude crypto detection; backend can still decide
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
      if (!data || data.ok !== true || !Array.isArray(data.bars)) {
        throw new Error("Invalid payload shape");
      }

      const bars = sanitizeBars(data.bars);
      if (bars.length < 50) throw new Error("Too few valid bars after sanitize");

      LAST_DATA_SOURCE = "live";
      LAST_ERR = "";
      return bars;
    } catch (e) {
      LAST_DATA_SOURCE = "demo";
      LAST_ERR = (e && (e.message || String(e))) || "unknown error";
      log("[chart] Market data failed -> demo fallback:", LAST_ERR);
      return genDemoCandles(DEFAULT_BARS, timeframe);
    }
  }

  /* -----------------------------
   * Load & render
   * - Supports no-args call: load() reads UI
   * ----------------------------- */
  async function load(symbol, tf) {
    if (!chart || !candleSeries) {
      throw new Error("Chart not initialized. Call ChartCore.init() first.");
    }

    const sym = (symbol || getUiSymbol()).trim().toUpperCase();
    const timeframe = (tf || getUiTf()).trim() || "1d";

    setHint("Loading...");

    const bars = await fetchMarketData(sym, timeframe);
    CURRENT_BARS = bars;

    const prm = TF_PARAMS[timeframe] || TF_PARAMS["1d"];

    // ONE EMA, split to color-change visually
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

    // Markers: keep but minimal text (overlay is main)
    candleSeries.setMarkers(
      sigs.map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#FFD400" : "#FFFFFF", // B yellow, S white
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: "", // keep clean (overlay shows letters)
      }))
    );

    applyToggles();
    repaintOverlay();

    const last = bars[bars.length - 1];
    setHeader(sym, last?.close);

    const src = LAST_DATA_SOURCE === "live" ? "LIVE" : "DEMO";
    const extra =
      LAST_DATA_SOURCE === "live"
        ? ""
        : `（fallback: ${String(LAST_ERR).slice(0, 120)}）`;

    setHint(`Loaded · 已加载（TF=${timeframe} · sigs=${sigs.length} · ${src}）${extra}`);
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

    // EMA split series => ONE EMA visually (color change)
    // IMPORTANT: turn off price line / last value so it doesn't look like extra "lines"
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

    try {
      new ResizeObserver(resize).observe(containerEl);
    } catch (_) {
      // ignore
    }
    window.addEventListener("resize", resize);
    resize();

    // Default auto-load
    if (opts.autoLoad !== false) {
      load().catch((e) => log("[chart] initial load failed:", e.message || e));
    }
  }

  /* -----------------------------
   * Public
   * ----------------------------- */
  window.ChartCore = {
    init,
    load,
    applyToggles,
    exportPNG,
  };
})();
