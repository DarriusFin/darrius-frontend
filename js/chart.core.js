/* =========================================================
 * DarriusAI · Chart Core (FIXED + MORE REALISTIC)
 * File: js/chart.core.js
 * Public:
 *  window.ChartCore = { init, load, applyToggles, exportPNG }
 * ========================================================= */

(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }
  function log() { if (window.console) console.log.apply(console, arguments); }

  function getApiBase() {
    return (window.API_BASE || "").trim() || "";
  }
  function getUiSymbol() {
    return (($("symbol")?.value || "BTCUSDT") + "").trim().toUpperCase();
  }
  function getUiTf() {
    return (($("tf")?.value || "1d") + "").trim() || "1d";
  }

  const DEFAULT_BARS = 260;

  const TF_PARAMS = {
    "5m": { ema: 8,  aux: 20, cooldown: 10, pivot: 3 },
    "15m":{ ema: 9,  aux: 21, cooldown: 12, pivot: 3 },
    "30m":{ ema: 10, aux: 24, cooldown: 14, pivot: 3 },
    "1h": { ema: 10, aux: 26, cooldown: 16, pivot: 4 },
    "4h": { ema: 12, aux: 30, cooldown: 18, pivot: 4 },
    "1d": { ema: 10, aux: 21, cooldown: 14, pivot: 5 },
    "1w": { ema: 8,  aux: 18, cooldown: 10, pivot: 5 },
    "1M": { ema: 6,  aux: 14, cooldown: 8,  pivot: 5 },
  };

  let chart = null;
  let candleSeries = null;
  let emaUp = null;
  let emaDown = null;
  let auxSeries = null;

  let CURRENT_BARS = [];
  let CURRENT_SIGS = [];

  let containerEl = null;
  let overlayEl = null;

  /* -----------------------------
   * Demo fallback
   * ----------------------------- */
  function genDemoCandles(n, tf) {
    n = n || DEFAULT_BARS;
    const stepMap = {
      "5m": 300, "15m": 900, "30m": 1800,
      "1h": 3600, "4h": 14400, "1d": 86400,
      "1w": 604800, "1M": 2592000,
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
        low: +low.toFixed(2),
        close: +close.toFixed(2),
      });
      t += step;
    }
    return arr;
  }

  /* -----------------------------
   * Data sanitization (CRITICAL)
   * - fix ms timestamps
   * - drop invalid OHLC (0/NaN/high<low/etc.)
   * ----------------------------- */
  function normalizeBars(rawBars) {
    if (!Array.isArray(rawBars)) return [];

    const out = [];
    for (const b of rawBars) {
      if (!b) continue;

      let t = Number(b.time);
      let o = Number(b.open);
      let h = Number(b.high);
      let l = Number(b.low);
      let c = Number(b.close);

      if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;

      // ms -> s auto-fix
      if (t > 1e12) t = Math.floor(t / 1000);

      // reject unrealistic time (before 2000 or too far future)
      if (t < 946684800 || t > 4102444800) continue;

      // reject zeros / negatives for stock/crypto
      if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;

      // enforce OHLC integrity
      const hi = Math.max(o, h, l, c);
      const lo = Math.min(o, h, l, c);
      if (hi < lo) continue;

      h = hi;
      l = lo;

      out.push({ time: t, open: o, high: h, low: l, close: c });
    }

    // sort & de-dup by time
    out.sort((a, b) => a.time - b.time);
    const dedup = [];
    let lastT = -1;
    for (const x of out) {
      if (x.time === lastT) continue;
      lastT = x.time;
      dedup.push(x);
    }
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
    for (const b of bars) {
      const v = b.close;
      prev = (prev === null) ? v : (v * k + prev * (1 - k));
      out.push({ time: b.time, value: +prev.toFixed(6) });
    }
    return out;
  }

  /* -----------------------------
   * EMA color split (REAL gap using undefined)
   * ----------------------------- */
 function splitEMABySlope(emaArr) {
  const up = [];
  const down = [];

  for (let i = 0; i < emaArr.length; i++) {
    const cur = emaArr[i];
    const prev = emaArr[i - 1];

    if (!prev) {
      // first point: show as up by default
      up.push({ time: cur.time, value: cur.value });
      continue;
    }

    if (cur.value >= prev.value) {
      // show ONLY green point
      up.push({ time: cur.time, value: cur.value });
      // do NOT push down point at this time => hard gap
    } else {
      // show ONLY red point
      down.push({ time: cur.time, value: cur.value });
      // do NOT push up point at this time => hard gap
    }
  }

  return { up, down };
}


  /* -----------------------------
   * More realistic signals:
   * 1) EMA x AUX cross -> pending
   * 2) confirm on next bar by EMA slope direction
   * 3) pivot fallback (optional) for obvious peaks/valleys
   * ----------------------------- */
  function detectCrossConfirmSignals(bars, emaFast, auxSlow, cooldownBars) {
    const sigs = [];
    let lastSigIdx = -1e9;
    let pending = null; // {side:'B'|'S', idxCross:number}

    for (let i = 2; i < bars.length; i++) {
      const diffPrev = (emaFast[i - 1]?.value ?? bars[i - 1].close) - (auxSlow[i - 1]?.value ?? bars[i - 1].close);
      const diffNow  = (emaFast[i]?.value ?? bars[i].close)     - (auxSlow[i]?.value ?? bars[i].close);

      const crossUp = (diffPrev <= 0 && diffNow > 0);
      const crossDn = (diffPrev >= 0 && diffNow < 0);

      if (!pending) {
        if (crossUp) pending = { side: "B", idxCross: i };
        else if (crossDn) pending = { side: "S", idxCross: i };
      } else {
        // confirm at idxCross + 1
        if (i === pending.idxCross + 1) {
          const eNow = emaFast[i]?.value ?? bars[i].close;
          const ePrev = emaFast[i - 1]?.value ?? bars[i - 1].close;
          const slope = eNow - ePrev;

          const ok =
            (pending.side === "B" && slope >= 0) ||
            (pending.side === "S" && slope <= 0);

          if (ok && (i - lastSigIdx >= cooldownBars)) {
            sigs.push({
              time: bars[i].time,
              price: pending.side === "B" ? bars[i].low : bars[i].high,
              side: pending.side,
              src: "cross",
            });
            lastSigIdx = i;
          }
          pending = null;
        }

        // timeout
        if (pending && (i - pending.idxCross) > 6) pending = null;
      }
    }
    return sigs;
  }

  function detectPivotSignals(bars, leftRight, cooldownBars) {
    const sigs = [];
    let last = -1e9;
    const L = Math.max(2, Number(leftRight) || 4);

    for (let i = L; i < bars.length - L; i++) {
      if (i - last < cooldownBars) continue;

      let isHigh = true;
      let isLow = true;
      const hi = bars[i].high;
      const lo = bars[i].low;

      for (let k = 1; k <= L; k++) {
        if (bars[i - k].high >= hi || bars[i + k].high >= hi) isHigh = false;
        if (bars[i - k].low  <= lo || bars[i + k].low  <= lo) isLow = false;
        if (!isHigh && !isLow) break;
      }

      if (isHigh) {
        sigs.push({ time: bars[i].time, price: bars[i].high, side: "S", src: "pivot" });
        last = i;
      } else if (isLow) {
        sigs.push({ time: bars[i].time, price: bars[i].low, side: "B", src: "pivot" });
        last = i;
      }
    }
    return sigs;
  }

  function mergeSignals(primary, secondary, maxCount) {
    const map = new Map();
    for (const s of primary) map.set(`${s.side}_${s.time}`, s);
    for (const s of secondary) {
      const key = `${s.side}_${s.time}`;
      if (!map.has(key)) map.set(key, s);
    }
    const arr = Array.from(map.values()).sort((a, b) => a.time - b.time);
    return arr.slice(Math.max(0, arr.length - (maxCount || 30)));
  }

  /* -----------------------------
   * Overlay
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

      // FORCE colors (B yellow, S white) regardless of CSS
      if (s.side === "B") {
        d.style.background = "#FFD400";
        d.style.color = "#111";
        d.style.borderColor = "rgba(255,212,0,.55)";
      } else {
        d.style.background = "#FFFFFF";
        d.style.color = "#111";
        d.style.borderColor = "rgba(255,255,255,.55)";
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
   * Market data via backend proxy
   * ----------------------------- */
  async function fetchMarketData(symbol, tf) {
    const sym = (symbol || "").trim().toUpperCase();
    const timeframe = (tf || "1d").trim();

    // IMPORTANT: don't over-detect crypto; treat only obvious cases as crypto
    const isCrypto =
      sym.includes("/") ||
      sym.endsWith("USDT") ||
      sym.endsWith("USDC");

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
      if (!data || data.ok !== true || !Array.isArray(data.bars)) {
        throw new Error("Invalid payload");
      }

      const bars = normalizeBars(data.bars);
      if (bars.length < 30) throw new Error("Too few valid bars");

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
    if (!chart || !candleSeries) throw new Error("Chart not initialized");

    const sym = (symbol || getUiSymbol()).trim().toUpperCase();
    const timeframe = (tf || getUiTf()).trim() || "1d";

    const bars = await fetchMarketData(sym, timeframe);
    CURRENT_BARS = bars;

    const prm = TF_PARAMS[timeframe] || TF_PARAMS["1d"];

    const emaArr = calcEMA(bars, prm.ema);
    const auxArr = calcEMA(bars, prm.aux);
    const split = splitEMABySlope(emaArr);

    candleSeries.setData(bars);
    emaUp.setData(split.up);
    emaDown.setData(split.down);
    auxSeries.setData(auxArr);

    // signals: cross-confirm + pivot fallback
    const crossSigs = detectCrossConfirmSignals(bars, emaArr, auxArr, prm.cooldown);
    const pivotSigs = detectPivotSignals(bars, prm.pivot, prm.cooldown);

    const sigs = mergeSignals(crossSigs, pivotSigs, 30);
    CURRENT_SIGS = sigs;

    // markers colors per your request: B yellow, S white
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

    // EMA split series (this is ONE EMA visually, with color change)
    emaUp = chart.addLineSeries({ color: "#2BE2A6", lineWidth: 2 });
    emaDown = chart.addLineSeries({ color: "#FF5A5A", lineWidth: 2 });

    // AUX only one line
    auxSeries = chart.addLineSeries({ color: "rgba(255,184,108,.85)", lineWidth: 2 });

    bindOverlay();

    const resize = () => {
      const r = containerEl.getBoundingClientRect();
      chart.applyOptions({ width: Math.max(1, Math.floor(r.width)), height: Math.max(1, Math.floor(r.height)) });
      chart.timeScale().fitContent();
      repaintOverlay();
    };

    try { new ResizeObserver(resize).observe(containerEl); } catch (_) {}
    window.addEventListener("resize", resize);
    resize();

    // IMPORTANT: default auto load (do not break existing boot/index)
    if (opts.autoLoad !== false) {
      load().catch((e) => log("[chart] initial load failed:", e.message || e));
    }
  }

  window.ChartCore = { init, load, applyToggles, exportPNG };
})();
