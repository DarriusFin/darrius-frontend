/* =========================================================
 * FILE: darrius-frontend/js/boot.js
 * DarriusAI · Boot / Wiring Module (Final, deduped) + TSLA default
 * - Wires UI events
 * - Starts ChartCore + Subscription modules
 * - Keeps subscription stable; does NOT touch backend secrets
 * ========================================================= */

(function () {
  "use strict";

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);

  // ✅兼容 symbol / symbo1（你现在 HTML 里是 symbo1）
  function getSymbolEl() {
    return $("symbol") || $("symbo1") || null;
  }

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

      const symEl = getSymbolEl();
      if (qsSym && symEl) symEl.value = qsSym.toUpperCase();
      if (qsTf && $("tf")) $("tf").value = qsTf;
    } catch (_) {}
  }

  // ---------- optional: share link ----------
  async function copyShareLink() {
    // ✅默认 TSLA
    const symEl = getSymbolEl();
    const sym = ((symEl?.value || "TSLA").trim().toUpperCase()) || "TSLA";
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

  // ---------- Route Manage -> account.html ----------
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

      window.location.href = "/account.html?" + qs.toString();
    };

    manageBtn.disabled = false;
    if (isAdmin()) console.log("[BOOT] Order Manage routed to /account.html");
  }

  // ---------- main boot ----------
  function boot() {
    safeText($("yearNow"), String(new Date().getFullYear()));

    // ✅ 全站 API base（不在这里暴露算法）
    if (!window.API_BASE) window.API_BASE = "https://darrius-api.onrender.com";

    enableAdminBlocksIfNeeded();
    applyQueryParamsToUI();

    // ✅ 若 symbol/symbo1 为空，兜底 TSLA（不改 UI，只填默认值）
    const symEl = getSymbolEl();
    if (symEl && !String(symEl.value || "").trim()) symEl.value = "TSLA";

    syncTfQuick($("tf")?.value || "1d");

    // ---- ChartCore wiring ----
    if (!window.ChartCore) {
      setStatus("ChartCore missing (js not loaded)", false);
      log("❌ ChartCore not found on window. Did you include /js/chart.core.js ?");
    } else {
      bindTfQuick(() => {
        if (typeof window.ChartCore.load === "function") window.ChartCore.load();
      });

      $("tgEMA")?.addEventListener("change", () => {
        if (typeof window.ChartCore.applyToggles === "function") window.ChartCore.applyToggles();
      });
      $("tgAux")?.addEventListener("change", () => {
        if (typeof window.ChartCore.applyToggles === "function") window.ChartCore.applyToggles();
      });

      $("loadBtn")?.addEventListener("click", () => {
        if (typeof window.ChartCore.load === "function") window.ChartCore.load();
      });

      try {
        if (typeof window.ChartCore.init === "function") {
          window.ChartCore.init({
            chartElId: "chart",
            overlayElId: "sigOverlay",
            // ✅兼容你现在 HTML 的 symbo1
            symbolElIdPrimary: "symbol",
            symbolElIdFallback: "symbo1",
            tfElId: "tf",
            defaultSymbol: "TSLA",
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

    // ---- Subscription wiring (DO NOT TOUCH) ----
    if (!window.Subscription) {
      log("⚠️ Subscription module not found. Did you include /js/subscription.js ?");
    } else {
      try {
        if (typeof window.Subscription.attach === "function") {
          window.Subscription.attach();
          log("✅ Subscription.attach()");
        } else if (typeof window.Subscription.initPlans === "function") {
          window.Subscription.initPlans();
          log("✅ Subscription.initPlans()");
        } else {
          log("⚠️ Subscription has no attach/initPlans");
        }
      } catch (e) {
        log("❌ Subscription wiring error: " + e.message);
      }
    }

    wireManageToAccount();

    $("copyLinkBtn")?.addEventListener("click", copyShareLink);
    $("exportBtn")?.addEventListener("click", exportPNG);
    $("affiliateBtn")?.addEventListener("click", openAffiliate);

    setStatus("Ready · 前端已就绪", true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.Boot = { boot };
})();
