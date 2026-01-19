// ===============================
// HARD GUARD: prevent double init
// ===============================
if (window.__DAI_CHARTCORE_LOADED__) {
  // already loaded once; do not redefine / re-init
  console.warn("[ChartCore] duplicate load blocked");
  return;
}
window.__DAI_CHARTCORE_LOADED__ = true;

/* =========================================================
 * DarriusAI · Chart Core (HARD-STABLE, NO-DUP INIT)
 * File: js/chart.core.js
 * ========================================================= */

(function () {
  "use strict";

  /* -----------------------------
   * Utilities
   * ----------------------------- */
  function $(id) { return document.getElementById(id); }
  function log() { if (window.console) console.log.apply(console, arguments); }
  function getApiBase() { return (window.API_BASE || "").trim() || ""; }
  function getUiSymbol() { return (($("symbol")?.value || "BTCUSDT") + "").trim().toUpperCase(); }
  function getUiTf() { return (($("tf")?.value || "1d") + "").trim(); }

  function isCryptoSymbol(sym) {
    const s = (sym || "").toUpperCase();
    return s.includes("/") || s.endsWith("USDT") || s.endsWith("USDC") || s.endsWith("USD");
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

  let containerEl = null;
  let overlayEl = null;

  let CURRENT_BARS = [];
  let CURRENT_SIGS = [];

  /* -----------------------------
   * Style (overlay labels)
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
        font-size: 12px;
        line-height: 1;
        padding: 4px 6px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,.12);
        box-shadow: 0 6px 18px rgba(0,0,0,.35);
      }
      .sigMark.buy{ background: rgba(255, 212, 0, .92); color:#111; }
      .sigMark.sell{ background: rgba(255,255,255,.92); color:#111; }
    `;
    document.head.appendChild(style);
  }

  /* -----------------------------
   * Demo fallback
   * ----------------------------- */
  function genDemoCandles(n, tf, asset) {
    n = n || DEFAULT_BARS;
    const stepMap = { "5m":300,"15m":900,"30m":1800,"1h":3600,"4h":14400,"1d":86400,"1w":604800,"1M":2592000 };
    const step = stepMap[tf] || 86400;
    const now = Math.floor(Date.now() / 1000);

    let t = now - n * step;
    let price = asset === "stock" ? 480 : 67000;

    const arr = [];
    for (let i = 0; i < n; i++) {
      const k = asset === "stock" ? 0.01 : 1;
      const wave1 = Math.sin(i / 14) * 220 * k;
      const wave2 = Math.sin(i / 33) * 420 * k;
      const wave3 = Math.sin(i / 85) * 700 * k;
      const noise = (Math.random() - 0.5) * 260 * k;
      const drift = Math.sin(i / 170) * 160 * k;

      const open = price;
      const close = open + wave1 + wave2 + wave3 + drift + noise;
      const high = Math.max(open, close) + Math.random() * 220 * k;
      const low  = Math.min(open, close) - Math.random() * 220 * k;

      price = close;
      arr.push({ time: t, open:+open.toFixed(2), high:+high.toFixed(2), low:+low.toFixed(2), close:+close.toFixed(2) });
      t += step;
    }
    return arr;
  }

  /* -----------------------------
   * Normalize bars
   * - time ms->sec
   * - stock price scale heuristics (avoid NVDA "228k" demo-look)
   * ----------------------------- */
  function normalizeBars(bars, asset) {
    if (!Array.isArray(bars) || bars.length === 0) return [];
    const sampleT = Number(bars[Math.min(3, bars.length - 1)]?.time);
    const timeIsMs = Number.isFinite(sampleT) && sampleT > 1e12;

    const out = bars.map((b) => {
      const t0 = Number(b.time);
      const t = timeIsMs ? Math.floor(t0 / 1000) : Math.floor(t0);
      const o = Number(b.open), h = Number(b.high), l = Number(b.low), c = Number(b.close);
      if (![t, o, h, l, c].every(Number.isFinite)) return null;
      return { time: t, open: o, high: h, low: l, close: c };
    }).filter(Boolean);

    if (!out.length) return [];

    if (asset === "stock") {
      // median close heuristic
      const closes = out.slice(-80).map(x => x.close).sort((a,b)=>a-b);
      const med = closes[Math.floor(closes.length/2)] || out[out.length-1].close;

      // If insanely high, scale down by 10 until sane (< 5000)
      let factor = 1;
      while (med / factor > 5000) factor *= 10;
      if (factor > 1) {
        for (const b of out) {
          b.open /= factor; b.high /= factor; b.low /= factor; b.close /= factor;
        }
      }
    }

    // ensure high/low consistent
    for (const b of out) {
      b.high = Math.max(b.high, b.open, b.close);
      b.low  = Math.min(b.low, b.open, b.close);
    }
    return out;
  }

  /* -----------------------------
   * EMA calc
   * ----------------------------- */
  function calcEMA(bars, period) {
    const p = Math.max(2, Number(period) || 10);
    const k = 2 / (p + 1);
    let prev = null;
    const out = [];
    for (let i = 0; i < bars.length; i++) {
      const v = bars[i].close;
      prev = prev === null ? v : v * k + prev * (1 - k);
      out.push({ time: bars[i].time, value: prev });
    }
    return out;
  }

  /* -----------------------------
   * EMA split with STRICT gaps
   * - GAP must be {time} ONLY (no value field)
   * - This guarantees Up/Down will NOT both draw a continuous line together
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
   * Signals (RESTORED)
   * - Pure EMA x AUX cross + cooldown
   * - No swing filter (prevents "no B/S" issue)
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
   * Overlay
   * ----------------------------- */
  function repaintOverlay() {
    if (!overlayEl || !chart || !candleSeries) return;
    overlayEl.innerHTML = "";
    if (!CURRENT_SIGS || !CURRENT_SIGS.length) return;

    const ts = chart.timeScale();
    for (const s of CURRENT_SIGS) {
      const x = ts.timeToCoordinate(s.time);
      const y = candleSeries.priceToCoordinate(s.price);
      if (x == null || y == null) continue;

      const d = document.createElement("div");
      d.className = "sigMark " + (s.side === "B" ? "buy" : "sell");
      d.style.left = x + "px";
      d.style.top  = (y + (s.side === "B" ? 14 : -14)) + "px";
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
   * Toggles
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
   * Fetch market data (backend proxy)
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
      return { bars: norm, asset, isFallback: false, note: "" };
    } catch (e) {
      const note = e?.message ? e.message : String(e);
      log("[chart] fallback:", note);
      const demo = genDemoCandles(DEFAULT_BARS, timeframe, asset);
      return { bars: demo, asset, isFallback: true, note };
    }
  }

  /* -----------------------------
   * Load
   * ----------------------------- */
  async function load(symbol, tf) {
    if (!chart || !candleSeries) throw new Error("Chart not initialized. Call ChartCore.init() first.");

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

    // EMA = 2 series but visually 1 color-changing line (no parallel draw)
    emaSeriesUp.setData(split.up);
    emaSeriesDown.setData(split.down);

    // AUX = one line
    auxSeries.setData(auxArr);

    // Signals back (guarantee B/S exists)
    const sigs = detectSignals(bars, emaArr, auxArr, prm.cooldown);
    CURRENT_SIGS = sigs;

    candleSeries.setMarkers(
      sigs.map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#FFD400" : "#FFFFFF",
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: "", // use overlay big letter
      }))
    );

    applyToggles();
    repaintOverlay();

    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

    const fb = res.isFallback ? ` · DEMO (fallback: ${res.note})` : " · LIVE";
    if ($("hintText")) $("hintText").textContent = `Loaded · 已加载（TF=${timeframe} · sigs=${sigs.length}）${fb}`;
  }

  /* -----------------------------
   * Export
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
   * Init (CRITICAL: prevent duplicate init)
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

    // >>> KEY FIX: if init called again, remove old chart first (prevents extra series)
    if (chart && typeof chart.remove === "function") {
      try { chart.remove(); } catch (_) {}
    }
    chart = null;
    candleSeries = null;
    emaSeriesUp = null;
    emaSeriesDown = null;
    auxSeries = null;

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

    // EMA split (disable priceLine/lastValue to avoid extra "line" feeling)
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

    // AUX
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

    if (opts.autoLoad !== false) {
      load().catch((e) => log("[chart] initial load failed:", e.message || e));
    }
  }

  window.ChartCore = { init, load, applyToggles, exportPNG };
})();
