/* =========================================================
 * DarriusAI · Chart Core (FINAL INTEGRATED COVER)
 * File: js/chart.core.js
 * Role:
 *  - Candlestick chart (up=green / down=red)
 *  - EMA (color switch by two series + null (EMPTY_VALUE))
 *  - AUX line
 *  - Signal engine (EMA x AUX cross) -> B/S markers
 *  - Overlay markers (optional)
 *  - Market data from backend proxy (NO KEY on front-end)
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

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  /* -----------------------------
   * Config
   * ----------------------------- */
  const DEFAULT_BARS = 260;

  // params per timeframe (adjustable)
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

  // EMA color-switch: two series (only one is visible at each point)
  let emaUp = null;
  let emaDown = null;

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
   * Data sanitize (IMPORTANT)
   * - fix stock "straight line" / crazy scale caused by bad payload
   * ----------------------------- */
  function sanitizeBars(bars) {
    if (!Array.isArray(bars)) return [];

    // normalize & filter
    let out = [];
    for (const b of bars) {
      const t = Number(b.time);
      const o = Number(b.open);
      const h = Number(b.high);
      const l = Number(b.low);
      const c = Number(b.close);

      // basic validity
      if (!Number.isFinite(t) || t <= 0) continue;
      if (![o, h, l, c].every(Number.isFinite)) continue;

      // price must be positive, and high/low consistent
      if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
      const hi = Math.max(o, h, l, c);
      const lo = Math.min(o, h, l, c);

      out.push({
        time: t,
        open: o,
        high: hi,
        low: lo,
        close: c,
      });
    }

    // sort by time asc
    out.sort((a, b) => a.time - b.time);

    // de-duplicate same timestamp (keep last)
    const dedup = [];
    for (let i = 0; i < out.length; i++) {
      const cur = out[i];
      const prev = dedup[dedup.length - 1];
      if (!prev || prev.time !== cur.time) dedup.push(cur);
      else dedup[dedup.length - 1] = cur;
    }

    // if too few bars, treat as invalid
    if (dedup.length < 30) return [];

    return dedup;
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
   * EMA color-switch (your "EMPTY_VALUE" logic)
   * - two series, only one visible at a time by setting null
   * - improved: debounce confirm + bridge like your MQL (x+1)
   * ----------------------------- */
  function buildColorSwitchEMA(emaArr) {
    // tweakable:稳定、不乱跳
    const CONFIRM_BARS = 3;      // 3~5 更稳
    const REL_EPS = 0.00015;     // 过滤极小斜率抖动

    const up = [];
    const dn = [];

    let state = null;           // "UP" or "DN"
    let pending = null;
    let pendingCount = 0;

    for (let i = 0; i < emaArr.length; i++) {
      const cur = emaArr[i];
      const prev = emaArr[i - 1];

      if (!prev) {
        state = "UP";
        up.push(cur);
        dn.push({ time: cur.time, value: null });
        continue;
      }

      const slope = cur.value - prev.value;
      const eps = Math.max(Math.abs(cur.value) * REL_EPS, 1e-9);

      let want;
      if (slope > eps) want = "UP";
      else if (slope < -eps) want = "DN";
      else want = state || "UP";

      if (!state) state = want;

      if (want !== state) {
        if (pending === want) pendingCount++;
        else {
          pending = want;
          pendingCount = 1;
        }

        if (pendingCount >= CONFIRM_BARS) {
          // bridge at switch: make prev point visible on both series
          up[up.length - 1] = { time: prev.time, value: prev.value };
          dn[dn.length - 1] = { time: prev.time, value: prev.value };

          state = pending;
          pending = null;
          pendingCount = 0;
        }
      } else {
        pending = null;
        pendingCount = 0;
      }

      if (state === "UP") {
        up.push(cur);
        dn.push({ time: cur.time, value: null });
      } else {
        dn.push(cur);
        up.push({ time: cur.time, value: null });
      }
    }

    return { up, dn };
  }

  /* -----------------------------
   * Signal engine (EMA x AUX cross)
   * ----------------------------- */
  function detectSignals(bars, emaFast, auxSlow, cooldown) {
    const sigs = [];
    let lastIdx = -1e9;
    const cd = Math.max(1, Number(cooldown) || 14);

    for (let i = 1; i < bars.length; i++) {
      const prevDiff = emaFast[i - 1].value - auxSlow[i - 1].value;
      const nowDiff = emaFast[i].value - auxSlow[i].value;

      if (i - lastIdx < cd) continue;

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
   * Overlay (optional BIG B/S)
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
   * Toggles (UI)
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
   * Market data from backend proxy
   * Expected endpoint:
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

      const bars = sanitizeBars(
        data.bars.map((b) => ({
          time: Number(b.time),
          open: +b.open,
          high: +b.high,
          low: +b.low,
          close: +b.close,
        }))
      );

      if (!bars.length) throw new Error("Sanitize failed");

      return bars;
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

    const prm = TF_PARAMS[timeframe] || TF_PARAMS["1d"];

    const bars = await fetchMarketData(sym, timeframe);
    CURRENT_BARS = bars;

    const emaArr = calcEMA(bars, prm.ema);
    const auxArr = calcEMA(bars, prm.aux);

    const emaSplit = buildColorSwitchEMA(emaArr);

    candleSeries.setData(bars);
    emaUp.setData(emaSplit.up);
    emaDown.setData(emaSplit.dn);
    auxSeries.setData(auxArr);

    // signals
    const sigs = detectSignals(bars, emaArr, auxArr, prm.cooldown);
    CURRENT_SIGS = sigs;

    candleSeries.setMarkers(
      sigs.map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#FFD400" : "#FFFFFF", // B yellow, S white
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: s.side,
      }))
    );

    applyToggles();
    repaintOverlay();

    // header text
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
    const containerId = opts.containerId || opts.chartElId || "chart";
    const overlayId = opts.overlayId || opts.overlayElId || "sigOverlay";

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

    // Candles: up=green, down=red
    candleSeries = chart.addCandlestickSeries({
      upColor: "#2BE2A6",
      downColor: "#FF5A5A",
      wickUpColor: "#2BE2A6",
      wickDownColor: "#FF5A5A",
      borderVisible: false,
    });

    // EMA split series (only 2 series -> visually 1 color-switch EMA)
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

    // AUX (only 1 line)
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

    // default auto-load (safe)
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
