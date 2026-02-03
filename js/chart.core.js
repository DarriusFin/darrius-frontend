/* =========================================================================
 * FILE: darrius-frontend/js/chart.core.js
 * DarriusAI - ChartCore (RENDER-ONLY) v2026.02.03-GLOW-BADGE
 *
 * Security goal:
 *  - NO EMA/AUX/signal algorithm in frontend.
 *  - Frontend ONLY fetches snapshot from backend and renders:
 *      - candles
 *      - ema_series / aux_series (optional)
 *      - B/S/eB/eS as GLOW BADGES (overlay canvas)
 *
 * Backend contract:
 *  GET /api/market/snapshot?symbol=TSLA&tf=1d&limit=600
 *  -> { ok, bars, ema_series?, aux_series?, signals? (or sigs), meta? }
 * ========================================================================= */

(function () {
  "use strict";

  // -----------------------------
  // Config / constants
  // -----------------------------
  const API_BASE = (window.API_BASE || "https://darrius-api.onrender.com").replace(/\/+$/, "");

  const DEFAULTS = {
    symbol: "TSLA",
    tf: "1d",
    limit: 600,
  };

  const $ = (id) => document.getElementById(id);

  function safeRun(tag, fn) {
    try { return fn(); }
    catch (e) { console.warn("[ChartCore]", tag, e); return null; }
  }

  function toNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function normSymbol(s) {
    return String(s || "").trim().toUpperCase() || DEFAULTS.symbol;
  }

  function getElBy2(primaryId, fallbackId) {
    return $(primaryId) || $(fallbackId) || null;
  }

  function getTF(tfElId) {
    return (($(tfElId)?.value || DEFAULTS.tf) + "").trim();
  }

  function nowTs() { return Date.now(); }

  // -----------------------------
  // Internal state
  // -----------------------------
  const S = {
    chart: null,
    candle: null,
    ema: null,
    aux: null,

    // v5 markers helper (if available)
    v5Markers: null,

    ro: null,

    // overlay canvas for glow badges
    sigCanvas: null,
    sigCtx: null,

    opts: {
      chartElId: "chart",
      overlayElId: "sigOverlay",     // if exists, we reuse
      symbolElIdPrimary: "symbol",
      symbolElIdFallback: "symbo1",
      tfElId: "tf",
      defaultSymbol: "TSLA",
    },

    toggles: {
      ema: true,
      aux: true,
    },

    // last snapshot + bar index for quick price lookup
    lastSnapshot: null,
    barCloseByTime: new Map(), // time -> close

    // to prevent spamming
    _inFlight: false,
  };

  // -----------------------------
  // Lightweight Charts compatibility (v4 & v5)
  // -----------------------------
  function lc() {
    return window.LightweightCharts;
  }

  function isV5() {
    // v5 has LightweightCharts.CandlestickSeries etc, but v4 also has some exports.
    // Better: check chart.addSeries exists and chart.addCandlestickSeries missing.
    return !!(S.chart && typeof S.chart.addSeries === "function" && typeof S.chart.addCandlestickSeries !== "function");
  }

  function createCandleSeries(chart) {
    // v4
    if (typeof chart.addCandlestickSeries === "function") {
      return chart.addCandlestickSeries({
        upColor: "#00ff88",
        downColor: "#ff4757",
        wickUpColor: "#00ff88",
        wickDownColor: "#ff4757",
        borderVisible: false,
      });
    }

    // v5
    if (typeof chart.addSeries === "function" && lc() && lc().CandlestickSeries) {
      return chart.addSeries(lc().CandlestickSeries, {
        upColor: "#00ff88",
        downColor: "#ff4757",
        wickUpColor: "#00ff88",
        wickDownColor: "#ff4757",
        borderVisible: false,
      });
    }

    throw new Error("no_candles_api");
  }

  function createLineSeries(chart, options) {
    // v4
    if (typeof chart.addLineSeries === "function") {
      return chart.addLineSeries(options || {});
    }
    // v5
    if (typeof chart.addSeries === "function" && lc() && lc().LineSeries) {
      return chart.addSeries(lc().LineSeries, options || {});
    }
    throw new Error("no_line_api");
  }

  // v4: series.setMarkers([...])
  // v5: series markers plugin: LightweightCharts.createSeriesMarkers(series)
  function trySetSmallMarkers(markers) {
    // 如果你只要“徽章”，我们默认不画小 markers（避免一堆小箭头/小圆点）
    // 你想保留也行：把 window.__KEEP_SMALL_MARKERS__ = true
    if (!window.__KEEP_SMALL_MARKERS__) return;

    const series = S.candle;
    if (!series) return;

    if (typeof series.setMarkers === "function") {
      series.setMarkers(markers || []);
      return;
    }

    // v5 markers
    if (lc() && typeof lc().createSeriesMarkers === "function") {
      if (!S.v5Markers) S.v5Markers = lc().createSeriesMarkers(series);
      if (S.v5Markers && typeof S.v5Markers.setMarkers === "function") {
        S.v5Markers.setMarkers(markers || []);
      }
    }
  }

  // -----------------------------
  // Ensure chart exists
  // -----------------------------
  function ensureChart() {
    if (S.chart && S.candle) return true;

    if (!lc()) {
      console.error("[ChartCore] LightweightCharts missing. Ensure CDN script is loaded BEFORE chart.core.js");
      return false;
    }

    const el = $(S.opts.chartElId);
    if (!el) {
      console.error("[ChartCore] Missing chart container #" + S.opts.chartElId);
      return false;
    }

    // create chart
    const chart = lc().createChart(el, {
      layout: { background: { color: "transparent" }, textColor: "#d1d4dc" },
      grid: { vertLines: { color: "rgba(255,255,255,0.06)" }, horzLines: { color: "rgba(255,255,255,0.06)" } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderVisible: false },
      crosshair: { mode: 1 },
    });

    // series
    let candle, ema, aux;
    try {
      candle = createCandleSeries(chart);
      ema = createLineSeries(chart, { lineWidth: 2, color: "#FFFFFF" }); // EMA white
      aux = createLineSeries(chart, { lineWidth: 2, color: "#FFD400" }); // AUX yellow
    } catch (e) {
      console.error("[ChartCore] series init failed:", e);
      return false;
    }

    // resize fit
    function fit() {
      const r = el.getBoundingClientRect();
      chart.applyOptions({
        width: Math.max(1, Math.floor(r.width)),
        height: Math.max(1, Math.floor(r.height)),
      });
      safeRun("fitContent", () => chart.timeScale().fitContent());
      // overlay canvas also resize
      safeRun("resizeOverlay", () => resizeOverlayCanvas());
      // redraw badges if we have snapshot
      safeRun("redrawBadges", () => drawBadgesFromSnapshot(S.lastSnapshot));
    }

    S.ro = new ResizeObserver(() => fit());
    S.ro.observe(el);
    window.addEventListener("resize", fit);

    S.chart = chart;
    S.candle = candle;
    S.ema = ema;
    S.aux = aux;

    // Create / reuse overlay canvas (NO HTML change required)
    ensureOverlayCanvas();

    // Try subscribe to time scale changes to redraw badges (helps on zoom/scroll)
    safeRun("subscribeVisibleRange", () => {
      const ts = chart.timeScale();
      if (ts && typeof ts.subscribeVisibleTimeRangeChange === "function") {
        ts.subscribeVisibleTimeRangeChange(() => drawBadgesFromSnapshot(S.lastSnapshot));
      }
      if (ts && typeof ts.subscribeVisibleLogicalRangeChange === "function") {
        ts.subscribeVisibleLogicalRangeChange(() => drawBadgesFromSnapshot(S.lastSnapshot));
      }
    });

    // Try subscribe crosshair move? optional
    return true;
  }

  // -----------------------------
  // Overlay canvas for Glow Badges
  // -----------------------------
  function ensureOverlayCanvas() {
    const chartEl = $(S.opts.chartElId);
    if (!chartEl) return;

    // If an overlay element exists, use it; else create one (no structural changes required)
    let overlay = $(S.opts.overlayElId);

    // If overlay is not present, we create a canvas and append inside chart container
    // This is a JS-only addition; it does not require HTML edits.
    if (!overlay) {
      overlay = document.createElement("canvas");
      overlay.id = S.opts.overlayElId;
      overlay.style.position = "absolute";
      overlay.style.left = "0";
      overlay.style.top = "0";
      overlay.style.width = "100%";
      overlay.style.height = "100%";
      overlay.style.pointerEvents = "none";
      overlay.style.zIndex = "5";

      // Ensure chart container is position:relative to anchor overlay
      const cs = window.getComputedStyle(chartEl);
      if (cs.position === "static") chartEl.style.position = "relative";

      chartEl.appendChild(overlay);
    }

    S.sigCanvas = overlay;
    S.sigCtx = overlay.getContext("2d");
    resizeOverlayCanvas();
  }

  function resizeOverlayCanvas() {
    if (!S.sigCanvas || !S.sigCtx) return;
    const chartEl = $(S.opts.chartElId);
    if (!chartEl) return;

    const r = chartEl.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);

    S.sigCanvas.width = Math.max(1, Math.floor(r.width * dpr));
    S.sigCanvas.height = Math.max(1, Math.floor(r.height * dpr));
    S.sigCanvas.style.width = Math.floor(r.width) + "px";
    S.sigCanvas.style.height = Math.floor(r.height) + "px";

    S.sigCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    S.sigCtx.imageSmoothingEnabled = true;
  }

  function clearOverlay() {
    if (!S.sigCtx || !S.sigCanvas) return;
    const chartEl = $(S.opts.chartElId);
    if (!chartEl) return;
    const r = chartEl.getBoundingClientRect();
    S.sigCtx.clearRect(0, 0, r.width, r.height);
  }

  // ---- GLOW BADGE (你要的核心) ----
  function drawBadge(x, y, label, isBuy) {
    if (!S.sigCtx) return;

    const isEarly = (label === "eB" || label === "eS");

    // size hierarchy
    const radius = isEarly ? 8 : 10;
    const ring = 2.2;
    const glow = isEarly ? 10 : 16;
    const fontSize = isEarly ? 9 : 11;

    // buy below, sell above
    const dy = isBuy ? 16 : -16;
    const y2 = y + dy;

    // colors (match your old style)
    const fill = isBuy ? "#FFD400" : "#FF3B30";           // yellow / red
    const textColor = isBuy ? "#111111" : "#FFFFFF";      // B black / S white
    const glowColor = isBuy
      ? "rgba(255, 212, 0, 0.55)"
      : "rgba(255, 59, 48, 0.55)";

    const ctx = S.sigCtx;

    // glow layer
    ctx.beginPath();
    ctx.arc(x, y2, radius, 0, Math.PI * 2);
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = glow;
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.shadowBlur = 0;

    // main circle
    ctx.beginPath();
    ctx.arc(x, y2, radius, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();

    // white ring
    ctx.lineWidth = ring;
    ctx.strokeStyle = "#FFFFFF";
    ctx.stroke();

    // text
    ctx.font = `700 ${fontSize}px system-ui, -apple-system, Segoe UI, Arial`;
    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y2 + 0.5);
  }

  function drawBadgesFromSnapshot(snapshot) {
    if (!snapshot || !snapshot.ok || !S.chart || !S.candle) return;
    if (!S.sigCtx) return;

    // if user wants to hide overlay badges:
    if (window.__OVERLAY_BIG_SIGS__ === false) return;

    clearOverlay();

    const signals = snapshot.signals || [];
    if (!signals.length) return;

    // sort by time to draw in order
    const sigs = signals.slice().sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));

    for (const s of sigs) {
      const side = String(s.side || "").trim();
      if (!side) continue;

      const t = toNum(s.time);
      if (!t) continue;

      const isBuy = (side === "B" || side === "eB");
      const isSell = (side === "S" || side === "eS");
      if (!isBuy && !isSell) continue;

      // x coordinate
      const x = safeRun("timeToX", () => S.chart.timeScale().timeToCoordinate(t));
      if (x == null) continue;

      // y coordinate: prefer signal.price, else close at that time, else skip
      const p = toNum(s.price);
      const close = S.barCloseByTime.get(t);
      const price = (p != null) ? p : (close != null ? close : null);
      if (price == null) continue;

      const y = safeRun("priceToY", () => S.candle.priceToCoordinate(price));
      if (y == null) continue;

      drawBadge(x, y, side, isBuy);
    }
  }

  // -----------------------------
  // UI helpers
  // -----------------------------
  function setTopText(sym, lastClose) {
    safeRun("topText", () => {
      if ($("symText")) $("symText").textContent = sym;
      if ($("priceText") && lastClose != null) $("priceText").textContent = Number(lastClose).toFixed(2);
      if ($("hintText")) $("hintText").textContent = "Market snapshot loaded · 已加载市场快照";
    });
  }

  function setHint(text) {
    safeRun("hintText", () => {
      if ($("hintText")) $("hintText").textContent = text;
    });
  }

  // -----------------------------
  // Schema compatibility block
  // -----------------------------
  function normalizeSnapshot(raw) {
    const ok = (raw && raw.ok === true);

    const bars = raw?.bars || raw?.data || [];
    const ema_series = raw?.ema_series || raw?.ema || [];
    const aux_series = raw?.aux_series || raw?.aux || [];
    const signals = raw?.signals || raw?.sigs || raw?.markers || [];

    const meta = raw?.meta || {};
    const source = raw?.source || meta?.source || "backend";

    return { ok, bars, ema_series, aux_series, signals, meta, source, _raw: raw };
  }

  function indexBars(bars) {
    S.barCloseByTime.clear();
    (bars || []).forEach((b) => {
      const t = toNum(b.time);
      const c = toNum(b.close);
      if (t && c != null) S.barCloseByTime.set(t, c);
    });
  }

  // -----------------------------
  // Fetch snapshot (absolute URL + error printing)
  // -----------------------------
  async function fetchSnapshot(symbol, tf, limit) {
    const url =
      `${API_BASE}/api/market/snapshot?symbol=${encodeURIComponent(symbol)}` +
      `&tf=${encodeURIComponent(tf)}` +
      `&limit=${encodeURIComponent(String(limit || DEFAULTS.limit))}`;

    // 强制把 URL 打出来（你要 Network 定位）
    console.log("[ChartCore] FETCH snapshot:", url);

    let resp;
    try {
      resp = await fetch(url, { method: "GET", mode: "cors", credentials: "omit" });
    } catch (e) {
      console.error("[ChartCore] NETWORK ERROR (fetch failed):", e);
      throw new Error("network_fetch_failed");
    }

    if (!resp.ok) {
      const text = await safeRun("readErrText", () => resp.text());
      console.error("[ChartCore] HTTP ERROR:", resp.status, resp.statusText, text || "");
      throw new Error(`snapshot_http_${resp.status}`);
    }

    const json = await resp.json();
    return { url, json };
  }

  // -----------------------------
  // Render
  // -----------------------------
  function renderSnapshot(symbol, tf, normalized) {
    if (!normalized || normalized.ok !== true) {
      console.error("[ChartCore] snapshot_not_ok:", normalized?._raw || normalized);
      throw new Error("snapshot_not_ok");
    }

    const bars = normalized.bars || [];
    if (!bars.length) throw new Error("no_bars");

    indexBars(bars);

    // candles
    safeRun("setCandles", () => S.candle.setData(bars));

    // top text
    const last = bars[bars.length - 1];
    setTopText(symbol, last && last.close);

    // series (EMA/AUX)
    const emaSeries = normalized.ema_series || [];
    const auxSeries = normalized.aux_series || [];

    if (S.toggles.ema && emaSeries.length) safeRun("setEMA", () => S.ema.setData(emaSeries));
    else safeRun("clearEMA", () => S.ema.setData([]));

    if (S.toggles.aux && auxSeries.length) safeRun("setAUX", () => S.aux.setData(auxSeries));
    else safeRun("clearAUX", () => S.aux.setData([]));

    // signals -> snapshot state
    const snapshot = {
      ok: true,
      symbol,
      tf,
      bars,
      ema_series: emaSeries,
      aux_series: auxSeries,
      signals: normalized.signals || [],
      meta: normalized.meta || {},
      source: normalized.source || "backend",
      ts: nowTs(),
    };

    S.lastSnapshot = snapshot;
    window.__DARRIUS_CHART_STATE__ = snapshot;

    // OPTIONAL: keep small markers only if user explicitly wants
    // otherwise, we rely on glow badges overlay
    if (window.__KEEP_SMALL_MARKERS__) {
      const markers = (snapshot.signals || []).map((s) => {
        const side = String(s.side || "").trim();
        const t = toNum(s.time);
        if (!t || !side) return null;

        const isBuy = (side === "B" || side === "eB");
        const isSell = (side === "S" || side === "eS");
        if (!isBuy && !isSell) return null;

        return {
          time: t,
          position: isBuy ? "belowBar" : "aboveBar",
          shape: "circle",
          color: isBuy ? "#FFD400" : "#FF3B30",
          text: side,
        };
      }).filter(Boolean);

      trySetSmallMarkers(markers);
    }

    // Draw glow badges
    drawBadgesFromSnapshot(snapshot);

    // Read-only bridge for overlay UI (market.pulse.js)
    window.DarriusChart = {
      timeToX: (t) => safeRun("timeToX", () => S.chart.timeScale().timeToCoordinate(t)),
      priceToY: (p) => safeRun("priceToY", () => S.candle.priceToCoordinate(p)),
      getSnapshot: () => (window.__DARRIUS_CHART_STATE__ || null),
    };

    // Emit event
    safeRun("emit", () => {
      window.dispatchEvent(new CustomEvent("darrius:chartUpdated", { detail: snapshot }));
    });

    // Debug line (optional)
    setHint(`Loaded · Market · TF=${tf} · bars=${bars.length} · sigs=${(snapshot.signals||[]).length}`);
  }

  // -----------------------------
  // UI read
  // -----------------------------
  function readSymbolFromUI() {
    const symEl = getElBy2(S.opts.symbolElIdPrimary, S.opts.symbolElIdFallback);
    const v = symEl ? symEl.value : "";
    return normSymbol(v || S.opts.defaultSymbol || DEFAULTS.symbol);
  }

  // -----------------------------
  // Public load
  // -----------------------------
  async function load() {
    if (S._inFlight) return;
    if (!ensureChart()) return;

    S._inFlight = true;

    const symbol = readSymbolFromUI();
    const tf = getTF(S.opts.tfElId);
    const limit = DEFAULTS.limit;

    setHint("Loading snapshot… / 加载中…");

    try {
      const { url, json } = await fetchSnapshot(symbol, tf, limit);
      const normalized = normalizeSnapshot(json);

      console.log("[ChartCore] SNAPSHOT OK:", { url, ok: normalized.ok, bars: normalized.bars?.length, sigs: normalized.signals?.length });

      renderSnapshot(symbol, tf, normalized);
    } catch (e) {
      console.error("[ChartCore] Snapshot failed:", e);
      setHint(`Snapshot failed · ${(e && e.message) ? e.message : String(e)} · 请看 Console/Network`);
      // keep overlay clear
      clearOverlay();
    } finally {
      S._inFlight = false;
    }
  }

  function applyToggles() {
    const tgEMA = $("tgEMA");
    const tgAux = $("tgAux");
    if (tgEMA) S.toggles.ema = !!tgEMA.checked;
    if (tgAux) S.toggles.aux = !!tgAux.checked;

    // rerender from snapshot
    if (S.lastSnapshot && S.lastSnapshot.bars) {
      const sym = S.lastSnapshot.symbol || readSymbolFromUI();
      const tf = S.lastSnapshot.tf || getTF(S.opts.tfElId);
      // rebuild minimal normalized snapshot shape
      const normalized = {
        ok: true,
        bars: S.lastSnapshot.bars,
        ema_series: S.lastSnapshot.ema_series || [],
        aux_series: S.lastSnapshot.aux_series || [],
        signals: S.lastSnapshot.signals || [],
        meta: S.lastSnapshot.meta || {},
        source: S.lastSnapshot.source || "backend",
      };
      renderSnapshot(sym, tf, normalized);
    } else {
      load();
    }
  }

  function exportPNG() {
    alert("导出 PNG：建议用浏览器截图；如需一键导出，可后续加入 html2canvas。");
  }

  function init(opts) {
    S.opts = Object.assign({}, S.opts, (opts || {}));
    if (!S.opts.defaultSymbol) S.opts.defaultSymbol = DEFAULTS.symbol;

    ensureChart();

    // initial load
    load();
  }

  // Expose
  window.ChartCore = {
    init,
    load,
    applyToggles,
    exportPNG,
  };
})();
