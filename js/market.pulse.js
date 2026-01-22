/* market.pulse.js
 * UI-only layer. Must NOT mutate chart.core.js internals.
 * - Reads snapshot from window.__DARRIUS_CHART_STATE__ and/or window.DarriusChart.getSnapshot()
 * - Updates UI panels: Data Source strong hint, Market Pulse, Risk Copilot
 * - Never touches billing/subscription/payment logic
 */
(() => {
  "use strict";

  // -----------------------------
  // Absolute no-throw safe zone
  // -----------------------------
  function safeRun(tag, fn) {
    try { return fn(); } catch (e) { return null; }
  }

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);
  const qs = (sel, root) => (root || document).querySelector(sel);
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function setText(el, text) {
    if (!el) return;
    el.textContent = (text == null ? "" : String(text));
  }

  function setHtml(el, html) {
    if (!el) return;
    el.innerHTML = (html == null ? "" : String(html));
  }

  function addClass(el, cls) {
    if (!el) return;
    el.classList.add(cls);
  }

  function removeClass(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
  }

  // -----------------------------
  // Snapshot readers
  // -----------------------------
  function readCoreState() {
    return safeRun("readCoreState", () => window.__DARRIUS_CHART_STATE__ || null) || null;
  }

  function readUiSnapshot() {
    return safeRun("readUiSnapshot", () => {
      if (window.DarriusChart && typeof window.DarriusChart.getSnapshot === "function") {
        return window.DarriusChart.getSnapshot();
      }
      if (typeof window.getChartSnapshot === "function") {
        return window.getChartSnapshot();
      }
      return null;
    }) || null;
  }

  function pickFirst(...vals) {
    for (const v of vals) {
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return null;
  }

  // -----------------------------
  // Data Source inference (robust)
  // -----------------------------
  function inferDataInfo(coreState, uiSnap) {
    const version = pickFirst(coreState?.version, uiSnap?.version, "unknown");
    const urlUsed = pickFirst(coreState?.urlUsed, coreState?.meta?.urlUsed, uiSnap?.meta?.urlUsed, null);

    // explicit fields (if chart.core.js exports them)
    const dataMode = pickFirst(
      coreState?.dataMode,
      coreState?.data_mode,
      coreState?.mode,
      uiSnap?.meta?.dataMode,
      uiSnap?.meta?.mode,
      null
    );

    const dataSource = pickFirst(
      coreState?.dataSource,
      coreState?.data_source,
      coreState?.source,
      uiSnap?.meta?.source,
      uiSnap?.meta?.dataSource,
      null
    );

    const provider = pickFirst(
      coreState?.provider,
      coreState?.vendor,
      coreState?.dataProvider,
      uiSnap?.meta?.provider,
      uiSnap?.meta?.vendor,
      null
    );

    const delayedMinutes = pickFirst(
      coreState?.delayedMinutes,
      coreState?.delayed_minutes,
      coreState?.delayMinutes,
      uiSnap?.meta?.delayedMinutes,
      uiSnap?.meta?.delayMinutes,
      null
    );

    // fallback inference from urlUsed / version text
    const url = String(urlUsed || "");
    const v = String(version || "");
    const looksAggs = /\/api\/data\/stocks\/aggregates/i.test(url) || /aggregates/i.test(url);
    const looksMarket = looksAggs || /massive/i.test(v) || /datamode/i.test(v);

    // normalize mode
    let modeNorm = (dataMode || "").toLowerCase().trim();
    if (!modeNorm) {
      // If we see delayed in version or UI, assume delayed; else unknown -> demo
      if (/delayed/i.test(v) || /delay/i.test(v)) modeNorm = "delayed";
      else if (looksMarket) modeNorm = "market";
      else modeNorm = "demo";
    }

    // normalize source label
    let srcLabel = (dataSource || "").toLowerCase().trim();
    if (!srcLabel) {
      if (looksAggs) srcLabel = "market";
      else srcLabel = modeNorm === "demo" ? "demo" : "market";
    }

    // normalize provider label
    let providerLabel = provider ? String(provider) : (looksAggs ? "Massive" : "Local");
    if (String(providerLabel).toLowerCase() === "local") providerLabel = "Local";
    if (String(providerLabel).toLowerCase() === "massive") providerLabel = "Massive";

    // delayed minutes fallback
    let dmin = delayedMinutes;
    if ((modeNorm === "delayed" || /delayed/i.test(v)) && (dmin == null || dmin === "")) dmin = 15;

    // final display
    const displayMode =
      modeNorm === "demo" ? "Demo" :
      modeNorm === "delayed" ? "Delayed" :
      modeNorm === "market" ? "Market" :
      "Market";

    const displaySource =
      srcLabel === "demo" ? "Demo (Local)" :
      srcLabel === "market" ? "Market" :
      "Market";

    const delayText = (displayMode === "Delayed" || modeNorm === "delayed")
      ? `(${Number(dmin) || 15}m)`
      : "";

    return {
      version: String(version),
      urlUsed: urlUsed ? String(urlUsed) : "",
      displayMode,
      displaySource,
      provider: providerLabel,
      delayedMinutes: (Number.isFinite(Number(dmin)) ? Number(dmin) : null),
      delayText,
      isDelayed: (displayMode === "Delayed" || modeNorm === "delayed"),
      isDemo: (displayMode === "Demo" || modeNorm === "demo"),
    };
  }

  // -----------------------------
  // UI: Data Source strong hint
  // -----------------------------
  function ensureDataStatusWidget() {
    // Try to attach to existing right-panel control center if present
    const rightPanel =
      $("controlCenter") ||
      qs("#rightPanel") ||
      qs(".control-center") ||
      qs("[data-panel='control']") ||
      qs(".panel-right") ||
      null;

    // If we can't find a right panel, we fallback to a small fixed badge (non-invasive)
    if (!rightPanel) return { root: ensureFloatingBadgeRoot(), modeEl: null, detailEl: null };

    // Find an existing "Data Source" section container if you have one
    const existing =
      qs("#dataSourceSection", rightPanel) ||
      qs(".data-source", rightPanel) ||
      qs("[data-section='data-source']", rightPanel) ||
      null;

    const host = existing || rightPanel;

    // Create (or reuse) widget root
    let root = qs("#darriusDataStatus", host);
    if (!root) {
      root = document.createElement("div");
      root.id = "darriusDataStatus";
      root.style.cssText = [
        "margin: 10px 0 12px 0",
        "padding: 10px 12px",
        "border: 1px solid rgba(255,255,255,.08)",
        "border-radius: 12px",
        "background: rgba(0,0,0,.18)",
        "backdrop-filter: blur(6px)",
      ].join(";");

      root.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="display:flex;flex-direction:column;gap:4px;">
            <div style="font-weight:700;font-size:12px;letter-spacing:.2px;opacity:.92;">
              Data Source <span style="opacity:.5;">/ 数据源</span>
            </div>
            <div id="darriusDataModeLine" style="font-size:13px;font-weight:800;"></div>
            <div id="darriusDataDetailLine" style="font-size:11px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
          </div>
          <div id="darriusDataPill" style="
            font-size:12px;font-weight:900;
            padding:6px 10px;border-radius:999px;
            border:1px solid rgba(255,255,255,.14);
            background: rgba(255,255,255,.06);
            white-space:nowrap;">
          </div>
        </div>
      `;

      // Insert near the top of section
      host.insertBefore(root, host.firstChild);
    }

    return {
      root,
      modeEl: qs("#darriusDataModeLine", root),
      detailEl: qs("#darriusDataDetailLine", root),
      pillEl: qs("#darriusDataPill", root),
    };
  }

  function ensureFloatingBadgeRoot() {
    let root = qs("#darriusFloatingDataBadge");
    if (root) return root;

    root = document.createElement("div");
    root.id = "darriusFloatingDataBadge";
    root.style.cssText = [
      "position: fixed",
      "top: 12px",
      "left: 50%",
      "transform: translateX(-50%)",
      "z-index: 9999",
      "display: flex",
      "align-items: center",
      "gap: 8px",
      "padding: 8px 12px",
      "border-radius: 999px",
      "border: 1px solid rgba(255,255,255,.14)",
      "background: rgba(0,0,0,.35)",
      "backdrop-filter: blur(8px)",
      "font-size: 12px",
      "font-weight: 900",
      "letter-spacing: .2px",
      "pointer-events: none",
    ].join(";");

    root.innerHTML = `
      <span id="darriusFloatingPill"></span>
      <span id="darriusFloatingDetail" style="font-weight:700;opacity:.75;"></span>
    `;

    document.body.appendChild(root);
    return root;
  }

  function renderDataStatus(info) {
    safeRun("renderDataStatus", () => {
      const w = ensureDataStatusWidget();

      const modeLine = `${info.displaySource} · ${info.displayMode}${info.delayText ? " " + info.delayText : ""}`;
      const detailLine = info.urlUsed ? `Provider: ${info.provider} · ${info.urlUsed}` : `Provider: ${info.provider}`;

      // Color strategy (no CSS dependency)
      const pillText = info.isDemo ? "DEMO" : (info.isDelayed ? "DELAYED" : "MARKET");
      const pillBorder = info.isDemo
        ? "rgba(255,255,255,.18)"
        : info.isDelayed
          ? "rgba(255,210,0,.35)"
          : "rgba(0,255,170,.25)";
      const pillBg = info.isDemo
        ? "rgba(255,255,255,.06)"
        : info.isDelayed
          ? "rgba(255,210,0,.10)"
          : "rgba(0,255,170,.08)";

      if (w.modeEl) setText(w.modeEl, modeLine);
      if (w.detailEl) setText(w.detailEl, detailLine);

      if (w.pillEl) {
        setText(w.pillEl, pillText);
        w.pillEl.style.borderColor = pillBorder;
        w.pillEl.style.background = pillBg;
      }

      // floating badge fallback
      const f = qs("#darriusFloatingDataBadge");
      if (f) {
        const fp = qs("#darriusFloatingPill", f);
        const fd = qs("#darriusFloatingDetail", f);
        if (fp) setText(fp, `${pillText}`);
        if (fd) setText(fd, `${info.displaySource} · ${info.displayMode}${info.delayText ? " " + info.delayText : ""}`);
        f.style.borderColor = pillBorder;
        f.style.background = "rgba(0,0,0,.35)";
      }
    });
  }

  // -----------------------------
  // UI: Remove / sanitize misleading texts (safe & scoped)
  // -----------------------------
  function sanitizeUiTexts() {
    safeRun("sanitizeUiTexts", () => {
      // Only touch known hint/notes nodes; never touch subscription/payment area.
      const idsToClear = [
        "yellowText",
        "yellowHint",
        "dataHintYellow",
        "hintYellow",
        "legacyHint",
      ];
      idsToClear.forEach((id) => setText($(id), ""));

      // If your page has a known "yellow box" container, clear only that container
      const yellowBox =
        qs("#yellowBox") ||
        qs(".yellow-box") ||
        qs("[data-ui='yellow']") ||
        null;
      if (yellowBox) setText(yellowBox, "");

      // Optional: shrink overly long disclaimers if a specific container exists
      const note = qs("#marketPulseNote") || qs("[data-note='market-pulse']");
      if (note && note.textContent && note.textContent.length > 400) {
        // keep it short to reduce clutter
        note.textContent = note.textContent.slice(0, 220) + "…";
      }
    });
  }

  // -----------------------------
  // UI: Market Pulse + Risk Copilot (read-only)
  // -----------------------------
  function calcPulseFromSnapshot(uiSnap, coreState) {
    // Minimal, stable pulse: based on recent EMA slope regime from uiSnap.trend or coreState.ema.
    // Never blocks chart.
    return safeRun("calcPulse", () => {
      const trend = uiSnap?.trend || null;

      // If provided by chart.core snapshot bridge
      if (trend && (trend.emaSlope != null || trend.emaRegime)) {
        const slope = Number(trend.emaSlope);
        const regime = String(trend.emaRegime || "").toUpperCase();
        const scoreBase =
          regime === "UP" ? 58 :
          regime === "DOWN" ? 42 :
          50;

        const slopeAdj = Number.isFinite(slope) ? Math.max(-8, Math.min(8, slope * 1000)) : 0;
        const score = Math.max(1, Math.min(99, Math.round(scoreBase + slopeAdj)));

        return {
          score,
          bullish: Math.max(0, Math.min(100, Math.round(score + 5))),
          bearish: Math.max(0, Math.min(100, Math.round(100 - score - 5))),
          neutral: Math.max(0, Math.min(100, 100 - Math.round(score + 5) - Math.round(100 - score - 5))),
          netFlow: slope > 0 ? "Net Inflow" : slope < 0 ? "Net Outflow" : "Balanced",
        };
      }

      // Fallback: derive from coreState.ema array if exists
      const emaArr = coreState?.ema;
      if (Array.isArray(emaArr) && emaArr.length >= 8) {
        const n = Math.min(10, emaArr.length - 1);
        const now = Number(emaArr[emaArr.length - 1]);
        const prev = Number(emaArr[emaArr.length - 1 - n]);
        if (Number.isFinite(now) && Number.isFinite(prev)) {
          const slope = (now - prev) / n;
          const score = Math.max(1, Math.min(99, Math.round(50 + Math.max(-15, Math.min(15, slope * 500)))));
          return {
            score,
            bullish: Math.round(Math.min(100, score + 6)),
            bearish: Math.round(Math.min(100, 100 - score + 6)),
            neutral: Math.max(0, 100 - Math.round(Math.min(100, score + 6)) - Math.round(Math.min(100, 100 - score + 6))),
            netFlow: slope > 0 ? "Net Inflow" : slope < 0 ? "Net Outflow" : "Balanced",
          };
        }
      }

      return { score: 50, bullish: 33, bearish: 33, neutral: 34, netFlow: "Balanced" };
    }) || { score: 50, bullish: 33, bearish: 33, neutral: 34, netFlow: "Balanced" };
  }

  function renderMarketPulse(pulse) {
    safeRun("renderMarketPulse", () => {
      // Try common ids (no assumptions)
      setText($("pulseScore"), pulse.score);
      setText($("mpScore"), pulse.score);

      setText($("pulseBullish"), `${pulse.bullish}%`);
      setText($("pulseBearish"), `${pulse.bearish}%`);
      setText($("pulseNeutral"), `${pulse.neutral}%`);
      setText($("pulseNetFlow"), pulse.netFlow);

      // If there is a ring gauge using CSS vars
      const ring = $("pulseRing") || qs(".pulse-ring");
      if (ring) {
        ring.style.setProperty("--pulse", String(pulse.score));
      }
    });
  }

  function renderRiskCopilot(uiSnap, coreState) {
    safeRun("renderRiskCopilot", () => {
      // If UI snapshot provides risk; otherwise keep existing UI untouched.
      const risk = uiSnap?.risk || null;
      if (!risk) return;

      // Common ids
      if (risk.entry != null) setText($("riskEntry"), String(risk.entry));
      if (risk.stop != null) setText($("riskStop"), String(risk.stop));
      if (risk.targets != null) setText($("riskTargets"), Array.isArray(risk.targets) ? risk.targets.join(" / ") : String(risk.targets));
      if (risk.confidence != null) setText($("riskConfidence"), String(risk.confidence));
      if (risk.winrate != null) setText($("riskWinrate"), String(risk.winrate));
    });
  }

  // -----------------------------
  // Main refresh pipeline
  // -----------------------------
  function refreshAll(reason) {
    safeRun("refreshAll", () => {
      const coreState = readCoreState();
      const uiSnap = readUiSnapshot();

      const info = inferDataInfo(coreState, uiSnap);
      renderDataStatus(info);
      sanitizeUiTexts();

      const pulse = calcPulseFromSnapshot(uiSnap, coreState);
      renderMarketPulse(pulse);
      renderRiskCopilot(uiSnap, coreState);

      // optional: show a tiny debug line if a container exists (doesn't clutter)
      const dbg = $("uiDebugLine") || qs("[data-ui='debugline']");
      if (dbg) {
        const sym = pickFirst(coreState?.symbol, uiSnap?.meta?.symbol, "");
        const tf = pickFirst(coreState?.tf, uiSnap?.meta?.timeframe, "");
        setText(dbg, `${sym} · ${tf} · ${info.displayMode}${info.delayText ? " " + info.delayText : ""} · v=${info.version}`);
      }
    });
  }

  // -----------------------------
  // Boot
  // -----------------------------
  function boot() {
    safeRun("boot", () => {
      // Run once on load (after DOM ready)
      refreshAll("boot");

      // Listen to chart updates
      window.addEventListener("darrius:chartUpdated", () => refreshAll("event"));

      // Fallback timer (UI-only; low frequency)
      setInterval(() => refreshAll("timer"), 2500);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
