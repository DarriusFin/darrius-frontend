/* =========================================================================
 * FILE: darrius-frontend/js/chart.core.js
 * DarriusAI - ChartCore (RENDER-ONLY) v2026.02.03-PATCHED
 *
 * Security goal:
 *  - NO EMA/AUX/signal algorithm in frontend.
 *  - Frontend ONLY fetches snapshot from backend and renders:
 *      - candles
 *      - ema_series / aux_series (optional)
 *      - markers from signals (B/S/eB/eS)
 *
 * Backend contract (recommended):
 *  GET /api/market/snapshot?symbol=TSLA&tf=1d&limit=600
 *  -> { ok, bars, ema_series?, aux_series?, signals?, meta? }
 * ========================================================================= */

(function () {
  "use strict";

  // -----------------------------
  // Hard compatibility shims (DO NOT REMOVE)
  //   - Fix: Cannot read properties of undefined (reading 'js') from __PATHS__
  //   - Fix: legacy scripts referencing global `chart`
  // -----------------------------
  try {
    if (!window.__PATHS__ || typeof window.__PATHS__ !== "object") window.__PATHS__ = {};
    // Some legacy code reads window.__PATHS__.js as base path
    if (typeof window.__PATHS__.js !== "string") window.__PATHS__.js = "js/";
  } catch (e) {}

  const API_BASE = String(window.API_BASE || "https://darrius-api.onrender.com").replace(/\/+$/, "");

  const DEFAULTS = {
    symbol: "TSLA",
    tf: "1d",
    limit: 600,
  };

  const $ = (id) => document.getElementById(id);

  function safeRun(tag, fn) {
    try { return fn(); } catch (e) { console.warn("[ChartCore]", tag, e); return null; }
  }

  function getElBy2(primaryId, fallbackId) {
    return $(primaryId) || $(fallbackId) || null;
  }

  function normSymbol(s) {
    return String(s || "").trim().toUpperCase() || DEFAULTS.symbol;
  }

  function getTF(tfElId) {
    return (($(tfElId)?.value || DEFAULTS.tf) + "").trim();
  }

  function setHintText(msg) {
    safeRun("hintText", () => {
      const el = $("hintText");
      if (el) el.textContent = msg;
    });
  }

  function setTopText(sym, lastClose) {
    safeRun("topText", () => {
      if ($("symText")) $("symText").textContent = sym;
      if ($("priceText") && lastClose != null) $("priceText").textContent = Number(lastClose).toFixed(2);
      setHintText("Market snapshot loaded · 已加载市场快照");
    });
  }

  // Map backend signals -> lightweight-charts markers
  function mapSignalsToMarkers(signals) {
    const out = [];
    (signals || []).forEach((s) => {
      const side = String(s.side || "").trim();
      const t = Number(s.time);
      if (!t || !side) return;

      const isBuy = (side === "B" || side === "eB");
      const isSell = (side === "S" || side === "eS");
      if (!isBuy && !isSell) return;

      out.push({
        time: t, // backend contract: unix seconds
        position: isBuy ? "belowBar" : "aboveBar",
        shape: isBuy ? "arrowUp" : "arrowDown",
        color: isBuy ? "#00ff88" : "#ff4757",
        text: side, // keep as B/S/eB/eS
      });
    });
    return out;
  }

  // -----------------------------
  // ChartCore internal state
  // -----------------------------
  const S = {
    chart: null,
    candle: null,
    ema: null,
    aux: null,
    ro: null,

    opts: {
      chartElId: "chart",
      overlayElId: "sigOverlay",
      symbolElIdPrimary: "symbol",
      symbolElIdFallback: "symbo1",
      tfElId: "tf",
      defaultSymbol: "TSLA",
      limit: DEFAULTS.limit,
      // If your HTML doesn't include LWC, we will load it here:
      lwcCdn: "https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js",
      fetchTimeoutMs: 15000,
    },

    toggles: {
      ema: true,
      aux: true,
    },

    lastSnapshot: null,
    _lwcLoading: false,
  };

  // -----------------------------
  // Load LightweightCharts dynamically (no HTML change)
  // -----------------------------
  function loadLWCIfNeeded() {
    if (window.LightweightCharts) return Promise.resolve(true);
    if (S._lwcLoading) {
      // wait for it
      return new Promise((resolve) => {
        const start = Date.now();
        const timer = setInterval(() => {
          if (window.LightweightCharts) { clearInterval(timer); resolve(true); }
          if (Date.now() - start > 15000) { clearInterval(timer); resolve(false); }
        }, 80);
      });
    }

    S._lwcLoading = true;
    return new Promise((resolve) => {
      try {
        const src = S.opts.lwcCdn;
        if (!src) return resolve(false);

        // Avoid injecting twice
        const exists = Array.from(document.scripts || []).some((sc) => (sc.src || "").includes("lightweight-charts"));
        if (exists) {
          const start = Date.now();
          const timer = setInterval(() => {
            if (window.LightweightCharts) { clearInterval(timer); resolve(true); }
            if (Date.now() - start > 15000) { clearInterval(timer); resolve(false); }
          }, 80);
          return;
        }

        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.onload = () => resolve(!!window.LightweightCharts);
        s.onerror = () => resolve(false);
        document.head.appendChild(s);
      } catch (e) {
        resolve(false);
      }
    }).finally(() => {
      S._lwcLoading = false;
    });
  }

  // -----------------------------
  // Create / ensure chart
  // -----------------------------
  async function ensureChart() {
    if (S.chart && S.candle) return true;

    const ok = await loadLWCIfNeeded();
    if (!ok || typeof window.LightweightCharts === "undefined") {
      console.error("[ChartCore] LightweightCharts missing and could not be loaded.");
      setHintText("Chart lib missing · 缺少图表库 lightweight-charts");
      return false;
    }

    const el = $(S.opts.chartElId);
    if (!el) {
      console.error("[ChartCore] Missing chart container #" + S.opts.chartElId);
      setHintText("Missing chart container · 缺少图表容器 #chart");
      return false;
    }

    const chart = window.LightweightCharts.createChart(el, {
      layout: { background: { color: "transparent" }, textColor: "#d1d4dc" },
      grid: { vertLines: { color: "transparent" }, horzLines: { color: "transparent" } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderVisible: false },
      crosshair: { mode: 1 },
    });

    const candle = chart.addCandlestickSeries({
      upColor: "#00ff88",
      downColor: "#ff4757",
      wickUpColor: "#00ff88",
      wickDownColor: "#ff4757",
      borderVisible: false,
    });

    const ema = chart.addLineSeries({ lineWidth: 2 });
    const aux = chart.addLineSeries({ lineWidth: 2 });

    function fit() {
      const r = el.getBoundingClientRect();
      chart.applyOptions({
        width: Math.max(1, Math.floor(r.width)),
        height: Math.max(1, Math.floor(r.height)),
      });
      chart.timeScale().fitContent();
    }

    try {
      S.ro = new ResizeObserver(() => fit());
      S.ro.observe(el);
    } catch (e) {
      // old browsers: ignore
    }
    window.addEventListener("resize", fit);

    S.chart = chart;
    S.candle = candle;
    S.ema = ema;
    S.aux = aux;

    // ---- Compatibility shim (legacy scripts) ----
    // Some old scripts expect global `chart` and series references.
    try { window.chart = S.chart; } catch (e) {}
    try { window.candleSeries = S.candle; } catch (e) {}
    try { window.emaSeries = S.ema; } catch (e) {}
    try { window.auxSeries = S.aux; } catch (e) {}

    return true;
  }

  function readSymbolFromUI() {
    const symEl = getElBy2(S.opts.symbolElIdPrimary, S.opts.symbolElIdFallback);
    const v = symEl ? symEl.value : "";
    return normSymbol(v || S.opts.defaultSymbol || DEFAULTS.symbol);
  }

  async function fetchSnapshot(symbol, tf, limit) {
    const url =
      `${API_BASE}/api/market/snapshot?symbol=${encodeURIComponent(symbol)}` +
      `&tf=${encodeURIComponent(tf)}` +
      `&limit=${encodeURIComponent(String(limit || DEFAULTS.limit))}`;

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), Number(S.opts.fetchTimeoutMs || 15000));

    try {
      const resp = await fetch(url, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`snapshot_http_${resp.status}`);
      return await resp.json();
    } finally {
      clearTimeout(to);
    }
  }

  function renderSnapshot(symbol, tf, snap) {
    if (!snap || snap.ok !== true) throw new Error("snapshot_not_ok");

    const bars = snap.bars || [];
    if (!bars.length) throw new Error("no_bars");

    // candles
    S.candle.setData(bars);

    // top text
    const last = bars[bars.length - 1];
    setTopText(symbol, last && last.close);

    // EMA / AUX series (optional)
    const emaSeries = snap.ema_series || [];
    const auxSeries = snap.aux_series || [];

    if (S.toggles.ema && emaSeries.length) S.ema.setData(emaSeries);
    else S.ema.setData([]);

    if (S.toggles.aux && auxSeries.length) S.aux.setData(auxSeries);
    else S.aux.setData([]);

    // markers
    const markers = mapSignalsToMarkers(snap.signals || snap.sigs || []);
    S.candle.setMarkers(markers);

    // snapshot for overlay UI (market.pulse.js)
    const snapshot = {
      ok: true,
      symbol,
      tf,
      bars,
      ema_series: emaSeries,
      aux_series: auxSeries,
      signals: (snap.signals || snap.sigs || []),
      meta: (snap.meta || {}),
      source: snap.source || (snap.meta && snap.meta.source) || "backend",
      ts: Date.now(),
    };

    S.lastSnapshot = snapshot;
    window.__DARRIUS_CHART_STATE__ = snapshot;

    // Provide read-only bridge
    window.DarriusChart = {
      timeToX: (t) => safeRun("timeToX", () => S.chart.timeScale().timeToCoordinate(t)),
      priceToY: (p) => safeRun("priceToY", () => S.candle.priceToCoordinate(p)),
      getSnapshot: () => (window.__DARRIUS_CHART_STATE__ || null),
    };

    // Emit event
    safeRun("emit", () => {
      window.dispatchEvent(new CustomEvent("darrius:chartUpdated", { detail: snapshot }));
    });
  }

  async function load() {
    const ok = await ensureChart();
    if (!ok) return;

    const symbol = readSymbolFromUI();
    const tf = getTF(S.opts.tfElId);
    const limit = Number(S.opts.limit || DEFAULTS.limit);

    setHintText("Loading snapshot… / 加载中…");

    const snap = await fetchSnapshot(symbol, tf, limit);
    renderSnapshot(symbol, tf, snap);
  }

  function applyToggles() {
    const tgEMA = $("tgEMA");
    const tgAux = $("tgAux");
    if (tgEMA) S.toggles.ema = !!tgEMA.checked;
    if (tgAux) S.toggles.aux = !!tgAux.checked;

    if (S.lastSnapshot && S.lastSnapshot.ok && (S.lastSnapshot.bars || []).length) {
      const sym = S.lastSnapshot.symbol || readSymbolFromUI();
      const tf = S.lastSnapshot.tf || getTF(S.opts.tfElId);
      // Re-render using last snapshot (no refetch)
      renderSnapshot(sym, tf, S.lastSnapshot);
    }
  }

  function exportPNG() {
    alert("导出 PNG：建议用浏览器截图或后续加入 html2canvas。");
  }

  function init(opts) {
    S.opts = Object.assign({}, S.opts, (opts || {}));
    if (!S.opts.defaultSymbol) S.opts.defaultSymbol = "TSLA";
    if (!S.opts.limit) S.opts.limit = DEFAULTS.limit;

    // Do not throw: kick off initial load
    load().catch((e) => {
      console.warn("[ChartCore] initial load failed:", e && e.message ? e.message : e);
      setHintText("Snapshot failed · 请检查后端 /api/market/snapshot");
    });
  }

  // Expose
  window.ChartCore = {
    init,
    load,
    applyToggles,
    exportPNG,
  };
})();
