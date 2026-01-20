/* =========================================================
 * DarriusAI · Subscription Module (Final)  ✅ FINAL CHECKED
 * File: js/subscription.js
 * Purpose:
 *  - Load plans from backend: /api/plans (preferred)
 *  - Fallback: /billing/prices (legacy)
 *  - Fallback: local default plans
 *  - Create checkout: POST /billing/checkout
 *  - (Optional) Subscription status: GET /api/subscription/status?user_id=
 *  - (Optional) Customer portal: POST /api/billing/portal
 *
 * Notes:
 *  - NO secrets on frontend
 *  - Safe defaults & graceful fallbacks
 * ========================================================= */
(function () {
  "use strict";

  function $(id) {
    return document.getElementById(id);
  }

  function isAdmin() {
    try {
      const p = new URLSearchParams(location.search);
      return p.get("admin") === "1";
    } catch (_) {
      return false;
    }
  }

  function safeJsonParse(txt) {
    try {
      return JSON.parse(txt);
    } catch (_) {
      return null;
    }
  }

  function nowISOTime() {
    return new Date().toISOString().slice(11, 19);
  }

  function log(msg) {
    // If page has log() already, use it; otherwise console
    try {
      if (typeof window.log === "function") {
        window.log(msg);
      } else {
        console.log("[Subscription]", msg);
      }
    } catch (_) {}
  }

  function setStatusBadge(text, ok) {
    // If page has setStatus() already, use it; otherwise ignore
    try {
      if (typeof window.setStatus === "function") {
        window.setStatus(text, ok !== false);
      }
    } catch (_) {}
  }

  // -------- Config --------
  const API_BASE = (window.API_BASE || "").trim() || "https://darrius-api.onrender.com";

  // -------- DOM ids (match your current UI) --------
  const IDS = {
    planStatus: "planStatus",
    planSelect: "planSelect",
    subscribeBtn: "subscribeBtn",
    manageBtn: "manageBtn",
    subStatusText: "subStatusText",
    userId: "userId",
    email: "email",
    priceOverride: "priceOverride",
    priceOverrideRow: "priceOverrideRow",
  };

  // -------- State --------
  let PLANS = []; // {key,label,price_id,trial_days}
  let _subStatusTimer = null;

  // -------- API helpers --------
  async function apiGet(path) {
    const url = `${API_BASE}${path}`;
    const resp = await fetch(url, { method: "GET" });
    const txt = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 260)}`);
    const j = safeJsonParse(txt);
    return j !== null ? j : txt;
  }

  async function apiPost(path, payload) {
    const url = `${API_BASE}${path}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const txt = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 260)}`);
    const j = safeJsonParse(txt);
    return j !== null ? j : { raw: txt };
  }

  // -------- Fallback plans (your latest price strategy) --------
  function getLocalFallbackPlans() {
    // NOTE: Replace these price_ids if backend differs; local fallback is only for UI continuity
    return [
      { key: "weekly", label: "Weekly · $4.90", price_id: "price_weekly_PLACEHOLDER", trial_days: 0 },
      { key: "monthly", label: "Monthly · $19.90", price_id: "price_monthly_PLACEHOLDER", trial_days: 1 },
      { key: "quarterly", label: "Quarterly · $49.90", price_id: "price_quarterly_PLACEHOLDER", trial_days: 3 },
      { key: "yearly", label: "Yearly · $189", price_id: "price_yearly_PLACEHOLDER", trial_days: 5 },
    ];
  }

  function setPlanStatusText(t) {
    const el = $(IDS.planStatus);
    if (el) el.textContent = t;
  }

  function setSubStatusText(t) {
    const el = $(IDS.subStatusText);
    if (el) el.textContent = t;
  }

  function disableButtons(disabled) {
    const subBtn = $(IDS.subscribeBtn);
    const mngBtn = $(IDS.manageBtn);
    if (subBtn) subBtn.disabled = !!disabled;
    if (mngBtn) mngBtn.disabled = !!disabled;
  }

  function populatePlans(plans) {
    PLANS = (plans || []).slice();
    const sel = $(IDS.planSelect);
    if (!sel) return;

    sel.innerHTML = "";
    for (const p of PLANS) {
      const opt = document.createElement("option");
      opt.value = p.key;
      opt.textContent = p.label || p.key;
      sel.appendChild(opt);
    }

    setPlanStatusText(`已加载 ${PLANS.length} 个计划`);
    const subBtn = $(IDS.subscribeBtn);
    if (subBtn) subBtn.disabled = PLANS.length === 0;
  }

  // Preferred: /api/plans
  async function loadPlansPreferred() {
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
    return plans;
  }

  // Legacy fallback: /billing/prices
  async function loadPlansLegacy() {
    const legacy = await apiGet("/billing/prices");
    if (!legacy || legacy.ok !== true || !Array.isArray(legacy.prices) || legacy.prices.length === 0) {
      throw new Error("Invalid /billing/prices response");
    }

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

    if (candidates.length === 0) throw new Error("No legacy price mapping");
    return candidates;
  }

  async function initPlans() {
    try {
      setPlanStatusText("从后端拉取…");
      const plans = await loadPlansPreferred();
      populatePlans(plans);
      setStatusBadge("API OK", true);
      log(`✅ plans: loaded from /api/plans (${plans.length})`);
      return;
    } catch (e1) {
      try {
        const plans = await loadPlansLegacy();
        populatePlans(plans);
        setPlanStatusText(`已加载 ${plans.length} 个计划（legacy fallback）`);
        log(`⚠️ plans: loaded from /billing/prices fallback (${plans.length})`);
        return;
      } catch (e2) {
        const fallback = getLocalFallbackPlans();
        populatePlans(fallback);
        setPlanStatusText("已加载计划（local fallback）");
        setStatusBadge("API Degraded", false);
        if (isAdmin()) {
          log(`❌ initPlans failed: ${e1.message} / ${e2.message} -> local fallback`);
        }
      }
    }
  }

  // -------- Subscribe: POST /billing/checkout --------
  async function subscribe() {
    const user_id = (($(IDS.userId) && $(IDS.userId).value) || "").trim();
    const email = (($(IDS.email) && $(IDS.email).value) || "").trim();
    const planKey = (($(IDS.planSelect) && $(IDS.planSelect).value) || "").trim();
    const override = (($(IDS.priceOverride) && $(IDS.priceOverride).value) || "").trim();

    if (!user_id) {
      alert("User ID 必填（用于绑定 Stripe 订阅到你的系统用户）。");
      $(IDS.userId)?.focus?.();
      return;
    }

    let payload = { user_id };
    if (email) payload.email = email;

    if (override) {
      payload.price_id = override;
    } else {
      payload.plan = planKey;
      const p = PLANS.find((x) => x.key === planKey);
      if (p && p.price_id) payload.price_id = p.price_id;
    }

    try {
      setStatusBadge("Creating checkout…", true);
      if (isAdmin()) log(`➡️ [${nowISOTime()}] POST /billing/checkout ${JSON.stringify(payload)}`);

      // Use fetch directly because your backend returns {checkout_url}
      const resp = await fetch(`${API_BASE}/billing/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const txt = await resp.text();
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 260)}`);

      const data = safeJsonParse(txt) || { raw: txt };
      if (!data || !data.checkout_url) throw new Error("No checkout_url returned");

      setStatusBadge("Redirecting to Stripe…", true);
      if (isAdmin()) log(`✅ checkout_url ok -> redirect`);
      window.location.href = data.checkout_url;
    } catch (e) {
      setStatusBadge("Network/API error", false);
      if (isAdmin()) log(`❌ subscribe failed: ${e.message}`);
      alert("订阅失败：网络错误/后端未联通或接口报错。\n\n错误：\n" + e.message);
    }
  }

  // -------- Optional: subscription status --------
  async function refreshSubscriptionStatus() {
    const user_id = (($(IDS.userId) && $(IDS.userId).value) || "").trim();
    const manageBtn = $(IDS.manageBtn);

    // 1) 没 user_id：保持 Unknown + 禁用 Manage
    if (!user_id) {
      setSubStatusText("Unknown");
      if (manageBtn) manageBtn.disabled = true;
      return;
    }

    // 2) 有 user_id：先“乐观启用” Manage（portal 端点你已验证可用）
    if (manageBtn) {
      manageBtn.disabled = false;
      manageBtn.textContent = "Manage · 管理";
    }
    setSubStatusText("Checking...");

    // 3) 再尝试拉 status（失败也不影响 Manage）
    try {
      const data = await apiGet(`/api/subscription/status?user_id=${encodeURIComponent(user_id)}`);

      const status = data?.status || "unknown";
      const has = !!data?.has_access;
      setSubStatusText(`${status}${has ? " · Access ON" : " · Access OFF"}`);

      // 不再用 status 返回来锁按钮（只显示文案）
      if (manageBtn) manageBtn.textContent = "Manage · 管理";

      if (isAdmin()) log(`✅ sub status: ${JSON.stringify(data).slice(0, 260)}`);
    } catch (e) {
      // status 端点失败也没关系，Manage 仍可用
      setSubStatusText("Unknown");
      if (isAdmin()) log(`⚠️ status endpoint issue: ${e.message}`);
    }
  }

  function scheduleRefreshStatus() {
    window.clearTimeout(_subStatusTimer);
    _subStatusTimer = window.setTimeout(refreshSubscriptionStatus, 420);
  }

  // -------- Optional: Customer Portal --------
  async function openCustomerPortal() {
    const user_id = (($(IDS.userId) && $(IDS.userId).value) || "").trim();
    if (!user_id) {
      alert("请先填写 User ID，再打开订阅管理。");
      return;
    }

    try {
      const data = await apiPost("/api/billing/portal", { user_id });
      if (!data || !data.url) throw new Error("No portal url");
      window.location.href = data.url;
    } catch (e) {
      alert(
        "订阅管理（Customer Portal）暂未开通或接口未部署。\n\n" +
          "后端需要提供：POST /api/billing/portal -> 返回 {url}\n\n" +
          "错误：\n" +
          e.message
      );
      if (isAdmin()) log(`❌ open portal: ${e.message}`);
    }
  }

  // -------- Public attach --------
  function attach(opts) {
    opts = opts || {};

    // allow overriding ids
    if (opts.ids) {
      Object.assign(IDS, opts.ids);
    }

    // init plans now
    initPlans();

    // bind buttons (HARD BIND)
    const subBtn = $(IDS.subscribeBtn);
    if (subBtn) {
      subBtn.onclick = subscribe;
    }

    const m = $(IDS.manageBtn);
    if (m) {
      // 只要 attach 跑起来，就把 Manage 的点击“钉死”
      // 是否禁用由 refreshSubscriptionStatus() 决定（无 user_id 时禁用）
      m.onclick = openCustomerPortal;
    }

    // userId typing triggers status refresh (non-blocking)
    $(IDS.userId)?.addEventListener("input", scheduleRefreshStatus);

    // initial status (will enable/disable Manage based on user_id)
    refreshSubscriptionStatus();
  }

  // Expose module
  window.Subscription = {
    attach,
    initPlans,
    refreshSubscriptionStatus,
    subscribe,
    openCustomerPortal,
    _debug: { API_BASE },
  };
})();
