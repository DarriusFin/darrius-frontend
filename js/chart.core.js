/* =========================================================
 * DarriusAI · Chart Core (ROBUST FINAL COVER)
 * File: js/chart.core.js
 * Goals:
 *  - NEVER blank chart: always show demo if API fails
 *  - Probe multiple endpoints + accept multiple payload shapes
 *  - 2 MAs only: Color-switch EMA (2 series with null/EMPTY_VALUE) + AUX
 *  - Candles: up green / down red
 *  - B/S markers (EMA x AUX cross)
 * ========================================================= */

(function () {
  "use strict";

  /* -----------------------------
   * DOM helpers
   * ----------------------------- */
  function $(id) {
    return document.getElementById(id);
  }

  function pickContainer(preferredId) {
    const byId = preferredId && $(preferredId);
    if (byId) return byId;

    const ids = ["chart", "tvChart", "tvchart", "chartContainer"];
    for (const id of ids) {
      const el = $(id);
      if (el) return el;
    }

    const qs = [
      ".tvchart",
      ".tv-chart",
      ".chart",
      '[data-role="chart"]',
      '[data-chart="1"]',
    ];
    for (const s of qs) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function log() {
    if (window.console) console.log.apply(console, arguments);
  }

  function setHint(msg) {
    const el = $("hintText");
    if (el) el.textContent = msg;
  }

  function getUiSymbol() {
    return (($("symbol")?.value || "BTCUSDT") + "").trim().toUpperCase();
  }

  function getUiTf() {
    return (($("tf")?.value || "1d") + "").trim();
  }

  function getApiBase() {
    // allow window.API_BASE or <meta name="api-base" ...>
    const w = (window.API_BASE || "").trim();
    if (w) return w;
    const m = document.querySelector('meta[name="api-base"]');
    return (m?.content || "").trim();
  }

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  /* -----------------------------
   * Params
   * ----------------------------- */
  const DEFAULT_BARS = 260;

  const TF_PARAMS = {
    "5m": { ema: 8, aux: 20, cooldown: 10, step: 300 },
    "15m": { ema: 9, aux: 21, cooldown: 12, step: 900 },
    "30m": { ema: 10, aux: 24, cooldown: 14, step: 1800 },
    "1h": { ema: 10, aux: 26, cooldown: 16, step: 3600 },
    "4h": { ema: 12, aux: 30, cooldown: 18, step: 14400 },
    "1d": { ema: 10, aux: 21, cooldown: 14, step: 86400 },
    "1w": { ema: 8, aux: 18, cooldown: 10, step: 604800 },
    "1M": { ema: 6, aux: 14, cooldown: 8, step: 2592000 },
  };

  /* -----------------------------
   * Chart state
   * ----------------------------- */
  let chart = null;
  let candleSeries = null;

  // EMA (color-switch) => two series, only one visible by null
  let emaUp = null;
  let emaDown = null;

  // AUX
  let auxSeries = null;

  let containerEl = null;
  let overlayEl = null;

  let CURRENT_BARS = [];
  let CURRENT_SIGS = [];

  /* -----------------------------
   * Demo candles (fallback)
   * ----------------------------- */
  function genDemoCandles(n, tf) {
    n = n || DEFAULT_BARS;
    const prm = TF_PARAMS[tf] || TF_PARAMS["1d"];
    const step = prm.step || 86400;

    let t = nowSec() - n * step;
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
   * Sanitize bars (avoid stock "straight line / crazy scale")
   * ----------------------------- */
  function sanitizeBars(bars) {
    if (!Array.isArray(bars)) return [];

    const out = [];
    for (const b of bars) {
      const t = Number(b.time ?? b.t ?? b.timestamp);
      const o = Number(b.open ?? b.o);
      const h = Number(b.high ?? b.h);
      const l = Number(b.low ?? b.l);
      const c = Number(b.close ?? b.c);

      if (!Number.isFinite(t) || t <= 0) continue;
      if (![o, h, l, c].every(Number.isFinite)) continue;
      if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;

      const hi = Math.max(o, h, l, c);
      const lo = Math.min(o, h, l, c);

      out.push({ time: t, open: o, high: hi, low: lo, close: c });
    }

    out.sort((a, b) => a.time - b.time);

    // dedup time
    const dedup = [];
    for (const cur of out) {
      const prev = dedup[dedup.length - 1];
      if (!prev || prev.time !== cur.time) dedup.push(cur);
      else dedup[dedup.length - 1] = cur;
    }

    return dedup.length >= 30 ? dedup : [];
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
   * Color-switch EMA (your EMPTY_VALUE logic)
   *  - two series with null => visually one line changes color
   *  - improved switching (debounce + bridge like x+1)
   * ----------------------------- */
  function buildColorSwitchEMA(emaArr) {
    const CONFIRM_BARS = 3;      // stable
    const REL_EPS = 0.00015;     // avoid micro flip

    const up = [];
    const dn = [];

    let state = null;      // "UP" / "DN"
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
          // bridge at switch: make prev visible on both series (like your x+1)
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
   * Signals: EMA x AUX cross
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
    return sigs.slice(-60);
  }

  /* -----------------------------
   * Overlay (optional)
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
   * Toggles
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
   * API probe (MOST IMPORTANT to avoid blank)
   * ----------------------------- */
  function buildCandidates(symbol, tf) {
    const sym = encodeURIComponent(symbol);
    const timeframe = encodeURIComponent(tf);

    // allow old & new patterns
    const qs = `symbol=${sym}&tf=${timeframe}`;
    const list = [
      `/api/market/ohlc?${qs}`,
      `/api/ohlc?${qs}`,
      `/ohlc?${qs}`,
      `/market/ohlc?${qs}`,
      `/api/ohlcv?${qs}`,
    ];
    return list;
  }

  function extractBars(payload) {
    if (!payload) return null;
    // common shapes
    const cands = [
      payload.bars,
      payload.data,
      payload.result,
      payload.ohlc,
      payload.ohlcv,
      payload.items,
    ];
    for (const v of cands) {
      if (Array.isArray(v) && v.length) return v;
    }
    // sometimes payload itself is array
    if (Array.isArray(payload) && payload.length) return payload;
    return null;
  }

  async function tryFetchJson(url) {
    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  }

  async function fetchMarketData(symbol, tf) {
    const base = getApiBase(); // can be "" meaning same origin
    const candidates = buildCandidates(symbol, tf).map((p) => (base ? base + p : p));

    let lastErr = "";
    for (const url of candidates) {
      try {
        const payload = await tryFetchJson(url);
        const rawBars = extractBars(payload);
        const bars = sanitizeBars(rawBars || []);
        if (bars.length) {
          return { bars, source: url };
        }
        lastErr = `No valid bars from ${url}`;
      } catch (e) {
        lastErr = `${url} -> ${(e && e.message) || e}`;
      }
    }

    // hard fallback demo (NEVER blank)
    return { bars: genDemoCandles(DEFAULT_BARS, tf), source: `DEMO (fallback) | ${lastErr}` };
  }

  /* -----------------------------
   * Load & render (NEVER BLANK)
   * ----------------------------- */
  async function load(symbol, tf) {
    if (!chart || !candleSeries) throw new Error("Chart not initialized");

    const sym = (symbol || getUiSymbol()).trim().toUpperCase();
    const timeframe = (tf || getUiTf()).trim() || "1d";
    const prm = TF_PARAMS[timeframe] || TF_PARAMS["1d"];

    setHint("Loading...");

    try {
      const got = await fetchMarketData(sym, timeframe);
      const bars = got.bars;
      CURRENT_BARS = bars;

      const emaArr = calcEMA(bars, prm.ema);
      const auxArr = calcEMA(bars, prm.aux);
      const emaSplit = buildColorSwitchEMA(emaArr);

      candleSeries.setData(bars);
      emaUp.setData(emaSplit.up);
      emaDown.setData(emaSplit.dn);
      auxSeries.setData(auxArr);

      const sigs = detectSignals(bars, emaArr, auxArr, prm.cooldown);
      CURRENT_SIGS = sigs;

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

      const last = bars[bars.length - 1];
      if ($("symText")) $("symText").textContent = sym;
      if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

      setHint(`Loaded · 已加载（TF=${timeframe} · sigs=${sigs.length}） | ${got.source}`);
    } catch (e) {
      // Even here: force demo (NEVER blank)
      const bars = genDemoCandles(DEFAULT_BARS, timeframe);
      CURRENT_BARS = bars;

      const emaArr = calcEMA(bars, prm.ema);
      const auxArr = calcEMA(bars, prm.aux);
      const emaSplit = buildColorSwitchEMA(emaArr);

      candleSeries.setData(bars);
      emaUp.setData(emaSplit.up);
      emaDown.setData(emaSplit.dn);
      auxSeries.setData(auxArr);

      const sigs = detectSignals(bars, emaArr, auxArr, prm.cooldown);
      CURRENT_SIGS = sigs;

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

      setHint(`DEMO fallback (render ok) | ${(e && e.message) || e}`);
    }
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
   * Init (robust container sizing)
   * ----------------------------- */
  function init(opts) {
    opts = opts || {};
    const containerId = opts.containerId || "chart";
    const overlayId = opts.overlayId || "sigOverlay";

    containerEl = pickContainer(containerId);
    overlayEl = $(overlayId) || document.querySelector("#sigOverlay");

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

    // EMA split series (ONLY THESE TWO)
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

    // AUX (ONLY THIS ONE)
    auxSeries = chart.addLineSeries({
      color: "rgba(255,184,108,.85)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    bindOverlay();

    const resize = () => {
      const r = containerEl.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width));
      const h = Math.max(1, Math.floor(r.height));

      chart.applyOptions({ width: w, height: h });
      chart.timeScale().fitContent();
      repaintOverlay();
    };

    // If height is 0, force a minimum height so chart never blank
    const r0 = containerEl.getBoundingClientRect();
    if (r0.height < 40) {
      containerEl.style.minHeight = "520px";
    }

    try {
      new ResizeObserver(resize).observe(containerEl);
    } catch (_) {}
    window.addEventListener("resize", resize);

    resize();

    if (opts.autoLoad !== false) {
      load().catch((e) => setHint(`init autoload failed: ${(e && e.message) || e}`));
    }
  }

  window.ChartCore = { init, load, applyToggles, exportPNG };
})();
