/* =========================================================================
 * DarriusAI - chart.core.js (PRODUCTION FROZEN)
 * Guarantees:
 *  1) NO BLANK CHART from wrong endpoints: prefer /api/market/bars first
 *  2) EMA split color: ABSOLUTE NO-OVERLAP per bar (no seam stitch)
 *     - for each time: exactly ONE of (emaUp, emaDown) has a number
 *     - the other is ALWAYS {time, value: null}
 *  3) B/S markers: optional second request
 *     - try payload first; else try /api/market/sigs then /api/market/signals
 *     - 404/405/5xx => silent (no error, no fake signals)
 *  4) Safe init, safe toggles; NO billing/subscription touch
 * ========================================================================= */

(() => {
  "use strict";

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);
  const qs = (sel) => document.querySelector(sel);

  // -----------------------------
  // Config (IMPORTANT: NO syntax tricks here)
  // -----------------------------
  const DEFAULT_API_BASE =
    (window.DARRIUS_API_BASE && String(window.DARRIUS_API_BASE)) ||
    (window.__API_BASE__ && String(window.__API_BASE__)) ||
    (window._API_BASE_ && String(window._API_BASE_)) ||
    "https://darrius-api.onrender.com";

  // Prefer the endpoint that you verified works:
  //   GET /api/market/bars?symbol=BTCUSDT&tf=1d  -> { asset, bars:[...] }
  // Avoid endpoints that currently 500 for crypto (/api/market/ohlc in your screenshot).
  const BARS_PATH_CANDIDATES = [
    "/api/market/bars",   // ✅ best
    "/api/bars",
    "/bars",
    "/api/ohlcv",
    "/ohlcv",
    "/api/ohlc",
    "/ohlc",
    "/api/market/ohlcv",
    "/market/ohlcv",
    "/api/market/ohlc",   // ⚠ may 500 for crypto; keep LAST
    "/market/ohlc",
  ];

  // Optional signals endpoints (second request)
  const SIGS_PATH_CANDIDATES = [
    "/api/market/sigs",
    "/api/market/signals",
    "/api/sigs",
    "/api/signals",
    "/sigs",
    "/signals",
  ];

  // -----------------------------
  // State
  // -----------------------------
  let containerEl = null;
  let chart = null;
  let candleSeries = null;

  // EMA split (two series, but per bar exactly one has value)
  let emaUp = null;   // green
  let emaDown = null; // red

  // AUX series (single fixed color)
  let auxSeries = null;

  let showEMA = true;
  let showAUX = true;

  // -----------------------------
  // Logging
  // -----------------------------
  function log(...args) {
    console.log(...args);
  }

  // -----------------------------
  // UI readers
  // -----------------------------
  function getUiSymbol() {
    const el =
      $("symbolInput") ||
      $("symInput") ||
      $("symbol") ||
      qs('input[name="symbol"]') ||
      qs("#symbol") ||
      qs("#sym");
    const v = el && (el.value || el.textContent);
    return (v || "BTCUSDT").trim();
  }

  function getUiTf() {
    const el =
      $("tfSelect") ||
      $("timeframeSelect") ||
      $("tf") ||
      qs('select[name="timeframe"]') ||
      qs("#timeframe");
    const v = el && (el.value || el.textContent);
    return (v || "1d").trim();
  }

  // -----------------------------
  // Robust fetch helpers
  // -----------------------------
  async function fetchJson(url) {
    const r = await fetch(url, { method: "GET", credentials: "omit" });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      err.body = text;
      throw err;
    }
    return r.json();
  }

  function toUnixTime(t) {
    if (t == null) return null;
    if (typeof t === "number") {
      if (t > 2e10) return Math.floor(t / 1000); // ms -> s
      return t;
    }
    if (typeof t === "string") {
      const ms = Date.parse(t);
      if (!Number.isFinite(ms)) return null;
      return Math.floor(ms / 1000);
    }
    if (typeof t === "object" && t.year && t.month && t.day) return t;
    return null;
  }

  function normalizeBars(payload) {
    const raw =
      Array.isArray(payload) ? payload :
      Array.isArray(payload?.bars) ? payload.bars :
      Array.isArray(payload?.ohlcv) ? payload.ohlcv :
      Array.isArray(payload?.data) ? payload.data :
      [];

    const bars = (raw || [])
      .map((b) => {
        const time = toUnixTime(b.time ?? b.t ?? b.timestamp ?? b.ts ?? b.date);
        const open = Number(b.open ?? b.o ?? b.Open);
        const high = Number(b.high ?? b.h ?? b.High);
        const low  = Number(b.low  ?? b.l ?? b.Low);
        const close= Number(b.close?? b.c ?? b.Close);
        if (!time || !isFinite(open) || !isFinite(high) || !isFinite(low) || !isFinite(close)) return null;
        return { time, open, high, low, close };
      })
      .filter(Boolean);

    return bars;
  }

  function normalizeSignals(payload) {
    const raw = payload?.sigs || payload?.signals || payload?.data?.sigs || payload?.data?.signals || [];
    if (!Array.isArray(raw)) return [];
    return raw
      .map((s) => {
        const time = toUnixTime(s.time ?? s.t ?? s.timestamp ?? s.ts ?? s.date);
        const side = String(s.side ?? s.type ?? s.action ?? "").toUpperCase();
        if (!time || (side !== "B" && side !== "S")) return null;
        return { time, side };
      })
      .filter(Boolean);
  }

  async function fetchBarsPack(sym, tf) {
    const apiBase = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");
    const q = `symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;

    let lastErr = null;
    for (const p of BARS_PATH_CANDIDATES) {
      const url = `${apiBase}${p}?${q}`;
      try {
        const payload = await fetchJson(url);
        const bars = normalizeBars(payload);
        //关键：必须真的拿到 bars 才算成功，避免“ok:true但bars空”造成空白
        if (bars.length) return { payload, bars, urlUsed: url };
        lastErr = new Error(`bars empty from ${url}`);
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`All bars endpoints failed. Last error: ${lastErr?.message || lastErr}`);
  }

  async function fetchOptionalSignals(sym, tf) {
    const apiBase = String(DEFAULT_API_BASE || "").replace(/\/+$/, "");
    const q = `symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;

    // If backend already embeds signals in bars payload, caller will handle it.
    // Here we try optional endpoints silently.
    for (const p of SIGS_PATH_CANDIDATES) {
      const url = `${apiBase}${p}?${q}`;
      try {
        const payload = await fetchJson(url);
        const sigs = normalizeSignals(payload);
        if (sigs.length) return sigs;
        // If endpoint exists but returns empty, just accept empty.
        return [];
      } catch (e) {
        // silent on 404/405/500 etc.
        continue;
      }
    }
    return [];
  }

  // -----------------------------
  // EMA compute + ABSOLUTE NO-OVERLAP split
  // -----------------------------
  function computeEmaFromBars(bars, period) {
    const k = 2 / (period + 1);
    let ema = null;
    const out = [];
    for (let i = 0; i < bars.length; i++) {
      const c = bars[i].close;
      ema = ema == null ? c : c * k + ema * (1 - k);
      out.push({ time: bars[i].time, value: ema });
    }
    return out;
  }

 function buildSplitEmaNoOverlap(bars, emaPts) {
  if (!bars?.length || !emaPts?.length) return { up: [], down: [] };
  const emaMap = new Map(emaPts.map((p) => [p.time, p.value]));

  const up = [];
  const down = [];

  for (let i = 0; i < bars.length; i++) {
    const t = bars[i].time;
    const ema = emaMap.get(t);
    if (!isFinite(ema)) {
      // 保持时间对齐：两边都放 null gap
      up.push({ time: t, value: null });
      down.push({ time: t, value: null });
      continue;
    }

    const close = bars[i].close;
    const isUp = close >= ema;

    // ✅ 绝对不重叠：同一根K线只允许一边有数值，另一边永远 null
    up.push({ time: t, value: isUp ? ema : null });
    down.push({ time: t, value: isUp ? null : ema });
  }

  return { up, down };
}



  // -----------------------------
  // Markers
  // -----------------------------
  function applyMarkers(sigs) {
    if (!candleSeries) return;
    const arr = Array.isArray(sigs) ? sigs : [];
    candleSeries.setMarkers(
      arr.map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#FFD400" : "#FFFFFF",
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: s.side,
      }))
    );
  }

  // -----------------------------
  // Toggles
  // -----------------------------
  function applyToggles() {
    const emaChecked = $("toggleEMA")?.checked ?? $("emaToggle")?.checked ?? $("emaCheck")?.checked;
    const auxChecked = $("toggleAUX")?.checked ?? $("auxToggle")?.checked ?? $("auxCheck")?.checked;

    if (typeof emaChecked === "boolean") showEMA = emaChecked;
    if (typeof auxChecked === "boolean") showAUX = auxChecked;

    if (emaUp) emaUp.applyOptions({ visible: !!showEMA });
    if (emaDown) emaDown.applyOptions({ visible: !!showEMA });
    if (auxSeries) auxSeries.applyOptions({ visible: !!showAUX });
  }

  // -----------------------------
  // Core load
  // -----------------------------
  async function load() {
    if (!chart || !candleSeries) return;

    const sym = getUiSymbol();
    const tf = getUiTf();

    if ($("hintText")) $("hintText").textContent = "Loading...";

    let pack;
    try {
      pack = await fetchBarsPack(sym, tf);
    } catch (e) {
      log("[ChartCore] load failed:", e);
      if ($("hintText")) $("hintText").textContent = `加载失败：${e.message || e}`;
      throw e;
    }

    const { payload, bars } = pack;

    // Candles
    candleSeries.setData(bars);

    // EMA: compute from bars (backend不提供也能跑；避免依赖后端结构导致空白)
    const emaPts = computeEmaFromBars(bars, 20);
    const split = buildSplitEmaNoOverlap(bars, emaPts);
    emaUp.setData(split.up);
    emaDown.setData(split.down);

    // AUX: 你现在后端 bars 并未提供 aux；这里保持“有就画、没有就空”
    // 如果将来 payload.aux / indicators.aux 出现，可在此扩展。
    auxSeries.setData([]);

    // B/S: 先从 payload 取；没有则第二请求
    let sigs = normalizeSignals(payload);
    if (!sigs.length) {
      sigs = await fetchOptionalSignals(sym, tf);
    }
    applyMarkers(sigs);

    // Fit
    chart.timeScale().fitContent();

    // UI text
    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

    if ($("hintText")) {
      $("hintText").textContent = `Loaded · 已加载（TF=${tf} · sigs=${sigs.length}）`;
    }

    applyToggles();
    return { urlUsed: pack.urlUsed, bars: bars.length, sigs: sigs.length };
  }

  // -----------------------------
  // Export PNG
  // -----------------------------
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

  // -----------------------------
  // Init (idempotent)
  // -----------------------------
  function init(opts) {
    opts = opts || {};
    const containerId = opts.containerId || "chart";

    containerEl = $(containerId);

    if (!containerEl) throw new Error("Chart container missing: #" + containerId);
    if (!window.LightweightCharts) throw new Error("LightweightCharts missing");

    if (chart) return; // idempotent

    chart = window.LightweightCharts.createChart(containerEl, {
      layout: { background: { color: "transparent" }, textColor: "#EAF0F7" },
      grid: {
        vertLines: { color: "rgba(255,255,255,.04)" },
        horzLines: { color: "rgba(255,255,255,.04)" },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { timeVisible: true, secondsVisible: false, borderVisible: false },
      crosshair: { mode: 1 },
    });

    // Candles: 绿色上涨 / 红色下跌（你要求：两个都要）
    candleSeries = chart.addCandlestickSeries({
      upColor: "#2BE2A6",
      downColor: "#FF5A5A",
      wickUpColor: "#2BE2A6",
      wickDownColor: "#FF5A5A",
      borderVisible: false,
    });

    // EMA split
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

    // AUX (placeholder, if you later wire backend aux, it will show)
    auxSeries = chart.addLineSeries({
      color: "rgba(255,184,108,.85)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const resize = () => {
      const r = containerEl.getBoundingClientRect();
      chart.applyOptions({
        width: Math.max(1, Math.floor(r.width)),
        height: Math.max(1, Math.floor(r.height)),
      });
    };

    try {
      new ResizeObserver(resize).observe(containerEl);
    } catch (_) {
      window.addEventListener("resize", resize);
    }
    resize();

    // Bind toggles if present
    $("toggleEMA")?.addEventListener("change", applyToggles);
    $("emaToggle")?.addEventListener("change", applyToggles);
    $("emaCheck")?.addEventListener("change", applyToggles);

    $("toggleAUX")?.addEventListener("change", applyToggles);
    $("auxToggle")?.addEventListener("change", applyToggles);
    $("auxCheck")?.addEventListener("change", applyToggles);

    // auto load
    if (opts.autoLoad !== false) {
      load().catch((e) => log("[ChartCore] initial load failed:", e));
    }
  }

  // Expose
  window.ChartCore = { init, load, applyToggles, exportPNG };
})();
