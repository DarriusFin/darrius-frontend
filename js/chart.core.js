/* =========================================================================
 * FILE: darrius-frontend/js/chart.core.js
 * DarriusAI - ChartCore (RENDER-ONLY) v2026.02.03
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

  const API_BASE = (window.API_BASE || "https://darrius-api.onrender.com").replace(/\/+$/, "");

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

  function setTopText(sym, lastClose) {
    safeRun("topText", () => {
      if ($("symText")) $("symText").textContent = sym;
      if ($("priceText") && lastClose != null) $("priceText").textContent = Number(lastClose).toFixed(2);
      if ($("hintText")) $("hintText").textContent = "Market snapshot loaded · 已加载市场快照";
    });
  }

  function mapSignalsToMarkers(signals) {
    const out = [];
    (signals || []).forEach((s) => {
      const side = (s.side || "").trim();
      const t = Number(s.time);
      if (!t || !side) return;

      const isBuy = (side === "B" || side === "eB");
      const isSell = (side === "S" || side === "eS");

      if (!isBuy && !isSell) return;

      const text = side; // keep as B/S/eB/eS
      out.push({
        time: t,
        position: isBuy ? "belowBar" : "aboveBar",
        shape: isBuy ? "arrowUp" : "arrowDown",
        color: isBuy ? "#00ff88" : "#ff4757",
        text,
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
    },

    toggles: {
      ema: true,
      aux: true,
    },

    lastSnapshot: null,
  };

  function ensureChart() {
    if (S.chart && S.candle) return true;

    if (typeof window.LightweightCharts === "undefined") {
      console.error("[ChartCore] LightweightCharts missing. Add CDN script before chart.core.js");
      return false;
    }

    const el = $(S.opts.chartElId);
    if (!el) {
      console.error("[ChartCore] Missing chart container #" + S.opts.chartElId);
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

    // EMA/AUX (optional series)
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

    S.ro = new ResizeObserver(() => fit());
    S.ro.observe(el);
    window.addEventListener("resize", fit);

    S.chart = chart;
    S.candle = candle;
    S.ema = ema;
    S.aux = aux;

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

    const resp = await fetch(url, { method: "GET" });
    if (!resp.ok) throw new Error(`snapshot_http_${resp.status}`);
    return await resp.json();
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

    // EMA series (optional)
    const emaSeries = snap.ema_series || [];
    const auxSeries = snap.aux_series || [];

    // Apply toggles (do not destroy series; just set empty data)
    if (S.toggles.ema && emaSeries.length) {
      S.ema.setData(emaSeries);
    } else {
      S.ema.setData([]);
    }

    if (S.toggles.aux && auxSeries.length) {
      S.aux.setData(auxSeries);
    } else {
      S.aux.setData([]);
    }

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
    if (!ensureChart()) return;

    const symbol = readSymbolFromUI();
    const tf = getTF(S.opts.tfElId);
    const limit = DEFAULTS.limit;

    // UI hint (optional)
    safeRun("hint", () => {
      if ($("hintText")) $("hintText").textContent = "Loading snapshot… / 加载中…";
    });

    const snap = await fetchSnapshot(symbol, tf, limit);
    renderSnapshot(symbol, tf, snap);
  }

  function applyToggles() {
    // Read toggles from existing UI if present
    const tgEMA = $("tgEMA");
    const tgAux = $("tgAux");
    if (tgEMA) S.toggles.ema = !!tgEMA.checked;
    if (tgAux) S.toggles.aux = !!tgAux.checked;

    // Re-render last snapshot quickly
    if (S.lastSnapshot && S.lastSnapshot.bars) {
      const sym = S.lastSnapshot.symbol || readSymbolFromUI();
      const tf = S.lastSnapshot.tf || getTF(S.opts.tfElId);
      renderSnapshot(sym, tf, S.lastSnapshot);
    }
  }

  function exportPNG() {
    // lightweight-charts doesn't provide direct export in standalone by default in all builds.
    alert("导出 PNG：建议用浏览器截图或后续加入 html2canvas。");
  }

  function init(opts) {
    S.opts = Object.assign({}, S.opts, (opts || {}));
    // enforce TSLA default unless caller overrides
    if (!S.opts.defaultSymbol) S.opts.defaultSymbol = "TSLA";
    ensureChart();
    // initial load
    load().catch((e) => {
      console.warn("[ChartCore] initial load failed:", e && e.message ? e.message : e);
      safeRun("hintFail", () => {
        if ($("hintText")) $("hintText").textContent = "Snapshot failed · 请检查后端 /api/market/snapshot";
      });
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
