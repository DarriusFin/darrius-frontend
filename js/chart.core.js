/* =========================================================================
 * darrius-frontend/js/chart.core.js
 * ChartCore (RENDER-ONLY) v2026.02.03b-LW4+LW5-COMPAT
 * ========================================================================= */

(function () {
  "use strict";

  const API_BASE = "https://darrius-api.onrender.com";
  const SNAPSHOT_PATH = "/api/market/snapshot";
  const DEFAULTS = { symbol: "TSLA", tf: "1d", limit: 600 };

  const IDS = {
    chart: "chart",
    symbolPrimary: "symbol",
    symbolFallback: "symbo1",
    tf: "tf",
    hintText: "hintText",
    symText: "symText",
    priceText: "priceText",
    tgEMA: "tgEMA",
    tgAux: "tgAux",
  };

  const $ = (id) => document.getElementById(id);

  function setHint(msg) {
    const el = $(IDS.hintText);
    if (el) el.textContent = msg;
  }

  function safeRun(tag, fn) {
    try { return fn(); } catch (e) { console.warn("[ChartCore]", tag, e); return null; }
  }

  function normSymbol(s) {
    return String(s || "").trim().toUpperCase() || DEFAULTS.symbol;
  }

  function readSymbolFromUI() {
    const el = $(IDS.symbolPrimary) || $(IDS.symbolFallback);
    return normSymbol(el ? el.value : DEFAULTS.symbol);
  }

  function readTF() {
    const el = $(IDS.tf);
    return String((el && el.value) || DEFAULTS.tf).trim() || DEFAULTS.tf;
  }

  function readToggles() {
    const tgE = $(IDS.tgEMA);
    const tgA = $(IDS.tgAux);
    return { ema: tgE ? !!tgE.checked : true, aux: tgA ? !!tgA.checked : true };
  }

  function setTopText(sym, lastClose) {
    safeRun("topText", () => {
      if ($(IDS.symText)) $(IDS.symText).textContent = sym;
      if ($(IDS.priceText) && lastClose != null && isFinite(lastClose)) {
        $(IDS.priceText).textContent = Number(lastClose).toFixed(2);
      }
      setHint("Market snapshot loaded · 已加载市场快照");
    });
  }

  function mapSignalsToMarkers(signals) {
    const out = [];
    (signals || []).forEach((s) => {
      const side = String(s.side || "").trim();
      const t = Number(s.time);
      if (!t || !side) return;

      const isBuy = side === "B" || side === "eB";
      const isSell = side === "S" || side === "eS";
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

  function normalizeSnapshot(raw) {
    const ok = raw && (raw.ok === true || raw.ok === 1 || raw.success === true);
    const bars = (raw && (raw.bars || raw.data || raw.ohlcv)) || [];
    const ema_series = (raw && (raw.ema_series || raw.ema || raw.emaSeries)) || [];
    const aux_series = (raw && (raw.aux_series || raw.aux || raw.auxSeries)) || [];
    const signals = (raw && (raw.signals || raw.sigs || raw.markers || raw.signal_list)) || [];
    const meta = (raw && (raw.meta || raw.metadata)) || {};
    const source = (raw && (raw.source || (meta && meta.source))) || "backend";
    return { ok: !!ok, bars, ema_series, aux_series, signals, meta, source };
  }

  function waitForLightweightCharts({ timeoutMs = 12000, pollMs = 50 } = {}) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function tick() {
        if (window.LightweightCharts && typeof window.LightweightCharts.createChart === "function") return resolve(true);
        if (Date.now() - t0 > timeoutMs) return reject(new Error("LightweightCharts_not_ready_timeout"));
        setTimeout(tick, pollMs);
      })();
    });
  }

  // -----------------------------
  // Internal state
  // -----------------------------
  const S = {
    chart: null,
    candle: null,
    ema: null,
    aux: null,
    ro: null,
    lastSnapshot: null,
    inFlight: false,
    lwMode: null, // "v4" | "v5"
  };

  function detectLWMode(chart) {
    // v4 chart: addCandlestickSeries exists
    if (chart && typeof chart.addCandlestickSeries === "function") return "v4";

    // v5 chart: addSeries exists and global constructors exist
    const LW = window.LightweightCharts;
    if (chart && typeof chart.addSeries === "function" && LW && (LW.CandlestickSeries || LW.LineSeries)) return "v5";

    return null;
  }

  function addCandles(chart) {
    const LW = window.LightweightCharts;

    // v4
    if (typeof chart.addCandlestickSeries === "function") {
      S.lwMode = "v4";
      return chart.addCandlestickSeries({
        upColor: "#00ff88",
        downColor: "#ff4757",
        wickUpColor: "#00ff88",
        wickDownColor: "#ff4757",
        borderVisible: false,
      });
    }

    // v5
    if (typeof chart.addSeries === "function" && LW && LW.CandlestickSeries) {
      S.lwMode = "v5";
      return chart.addSeries(LW.CandlestickSeries, {
        upColor: "#00ff88",
        downColor: "#ff4757",
        wickUpColor: "#00ff88",
        wickDownColor: "#ff4757",
        borderVisible: false,
      });
    }

    throw new Error("LW_candles_api_missing");
  }

  function addLine(chart, opts) {
    const LW = window.LightweightCharts;

    // v4
    if (typeof chart.addLineSeries === "function") {
      S.lwMode = S.lwMode || "v4";
      return chart.addLineSeries(opts || { lineWidth: 2 });
    }

    // v5
    if (typeof chart.addSeries === "function" && LW && LW.LineSeries) {
      S.lwMode = "v5";
      return chart.addSeries(LW.LineSeries, opts || { lineWidth: 2 });
    }

    throw new Error("LW_line_api_missing");
  }

  function ensureChart() {
    if (S.chart && S.candle) return true;

    const el = $(IDS.chart);
    if (!el) throw new Error("Missing_chart_container_#" + IDS.chart);

    const chart = window.LightweightCharts.createChart(el, {
      layout: { background: { color: "transparent" }, textColor: "#d1d4dc" },
      grid: { vertLines: { color: "transparent" }, horzLines: { color: "transparent" } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderVisible: false },
      crosshair: { mode: 1 },
    });

    // detect (helps debug)
    S.lwMode = detectLWMode(chart);

    const candle = addCandles(chart);
    const ema = addLine(chart, { lineWidth: 2 });
    const aux = addLine(chart, { lineWidth: 2 });

    function fit() {
      const r = el.getBoundingClientRect();
      chart.applyOptions({
        width: Math.max(1, Math.floor(r.width)),
        height: Math.max(1, Math.floor(r.height)),
      });
      chart.timeScale().fitContent();
    }

    S.ro = new ResizeObserver(() => safeRun("resizeObserver", fit));
    S.ro.observe(el);
    window.addEventListener("resize", () => safeRun("windowResize", fit));
    safeRun("fitNow", fit);

    S.chart = chart;
    S.candle = candle;
    S.ema = ema;
    S.aux = aux;

    console.info("[ChartCore] LightweightCharts mode:", S.lwMode || "unknown");
    return true;
  }

  async function fetchSnapshot(symbol, tf, limit) {
    const url =
      `${API_BASE}${SNAPSHOT_PATH}` +
      `?symbol=${encodeURIComponent(symbol)}` +
      `&tf=${encodeURIComponent(tf)}` +
      `&limit=${encodeURIComponent(String(limit || DEFAULTS.limit))}` +
      `&_ts=${Date.now()}`;

    console.groupCollapsed("[ChartCore] snapshot fetch");
    console.log("URL:", url);
    console.log("Origin:", window.location.origin);
    console.groupEnd();

    let resp;
    try {
      resp = await fetch(url, { method: "GET", mode: "cors", credentials: "omit", cache: "no-store" });
    } catch (e) {
      throw new Error(`fetch_failed:${e && e.message ? e.message : String(e)}`);
    }

    const allowOrigin = resp.headers.get("access-control-allow-origin");
    console.groupCollapsed(`[ChartCore] snapshot response ${resp.status}`);
    console.log("access-control-allow-origin:", allowOrigin);
    console.groupEnd();

    const text = await resp.text();
    if (!resp.ok) throw new Error(`http_${resp.status}:${text.slice(0, 300)}`);

    let json;
    try { json = JSON.parse(text); }
    catch { throw new Error(`json_parse_failed:${text.slice(0, 300)}`); }

    return json;
  }

  function renderSnapshot(symbol, tf, rawSnap) {
    const snap = normalizeSnapshot(rawSnap);
    if (!snap.ok) throw new Error("snapshot_not_ok");

    const bars = Array.isArray(snap.bars) ? snap.bars : [];
    if (!bars.length) throw new Error("no_bars");

    const toggles = readToggles();

    // candles
    S.candle.setData(bars);

    // top text
    const last = bars[bars.length - 1];
    setTopText(symbol, last && last.close);

    // EMA/AUX
    if (toggles.ema && Array.isArray(snap.ema_series) && snap.ema_series.length) S.ema.setData(snap.ema_series);
    else S.ema.setData([]);

    if (toggles.aux && Array.isArray(snap.aux_series) && snap.aux_series.length) S.aux.setData(snap.aux_series);
    else S.aux.setData([]);

    // markers (small)
    S.candle.setMarkers(mapSignalsToMarkers(snap.signals));

    // publish snapshot
    const out = {
      ok: true,
      symbol,
      tf,
      bars,
      ema_series: snap.ema_series || [],
      aux_series: snap.aux_series || [],
      signals: snap.signals || [],
      meta: snap.meta || {},
      source: snap.source || "backend",
      ts: Date.now(),
    };

    S.lastSnapshot = out;
    window.__DARRIUS_CHART_STATE__ = out;

    window.DarriusChart = {
      timeToX: (t) => safeRun("timeToX", () => S.chart.timeScale().timeToCoordinate(t)),
      priceToY: (p) => safeRun("priceToY", () => S.candle.priceToCoordinate(p)),
      getSnapshot: () => (window.__DARRIUS_CHART_STATE__ || null),
    };

    safeRun("emit", () => {
      window.dispatchEvent(new CustomEvent("darrius:chartUpdated", { detail: out }));
    });
  }

  async function load() {
    if (S.inFlight) return;
    S.inFlight = true;

    const symbol = readSymbolFromUI();
    const tf = readTF();
    const limit = DEFAULTS.limit;

    setHint("Loading snapshot… / 加载中…");

    try {
      await waitForLightweightCharts();
      ensureChart();

      const json = await fetchSnapshot(symbol, tf, limit);
      renderSnapshot(symbol, tf, json);

      console.info("[ChartCore] LOAD OK", { symbol, tf, bars: (json && json.bars && json.bars.length) || "?" });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.error("[ChartCore] LOAD FAILED:", msg, e);
      setHint(`Snapshot failed · ${msg}`);
      window.__CHARTCORE_LAST_ERROR__ = { at: Date.now(), message: msg };
    } finally {
      S.inFlight = false;
    }
  }

  function applyToggles() {
    if (S.lastSnapshot && S.lastSnapshot.ok && S.lastSnapshot.bars) {
      safeRun("applyToggles", () => renderSnapshot(S.lastSnapshot.symbol, S.lastSnapshot.tf, S.lastSnapshot));
    } else {
      load();
    }
  }

  function exportPNG() {
    alert("导出 PNG：建议用浏览器截图；如需可后续加入 html2canvas。");
  }

  function init() {
    const go = () => load();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go, { once: true });
    else go();
  }

  window.ChartCore = { init, load, applyToggles, exportPNG };
  init();

})();
