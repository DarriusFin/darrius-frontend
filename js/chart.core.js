/* =========================================================================
 * FILE: darrius-frontend/js/chart.core.js
 * DarriusAI - ChartCore (RENDER-ONLY) v2026.02.03-RETRY-BASE-FIX
 * ========================================================================= */

(function () {
  "use strict";

  // ---- hard shims ----
  try {
    if (!window.__PATHS__ || typeof window.__PATHS__ !== "object") window.__PATHS__ = {};
    if (typeof window.__PATHS__.js !== "string") window.__PATHS__.js = "js/";
  } catch (e) {}

  const DEFAULT_API_BASE = "https://darrius-api.onrender.com";

  function cleanBase(x) {
    const s = String(x || "").trim();
    if (!s) return "";
    // only accept absolute http(s) base; otherwise ignore (prevents "/api" or "" breaking)
    if (!/^https?:\/\//i.test(s)) return "";
    return s.replace(/\/+$/, "");
  }

  // Collect candidate bases (first valid wins; failures will auto-try next)
  const CANDIDATE_BASES = [];
  const b1 = cleanBase(window.API_BASE);
  const b2 = cleanBase(DEFAULT_API_BASE);
  if (b1) CANDIDATE_BASES.push(b1);
  if (b2 && b2 !== b1) CANDIDATE_BASES.push(b2);

  const DEFAULTS = { symbol: "TSLA", tf: "1d", limit: 600 };
  const $ = (id) => document.getElementById(id);

  function safeRun(tag, fn) {
    try { return fn(); } catch (e) { console.warn("[ChartCore]", tag, e); return null; }
  }
  function setHintText(msg) {
    safeRun("hintText", () => { const el = $("hintText"); if (el) el.textContent = msg; });
  }
  function normSymbol(s) { return String(s || "").trim().toUpperCase() || DEFAULTS.symbol; }
  function getTF(tfElId) { return (($(tfElId)?.value || DEFAULTS.tf) + "").trim(); }
  function getElBy2(primaryId, fallbackId) { return $(primaryId) || $(fallbackId) || null; }

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
        time: t,
        position: isBuy ? "belowBar" : "aboveBar",
        shape: isBuy ? "arrowUp" : "arrowDown",
        color: isBuy ? "#00ff88" : "#ff4757",
        text: side,
      });
    });
    return out;
  }

  const S = {
    chart: null,
    candle: null,
    ema: null,
    aux: null,
    ro: null,
    _lwcLoading: false,
    opts: {
      chartElId: "chart",
      symbolElIdPrimary: "symbol",
      symbolElIdFallback: "symbo1",
      tfElId: "tf",
      defaultSymbol: "TSLA",
      limit: DEFAULTS.limit,
      lwcCdn: "https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js",
      fetchTimeoutMs: 20000, // 给 Render 冷启动更宽松一点
    },
    toggles: { ema: true, aux: true },
    lastSnapshot: null,
  };

  function loadLWCIfNeeded() {
    if (window.LightweightCharts) return Promise.resolve(true);
    if (S._lwcLoading) {
      return new Promise((resolve) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
          if (window.LightweightCharts) { clearInterval(timer); resolve(true); }
          if (Date.now() - t0 > 15000) { clearInterval(timer); resolve(false); }
        }, 80);
      });
    }
    S._lwcLoading = true;
    return new Promise((resolve) => {
      try {
        const src = S.opts.lwcCdn;
        if (!src) return resolve(false);
        const exists = Array.from(document.scripts || []).some((sc) => (sc.src || "").includes("lightweight-charts"));
        if (exists) return resolve(true);
        const s = document.createElement("script");
        s.src = src; s.async = true;
        s.onload = () => resolve(!!window.LightweightCharts);
        s.onerror = () => resolve(false);
        document.head.appendChild(s);
      } catch (e) { resolve(false); }
    }).finally(() => { S._lwcLoading = false; });
  }

  async function ensureChart() {
    if (S.chart && S.candle) return true;
    const ok = await loadLWCIfNeeded();
    if (!ok || !window.LightweightCharts) {
      setHintText("Chart lib missing · 缺少 lightweight-charts");
      return false;
    }
    const el = $(S.opts.chartElId);
    if (!el) { setHintText("Missing chart container #chart"); return false; }

    const chart = window.LightweightCharts.createChart(el, {
      layout: { background: { color: "transparent" }, textColor: "#d1d4dc" },
      grid: { vertLines: { color: "transparent" }, horzLines: { color: "transparent" } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderVisible: false },
      crosshair: { mode: 1 },
    });

    const candle = chart.addCandlestickSeries({
      upColor: "#00ff88", downColor: "#ff4757",
      wickUpColor: "#00ff88", wickDownColor: "#ff4757",
      borderVisible: false,
    });
    const ema = chart.addLineSeries({ lineWidth: 2 });
    const aux = chart.addLineSeries({ lineWidth: 2 });

    function fit() {
      const r = el.getBoundingClientRect();
      chart.applyOptions({ width: Math.max(1, r.width | 0), height: Math.max(1, r.height | 0) });
      chart.timeScale().fitContent();
    }
    try { S.ro = new ResizeObserver(fit); S.ro.observe(el); } catch (e) {}
    window.addEventListener("resize", fit);

    S.chart = chart; S.candle = candle; S.ema = ema; S.aux = aux;

    // legacy globals (avoid "chart is not defined")
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

  async function fetchJsonWithTimeout(url) {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), Number(S.opts.fetchTimeoutMs || 20000));
    try {
      const resp = await fetch(url, { method: "GET", cache: "no-store", signal: controller.signal });
      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      if (!resp.ok) throw new Error(`http_${resp.status}`);
      if (!ct.includes("application/json")) {
        // very common when hitting wrong host: returns HTML
        throw new Error("non_json_response");
      }
      return await resp.json();
    } finally {
      clearTimeout(to);
    }
  }

  async function fetchSnapshot(symbol, tf, limit) {
    const paths = CANDIDATE_BASES.length ? CANDIDATE_BASES : [DEFAULT_API_BASE];
    let lastErr = null;

    for (const base of paths) {
      const url =
        `${base}/api/market/snapshot?symbol=${encodeURIComponent(symbol)}` +
        `&tf=${encodeURIComponent(tf)}` +
        `&limit=${encodeURIComponent(String(limit || DEFAULTS.limit))}`;

      // expose for debugging
      window.__CHARTCORE_LAST_URL__ = url;

      try {
        setHintText(`Loading… ${symbol} ${tf}  (api: ${base.replace("https://", "")})`);
        const data = await fetchJsonWithTimeout(url);
        return { data, url, base };
      } catch (e) {
        lastErr = e;
        // try next base
      }
    }

    throw lastErr || new Error("snapshot_failed");
  }

  function renderSnapshot(symbol, tf, snap) {
    if (!snap || snap.ok !== true) throw new Error("snapshot_not_ok");
    const bars = snap.bars || [];
    if (!bars.length) throw new Error("no_bars");

    S.candle.setData(bars);

    const last = bars[bars.length - 1];
    safeRun("top", () => {
      if ($("symText")) $("symText").textContent = symbol;
      if ($("priceText") && last && last.close != null) $("priceText").textContent = Number(last.close).toFixed(2);
    });

    const emaSeries = snap.ema_series || [];
    const auxSeries = snap.aux_series || [];

    if (S.toggles.ema && emaSeries.length) S.ema.setData(emaSeries); else S.ema.setData([]);
    if (S.toggles.aux && auxSeries.length) S.aux.setData(auxSeries); else S.aux.setData([]);

    const markers = mapSignalsToMarkers(snap.signals || snap.sigs || []);
    S.candle.setMarkers(markers);

    const snapshot = {
      ok: true, symbol, tf, bars,
      ema_series: emaSeries,
      aux_series: auxSeries,
      signals: (snap.signals || snap.sigs || []),
      meta: (snap.meta || {}),
      source: snap.source || (snap.meta && snap.meta.source) || "backend",
      ts: Date.now(),
    };

    S.lastSnapshot = snapshot;
    window.__DARRIUS_CHART_STATE__ = snapshot;

    window.DarriusChart = {
      timeToX: (t) => safeRun("timeToX", () => S.chart.timeScale().timeToCoordinate(t)),
      priceToY: (p) => safeRun("priceToY", () => S.candle.priceToCoordinate(p)),
      getSnapshot: () => (window.__DARRIUS_CHART_STATE__ || null),
    };

    safeRun("emit", () => {
      window.dispatchEvent(new CustomEvent("darrius:chartUpdated", { detail: snapshot }));
    });

    setHintText("Market snapshot loaded · 已加载市场快照");
  }

  async function load() {
    const ok = await ensureChart();
    if (!ok) return;

    const symbol = readSymbolFromUI();
    const tf = getTF(S.opts.tfElId);
    const limit = Number(S.opts.limit || DEFAULTS.limit);

    try {
      const { data, url } = await fetchSnapshot(symbol, tf, limit);
      renderSnapshot(symbol, tf, data);
      // expose last good
      window.__CHARTCORE_LAST_OK_URL__ = url;
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      const url = window.__CHARTCORE_LAST_URL__ || "(unknown)";
      console.warn("[ChartCore] snapshot failed:", msg, "url=", url);
      setHintText(`Snapshot failed: ${msg} · ${url}`);
    }
  }

  function applyToggles() {
    const tgEMA = $("tgEMA");
    const tgAux = $("tgAux");
    if (tgEMA) S.toggles.ema = !!tgEMA.checked;
    if (tgAux) S.toggles.aux = !!tgAux.checked;

    if (S.lastSnapshot && S.lastSnapshot.ok && (S.lastSnapshot.bars || []).length) {
      renderSnapshot(S.lastSnapshot.symbol, S.lastSnapshot.tf, S.lastSnapshot);
    }
  }

  function init(opts) {
    S.opts = Object.assign({}, S.opts, (opts || {}));
    if (!S.opts.defaultSymbol) S.opts.defaultSymbol = "TSLA";
    if (!S.opts.limit) S.opts.limit = DEFAULTS.limit;
    load();
  }

  window.ChartCore = { init, load, applyToggles, exportPNG: () => alert("PNG：建议截图或后续加 html2canvas") };
})();
