/* =========================================================
 * DarriusAI · Chart Core (FINAL INTEGRATED COVER VERSION)
 * File: js/chart.core.js
 * Role:
 *  - Candlestick chart
 *  - EMA (single EMA visually, color-changing via split series)
 *  - AUX line (single yellow line)
 *  - Signal engine (EMA x AUX cross) + markers + overlay
 *  - Alpaca OHLC via backend proxy (NO KEY on front-end)
 *  - Robust normalization (ms->s, cents->dollars heuristic)
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

  function isLikelyCrypto(sym) {
    sym = (sym || "").toUpperCase();
    return (
      sym.includes("/") ||
      sym.endsWith("USDT") ||
      sym.endsWith("USDC") ||
      sym.endsWith("USD")
    );
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

  // EMA split (should look like ONE EMA with color change)
  let emaSeriesUp = null;
  let emaSeriesDown = null;

  // AUX (single line)
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
   * Normalization
   * - Fix ms timestamps, cents prices (heuristic), invalid bars
   * ----------------------------- */
  function normalizeBars(rawBars, asset) {
    if (!Array.isArray(rawBars)) return [];

    const bars = [];
    for (const b of rawBars) {
      const t0 = Number(b.time ?? b.t ?? b.timestamp);
      const o0 = Number(b.open ?? b.o);
      const h0 = Number(b.high ?? b.h);
      const l0 = Number(b.low ?? b.l);
      const c0 = Number(b.close ?? b.c);

      if (!isFinite(t0) || !isFinite(o0) || !isFinite(h0) || !isFinite(l0) || !isFinite(c0)) {
        continue;
      }

      // ms -> s
      const time = t0 > 2e10 ? Math.floor(t0 / 1000) : Math.floor(t0);

      bars.push({
        time,
        open: o0,
        high: h0,
        low: l0,
        close: c0,
      });
    }

    if (bars.length < 5) return bars;

    // Heuristic cents->dollars for stocks:
    // If stock median close is insanely large (> 5000), assume cents and /100.
    if (asset === "stock") {
      const closes = bars.map((x) => x.close).slice().sort((a, b) => a - b);
      const mid = closes[Math.floor(closes.length / 2)];
      if (isFinite(mid) && mid > 5000) {
        for (const x of bars) {
          x.open = x.open / 100;
          x.high = x.high / 100;
          x.low = x.low / 100;
          x.close = x.close / 100;
        }
      }
    }

    // Ensure monotonic time (lightweight-charts requires sorted asc)
    bars.sort((a, b) => a.time - b.time);
    return bars;
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
      out.push({ time: bars[i].time, value: prev });
    }
    return out;
  }

  /* -----------------------------
   * EMA color split (up / down)
   *
   * IMPORTANT:
   *  - Do NOT use null (can collapse to 0 -> vertical lines)
   *  - Use NaN as gap, and explicitly break line at flips.
   * ----------------------------- */
  function splitEMABySlope(emaArr) {
    const up = [];
    const down = [];

    if (!emaArr || emaArr.length === 0) return { up, down };

    // Start: put first point into "up" by default, and gap in down
    up.push({ time: emaArr[0].time, value: emaArr[0].value });
    down.push({ time: emaArr[0].time, value: NaN });

    for (let i = 1; i < emaArr.length; i++) {
      const cur = emaArr[i];
      const prev = emaArr[i - 1];

      const isUp = cur.value >= prev.value;

      if (isUp) {
        // Up series continues; down series gets gap
        up.push({ time: cur.time, value: cur.value });
        down.push({ time: cur.time, value: NaN });
      } else {
        down.push({ time: cur.time, value: cur.value });
        up.push({ time: cur.time, value: NaN });
      }

      // Break line exactly at flip (prevents faint "double line" effect)
      // If slope changed between i-1 and i, add an extra gap point right at cur.time for the opposite series.
      // (NaN already does this; this comment is here to clarify intent.)
    }

    return { up, down };
  }

  /* -----------------------------
   * Signal engine (EMA x AUX cross)
   * - Minimal stable cross, with cooldown
   * ----------------------------- */
  function detectSignals(bars, emaFast, auxSlow, cooldown) {
    const sigs = [];
    let lastIdx = -1e9;
    const cd = Math.max(1, Number(cooldown) || 10);

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

    return sigs.slice(-30);
  }

  /* -----------------------------
   * Overlay (BIG B / S)
   * - smaller font per your request
   * - B yellow / S white
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

      // Inline styling to force smaller text (regardless of CSS drift)
      d.style.position = "absolute";
      d.style.transform = "translate(-50%, -50%)";
      d.style.left = x + "px";
      d.style.top = (y + (s.side === "B" ? 14 : -14)) + "px";

      d.style.width = "20px";
      d.style.height = "20px";
      d.style.borderRadius = "7px";
      d.style.display = "flex";
      d.style.alignItems = "center";
      d.style.justifyContent = "center";
      d.style.fontWeight = "800";
      d.style.fontSize = "12px"; // ✅ smaller

      if (s.side === "B") {
        d.style.background = "#FFD400";
        d.style.color = "#111";
      } else {
        d.style.background = "#FFFFFF";
        d.style.color = "#111";
      }

      d.style.boxShadow = "0 10px 24px rgba(0,0,0,.28)";
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
   * Endpoint:
   *  GET /api/market/ohlc?symbol=...&tf=...&asset=stock|crypto
   * Response:
   *  { ok:true, bars:[{time,open,high,low,close}, ...] }
   * ----------------------------- */
  async function fetchMarketData(symbol, tf) {
    const sym = (symbol || "").trim().toUpperCase();
    const timeframe = (tf || "1d").trim();
    const asset = isLikelyCrypto(sym) ? "crypto" : "stock";

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

      const bars = normalizeBars(data.bars, asset);
      if (!bars || bars.length < 10) throw new Error("Too few bars");

      return { bars, meta: { asset, source: "LIVE" } };
    } catch (e) {
      log("[chart] Market data failed -> demo fallback:", e.message || e);
      return { bars: genDemoCandles(DEFAULT_BARS, timeframe), meta: { asset, source: "DEMO", error: String(e?.message || e) } };
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

    const { bars, meta } = await fetchMarketData(sym, timeframe);
    CURRENT_BARS = bars;

    // EMA & AUX
    const emaArr = calcEMA(bars, prm.ema);
    const auxArr = calcEMA(bars, prm.aux);

    const split = splitEMABySlope(emaArr);

    // Render
    candleSeries.setData(bars);
    emaSeriesUp.setData(split.up);
    emaSeriesDown.setData(split.down);
    auxSeries.setData(auxArr);

    // Signals
    const sigs = detectSignals(bars, emaArr, auxArr, prm.cooldown);
    CURRENT_SIGS = sigs;

    // Markers: B yellow, S white (arrow markers small and clear)
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

    // Header text
    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

    const extra =
      meta?.source === "DEMO"
        ? ` · DEMO（fallback: ${meta.error || "unknown"}）`
        : ` · ${meta.source || "LIVE"}`;

    if ($("hintText")) $("hintText").textContent = `Loaded · 已加载（TF=${timeframe} · sigs=${sigs.length}）${extra}`;
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

    // ✅ EMA split series (visually ONE EMA with color change)
    // ✅ Hide their price line / last value labels to avoid "extra line/value confusion"
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

    // ✅ AUX (single yellow line)
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

    // ✅ Default auto-load unless explicitly disabled
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
