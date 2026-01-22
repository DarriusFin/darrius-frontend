/* =========================================================================
 * DarriusAI - market.pulse.js (UI ONLY) v2026.01.22-STEP2A
 *
 * Goals (Step 2A):
 *  1) UI 精简：删除（隐藏）黄色框内的 Note/说明文本（不触碰订阅/支付）
 *  2) Data Source 强提示：顶部/右侧显示 Market vs Demo vs Delayed(15m)，含 provider + urlUsed
 *  3) 修正左侧 Market Pulse 面板：把 Bullish/Bearish/Neutral/Net Inflow 的 “—” 恢复为数值
 *  4) 恢复主图 B/S markers：若之前开启 __OVERLAY_BIG_SIGS__ 但 overlay 未实现，则关闭该开关
 *
 * Hard Rule:
 *  - MUST NOT touch billing/subscription/payment logic or endpoints.
 * ========================================================================= */

(() => {
  "use strict";

  // -----------------------------
  // Safe runner (never throw)
  // -----------------------------
  function safeRun(tag, fn) { try { return fn(); } catch (_) { return null; } }

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);
  const qs = (sel, root) => (root || document).querySelector(sel);
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function setText(el, text) { if (el) el.textContent = (text == null ? "" : String(text)); }
  function hide(el) { if (el) el.style.display = "none"; }
  function show(el) { if (el) el.style.display = ""; }

  // -----------------------------
  // Snapshot readers
  // -----------------------------
  function readCoreState() {
    return safeRun("readCoreState", () => window.__DARRIUS_CHART_STATE__ || null) || null;
  }
  function readUiSnapshot() {
    return safeRun("readUiSnapshot", () => {
      if (window.DarriusChart && typeof window.DarriusChart.getSnapshot === "function") return window.DarriusChart.getSnapshot();
      if (typeof window.getChartSnapshot === "function") return window.getChartSnapshot();
      return null;
    }) || null;
  }

  function pickFirst(...vals) {
    for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
    return null;
  }

  // -----------------------------
  // Data Source inference (robust)
  // -----------------------------
  function inferDataInfo(coreState, uiSnap) {
    const version = pickFirst(coreState?.version, uiSnap?.version, "unknown");
    const urlUsed = pickFirst(coreState?.urlUsed, uiSnap?.meta?.urlUsed, "");

    const dataMode = pickFirst(
      coreState?.dataMode, coreState?.mode, coreState?.data_mode,
      uiSnap?.meta?.dataMode, uiSnap?.meta?.mode, null
    );

    const dataSource = pickFirst(
      coreState?.dataSource, coreState?.source, coreState?.data_source,
      uiSnap?.meta?.source, uiSnap?.meta?.dataSource, null
    );

    const provider = pickFirst(
      coreState?.provider, coreState?.vendor, coreState?.dataProvider,
      uiSnap?.meta?.provider, uiSnap?.meta?.vendor, null
    );

    const delayedMinutes = pickFirst(
      coreState?.delayedMinutes, coreState?.delayMinutes, coreState?.delayed_minutes,
      uiSnap?.meta?.delayedMinutes, uiSnap?.meta?.delayMinutes, null
    );

    const url = String(urlUsed || "");
    const v = String(version || "");
    const looksAggs = /\/api\/data\/stocks\/aggregates/i.test(url) || /aggregates/i.test(url);
    const looksMarket = looksAggs || /massive/i.test(v) || /datamode/i.test(v);

    let modeNorm = (dataMode || "").toLowerCase().trim();
    if (!modeNorm) {
      if (/delayed/i.test(v) || /delay/i.test(v)) modeNorm = "delayed";
      else if (looksMarket) modeNorm = "market";
      else modeNorm = "demo";
    }

    let srcNorm = (dataSource || "").toLowerCase().trim();
    if (!srcNorm) srcNorm = looksMarket ? "market" : "demo";

    let providerLabel = provider ? String(provider) : (looksAggs ? "Massive" : "Local");
    if (/massive/i.test(providerLabel)) providerLabel = "Massive";

    let dmin = delayedMinutes;
    if ((modeNorm === "delayed" || /delayed/i.test(v)) && (dmin == null || dmin === "")) dmin = 15;

    const displayMode =
      modeNorm === "demo" ? "Demo" :
      modeNorm === "delayed" ? "Delayed" :
      "Market";

    const displaySource = (srcNorm === "demo") ? "Demo (Local)" : "Market";
    const delayText = (displayMode === "Delayed") ? `(${Number(dmin) || 15}m)` : "";

    return {
      version: String(version),
      urlUsed: String(urlUsed || ""),
      displayMode,
      displaySource,
      provider: providerLabel,
      delayedMinutes: (Number.isFinite(Number(dmin)) ? Number(dmin) : null),
      delayText,
      isDelayed: displayMode === "Delayed",
      isDemo: displayMode === "Demo",
    };
  }

  // -----------------------------
  // Widget: Data Source strong hint (top-right small badge + inside right panel if possible)
  // -----------------------------
  function ensureTopBadge() {
    let el = qs("#darriusTopDataBadge");
    if (el) return el;

    el = document.createElement("div");
    el.id = "darriusTopDataBadge";
    el.style.cssText = [
      "position: fixed",
      "top: 12px",
      "right: 16px",
      "z-index: 9999",
      "padding: 8px 10px",
      "border-radius: 10px",
      "border: 1px solid rgba(255,255,255,.14)",
      "background: rgba(0,0,0,.35)",
      "backdrop-filter: blur(8px)",
      "font-size: 12px",
      "line-height: 1.2",
      "font-weight: 900",
      "max-width: 420px",
      "pointer-events: none",
    ].join(";");

    el.innerHTML = `
      <div id="darriusTopDataLine1"></div>
      <div id="darriusTopDataLine2" style="font-weight:700;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
    `;
    document.body.appendChild(el);
    return el;
  }

  function ensureRightPanelCard() {
    // 尝试找到你右侧 Control Center 区域（不依赖固定 id）
    const rightPanel =
      $("controlCenter") ||
      qs(".control-center") ||
      qs("[data-panel='control']") ||
      qs(".panel-right") ||
      qs("#rightPanel") ||
      null;

    if (!rightPanel) return null;

    let card = qs("#darriusDataStatusCard", rightPanel);
    if (card) return card;

    card = document.createElement("div");
    card.id = "darriusDataStatusCard";
    card.style.cssText = [
      "margin: 10px 0 12px 0",
      "padding: 10px 12px",
      "border: 1px solid rgba(255,255,255,.10)",
      "border-radius: 12px",
      "background: rgba(0,0,0,.18)",
    ].join(";");

    card.innerHTML = `
      <div style="font-weight:800;font-size:12px;opacity:.9;margin-bottom:6px;">
        Data Source <span style="opacity:.5;">/ 数据源</span>
      </div>
      <div id="darriusDataCardLine1" style="font-size:13px;font-weight:900;"></div>
      <div id="darriusDataCardLine2" style="font-size:11px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
    `;

    rightPanel.insertBefore(card, rightPanel.firstChild);
    return card;
  }

  function renderDataStatus(info) {
    safeRun("renderDataStatus", () => {
      // Top badge
      const badge = ensureTopBadge();
      const l1 = qs("#darriusTopDataLine1", badge);
      const l2 = qs("#darriusTopDataLine2", badge);

      const line1 = `${info.displaySource} · ${info.displayMode}${info.delayText ? " " + info.delayText : ""}`;
      const line2 = info.urlUsed ? `Provider: ${info.provider} · ${info.urlUsed}` : `Provider: ${info.provider}`;

      setText(l1, line1);
      setText(l2, line2);

      // Color hint
      const border = info.isDemo
        ? "rgba(255,255,255,.18)"
        : info.isDelayed
          ? "rgba(255,210,0,.35)"
          : "rgba(0,255,170,.25)";

      badge.style.borderColor = border;

      // Right card
      const card = ensureRightPanelCard();
      if (card) {
        setText(qs("#darriusDataCardLine1", card), line1);
        setText(qs("#darriusDataCardLine2", card), line2);
      }
    });
  }

  // -----------------------------
  // Step2A UI cleanup: remove yellow box notes
  // (We hide blocks by matching text patterns; we do NOT touch subscription/payment area)
  // -----------------------------
  const REMOVE_TEXT_PATTERNS = [
    /Market Pulse is derived/i,
    /Pulse.*derived/i,
    /Commission terms/i,
    /For live data.*proxy/i,
    /EMA\/AUX parameters/i,
    /EMA.*AUX.*internal/i,
    /说明：\s*Market Pulse/i,
    /说明：\s*Market Pulse.*不会/i,
    /说明：\s*For live data/i,
    /说明：\s*EMA\/AUX/i,
    /说明：\s*推荐/i,
  ];

  function isInsideSubscriptionOrBilling(el) {
    // 防止误伤订阅/支付区域：只要祖先包含明显 subscription/billing/checkout 字样，就不动
    const p = el.closest?.("[data-section*='sub' i], [id*='sub' i], [class*='sub' i], [id*='billing' i], [class*='billing' i], [id*='checkout' i], [class*='checkout' i]");
    return !!p;
  }

  function cleanupYellowNotes() {
    safeRun("cleanupYellowNotes", () => {
      const nodes = qsa("div, p, span, small, li");
      for (const el of nodes) {
        if (!el || !el.textContent) continue;
        if (isInsideSubscriptionOrBilling(el)) continue;

        const t = el.textContent.trim();
        if (!t) continue;

        // 只清理“Note/说明”这类说明块，避免误杀正文标题
        const looksLikeNote = /^note\s*:/i.test(t) || /^说明：/i.test(t) || /Note\s*:/i.test(t);
        if (!looksLikeNote) continue;

        if (REMOVE_TEXT_PATTERNS.some((re) => re.test(t))) {
          hide(el);
        }
      }
    });
  }

  // -----------------------------
  // Red box improvement: refine disclaimers (left bottom blocks)
  // -----------------------------
  const EN_DISCLAIMER = [
    "English:",
    "For informational purposes only. Not investment advice.",
    "Delayed/market data may be delayed or inaccurate. Past performance is not indicative of future results.",
    "You are solely responsible for your trading decisions and risk.",
  ].join(" ");

  const ZH_DISCLAIMER = [
    "中文：",
    "本内容仅供信息参考，不构成任何投资建议。",
    "行情/信号可能延迟或不准确，历史表现不代表未来结果。",
    "交易有风险，盈亏自负。"
  ].join("");

  function refineDisclaimers() {
    safeRun("refineDisclaimers", () => {
      // 找到包含旧英文免责声明的块
      const blocks = qsa("div, p, small");
      for (const el of blocks) {
        const t = (el.textContent || "").trim();
        if (!t) continue;

        // 英文块
        if (/Informational use only/i.test(t) || (/For informational/i.test(t) && /Not investment advice/i.test(t))) {
          setText(el, EN_DISCLAIMER);
          el.style.opacity = "0.85";
          el.style.lineHeight = "1.25";
          el.style.fontSize = "11px";
          continue;
        }

        // 中文块
        if (/本系统仅用于信息展示/i.test(t) || (/不构成任何投资建议/i.test(t) && /风险/i.test(t))) {
          setText(el, ZH_DISCLAIMER);
          el.style.opacity = "0.85";
          el.style.lineHeight = "1.25";
          el.style.fontSize = "11px";
          continue;
        }
      }

      // Links line: try keep existing, if not exists create minimal
      const linkLine =
        qs("#darriusFooterLinks") ||
        qs("[data-ui='footer-links']") ||
        null;

      if (linkLine && !isInsideSubscriptionOrBilling(linkLine)) {
        // 只做轻微规范化
        linkLine.style.opacity = "0.85";
        linkLine.style.fontSize = "11px";
      }
    });
  }

  // -----------------------------
  // Market Pulse numbers: fill Bullish/Bearish/Neutral/Net Inflow
  // Strategy: locate panel by title text then locate rows by label text
  // -----------------------------
  function computePulse(coreState, uiSnap) {
    return safeRun("computePulse", () => {
      // Use uiSnap.trend if exists
      const trend = uiSnap?.trend || null;
      let score = 50;

      if (trend && (trend.emaSlope != null || trend.emaRegime)) {
        const slope = Number(trend.emaSlope);
        const regime = String(trend.emaRegime || "").toUpperCase();
        const base = regime === "UP" ? 58 : regime === "DOWN" ? 42 : 50;
        const adj = Number.isFinite(slope) ? Math.max(-10, Math.min(10, slope * 1000)) : 0;
        score = Math.max(1, Math.min(99, Math.round(base + adj)));
      } else {
        // fallback from coreState.ema array
        const emaArr = coreState?.ema;
        if (Array.isArray(emaArr) && emaArr.length >= 8) {
          const n = Math.min(10, emaArr.length - 1);
          const now = Number(emaArr[emaArr.length - 1]);
          const prev = Number(emaArr[emaArr.length - 1 - n]);
          if (Number.isFinite(now) && Number.isFinite(prev)) {
            const slope = (now - prev) / n;
            score = Math.max(1, Math.min(99, Math.round(50 + Math.max(-15, Math.min(15, slope * 500)))));
          }
        }
      }

      const bullish = Math.max(0, Math.min(100, Math.round(score + 5)));
      const bearish = Math.max(0, Math.min(100, Math.round(100 - score - 5)));
      const neutral = Math.max(0, 100 - bullish - bearish);

      const netFlow = score >= 55 ? "Net Inflow" : score <= 45 ? "Net Outflow" : "Balanced";

      return { score, bullish, bearish, neutral, netFlow };
    }) || { score: 50, bullish: 33, bearish: 33, neutral: 34, netFlow: "Balanced" };
  }

  function findPanelByTitleRegex(titleRegex) {
    const candidates = qsa("div, section, article");
    for (const el of candidates) {
      const t = (el.textContent || "").trim();
      if (!t) continue;
      // 要求同一块里包含标题（避免全页匹配）
      if (titleRegex.test(t) && t.length < 2000) return el;
    }
    return null;
  }

  function setRowValue(panel, labelRegex, valueText) {
    if (!panel) return false;

    // 找到包含 label 的元素，然后优先找同一行的“右侧值”
    const nodes = qsa("div, p, span, small", panel);
    for (const el of nodes) {
      const txt = (el.textContent || "").trim();
      if (!txt) continue;
      if (!labelRegex.test(txt)) continue;

      // 尝试：同一个父容器里最后一个 span/div 作为 value
      const row = el.closest("div") || el.parentElement;
      if (row) {
        const kids = qsa("span, div, small", row);
        // 找到看起来像 value 的（短、可能是 — 或 数字/百分号）
        for (let i = kids.length - 1; i >= 0; i--) {
          const k = kids[i];
          const kt = (k.textContent || "").trim();
          if (!kt) continue;
          if (k === el) continue;

          // value candidate
          if (kt === "—" || kt === "--" || /%$/.test(kt) || /^[0-9.]+$/.test(kt) || /Inflow|Outflow|Balanced/i.test(kt)) {
            setText(k, valueText);
            return true;
          }
        }
      }
    }
    return false;
  }

  function renderMarketPulseNumbers(pulse) {
    safeRun("renderMarketPulseNumbers", () => {
      // 大号中间分数
      const bigScore =
        $("pulseScore") ||
        $("mpScore") ||
        qs("[data-ui='pulse-score']") ||
        null;
      if (bigScore) setText(bigScore, pulse.score);

      // 面板定位（包含 Market Pulse / 市场情绪）
      const panel = findPanelByTitleRegex(/Market Pulse|市场情绪/i) || document;

      setRowValue(panel, /Bullish/i, `${pulse.bullish}%`);
      setRowValue(panel, /Bearish/i, `${pulse.bearish}%`);
      setRowValue(panel, /Neutral/i, `${pulse.neutral}%`);
      setRowValue(panel, /Net\s*Inflow|Net\s*Flow/i, pulse.netFlow);
    });
  }

  // -----------------------------
  // Restore B/S markers if overlay flag is ON but overlay not implemented
  // -----------------------------
  function restoreMarkersIfMissing() {
    safeRun("restoreMarkersIfMissing", () => {
      // 如果你没实现大号 overlay，就别开 __OVERLAY_BIG_SIGS__
      // 否则 chart.core.js 会清空 markers，导致 B/S 消失
      const overlayOn = (window.__OVERLAY_BIG_SIGS__ === true);

      // 简单判断：UI层有没有创建 overlay canvas（如果你以后做了大号 overlay，可把这个 id 保持一致）
      const overlayExists = !!qs("#darriusBigSignalsOverlay");

      if (overlayOn && !overlayExists) {
        window.__OVERLAY_BIG_SIGS__ = false;

        // 触发主图重绘 markers（不影响订阅/支付）
        if (window.ChartCore && typeof window.ChartCore.load === "function") {
          window.ChartCore.load().catch(() => {});
        }
      }
    });
  }

  // -----------------------------
  // Main refresh
  // -----------------------------
  function refreshAll() {
    safeRun("refreshAll", () => {
      const coreState = readCoreState();
      const uiSnap = readUiSnapshot();

      const info = inferDataInfo(coreState, uiSnap);
      renderDataStatus(info);

      restoreMarkersIfMissing();

      // 清理黄色说明块
      cleanupYellowNotes();

      // 完善红框免责声明（精简+专业化）
      refineDisclaimers();

      // 恢复市场情绪数据
      const pulse = computePulse(coreState, uiSnap);
      renderMarketPulseNumbers(pulse);
    });
  }

  // -----------------------------
  // Boot
  // -----------------------------
  function boot() {
    safeRun("boot", () => {
      refreshAll();

      window.addEventListener("darrius:chartUpdated", () => refreshAll());

      // 低频兜底刷新（UI-only）
      setInterval(refreshAll, 2500);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
