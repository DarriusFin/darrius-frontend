/* =========================================================================
 * DarriusAI - market.pulse.js (UI ONLY) v2026.01.22-STEP2A-FULL
 *
 * Purpose (Step 2A):
 *  - Home UI cleanup (remove yellow-box Note blocks)
 *  - Strong Data Source badge (Market/Demo + Delayed minutes + provider + urlUsed)
 *  - Restore Market Pulse numbers (Bull/Bear/Neutral/Net Inflow + Sentiment score)
 *  - Keep chart stable; never break main chart; never touch subscription/payment logic
 *
 * HARD RULE:
 *  - MUST NOT change billing/subscription/payment logic or endpoints.
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
  function show(el, cssText) { if (!el) return; el.style.display = ""; if (cssText) el.style.cssText += ";" + cssText; }

  // -----------------------------
  // Guard: never touch subscription/payment area
  // -----------------------------
  function isInsideBilling(el) {
    if (!el || !el.closest) return false;
    return !!el.closest(
      "[data-section*='sub' i],[id*='sub' i],[class*='sub' i]," +
      "[id*='billing' i],[class*='billing' i]," +
      "[id*='checkout' i],[class*='checkout' i]," +
      "[id*='payment' i],[class*='payment' i]," +
      "[id*='stripe' i],[class*='stripe' i]"
    );
  }

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

  // -----------------------------
  // Extract "Loaded - Delayed(15m)" from hint area (fallback)
  // -----------------------------
  function readHintDelayMinutes() {
    return safeRun("readHintDelay", () => {
      const hint =
        $("hintText") ||
        qs("[data-role='hintText']") ||
        qs("#hint") ||
        qs(".hintText");
      const t = (hint && hint.textContent) ? hint.textContent : "";
      const m = /Delayed\s*\(\s*(\d+)\s*m\s*\)/i.exec(t);
      if (m) return Number(m[1]) || null;
      return null;
    });
  }

  // -----------------------------
  // Strong Data Source badge (top-right)
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
      "max-width: 720px",
      "pointer-events: none",
    ].join(";");

    el.innerHTML = `
      <div id="darriusTopDataLine1"></div>
      <div id="darriusTopDataLine2"
           style="font-weight:700;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
    `;
    document.body.appendChild(el);
    return el;
  }

  function inferDataInfo(coreState, uiSnap) {
    const version = String(coreState?.version || uiSnap?.version || "unknown");
    const urlUsed = String(coreState?.urlUsed || "");
    const apiBase = String(coreState?.apiBase || "");

    const hintDelay = readHintDelayMinutes();
    const delayedMinutes =
      Number(coreState?.delayedMinutes || coreState?.delayMinutes || coreState?.dataDelayMinutes || 0) ||
      (hintDelay || 0);

    const looksAggs = /\/api\/data\/stocks\/aggregates/i.test(urlUsed) || /aggregates/i.test(urlUsed);
    const looksBars = /\/api\/market\/bars/i.test(urlUsed) || /\/bars\?/i.test(urlUsed);

    // displayMode: prefer Delayed if hint shows Delayed() or version contains DATAMODE/DELAYED
    const versionSaysDelayed = /delayed|datamode/i.test(version);
    const isDelayed = versionSaysDelayed || (delayedMinutes > 0);

    // Source
    const displaySource = looksAggs ? "Market" : (looksBars ? "Demo (Local)" : "Demo (Local)");

    // Provider
    // - If Market via aggregates -> Massive
    // - Else -> Local
    const provider = looksAggs ? "Massive" : "Local";

    const displayMode = isDelayed ? "Delayed" : (looksAggs ? "Market" : "Demo");
    const delayText = isDelayed ? `(${(delayedMinutes || 15)}m)` : "";

    return {
      version,
      apiBase,
      urlUsed,
      provider,
      displaySource,
      displayMode,
      delayText,
      isDelayed,
      isMarket: looksAggs,
    };
  }

  function renderDataStatus(info) {
    safeRun("renderDataStatus", () => {
      const badge = ensureTopBadge();
      const l1 = qs("#darriusTopDataLine1", badge);
      const l2 = qs("#darriusTopDataLine2", badge);

      setText(l1, `${info.displaySource} · ${info.displayMode} ${info.delayText}`.trim());
      setText(l2, `Provider: ${info.provider} · ${info.urlUsed || info.apiBase || ""}`.trim());

      // border cue
      badge.style.borderColor = info.isMarket
        ? (info.isDelayed ? "rgba(255,210,0,.35)" : "rgba(0,255,170,.25)")
        : "rgba(255,255,255,.18)";
    });
  }

  // -----------------------------
  // UI cleanup: remove ONLY Note blocks within specific cards
  // -----------------------------
  function findCardByHeaderText(headerText) {
    const ht = String(headerText || "").trim();
    if (!ht) return null;

    // Try common patterns: card headers are often h3/h4/div with bold
    const candidates = qsa("h1,h2,h3,h4,div,span").filter(el => {
      const t = (el.textContent || "").trim();
      return t === ht || t.includes(ht);
    });

    for (const h of candidates) {
      // card container: up to 5 levels
      let p = h;
      for (let k = 0; k < 5 && p; k++) {
        if (p.classList && (p.classList.contains("card") || p.classList.contains("panel"))) return p;
        // heuristic: container with border/box
        if (p.getBoundingClientRect && p.getBoundingClientRect().height > 80) {
          // don't climb into huge layout wrapper
          return p;
        }
        p = p.parentElement;
      }
    }
    return null;
  }

  function removeNoteLinesIn(root) {
    if (!root) return;

    safeRun("removeNoteLinesIn", () => {
      // Only small text nodes
      const nodes = qsa("p,small,span,li,div", root);

      for (const el of nodes) {
        if (!el || !el.textContent) continue;
        if (isInsideBilling(el)) continue;

        // Do not hide big containers: only leaf or small height blocks
        const t = el.textContent.trim();
        if (!t) continue;

        const looksNote = /^note\s*:/i.test(t) || /^说明：/.test(t);
        if (!looksNote) continue;

        // length limit to avoid swallowing real content
        if (t.length > 400) continue;

        // leaf preference
        const isLeaf = !el.children || el.children.length === 0;

        // height limit
        const h = safeRun("rect", () => el.getBoundingClientRect().height) || 0;

        if (isLeaf || h < 60) {
          hide(el);
        }
      }
    });
  }

  function cleanupYellowBoxes() {
    safeRun("cleanupYellowBoxes", () => {
      // Left: Market Pulse card note
      // Right: Data Source card note
      // Right: EMA/AUX note
      const headers = [
        "Data Source", "数据源",
        "Market Pulse", "市场情绪",
        "EMA", "AUX"
      ];

      for (const ht of headers) {
        const card = findCardByHeaderText(ht);
        if (card) removeNoteLinesIn(card);
      }

      // Extra safety: remove known exact note sentences anywhere (leaf only)
      const patterns = [
        /Market Pulse is derived/i,
        /For live data, requests should go through/i,
        /EMA\/AUX parameters are internal/i,
        /Commission terms are disclosed/i,
        /说明：\s*Market Pulse/i,
        /说明：\s*对外隐藏/i,
      ];

      const nodes = qsa("p,small,span,li");
      for (const el of nodes) {
        if (!el || !el.textContent) continue;
        if (isInsideBilling(el)) continue;
        if (el.children && el.children.length) continue;

        const t = el.textContent.trim();
        if (!t || t.length > 300) continue;
        if ((/^note\s*:/i.test(t) || /^说明：/.test(t)) && patterns.some(re => re.test(t))) hide(el);
      }
    });
  }

  // -----------------------------
  // Restore B/S markers if overlay flag is ON but overlay not present
  // -----------------------------
  function restoreMarkersIfMissing() {
    safeRun("restoreMarkersIfMissing", () => {
      const overlayOn = (window.__OVERLAY_BIG_SIGS__ === true);
      const overlayExists =
        !!qs("#darriusBigSignalsOverlay") ||
        !!qs("[data-overlay='big-sigs']") ||
        !!qs(".big-sigs-overlay");
      if (overlayOn && !overlayExists) {
        window.__OVERLAY_BIG_SIGS__ = false;
        if (window.ChartCore && typeof window.ChartCore.load === "function") {
          window.ChartCore.load().catch(() => {});
        }
      }
    });
  }

  // -----------------------------
  // Market Pulse numbers (left panel)
  // -----------------------------
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function pct(x) { return Math.round(clamp01(x) * 100); }

  // Compute a stable sentiment from bars + ema/aux if snapshot missing pulse
  function computeSentimentFromSnapshot(coreState, uiSnap) {
    return safeRun("computeSentiment", () => {
      // try ui snapshot first (more structured)
      const candles = uiSnap?.candles || coreState?.bars || [];
      const emaArr = uiSnap?.ema || [];
      const auxArr = uiSnap?.aux || [];

      const n = Array.isArray(candles) ? candles.length : 0;
      if (!n) return null;

      // last N window
      const W = Math.min(120, n);
      const slice = candles.slice(n - W);
      const closes = slice.map(b => Number(b.close ?? b.c));
      const rets = [];
      for (let i = 1; i < closes.length; i++) {
        const a = closes[i - 1], b = closes[i];
        if (Number.isFinite(a) && Number.isFinite(b) && a !== 0) rets.push((b - a) / a);
      }
      if (!rets.length) return null;

      // drift + volatility proxy
      const drift = rets.reduce((s, x) => s + x, 0) / rets.length;
      const vol = Math.sqrt(rets.reduce((s, x) => s + (x - drift) * (x - drift), 0) / rets.length) || 1e-9;

      // trend proxy: ema slope (if exists)
      let emaSlope = 0;
      if (Array.isArray(emaArr) && emaArr.length >= 10) {
        const m = emaArr.length;
        const k = Math.min(10, m - 1);
        const e1 = Number(emaArr[m - 1]?.value);
        const e0 = Number(emaArr[m - 1 - k]?.value);
        if (Number.isFinite(e1) && Number.isFinite(e0)) emaSlope = (e1 - e0) / k;
      } else if (Array.isArray(coreState?.ema) && coreState.ema.length >= 10) {
        const m = coreState.ema.length;
        const k = Math.min(10, m - 1);
        const e1 = Number(coreState.ema[m - 1]);
        const e0 = Number(coreState.ema[m - 1 - k]);
        if (Number.isFinite(e1) && Number.isFinite(e0)) emaSlope = (e1 - e0) / k;
      }

      // combine into 0..1
      // drift/vol is like Sharpe-ish, squashed
      const sharpeish = drift / (vol || 1e-9);
      const score0 = 0.5 + 0.25 * Math.tanh(sharpeish * 3) + 0.25 * Math.tanh(emaSlope * 50);
      const score = clamp01(score0);

      // split into bull/bear/neutral percentages
      // neutral centered around 0.5
      const bull = clamp01((score - 0.5) * 1.6 + 0.5);
      const bear = clamp01((0.5 - score) * 1.6 + 0.5);
      const neutral = clamp01(1 - Math.abs(score - 0.5) * 2);

      // net inflow proxy from last candles green/red ratio
      let up = 0, dn = 0;
      for (const b of slice.slice(-50)) {
        const o = Number(b.open), c = Number(b.close);
        if (!Number.isFinite(o) || !Number.isFinite(c)) continue;
        if (c >= o) up++; else dn++;
      }
      const net = (up + dn) ? (up - dn) / (up + dn) : 0;

      return {
        sentimentScore: Math.round(score * 100),
        bull: bull,
        bear: bear,
        neutral: neutral,
        netInflow: net,
      };
    });
  }

  // Update left UI (best-effort: try IDs, then label-based)
  function updateMarketPulseUI(coreState, uiSnap) {
    safeRun("updateMarketPulseUI", () => {
      // 1) If there is already a computed pulse in snapshot, prefer it
      const pulse = uiSnap?.pulse || uiSnap?.marketPulse || null;
      let data = null;

      if (pulse && typeof pulse === "object") {
        data = {
          sentimentScore: Number(pulse.score ?? pulse.sentiment ?? 0) || null,
          bull: Number(pulse.bull ?? 0) / 100 || null,
          bear: Number(pulse.bear ?? 0) / 100 || null,
          neutral: Number(pulse.neutral ?? 0) / 100 || null,
          netInflow: Number(pulse.netInflow ?? 0) || 0,
        };
      }

      if (!data) data = computeSentimentFromSnapshot(coreState, uiSnap);
      if (!data) return;

      // Common IDs (if you already have them)
      const elScore = $("sentimentScore") || $("mpScore") || $("pulseScore");
      const elBull  = $("bullPct") || $("mpBull");
      const elBear  = $("bearPct") || $("mpBear");
      const elNeut  = $("neutralPct") || $("mpNeutral");
      const elNet   = $("netInflow") || $("mpNet");

      if (elScore) setText(elScore, String(data.sentimentScore));
      if (elBull)  setText(elBull, `${pct(data.bull)}%`);
      if (elBear)  setText(elBear, `${pct(data.bear)}%`);
      if (elNeut)  setText(elNeut, `${pct(data.neutral)}%`);
      if (elNet)   setText(elNet, (data.netInflow >= 0 ? "+" : "") + (data.netInflow * 100).toFixed(0) + "%");

      // If IDs not present, try label-based replacement in Market Pulse card
      const card = findCardByHeaderText("Market Pulse") || findCardByHeaderText("市场情绪");
      if (!card) return;

      // Replace the "—" on the right side of each row if present
      const rows = qsa("div,li,p,span", card).filter(el => {
        const t = (el.textContent || "").trim();
        return /Bullish|Bearish|Neutral|Net Inflow|多|空|中性|净流入/i.test(t);
      });

      for (const r of rows) {
        if (isInsideBilling(r)) continue;
        const t = (r.textContent || "");
        // heuristic: last text node often contains the value
        // We'll patch only when it contains '—' or ends with ':' etc.
        if (/Bullish/i.test(t)) {
          r.innerHTML = r.innerHTML.replace(/—/g, `${pct(data.bull)}%`);
        } else if (/Bearish/i.test(t)) {
          r.innerHTML = r.innerHTML.replace(/—/g, `${pct(data.bear)}%`);
        } else if (/Neutral/i.test(t)) {
          r.innerHTML = r.innerHTML.replace(/—/g, `${pct(data.neutral)}%`);
        } else if (/Net Inflow/i.test(t)) {
          const v = (data.netInflow >= 0 ? "+" : "") + (data.netInflow * 100).toFixed(0) + "%";
          r.innerHTML = r.innerHTML.replace(/—/g, v);
        }
      }

      // Big ring number: look for a single large number text within card
      const bigNum = qsa("div,span", card).find(el => {
        const s = (el.textContent || "").trim();
        return /^\d{1,3}$/.test(s) && (el.getBoundingClientRect().width > 30);
      });
      if (bigNum) setText(bigNum, String(data.sentimentScore));
    });
  }

  // -----------------------------
  // Red box improvements (Manage button + disclaimer block)
  // - We do NOT change logic, only text/visibility outside billing area
  // -----------------------------
  function improveRedBoxTexts() {
    safeRun("improveRedBoxTexts", () => {
      // Left bottom disclaimer title bilingual polish (if exists)
      const langTag = qs(".langTag") || qs("[data-lang-tag]") || null;
      if (langTag && !isInsideBilling(langTag)) {
        // no-op: keep your existing if you already styled it
      }

      // Right: Manage button label polish (DO NOT TOUCH handlers)
      const btns = qsa("button, a");
      for (const b of btns) {
        if (isInsideBilling(b)) continue;
        const t = (b.textContent || "").trim();
        if (/^Manage\b/i.test(t) && /管理/.test(t) === false) {
          // keep bilingual
          b.textContent = "Manage · 管理";
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

      // Step2A: remove yellow-box notes
      cleanupYellowBoxes();

      // Step2A: restore Market Pulse numbers
      updateMarketPulseUI(coreState, uiSnap);

      // Small text polish (red box)
      improveRedBoxTexts();
    });
  }

  // -----------------------------
  // Boot
  // -----------------------------
  function boot() {
    safeRun("boot", () => {
      refreshAll();
      window.addEventListener("darrius:chartUpdated", refreshAll);

      // Conservative polling: UI might render after chart update
      setInterval(refreshAll, 2500);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
