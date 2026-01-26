/* =========================================================
 * FILE: darrius-frontend/js/boot.js
 * DarriusAI · Boot / Wiring Module (Final, deduped)
 * - Wires UI events
 * - Starts ChartCore + Subscription modules
 * - Keeps subscription stable; does NOT touch backend secrets
 * - Path A: Order Start stays checkout; Order Manage routes to /account.html
 * ========================================================= */

(function () {
  "use strict";

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);

  function safeText(el, text) {
    if (!el) return;
    el.textContent = text == null ? "" : String(text);
  }

  function isAdmin() {
    try {
      const p = new URLSearchParams(location.search);
      return p.get("admin") === "1";
    } catch (_) {
      return false;
    }
  }

  function setStatus(text, ok = true) {
    const badge = $("statusBadge");
    if (badge) badge.classList.toggle("bad", !ok);
    safeText($("statusText"), text);
  }

  function log(msg) {
    // Reuse your existing logger if present
    if (typeof window.log === "function") {
      window.log(msg);
      return;
    }
    if (isAdmin()) console.log("[BOOT]", msg);
  }

  function syncTfQuick(tf) {
    document.querySelectorAll(".tfBtn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tf === tf);
    });
  }

  function bindTfQuick(onTfSelected) {
    document.querySelectorAll(".tfBtn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tf = btn.dataset.tf;
        const tfSel = $("tf");
        if (tfSel) tfSel.value = tf;
        syncTfQuick(tf);
        if (typeof onTfSelected === "function") onTfSelected(tf);
      });
    });
  }

  function applyQueryParamsToUI() {
    try {
      const p = new URLSearchParams(location.search);
      const qsSym = p.get("symbol");
      const qsTf = p.get("tf");
      if (qsSym && $("symbol")) $("symbol").value = qsSym.toUpperCase();
      if (qsTf && $("tf")) $("tf").value = qsTf;
    } catch (_) {}
  }

  // ---------- optional: share link ----------
  async function copyShareLink() {
    const sym = ($("symbol")?.value || "BTCUSDT").trim().toUpperCase();
    const tf = $("tf")?.value || "1d";
    const url = `${location.origin}${location.pathname}?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`;
    try {
      await navigator.clipboard.writeText(url);
      alert("已复制分享链接：\n" + url);
    } catch (_) {
      prompt("复制失败，请手动复制：", url);
    }
  }

  // ---------- optional: export png ----------
  function exportPNG() {
    try {
      // ChartCore may provide screenshot helper, else fallback to chart instance if exposed
      if (window.ChartCore && typeof window.ChartCore.exportPNG === "function") {
        window.ChartCore.exportPNG();
        return;
      }
      alert("导出功能将在最终 ChartCore 版本中统一提供。");
    } catch (e) {
      alert("导出失败：" + e.message);
    }
  }

  // ---------- optional: affiliate entry ----------
  function openAffiliate() {
    alert(
      "Affiliate 入口（合规版）：\n\n" +
        "下一步建议：\n" +
        "1) /affiliate/register（选择 US / non-US 身份）\n" +
        "2) 电子签署：W-9/1099 或 W-8 系列 + 合作协议\n" +
        "3) /affiliate/dashboard（推荐数、结算、发票/对账）\n\n" +
        "注：返佣比例与结算规则不在前端公开展示（商业机密）。"
    );
  }

  // ---------- admin blocks ----------
  function enableAdminBlocksIfNeeded() {
    if (!isAdmin()) return;

    $("diagCard")?.classList.remove("hidden");
    $("paramRow")?.classList.remove("hidden");
    $("priceOverrideRow")?.classList.remove("hidden");

    log("Admin mode enabled (?admin=1)");
  }

  // ---------- Path A: Route Manage -> account.html ----------
  function wireManageToAccount() {
    const manageBtn = $("manageBtn");
    if (!manageBtn) return;

    manageBtn.onclick = function () {
      const userId = $("userId")?.value?.trim() || "";
      const email = $("email")?.value?.trim() || "";

      if (!userId) {
        alert("请先填写 User ID，再进入账户管理。");
        $("userId")?.focus?.();
        return;
      }

      const qs = new URLSearchParams({ from: "home", user_id: userId });
      if (email) qs.set("email", email);

      // Go to Account Center
      window.location.href = "/account.html?" + qs.toString();
    };

    // 即使 status Unknown，也允许进入 account center
    manageBtn.disabled = false;

    if (isAdmin()) console.log("[BOOT] Order Manage routed to /account.html");
  }

  // ---------- main boot ----------
  function boot() {
    // year
    safeText($("yearNow"), String(new Date().getFullYear()));

    // global API base (shared by modules)
    // NOTE: you can set this in index.html before scripts; if not, we keep existing value
    if (!window.API_BASE) {
      // Prefer your known Render backend; can be overridden in index.html
      window.API_BASE = "https://darrius-api.onrender.com";
    }

    enableAdminBlocksIfNeeded();
    applyQueryParamsToUI();

    // Quick TF buttons
    syncTfQuick($("tf")?.value || "1d");

    // ---- ChartCore wiring ----
    const hasChartCore = !!window.ChartCore;
    if (!hasChartCore) {
      setStatus("ChartCore missing (js not loaded)", false);
      log("❌ ChartCore not found on window. Did you include /js/chart.core.js ?");
    } else {
      // Bind TF quick -> reload
      bindTfQuick(() => {
        // do a full reload of market data
        if (typeof window.ChartCore.load === "function") window.ChartCore.load();
      });

      // toggles
      $("tgEMA")?.addEventListener("change", () => {
        if (typeof window.ChartCore.applyToggles === "function") window.ChartCore.applyToggles();
      });
      $("tgAux")?.addEventListener("change", () => {
        if (typeof window.ChartCore.applyToggles === "function") window.ChartCore.applyToggles();
      });

      // Load button
      $("loadBtn")?.addEventListener("click", () => {
        if (typeof window.ChartCore.load === "function") window.ChartCore.load();
      });

      // Init chart (ChartCore should create chart and do initial load)
      try {
        if (typeof window.ChartCore.init === "function") {
          window.ChartCore.init({
            // pass DOM ids if ChartCore supports it; safe to ignore if not used
            chartElId: "chart",
            overlayElId: "sigOverlay",
          });
          log("✅ ChartCore.init()");
        } else {
          log("⚠️ ChartCore.init missing; please ensure chart.core.js exposes init()");
        }
      } catch (e) {
        setStatus("Chart init failed", false);
        log("❌ ChartCore.init error: " + e.message);
      }
    }

    // ---- Subscription wiring ----
    if (!window.Subscription) {
      log("⚠️ Subscription module not found. Did you include /js/subscription.js ?");
    } else {
      try {
        if (typeof window.Subscription.attach === "function") {
          window.Subscription.attach(); // ✅ bind buttons + load plans (original logic stays)
          log("✅ Subscription.attach()");
        } else if (typeof window.Subscription.initPlans === "function") {
          window.Subscription.initPlans(); // fallback: at least load plans
          log("✅ Subscription.initPlans()");
        } else {
          log("⚠️ Subscription has no attach/initPlans");
        }
      } catch (e) {
        log("❌ Subscription wiring error: " + e.message);
      }
    }

    // ✅ Path A: MUST be after Subscription.attach(), so our onclick wins.
    wireManageToAccount();

    // Other UI utilities
    $("copyLinkBtn")?.addEventListener("click", copyShareLink);
    $("exportBtn")?.addEventListener("click", exportPNG);
    $("affiliateBtn")?.addEventListener("click", openAffiliate);

    // Final status
    setStatus("Ready · 前端已就绪", true);
  }

  // Run
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // expose (optional)
  window.Boot = { boot };
})();
