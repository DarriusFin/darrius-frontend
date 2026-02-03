/* =========================================================================
 * FILE: darrius-frontend/js/chart.core.js
 * DarriusAI - ChartCore (RENDER-ONLY) v2026.02.03c
 *
 * Goals (NO-SECRETS):
 *  - NO EMA/AUX/signal algorithm in frontend.
 *  - Frontend ONLY fetches snapshot from backend and renders:
 *      - candles
 *      - ema_series / aux_series (optional)
 *      - markers from signals (B/S/eB/eS)
 *
 * Key fixes in this version:
 *  1) Absolute URL fetch + strong network error print
 *  2) Snapshot schema compatibility
 *  3) LightweightCharts v4/v5 series API compatibility
 *  4) Trend coloring: up-trend => green, down-trend => red (by close vs prevClose)
 *  5) EMA/AUX distinct colors
 *  6) Markers compatibility: v4 setMarkers() / v5 createSeriesMarkers()
 * ========================================================================= */

(function () {
  "use strict";

  // -----------------------------
  // Config
  // -----------------------------
  const API_BASE = (window.API_BASE || "https://darrius-api.onrender.com").replace(/\/+$/, "");

  const DEFAULTS = {
    symbol: "TSLA",
    tf: "1d",
    limit: 600,
  };

  // NOTE: 你要求“上涨趋势全绿/下跌趋势全红”
  // 这里用最小定义：close >= prevClose => UP(绿)，否则 DOWN(红)
  const TREND_COLORS = {
    up:   { body: "#00ff88", wick: "#00ff88", border: "#00ff88" },
    down: { body: "#ff4757", wick: "#ff4757", border: "#ff4757" },
  };

  // EMA/AUX 两条线区分颜色（可随时换）
  const LINE_COLORS = {
    ema: "#ffffff",   // 白
    aux: "#f5c542",   // 金黄
  };

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);

  function safeRun(tag, fn) {
    try { return fn(); }
    catch (e) {
      console.warn("[ChartCore]", tag, e);
      return null;
    }
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

  function setHint(msg) {
    safeRun("hint", () => {
      if ($("hintText")) $("hintText").textContent = msg;
    });
  }

  function setTopText(sym, lastClose) {
    safeRun("topText", () => {
      if ($("symText")) $("symText").textContent = sym;
      if ($("priceText") && lastClose != null) $("priceText").textContent = Number(lastClose).toFixed(2);
      setHint("Market snapshot loaded · 已加载市场快照");
    });
  }

  // -----------------------------
  // Snapshot schema compatibility
  // -----------------------------
  function normalizeSnapshot(raw) {
    // Accept different shapes:
    // { ok, bars, ema_series?, aux_series?, signals? }
    // { ok, data: { bars... } }  etc.
    const snap = raw && raw.data ? raw.data : raw;

    const ok = (snap && snap.ok === true) || (snap && snap.ok === 1);
    const bars = snap?.bars || snap?.candles || snap?.ohlcv || [];

    // allow ema/aux series
    const ema_series = snap?.ema_series || snap?.ema || [];
    const aux_series = snap?.aux_series || snap?.aux || snap?.aux_series_fast || [];

    // allow signals keys
    const signals = snap?.signals || snap?.sigs || snap?.markers || [];

    const meta = snap?.meta || {};
    const source = snap?.source || meta?.source || "backend";

    return { ok, bars, ema_series, aux_series, signals, meta, source };
  }

  // -----------------------------
  // Trend coloring for candles
  // -----------------------------
  function applyTrendColorsToBars(bars) {
    // LightweightCharts supports per-bar colors:
    // { time, open, high, low, close, color?, wickColor?, borderColor? }
    if (!Array.isArray(bars) || bars.length === 0) return bars;

    let prevClose = null;
    const out = [];

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i] || {};
      const close = Number(b.close);

      // if malformed, keep as-is
      if (!Number.isFinite(close)) { out.push(b); continue; }

      const isUpTrend = (prevClose == null) ? true : (close >= prevClose);
      const c = isUpTrend ? TREND_COLORS.up : TREND_COLORS.down;

      out.push(Object.assign({}, b, {
        color: c.body,
        wickColor: c.wick,
        borderColor: c.border,
      }));

      prevClose = close;
    }
    return out;
  }

  // -----------------------------
  // Signals -> markers
  // -----------------------------
  function mapSignalsToMarkers(signals) {
    const out = [];
    (signals || []).forEach((s) => {
      const side = String(s?.side || s?.label || "").trim(); // keep B/S/eB/eS
      const t = Number(s?.time);
      if (!t || !side) return;

      const isBuy = (side === "B" || side === "eB");
      const isSell = (side === "S" || side === "eS");
      if (!isBuy && !isSell) return;

      out.push({
        time: t,
        position: isBuy ? "belowBar" : "aboveBar",
        shape: isBuy ? "arrowUp" : "arrowDown",
        color: isBuy ? "#00ff88" : "#ff4757",
        text: side,
      });
    });
    return out;
  }

  // v4: series.setMarkers(markers)
  // v5: const m = LightweightCharts.createSeriesMarkers(series, markers); m.setMarkers(markers)
  function setSeriesMarkersCompat(series, markers) {
    const LW = window.LightweightCharts;

    if (series && typeof series.setMarkers === "function") {
      series.setMarkers(markers || []);
      return;
    }

    if (LW && typeof LW.createSeriesMarkers === "function") {
      // cache handle on series for reuse
      if (!series.__markersHandle) {
        series.__markersHandle = LW.createSeriesMarkers(series, markers || []);
      } else if (typeof series.__markersHandle.setMarkers === "function") {
        series.__markersHandle.setMarkers(markers || []);
      }
      return;
    }

    // If we reach here, markers API not available
    throw new Error("markers_api_missing (no setMarkers/createSeriesMarkers)");
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
    pollInFlight: false,
  };

  // -----------------------------
  // Ensure chart (v4/v5 compatible)
  // -----------------------------
  function ensureChart() {
    if (S.chart && S.candle) return true;

    const LW = window.LightweightCharts;
    if (!LW) {
      console.error("[ChartCore] LightweightCharts missing. Add CDN script before chart.core.js");
      return false;
    }

    const el = $(S.opts.chartElId);
    if (!el) {
      console.error("[ChartCore] Missing chart container #" + S.opts.chartElId);
      return false;
    }

    // v4: LW.createChart
    // v5: LW.createChart (still exists), but series API differs
    const chart = LW.createChart(el, {
      layout: { background: { color: "transparent" }, textColor: "#d1d4dc" },
      grid: { vertLines: { color: "transparent" }, horzLines: { color: "transparent" } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderVisible: false },
      crosshair: { mode: 1 },
    });

    // Candles (v4/v5)
    let candle;
    if (typeof chart.addCandlestickSeries === "function") {
      // v4
      candle = chart.addCandlestickSeries({
        upColor: TREND_COLORS.up.body,
        downColor: TREND_COLORS.down.body,
        wickUpColor: TREND_COLORS.up.wick,
        wickDownColor: TREND_COLORS.down.wick,
        borderVisible: false,
      });
    } else if (typeof chart.addSeries === "function" && LW.CandlestickSeries) {
      // v5
      candle = chart.addSeries(LW.CandlestickSeries, {
        upColor: TREND_COLORS.up.body,
        downColor: TREND_COLORS.down.body,
        wickUpColor: TREND_COLORS.up.wick,
        wickDownColor: TREND_COLORS.down.wick,
        borderVisible: false,
      });
    } else {
      console.error("[ChartCore] Candlestick series API missing");
      return false;
    }

    // Lines (v4/v5)
    function addLine(opts) {
      if (typeof chart.addLineSeries === "function") return chart.addLineSeries(opts);                 // v4
      if (typeof chart.addSeries === "function" && LW.LineSeries) return chart.addSeries(LW.LineSeries, opts); // v5
      throw new Error("line_api_missing");
    }

    const ema = addLine({ lineWidth: 2, color: LINE_COLORS.ema });
    const aux = addLine({ lineWidth: 2, color: LINE_COLORS.aux });

    // In case some builds use lineColor instead of color, enforce via applyOptions
    safeRun("applyLineColors", () => {
      ema.applyOptions ? ema.applyOptions({ color: LINE_COLORS.ema }) : null;
      aux.applyOptions ? aux.applyOptions({ color: LINE_COLORS.aux }) : null;
    });

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

  // -----------------------------
  // Network: fetch snapshot (absolute URL + strong error print)
  // -----------------------------
  async function fetchSnapshot(symbol, tf, limit) {
    const url =
      `${API_BASE}/api/market/snapshot?symbol=${encodeURIComponent(symbol)}` +
      `&tf=${encodeURIComponent(tf)}` +
      `&limit=${encodeURIComponent(String(limit || DEFAULTS.limit))}`;

    console.log("[ChartCore] FETCH", url);

    let resp, text;
    try {
      resp = await fetch(url, { method: "GET", mode: "cors", cache: "no-store" });
      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      text = await resp.text();

      if (!resp.ok) {
        console.error("[ChartCore] HTTP", resp.status, resp.statusText, "BODY:", text.slice(0, 500));
        throw new Error(`snapshot_http_${resp.status}`);
      }

      // try json
      if (ct.includes("application/json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
        return JSON.parse(text);
      }

      console.error("[ChartCore] Non-JSON response:", ct, text.slice(0, 300));
      throw new Error("snapshot_non_json");
    } catch (e) {
      console.error("[ChartCore] FETCH_FAIL", e && e.message ? e.message : e, "URL:", url);
      // helpful CORS hint
      if (String(e && e.message || "").toLowerCase().includes("failed to fetch")) {
        console.error("[ChartCore] Tip: If Postman works but browser fails => likely CORS. Check response headers: access-control-allow-origin");
      }
      throw e;
    }
  }

  function renderSnapshot(symbol, tf, rawSnap) {
    const snap = normalizeSnapshot(rawSnap);
    if (!snap.ok) throw new Error("snapshot_not_ok");

    let bars = snap.bars || [];
    if (!bars.length) throw new Error("no_bars");

    // Trend coloring
    bars = applyTrendColorsToBars(bars);

    // candles
    S.candle.setData(bars);

    // top text
    const last = bars[bars.length - 1];
    setTopText(symbol, last && last.close);

    // toggles
    const tgEMA = $("tgEMA");
    const tgAux = $("tgAux");
    if (tgEMA) S.toggles.ema = !!tgEMA.checked;
    if (tgAux) S.toggles.aux = !!tgAux.checked;

    const emaSeries = snap.ema_series || [];
    const auxSeries = snap.aux_series || [];

    if (S.toggles.ema && emaSeries.length) S.ema.setData(emaSeries);
    else S.ema.setData([]);

    if (S.toggles.aux && auxSeries.length) S.aux.setData(auxSeries);
    else S.aux.setData([]);

    // markers (B/S/eB/eS)
    const markers = mapSignalsToMarkers(snap.signals || []);
    setSeriesMarkersCompat(S.candle, markers);

    // snapshot for overlay UI
    const snapshot = {
      ok: true,
      symbol,
      tf,
      bars,
      ema_series: emaSeries,
      aux_series: auxSeries,
      signals: snap.signals || [],
      meta: snap.meta || {},
      source: snap.source || "backend",
      ts: Date.now(),
    };

    S.lastSnapshot = snapshot;
    window.__DARRIUS_CHART_STATE__ = snapshot;

    // bridge
    window.DarriusChart = {
      timeToX: (t) => safeRun("timeToX", () => S.chart.timeScale().timeToCoordinate(t)),
      priceToY: (p) => safeRun("priceToY", () => S.candle.priceToCoordinate(p)),
      getSnapshot: () => (window.__DARRIUS_CHART_STATE__ || null),
    };

    safeRun("emit", () => {
      window.dispatchEvent(new CustomEvent("darrius:chartUpdated", { detail: snapshot }));
    });
  }

  async function load() {
    if (S.pollInFlight) return;
    if (!ensureChart()) return;

    S.pollInFlight = true;
    try {
      const symbol = readSymbolFromUI();
      const tf = getTF(S.opts.tfElId);
      const limit = DEFAULTS.limit;

      setHint("Loading snapshot… / 加载中…");

      const raw = await fetchSnapshot(symbol, tf, limit);
      renderSnapshot(symbol, tf, raw);

      return true;
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      console.error("[ChartCore] LOAD_FAIL", msg, e);
      setHint(`Snapshot failed · ${msg}`);
      return false;
    } finally {
      S.pollInFlight = false;
    }
  }

  function applyToggles() {
    if (S.lastSnapshot && S.lastSnapshot.bars) {
      // re-render using stored snapshot (no extra network)
      renderSnapshot(S.lastSnapshot.symbol || readSymbolFromUI(), S.lastSnapshot.tf || getTF(S.opts.tfElId), S.lastSnapshot);
    } else {
      load();
    }
  }

  function exportPNG() {
    alert("导出 PNG：建议用浏览器截图或后续加入 html2canvas。");
  }

  function init(opts) {
    S.opts = Object.assign({}, S.opts, (opts || {}));
    if (!S.opts.defaultSymbol) S.opts.defaultSymbol = DEFAULTS.symbol;

    ensureChart();
    load();
  }

  // expose
  window.ChartCore = { init, load, applyToggles, exportPNG };

})();
