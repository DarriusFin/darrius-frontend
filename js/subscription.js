/* =========================================================
 * FILE: darrius-frontend/js/subscription.js
 * DarriusAI · Subscription Module (Final)
 * - Keeps existing backend routes untouched
 * - Prefer:   GET  /api/plans
 * - Fallback: GET  /billing/prices
 * - Checkout: POST /billing/checkout   -> {checkout_url}
 * - Portal:   POST /api/billing/portal -> {url} (optional)
 * - Status:   GET  /api/subscription/status?user_id=... (optional)
 * ========================================================= */

(function () {
  "use strict";

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);

  function getApiBase() {
    // allow index.html to set window.API_BASE, else fallback to same origin
    return (window.API_BASE || "").trim() || "";
  }

  function safeText(el, text) {
    if (!el) return;
    el.textContent = text == null ? "" : String(text);
  }

  function setDisabled(el, disabled) {
    if (!el) return;
    el.disabled = !!disabled;
  }

  function isAdmin() {
    try {
      const p = new URLSearchParams(location.search);
      return p.get("admin") === "1";
    } catch (_) {
      return false;
    }
  }

  function log(msg) {
    // If you already have a global log() in index.html, use it.
    if (typeof window.log === "function") {
      window.log(msg);
      return;
    }
    if (isAdmin()) console.log("[Subscription]", msg);
  }

  async function apiGet(path) {
    const base = getApiBase();
    const url = base ? `${base}${path}` : path;
    const resp = await fetch(url, { method: "GET" });
    const txt = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 240)}`);
    try {
      return JSON.parse(txt);
    } catch (_) {
      return txt;
    }
  }

  async function apiPost(path, payload) {
    const base = getApiBase();
    const url = base ? `${base}${path}` : path;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const txt = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 240)}`);
    try {
      return JSON.parse(txt);
    } catch (_) {
      return { raw: txt };
    }
  }

  // ---------- plans ----------
  // Internal plans cache: [{key,label,price_id,trial_days}]
  let PLANS = [];

  function getLocalFallbackPlans() {
    // IMPORTANT: replace with your actual final price_ids if needed
    // You already had this fallback list in index.html; keep same
    return [
      { key: "weekly", label: "Weekly · $4.90", price_id: "price_1SpJMmR84UMUVSTg0T7xfm6r", trial_days: 0 },
      { key: "monthly", label: "Monthly · $19.90", price_id: "price_1SpbvRR84UMUVSTggbg0SFzi", trial_days: 1 },
      { key: "quarterly", label: "Quarterly · $49.90", price_id: "price_1SpbwYR84UMUVSTgMQpUrE42", trial_days: 3 },
      { key: "yearly", label: "Yearly · $189", price_id: "price_1SpbpxR84UMUVSTgapaJDjMX", trial_days: 5 },
    ];
  }

  function setPlanStatusText(text) {
    safeText($("planStatus"), text);
  }

  function populatePlans(plans) {
    PLANS = Array.isArray(plans) ? plans.slice() : [];

    const sel = $("planSelect");
    if (!sel) return;

    sel.innerHTML = "";
    if (PLANS.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No plans";
      sel.appendChild(opt);
      setDisabled($("subscribeBtn"), true);
      setPlanStatusText("无可用计划");
      return;
    }

    for (const p of PLANS) {
      const opt = document.createElement("option");
      opt.value = p.key;
      opt.textContent = p.label || p.key;
      sel.appendChild(opt);
    }

    setDisabled($("subscribeBtn"), false);
    setPlanStatusText(`已加载 ${PLANS.length} 个计划`);
  }

  async function initPlans() {
    // Try /api/plans first
    try {
      setPlanStatusText("从后端拉取…");
      const data = await apiGet("/api/plans");
      if (!data || data.ok !== true || !Array.isArray(data.plans) || data.plans.length === 0) {
        throw new Error("Invalid /api/plans response");
      }

      const plans = data.plans
        .map((x) => ({
          key: x.key,
          label: x.label || x.key,
          price_id: x.price_id,
          trial_days: Number(x.trial_days || 0),
        }))
        .filter((x) => x.key && x.price_id);

      if (plans.length === 0) throw new Error("No valid plans with price_id");

      populatePlans(plans);
      log("✅ plans loaded from /api/plans");
      return;
    } catch (e1) {
      log("⚠️ /api/plans failed: " + e1.message);
    }

    // Fallback: /billing/prices (legacy)
    try {
      const legacy = await apiGet("/billing/prices");
      if (legacy && legacy.ok === true && Array.isArray(legacy.prices) && legacy.prices.length > 0) {
        const planToPrice = legacy.plan_to_price || {};
        const priceToTrial = {};
        for (const it of legacy.prices) {
          if (it && it.price_id) priceToTrial[it.price_id] = Number(it.trial_days || 0);
        }

        const candidates = [
          { key: "weekly", label: "Weekly · $4.90", price_id: planToPrice.weekly || "", trial_days: priceToTrial[planToPrice.weekly] || 0 },
          { key: "monthly", label: "Monthly · $19.90", price_id: planToPrice.monthly || "", trial_days: priceToTrial[planToPrice.monthly] || 1 },
          { key: "quarterly", label: "Quarterly · $49.90", price_id: planToPrice.quarterly || "", trial_days: priceToTrial[planToPrice.quarterly] || 3 },
          { key: "yearly", label: "Yearly · $189", price_id: planToPrice.yearly || "", trial_days: priceToTrial[planToPrice.yearly] || 5 },
        ].filter((x) => x.price_id);

        if (candidates.length >= 1) {
          populatePlans(candidates);
          setPlanStatusText(`已加载 ${candidates.length} 个计划（legacy fallback）`);
          log("✅ plans loaded from /billing/prices");
          return;
        }
      }
      throw new Error("Legacy invalid or empty");
    } catch (e2) {
      log("⚠️ /billing/prices failed: " + e2.message);
    }

    // Final fallback: local
    const fallback = getLocalFallbackPlans();
    populatePlans(fallback);
    setPlanStatusText("已加载 4 个计划（local fallback）");
    log("⚠️ using local fallback plans");
  }

  // ---------- checkout ----------
  function buildCheckoutPayload() {
    const user_id = ($("userId")?.value || "").trim();
    const email = ($("email")?.value || "").trim();
    const planKey = $("planSelect")?.value || "";
    const override = ($("priceOverride")?.value || "").trim();

    if (!user_id) {
      throw new Error("User ID 必填");
    }

    let payload = { user_id };
    if (email) payload.email = email;

    if (override) {
      payload.price_id = override;
      payload.plan = planKey || undefined;
      return payload;
    }

    payload.plan = planKey || undefined;

    const p = PLANS.find((x) => x.key === planKey);
    if (p && p.price_id) payload.price_id = p.price_id;

    return payload;
  }

  async function startCheckout() {
    let payload;
    try {
      payload = buildCheckoutPayload();
    } catch (e) {
      alert(e.message);
      $("userId")?.focus();
      return;
    }

    try {
      setDisabled($("subscribeBtn"), true);
      setPlanStatusText("创建支付…");

      log("➡️ POST /billing/checkout " + JSON.stringify(payload));

      // IMPORTANT: keep route as-is: POST /billing/checkout
      const data = await apiPost("/billing/checkout", payload);
      const url = data?.checkout_url;

      if (!url) throw new Error("No checkout_url returned");

      setPlanStatusText("跳转 Stripe…");
      window.location.href = url;
    } catch (e) {
      setPlanStatusText("支付创建失败");
      log("❌ checkout error: " + e.message);
      alert("订阅失败：\n" + e.message);
    } finally {
      setDisabled($("subscribeBtn"), false);
    }
  }

  // ---------- portal (optional) ----------
  async function openCustomerPortal() {
    const user_id = ($("userId")?.value || "").trim();
    if (!user_id) {
      alert("请先填写 User ID，再打开订阅管理。");
      $("userId")?.focus();
      return;
    }

    try {
      // This endpoint is optional. If you don't have it, it will alert.
      const data = await apiPost("/api/billing/portal", { user_id });
      if (!data || !data.url) throw new Error("No portal url");
      window.location.href = data.url;
    } catch (e) {
      log("⚠️ portal not available: " + e.message);
      alert(
        "订阅管理（Customer Portal）暂未开通或接口未部署。\n\n" +
          "后端可选提供：POST /api/billing/portal -> 返回 {url}\n\n" +
          "错误：\n" +
          e.message
      );
    }
  }

  // ---------- status (optional) ----------
  let __statusTimer = null;

  async function refreshSubscriptionStatus() {
    const user_id = ($("userId")?.value || "").trim();

    if (!user_id) {
      safeText($("subStatusText"), "Unknown");
      setDisabled($("manageBtn"), true);
      return;
    }

    try {
      // Optional endpoint. If not implemented, we degrade gracefully.
      const data = await apiGet(`/api/subscription/status?user_id=${encodeURIComponent(user_id)}`);
      const status = data?.status || "unknown";
      const has = !!data?.has_access;

      safeText($("subStatusText"), `${status}${has ? " · Access ON" : " · Access OFF"}`);

      const portal = !!data?.customer_portal;
      setDisabled($("manageBtn"), !portal);
      if ($("manageBtn")) $("manageBtn").textContent = portal ? "Manage · 管理" : "Manage · (pending)";

      log("✅ subscription status: " + JSON.stringify(data).slice(0, 240));
    } catch (e) {
      // Not implemented or error -> don't break UI
      safeText($("subStatusText"), "Not implemented");
      setDisabled($("manageBtn"), true);
      log("⚠️ status endpoint missing or failed: " + e.message);
    }
  }

  function debounceRefreshStatus() {
    window.clearTimeout(__statusTimer);
    __statusTimer = window.setTimeout(refreshSubscriptionStatus, 400);
  }

  // ---------- public init ----------
  function init() {
    // Wire events if elements exist
    const subscribeBtn = $("subscribeBtn");
    const manageBtn = $("manageBtn");
    const userId = $("userId");

    if (subscribeBtn) subscribeBtn.addEventListener("click", startCheckout);
    if (manageBtn) manageBtn.addEventListener("click", openCustomerPortal);
    if (userId) userId.addEventListener("input", debounceRefreshStatus);

    // Load plans on init
    initPlans().then(() => {
      // after plans loaded, enable manage button state check
      refreshSubscriptionStatus();
    });
  }

  // Expose
  window.Subscription = {
    init,
    initPlans,
    refreshSubscriptionStatus,
    startCheckout,
    openCustomerPortal,
    // for debugging/admin
    _getPlans: () => PLANS.slice(),
  };
})();
