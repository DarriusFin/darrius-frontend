/* =========================================================================
 * DarriusAI - market.pulse.js (UI ONLY) v2026.01.22-STEP2A-HOTFIX
 *
 * HOTFIX:
 *  - Prevent "hide()误伤大容器" causing whole page blank
 *  - Only hide small LEAF note elements (p/small/span/li), short text, starts with Note/说明
 *  - Never touch subscription/payment area
 *
 * Hard Rule:
 *  - MUST NOT touch billing/subscription/payment logic or endpoints.
 * ========================================================================= */

(() => {
  "use strict";

  // -----------------------------
  // Safe runner (never throw)
  // -----------------------------
  function safeRun(tag, fn) { try { return fn(); } catch (e) { return null; } }

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);
  const qs = (sel, root) => (root || document).querySelector(sel);
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function setText(el, text) { if (el) el.textContent = (text == null ? "" : String(text)); }
  function hide(el) { if (el) el.style.display = "none"; }

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
  // Strong Data Source badge (top-right only)
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
      "max-width: 520px",
      "pointer-events: none",
    ].join(";");

    el.innerHTML = `
      <div id="darriusTopDataLine1"></div>
      <div id="darriusTopDataLine2" style="font-weight:700;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
    `;
    document.body.appendChild(el);
    return el;
  }

  function inferDataInfo(coreState, uiSnap) {
    const version = pickFirst(coreState?.version, uiSnap?.version, "unknown");
    const urlUsed = pickFirst(coreState?.urlUsed, "");
    const delayedMinutes = pickFirst(coreState?.delayedMinutes, coreState?.delayMinutes, null);

    const url = String(urlUsed || "");
    const v = String(version || "");

    const looksAggs = /\/api\/data\/stocks\/aggregates/i.test(url) || /aggregates/i.test(url);
    let displaySource = looksAggs ? "Market" : "Demo (Local)";

    // 你的截图顶栏显示 Delayed(15m)，这里也跟随 coreState/version 文案
    let displayMode = /delayed/i.test(v) ? "Delayed" : (looksAggs ? "Market" : "Demo");
    let dmin = (displayMode === "Delayed") ? (Number(delayedMinutes) || 15) : null;

    // provider：优先 Massive，否则 Local
    let provider = looksAggs ? "Massive" : "Local";

    return {
      version: String(version),
      urlUsed: url,
      displaySource,
      displayMode,
      provider,
      delayText: (displayMode === "Delayed" ? `(${dmin}m)` : ""),
      isDelayed: displayMode === "Delayed",
      isDemo: displayMode === "Demo" || displaySource.includes("Demo"),
    };
  }

  function renderDataStatus(info) {
    safeRun("renderDataStatus", () => {
      const badge = ensureTopBadge();
      const l1 = qs("#darriusTopDataLine1", badge);
      const l2 = qs("#darriusTopDataLine2", badge);

      const line1 = `${info.displaySource} · ${info.displayMode}${info.delayText ? " " + info.delayText : ""}`;
      const line2 = info.urlUsed ? `Provider: ${info.provider} · ${info.urlUsed}` : `Provider: ${info.provider}`;

      setText(l1, line1);
      setText(l2, line2);

      const border = info.isDemo
        ? "rgba(255,255,255,.18)"
        : info.isDelayed
          ? "rgba(255,210,0,.35)"
          : "rgba(0,255,170,.25)";
      badge.style.borderColor = border;
    });
  }

  // -----------------------------
  // DO NOT TOUCH billing/subscription/payment area
  // -----------------------------
  function isInsideSubscriptionOrBilling(el) {
    const p = el.closest?.(
      "[data-section*='sub' i], [id*='sub' i], [class*='sub' i], " +
      "[id*='billing' i], [class*='billing' i], " +
      "[id*='checkout' i], [class*='checkout' i], " +
      "[id*='payment' i], [class*='payment' i]"
    );
    return !!p;
  }

  // -----------------------------
  // SAFE cleanup: hide only small leaf Note/说明 lines
  // -----------------------------
  const REMOVE_TEXT_PATTERNS = [
    /Market Pulse is derived/i,
    /Commission terms/i,
    /For live data.*proxy/i,
    /EMA\/AUX parameters/i,
    /说明：\s*Market Pulse/i,
    /说明：\s*For live data/i,
    /说明：\s*EMA\/AUX/i,
    /说明：\s*推荐/i,
  ];

  function isLeaf(el) {
    // “没有子元素”才算 leaf，防止把大容器干掉
    return el && el.children && el.children.length === 0;
  }

  function cleanupYellowNotesSafe() {
    safeRun("cleanupYellowNotesSafe", () => {
      // 只处理小标签，不再碰 div
      const nodes = qsa("p, small, span, li");

      for (const el of nodes) {
        if (!el || !el.textContent) continue;
        if (!isLeaf(el)) continue;
        if (isInsideSubscriptionOrBilling(el)) continue;

        const t = el.textContent.trim();
        if (!t) continue;

        // 必须是短文本、且以 Note/说明 开头
        if (t.length > 240) continue;
        const looksLikeNote = /^note\s*:/i.test(t) || /^说明：/i.test(t);
        if (!looksLikeNote) continue;

        if (REMOVE_TEXT_PATTERNS.some((re) => re.test(t))) {
          hide(el);
        }
      }
    });
  }

  // -----------------------------
  // Restore B/S markers if overlay flag is ON but overlay not present
  // -----------------------------
  function restoreMarkersIfMissing() {
    safeRun("restoreMarkersIfMissing", () => {
      const overlayOn = (window.__OVERLAY_BIG_SIGS__ === true);
      const overlayExists = !!qs("#darriusBigSignalsOverlay");
      if (overlayOn && !overlayExists) {
        window.__OVERLAY_BIG_SIGS__ = false;
        if (window.ChartCore && typeof window.ChartCore.load === "function") {
          window.ChartCore.load().catch(() => {});
        }
      }
    });
  }

  // -----------------------------
  // Main refresh (ultra safe)
  // -----------------------------
  function refreshAll() {
    safeRun("refreshAll", () => {
      const coreState = readCoreState();
      const uiSnap = readUiSnapshot();

      const info = inferDataInfo(coreState, uiSnap);
      renderDataStatus(info);

      restoreMarkersIfMissing();

      cleanupYellowNotesSafe();
    });
  }

  // -----------------------------
  // Boot
  // -----------------------------
  function boot() {
    safeRun("boot", () => {
      refreshAll();
      window.addEventListener("darrius:chartUpdated", refreshAll);

      // 兜底刷新，但更保守（避免任何潜在抖动）
      setInterval(refreshAll, 4000);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
