/* =========================================================
 * DarriusAI - chart.core.js (Integrated, Idempotent Init)
 * - Fix: OHLC 404 leads blank chart (make path configurable)
 * - Fix: EMA split via EMPTY(null) + seam point (no parallel double-lines)
 * - Keeps: markers B/S, toggles EMA/AUX, exportPNG
 * ========================================================= */
(() => {
  "use strict";

  // ---------- Config (YOU MUST VERIFY) ----------
  const API_BASE = "https://darrius-api.onrender.com";
  const OHLC_PATH = "/api/ohlc"; // <<< 改成 https://darrius-api.onrender.com/routes 里真实存在的那条

  // ---------- State ----------
  let chart, candleSeries;
  let emaUpSeries, emaDnSeries, auxSeries;
  let containerEl, overlayEl;

  let CURRENT_BARS = [];
  let CURRENT_SIGS = [];
  let CURRENT_EMA = [];
  let CURRENT_AUX = [];

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);

  function log(...args) {
    try { console.log(...args); } catch (_) {}
  }

  function getUiSymbol() {
    // 尽量兼容你页面各种输入框 id
    const ids = ["symbol", "sym", "symbolInput", "symInput"];
    for (const id of ids) {
      const el = $(id);
      if (el && (el.value || el.textContent)) return (el.value || el.textContent).trim();
    }
    // 右侧面板里你有默认 BTCUSDT
    return "BTCUSDT";
  }

  function getUiTf() {
    const ids = ["timeframe", "tf", "tfSelect", "timeframeSelect"];
    for (const id of ids) {
      const el = $(id);
      if (el && el.value) return el.value.trim();
    }
    return "1d";
  }

  function isTogOn(name) {
    // 兼容你页面的 checkbox
    const map = {
      EMA: ["togEMA", "emaToggle", "chkEMA"],
      AUX: ["togAUX", "auxToggle", "chkAUX"],
    };
    const ids = map[name] || [];
    for (const id of ids) {
      const el = $(id);
      if (el && typeof el.checked === "boolean") return !!el.checked;
    }
    // 如果找不到，就默认 true（避免你以为没画）
    return true;
  }

  function setTopText(sym, bars, sigs, tf, extra) {
    const last = bars && bars.length ? bars[bars.length - 1] : null;
    if ($("symText")) $("symText").textContent = sym || "--";
    if ($("priceText") && last) $("priceText").textContent = Number(last.close).toFixed(2);
    if ($("hintText")) {
      const base = `Loaded · 已加载（TF=${tf} · sigs=${(sigs || []).length}）`;
      $("hintText").textContent = extra ? `${base}  ${extra}` : base;
    }
  }

  function ensureChartSized() {
    if (!chart || !containerEl) return;
    const r = containerEl.getBoundingClientRect();
    chart.applyOptions({
      width: Math.max(1, Math.floor(r.width)),
      height: Math.max(1, Math.floor(r.height)),
    });
  }

  // ---------- Math ----------
  function calcEMA(values, period) {
    const out = new Array(values.length).fill(null);
    if (!values.length) return out;
    const k = 2 / (period + 1);

    // seed: first non-null close as initial
    let ema = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (typeof v === "number" && isFinite(v)) { ema = v; out[i] = ema; break; }
    }
    if (ema === null) return out;

    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (out[i] === null) {
        if (typeof v !== "number" || !isFinite(v)) continue;
        ema = v * k + ema * (1 - k);
        out[i] = ema;
      }
    }
    return out;
  }

  // ---------- EMA Split (EMPTY_VALUE = null) ----------
  // 规则：close >= ema => 绿线显示，红线隐藏；否则红线显示，绿线隐藏
  // 并在切换点补“接缝点”，避免断裂 / 并行双线
  function buildSplitLine(bars, emaArr) {
    const up = [];
    const dn = [];
    if (!bars || !bars.length) return { up, dn };

    let prevState = null; // "UP" or "DN"
    for (let i = 0; i < bars.length; i++) {
      const t = bars[i].time;
      const close = bars[i].close;
      const ema = emaArr[i];
      if (ema == null) {
        up.push({ time: t, value: null });
        dn.push({ time: t, value: null });
        continue;
      }

      const state = close >= ema ? "UP" : "DN";

      // seam: 状态发生变化时，在当前点给两条都补值（只补这一点），让视觉连接自然
      if (prevState && state !== prevState) {
        // 先把上一条在当前点也补一下（等价于 MT4 的 x+1 补点）
        // 当前点：两条都给 value，下一点开始再按 state 分流
        up.push({ time: t, value: ema });
        dn.push({ time: t, value: ema });
      } else {
        if (state === "UP") {
          up.push({ time: t, value: ema });
          dn.push({ time: t, value: null }); // EMPTY
        } else {
          dn.push({ time: t, value: ema });
          up.push({ time: t, value: null }); // EMPTY
        }
      }

      prevState = state;
    }

    return { up, dn };
  }

  // ---------- Data Fetch ----------
  async function fetchOHLC(symbol, tf) {
    const url = `${API_BASE}${OHLC_PATH}?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    // 兼容多种返回格式：[{time,open,high,low,close}] 或 {bars:[...]}
    const bars = Array.isArray(json) ? json : (json.bars || json.data || []);
    if (!Array.isArray(bars) || !bars.length) throw new Error("Empty bars");

    // 统一 time：lightweight-charts 需要 unix seconds 或 business day
    return bars.map((b) => ({
      time: b.time ?? b.t ?? b.timestamp, // 你后端返回哪个就用哪个
      open: Number(b.open ?? b.o),
      high: Number(b.high ?? b.h),
      low: Number(b.low ?? b.l),
      close: Number(b.close ?? b.c),
    }));
  }

  async function fetchSignals(symbol, tf) {
    // 如果你有 signals 接口就在这里接；没有就返回空
    // 保持不报错，避免把图搞空
    return [];
  }

  // ---------- Rendering ----------
  function applyToggles() {
    const showEMA = isTogOn("EMA");
    const showAUX = isTogOn("AUX");

    if (emaUpSeries) emaUpSeries.applyOptions({ visible: !!showEMA });
    if (emaDnSeries) emaDnSeries.applyOptions({ visible: !!showEMA });
    if (auxSeries) auxSeries.applyOptions({ visible: !!showAUX });
  }

  function renderAll(symbol, tf) {
    if (!candleSeries || !chart) return;
    if (!CURRENT_BARS.length) return;

    candleSeries.setData(CURRENT_BARS);

    // markers (B/S)
    if (CURRENT_SIGS && CURRENT_SIGS.length) {
      candleSeries.setMarkers(
        CURRENT_SIGS.map((s) => ({
          time: s.time,
          position: s.side === "B" ? "belowBar" : "aboveBar",
          color: s.side === "B" ? "#FFD400" : "#FFFFFF",
          shape: s.side === "B" ? "arrowUp" : "arrowDown",
          text: s.side,
        }))
      );
    } else {
      candleSeries.setMarkers([]);
    }

    // EMA (split)
    if (emaUpSeries && emaDnSeries) {
      const closes = CURRENT_BARS.map((b) => b.close);
      const ema = calcEMA(closes, 20); // period 你可改
      CURRENT_EMA = ema;

      const split = buildSplitLine(CURRENT_BARS, ema);
      emaUpSeries.setData(split.up);
      emaDnSeries.setData(split.dn);
    }

    // AUX: 这里先给占位（如果你有 AUX 真实算法，把 CURRENT_AUX 算出来再 setData）
    if (auxSeries) {
      if (CURRENT_AUX && CURRENT_AUX.length === CURRENT_BARS.length) {
        auxSeries.setData(CURRENT_BARS.map((b, i) => ({ time: b.time, value: CURRENT_AUX[i] })));
      } else {
        auxSeries.setData([]); // 没算就不画，避免“第三根线”误会
      }
    }

    applyToggles();
    chart.timeScale().fitContent();
    setTopText(symbol, CURRENT_BARS, CURRENT_SIGS, tf, "");
  }

  // ---------- Public API ----------
  async function load() {
    const symbol = getUiSymbol();
    const tf = getUiTf();

    try {
      setTopText(symbol, [], [], tf, "Loading...");
      const bars = await fetchOHLC(symbol, tf); // <- 404 就会在这里抛错
      CURRENT_BARS = bars;

      // signals 可选
      try {
        CURRENT_SIGS = await fetchSignals(symbol, tf);
      } catch (_) {
        CURRENT_SIGS = [];
      }

      renderAll(symbol, tf);
      log("[ChartCore] loaded bars:", bars.length);
    } catch (e) {
      log("[ChartCore] initial load failed:", e.message || e);
      setTopText(symbol, [], [], tf, `加载失败：${e.message || e}`);
      // 注意：这里不 throw，避免把整页搞崩
    }
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

  function init(opts) {
    opts = opts || {};
    const containerId = opts.containerId || "chart";
    const overlayId = opts.overlayId || "sigOverlay";

    // idempotent: 防止重复 init 产生多条线/多次 observer
    if (window.__DAR_CHARTCORE_INITED__) return;
    window.__DAR_CHARTCORE_INITED__ = true;

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
      upColor: "#2BE2A6",     // 上涨=绿
      downColor: "#FF5A5A",   // 下跌=红
      wickUpColor: "#2BE2A6",
      wickDownColor: "#FF5A5A",
      borderVisible: false,
    });

    // EMA split: 绿/红 两条，但通过 null 实现“视觉只有一条会变色的线”
    emaUpSeries = chart.addLineSeries({
      color: "#2BE2A6",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    emaDnSeries = chart.addLineSeries({
      color: "#FF5A5A",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // AUX（默认不画数据，除非你算出 CURRENT_AUX）
    auxSeries = chart.addLineSeries({
      color: "rgba(255,184,108,.85)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: true,
    });

    const resize = () => {
      ensureChartSized();
      if (chart) chart.timeScale().fitContent();
    };
    try { new ResizeObserver(resize).observe(containerEl); } catch (_) {}
    window.addEventListener("resize", resize);
    resize();

    if (opts.autoLoad !== false) {
      load();
    }
  }

  window.ChartCore = { init, load, applyToggles, exportPNG };
})();
