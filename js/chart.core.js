/* =========================================================================
 * DarriusAI - chart.core.js (PRODUCTION FREEZE v1.0.0)
 * Last Updated: 2026-01-19
 *
 * GUARANTEES (do not change subscription/billing logic):
 *  1) Chart will not go blank due to wrong OHLCV path:
 *     - Prefer: /api/market/bars
 *     - Fallback: /api/market/ohlc, /api/bars, /bars, /api/ohlcv, /ohlcv ...
 *  2) EMA split color = ABSOLUTE MUTUAL EXCLUSION (NO OVERLAP):
 *     - For each bar time: ONLY ONE of (emaUp, emaDown) can have numeric value
 *     - The other is ALWAYS Whitespace: { time } (NO value field)
 *     - NO seam stitch, NO parallel double lines
 *  3) Remove "drop-to-bottom" vertical artifacts:
 *     - NEVER emit {time, value: null}
 *     - Sanitize 0/NaN/Infinity/undefined/null
 *     - Whitespace is { time } only
 *  4) B/S markers:
 *     - Try from bars payload first (payload.sigs/signals)
 *     - If missing, optional second request:
 *         /api/market/sigs  then  /api/market/signals
 *       If not found => silent (no error, no fake signals)
 *  5) Safe init, safe toggles; NO billing/subscription touched.
 * ========================================================================= */

(() => {
  "use strict";

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);
  const qs = (sel) => document.querySelector(sel);

  // -----------------------------
  // Config
  // -----------------------------
  const DEFAULT_API_BASE =
    (window.DARRIUS_API_BASE || window._API_BASE_ || "https://darrius-api.onrender.com").replace(/\/+$/, "");

  // Prefer /api/market/bars first (your current working endpoint)
  const BARS_PATH_CANDIDATES = [
    "/api/market/bars",
    "/api/market/ohlc",
    "/api/bars",
    "/bars",
    "/api/ohlcv",
    "/ohlcv",
    "/api/market/ohlcv",
    "/market/ohlcv",
  ];

  // Optional signals endpoints (second request)
  const SIGS_PATH_CANDIDATES = [
    "/api/market/sigs",
    "/api/market/signals",
  ];

  // -----------------------------
  // State
  // -----------------------------
  let containerEl = null;

  let chart = null;
  let candleSeries = null;

  let emaUp = null;     // green
  let emaDown = null;   // red
  let auxSeries = null; // orange

  let LAST_BARS = [];
  let CURRENT_SIGS = [];

  let showEMA = true;
  let showAUX = true;

  // -----------------------------
  // Logging
  // -----------------------------
  function log(...args) {
    console.log("[ChartCore]", ...args);
  }

  // -----------------------------
  // UI readers (tolerant)
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
    return (v || "BTCUSDT").trim().toUpperCase();
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
  // Fetch helpers
  // -----------------------------
  async function fetchJson(url) {
    const r = await fetch(url, { method: "GET", credentials: "omit" });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      const err = new Error(HTTP ${r.status});
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

  // -----------------------------
  // Sanitizers (CRITICAL: prevent "drop-to-bottom" artifacts)
  // -----------------------------
  function isBadNumber(v) {
    // We treat 0 as bad for EMA/AUX because your "竖线到底"曾经由 0/NaN 引发；
    // 若你未来确实存在真实值=0的指标（几乎不可能在价格指标中），再单独放开。
    return v == null || !Number.isFinite(v) || v === 0;
  }

  const WS = (time) => ({ time }); // Whitespace point MUST NOT have value

  function normalizeBars(payload) {
    const raw =
      Array.isArray(payload) ? payload :
      payload?.bars ? payload.bars :
      payload?.ohlcv ? payload.ohlcv :
      payload?.data ? payload.data :
      [];

    const bars = (raw || [])
      .map((b) => {
        const time = toUnixTime(b.time ?? b.t ?? b.timestamp ?? b.ts ?? b.date);
        const open  = Number(b.open  ?? b.o ?? b.Open);
        const high  = Number(b.high  ?? b.h ?? b.High);
        const low   = Number(b.low   ?? b.l ?? b.Low);
        const close = Number(b.close ?? b.c ?? b.Close);

        if (!time) return null;
        if (![open, high, low, close].every((x) => Number.isFinite(x))) return null;
        return { time, open, high, low, close };
      })
      .filter(Boolean);

    return bars;
  }

  function normalizeLinePoints(payload, keyCandidates) {
    const pick = (obj, keys) => {
      for (const k of keys) {
        if (obj && obj[k] != null) return obj[k];
      }
      return null;
    };

    const src =
      pick(payload, keyCandidates) ||
      pick(payload?.indicators || {}, keyCandidates) ||
      pick(payload?.lines || {}, keyCandidates) ||
      [];

    const arr = Array.isArray(src) ? src : [];
    return arr
      .map((p) => {
        const time = toUnixTime(p.time ?? p.t ?? p.timestamp ?? p.ts ?? p.date);
        const value = Number(p.value ?? p.v ?? p.val);
        if (!time) return null;
        if (isBadNumber(value)) return null;
        return { time, value };
      })
      .filter(Boolean);
  }

  function normalizeSignals(payload) {
    const raw = payload?.sigs || payload?.signals || [];
    if (!Array.isArray(raw)) return [];
    return raw
      .map((s) => {
        const time = toUnixTime(s.time ?? s.t ?? s.timestamp ?? s.ts ?? s.date);
        const side = (s.side ?? s.type ?? s.action ?? "").toString().toUpperCase();
        if (!time || (side !== "B" && side !== "S")) return null;
        return { time, side };
      })
      .filter(Boolean);
  }

  async function fetchFirstWorking(sym, tf, paths) {
    const q = symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)};
    let lastErr = null;

    for (const p of paths) {
      const url = ${DEFAULT_API_BASE}${p}?${q};
      try {
        const payload = await fetchJson(url);
        return { payload, urlUsed: url };
      } catch (e) {
        lastErr = e;
        continue;
      }
    }
    const err = new Error(All endpoints failed. Last error: ${lastErr?.message || lastErr});
    err.cause = lastErr;
    throw err;
  }

  async function tryFetchSignals(sym, tf) {
    // 1) already in bars payload? handled in load()
    // 2) optional second request
    try {
      const r = await fetchFirstWorking(sym, tf, SIGS_PATH_CANDIDATES);
      const sigs = normalizeSignals(r.payload);
      return sigs;
    } catch (e) {
      // SILENT by design
      return [];
    }
  }

  // -----------------------------
  // EMA split (ABSOLUTE MUTUAL EXCLUSION)
  // CRITICAL RULE:
  //  - Up has value => Down is Whitespace {time}
  //  - Down has value => Up is Whitespace {time}
  //  - NEVER emit {time, value:null}  (this causes vertical-to-bottom artifacts)
  //  - Also sanitize ema=0/NaN => both Whitespace
  // -----------------------------
  function buildSplitEmaPointsMutualExclusive(bars, emaPoints) {
    if (!bars?.length || !emaPoints?.length) return { up: [], down: [] };

    const emaMap = new Map(emaPoints.map((p) => [p.time, p.value]));
    const up = [];
    const down = [];

    for (let i = 0; i < bars.length; i++) {
      const t = bars[i].time;
      const ema = Number(emaMap.get(t));

      if (isBadNumber(ema)) {
        up.push(WS(t));
        down.push(WS(t));
        continue;
      }

      const close = Number(bars[i].close);
      const isUp = Number.isFinite(close) && close >= ema;

      if (isUp) {
        up.push({ time: t, value: ema });
        down.push(WS(t));
      } else {
        down.push({ time: t, value: ema });
        up.push(WS(t));
      }
    }

    return { up, down };
  }

  // EMA fallback compute (never returns 0/NaN; still sanitize)
  function computeEmaFromBars(bars, period) {
    const k = 2 / (period + 1);
    let ema = null;
    const out = [];
    for (let i = 0; i < bars.length; i++) {
      const c = Number(bars[i].close);
      if (!Number.isFinite(c)) continue;
      ema = ema == null ? c : c * k + ema * (1 - k);
      if (isBadNumber(ema)) continue; // extra safety
      out.push({ time: bars[i].time, value: ema });
    }
    return out;
  }

  // -----------------------------
  // Markers (B yellow, S white) — "bigger looking" text
  // NOTE: marker font size is not directly configurable in LightweightCharts.
  // We make it more visible by using double-letter text and strong contrast.
  // -----------------------------
  function applyMarkers(sigs) {
    CURRENT_SIGS = sigs || [];
    if (!candleSeries) return;

    candleSeries.setMarkers(
      (CURRENT_SIGS || []).map((s) => ({
        time: s.time,
        position: s.side === "B" ? "belowBar" : "aboveBar",
        color: s.side === "B" ? "#FFD400" : "#FFFFFF",
        shape: s.side === "B" ? "arrowUp" : "arrowDown",
        text: s.side === "B" ? "BB" : "SS", // looks bigger than single char
      }))
    );
  }

  // -----------------------------
  // Toggles
  // -----------------------------
  function applyToggles() {
    showEMA = !!($("toggleEMA")?.checked ?? $("emaToggle")?.checked ?? showEMA);
    showAUX = !!($("toggleAUX")?.checked ?? $("auxToggle")?.checked ?? showAUX);

    const altEma = $("emaCheck")?.checked;
    const altAux = $("auxCheck")?.checked;
    if (typeof altEma === "boolean") showEMA = altEma;
    if (typeof altAux === "boolean") showAUX = altAux;

    if (emaUp) emaUp.applyOptions({ visible: showEMA });
    if (emaDown) emaDown.applyOptions({ visible: showEMA });
    if (auxSeries) auxSeries.applyOptions({ visible: showAUX });
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
      pack = await fetchFirstWorking(sym, tf, BARS_PATH_CANDIDATES);
    } catch (e) {
      log("load failed:", e.message || e);
      if ($("hintText")) $("hintText").textContent = 加载失败：${e.message || e};
      throw e;
    }

    const payload = pack.payload;
    const bars = normalizeBars(payload);

    if (!bars.length) {
      if ($("hintText")) $("hintText").textContent = "加载失败：bars 为空（检查后端返回结构）";
      throw new Error("bars empty");
    }
    LAST_BARS = bars;

    // 1) Candles
    candleSeries.setData(bars);

    // 2) EMA (prefer backend; else fallback compute)
    let emaPts = normalizeLinePoints(payload, ["ema", "EMA"]);
    if (!emaPts.length) emaPts = computeEmaFromBars(bars, 20);

    const split = buildSplitEmaPointsMutualExclusive(bars, emaPts);
    emaUp.setData(split.up);
    emaDown.setData(split.down);

    // 3) AUX
    // If backend doesn't provide aux => set empty (no fake line)
    const auxPts = normalizeLinePoints(payload, ["aux", "AUX"]);
    auxSeries.setData(auxPts);

    // 4) Signals
    // - First try from payload
    let sigs = normalizeSignals(payload);

    // - If none, optional second request
    if (!sigs.length) {
      sigs = await tryFetchSignals(sym, tf);
    }
    applyMarkers(sigs);

    // Fit
    chart.timeScale().fitContent();

    // UI texts
    const last = bars[bars.length - 1];
    if ($("symText")) $("symText").textContent = sym;
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);

    if ($("hintText")) {
      $("hintText").textContent = Loaded · 已加载（TF=${tf} · sigs=${sigs.length}）;
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
      a.download = DarriusAI_${getUiSymbol()}_${getUiTf()}.png;
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
    if (!containerEl || !window.LightweightCharts) {
      throw new Error("Chart container or lightweight-charts missing");
    }

    // Prevent double init
    if (chart) return;

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

    // Candles: green up / red down
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

    // AUX
    auxSeries = chart.addLineSeries({
      color: "rgba(255,184,108,.85)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // Resize (stable)
    const resize = () => {
      const r = containerEl.getBoundingClientRect();
      chart.applyOptions({
        width: Math.max(1, Math.floor(r.width)),
        height: Math.max(1, Math.floor(r.height)),
      });
      chart.timeScale().fitContent();
    };

    try {
      new ResizeObserver(resize).observe(containerEl);
    } catch (_) {}
    window.addEventListener("resize", resize);
    resize();

    // auto load
    if (opts.autoLoad !== false) {
      load().catch((e) => log("initial load failed:", e.message || e));
    }
  }

  // Expose
  window.ChartCore = { init, load, applyToggles, exportPNG };
})();
