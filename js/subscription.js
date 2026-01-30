/* =========================================================
 * DarriusAI · Subscription Module (FINAL - Industrial)
 * File: js/subscription.js
 * Purpose:
 *  - Load plans from backend: /api/plans (preferred)
 *  - Fallback: /billing/prices (legacy)
 *  - Fallback: local default plans
 *  - Create checkout: POST /billing/create-checkout-session   ✅ (STANDARD)
 *  - Subscription status UX: GET /api/subscription/status?user_id=
 *  - (Optional) Customer portal: POST /api/billing/portal
 *
 * Guarantees:
 *  - NO secrets on frontend
 *  - Safe defaults & graceful fallbacks
 *  - Does NOT change your Stripe products/prices
 *  - Checkout call is unified for Weekly/Monthly/Quarterly/Yearly
 * ========================================================= */
(function () {
  "use strict";

  // -----------------------------
  // DOM helpers
  // -----------------------------
  function $(id) { return document.getElementById(id); }

  function isAdmin() {
    try {
      const p = new URLSearchParams(location.search);
      return p.get("admin") === "1";
    } catch (_) { return false; }
  }

  function safeJsonParse(txt) {
    try { return JSON.parse(txt); } catch (_) { return null; }
  }

  function nowISOTime() {
    return new Date().toISOString().slice(11, 19);
  }

  function log(msg) {
    try {
      if (typeof window.log === "function") window.log(msg);
      else console.log("[Subscription]", msg);
    } catch (_) {}
  }

  function setStatusBadge(text, ok) {
    try {
      if (typeof window.setStatus === "function") window.setStatus(text, ok !== false);
    } catch (_) {}
  }

  // -----------------------------
  // Config
  // -----------------------------
  const API_BASE = (window.API_BASE || "").trim() || "https://darrius-api.onrender.com";

  // -----------------------------
  // DOM ids (match your current UI)
  // -----------------------------
  const IDS = {
    planStatus: "planStatus",
    planSelect: "planSelect",
    subscribeBtn: "subscribeBtn",
    manageBtn: "manageBtn",
    subStatusText: "subStatusText",
    accessBadge: "accessBadge",
    userId: "userId",
    email: "email",
    priceOverride: "priceOverride",
    priceOverrideRow: "priceOverrideRow",
  };

  // -----------------------------
  // State
  // -----------------------------
  let PLANS = []; // {key,label,price_id,trial_days}
  let _subStatusTimer = null;

  // -----------------------------
  // API helpers
  // -----------------------------
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

  // -----------------------------
  // Referral helper (dref_code)
  // Priority:
  // 1) window.DarriusReferral.get()
  // 2) localStorage 'dref_code'
  // 3) localStorage 'dref'
  // 4) localStorage 'darrius_ref_code' (compat legacy)
  // -----------------------------
  function getDrefCode() {
    try {
      if (window.DarriusReferral && typeof window.DarriusReferral.get === "function") {
        const v = String(window.DarriusReferral.get() || "").trim();
        if (v) return v;
      }
    } catch (_) {}

    try {
      const v1 = String(localStorage.getItem("dref_code") || "").trim();
      if (v1) return v1;
    } catch (_) {}

    try {
      const v2 = String(localStorage.getItem("dref") || "").trim();
      if (v2) return v2;
    } catch (_) {}

    try {
      const v3 = String(localStorage.getItem("darrius_ref_code") || "").trim();
      if (v3) return v3;
    } catch (_) {}

    return "";
  }

  function getRefLanding() {
    try {
      return (window.location.pathname + window.location.search).slice(0, 256);
    } catch (_) {
      return "";
    }
  }

  // -----------------------------
  // Canonical Price Map (authoritative fallback)
  // IMPORTANT: keep in sync with your Stripe Price IDs
  // -----------------------------
  const PRICE_MAP = {
    weekly:    "price_1SpJMmR84UMUVSTg0T7xfm6r", // $4.90 / week
    monthly:   "price_1SpbvRR84UMUVSTggbg0SFzi", // $19.90 / month
    quarterly: "price_1SpbwYR84UMUVSTgMQpUrE42", // $49.90 / quarter
    yearly:    "price_1SpbpxR84UMUVSTgapaJDjMX", // $189 / year
  };

  // UI-only trial badges (actual trial must be enforced by backend/Stripe)
  const TRIAL_DAYS_BY_KEY = {
    weekly: 0,
    monthly: 1,
    quarterly: 3,
    yearly: 5,
  };

  // -----------------------------
  // Local fallback plans (UI continuity only)
  // -----------------------------
  function getLocalFallbackPlans() {
    return [
      { key: "weekly", label: "Weekly · $4.90", price_id: PRICE_MAP.weekly, trial_days: TRIAL_DAYS_BY_KEY.weekly },
      { key: "monthly", label: "Monthly · $19.90", price_id: PRICE_MAP.monthly, trial_days: TRIAL_DAYS_BY_KEY.monthly },
      { key: "quarterly", label: "Quarterly · $49.90", price_id: PRICE_MAP.quarterly, trial_days: TRIAL_DAYS_BY_KEY.quarterly },
      { key: "yearly", label: "Yearly · $189", price_id: PRICE_MAP.yearly, trial_days: TRIAL_DAYS_BY_KEY.yearly },
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

  // -----------------------------
  // Plans loaders
  // -----------------------------
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
      { key: "weekly", label: "Weekly · $4.90", price_id: planToPrice.weekly || PRICE_MAP.weekly, trial_days: priceToTrial[planToPrice.weekly] ?? TRIAL_DAYS_BY_KEY.weekly },
      { key: "monthly", label: "Monthly · $19.90", price_id: planToPrice.monthly || PRICE_MAP.monthly, trial_days: priceToTrial[planToPrice.monthly] ?? TRIAL_DAYS_BY_KEY.monthly },
      { key: "quarterly", label: "Quarterly · $49.90", price_id: planToPrice.quarterly || PRICE_MAP.quarterly, trial_days: priceToTrial[planToPrice.quarterly] ?? TRIAL_DAYS_BY_KEY.quarterly },
      { key: "yearly", label: "Yearly · $189", price_id: planToPrice.yearly || PRICE_MAP.yearly, trial_days: priceToTrial[planToPrice.yearly] ?? TRIAL_DAYS_BY_KEY.yearly },
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
        if (isAdmin()) log(`❌ initPlans failed: ${e1.message} / ${e2.message} -> local fallback`);
      }
    }
  }

  // =========================================================
  // ✅ Unified Checkout Session Creator (TOP-LEVEL FUNCTION)
  // MUST stay at top-level (NOT inside click handlers)
  // =========================================================
  async function createCheckoutSession(payload) {
    // payload expected:
    // { price_id, user_id, email?, dref_code?, ref_landing?, plan? }
    const body = Object.assign({}, payload || {});

    // Hard safety trims
    if (body.user_id) body.user_id = String(body.user_id).trim();
    if (body.email) body.email = String(body.email).trim();
    if (body.price_id) body.price_id = String(body.price_id).trim();
    if (body.dref_code) body.dref_code = String(body.dref_code).trim().slice(0, 64);
    if (body.ref_landing) body.ref_landing = String(body.ref_landing).trim().slice(0, 256);
    if (body.plan) body.plan = String(body.plan).trim().slice(0, 24);

    // NOTE:
    // - Trial / invoice behavior MUST be enforced by backend (billing/routes.py)
    // - Frontend does NOT set trial logic to avoid drift/abuse
    setStatusBadge("Creating checkout…", true);
    if (isAdmin()) log(`➡️ [${nowISOTime()}] POST /billing/create-checkout-session ${JSON.stringify(body)}`);

    const resp = await fetch(`${API_BASE}/billing/create-checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const txt = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 260)}`);

    const data = safeJsonParse(txt) || { raw: txt };

    // accept multiple schemas: {url} / {checkout_url}
    const checkoutUrl = data.url || data.checkout_url || "";
    if (!data.ok || !checkoutUrl) {
      const msg = data.error || "checkout_failed";
      throw new Error(msg);
    }

    setStatusBadge("Redirecting to Stripe…", true);
    window.location.href = checkoutUrl;
  }

  // -----------------------------
  // Subscribe (Unified Entry)
  // - Reads user_id/email/plan selection
  // - Adds dref_code/ref_landing
  // - Calls createCheckoutSession()
  // -----------------------------
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

    // Determine price_id
    let price_id = "";
    let pickedPlanKey = planKey;

    if (override) {
      price_id = override;
      pickedPlanKey = "override";
    } else {
      const p = PLANS.find((x) => x.key === planKey);
      price_id = (p && p.price_id) ? p.price_id : "";
      if (!price_id) {
        // As final fallback, try canonical map
        price_id = PRICE_MAP[String(planKey || "").toLowerCase()] || "";
      }
    }

    if (!price_id) {
      alert("未找到 price_id（计划价格 ID）。请刷新页面或联系管理员。");
      return;
    }

    // Referral
    const dref_code = getDrefCode();
    const ref_landing = getRefLanding();

    // Build payload
    const payload = {
      price_id,
      user_id,
      ref_landing,
      // Keep plan key for debugging (backend may ignore)
      plan: pickedPlanKey || "",
    };
    if (email) payload.email = email;
    if (dref_code) payload.dref_code = dref_code;

    try {
      await createCheckoutSession(payload);
    } catch (e) {
      setStatusBadge("Network/API error", false);
      if (isAdmin()) log(`❌ subscribe failed: ${e.message}`);
      alert("订阅失败：网络错误/后端未联通或接口报错。\n\n错误：\n" + e.message);
    }
  }

  // -----------------------------
  // Subscription status UX (robust)
  // -----------------------------
  function toDateObj(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;

    if (typeof v === "number") {
      const ms = v < 1e12 ? v * 1000 : v;
      const d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }

    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return null;
      const n = Number(s);
      if (!Number.isNaN(n) && s !== "") return toDateObj(n);
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  function fmtYMD(d) {
    if (!d) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }

  function fmtRemain(d) {
    if (!d) return "";
    const ms = d.getTime() - Date.now();
    if (!isFinite(ms)) return "";
    const s = Math.floor(ms / 1000);
    const sign = s >= 0 ? "" : "-";
    const a = Math.abs(s);
    const days = Math.floor(a / 86400);
    const hrs = Math.floor((a % 86400) / 3600);
    return `${sign}${days}d ${hrs}h`;
  }

  function normalizeStripeStatus(raw) {
    const s = String(raw || "").trim().toLowerCase();
    return s || "unknown";
  }

  function isFuture(d) {
    return !!(d && d instanceof Date && isFinite(d.getTime()) && d.getTime() > Date.now());
  }

  function pickPeriodEnd(data) {
    return (
      toDateObj(data?.current_period_end) ||
      toDateObj(data?.period_end) ||
      toDateObj(data?.ends_at) ||
      toDateObj(data?.access_end) ||
      null
    );
  }

  function pickTrialEnd(data) {
    return toDateObj(data?.trial_end || data?.trial_ends_at) || null;
  }

  function decideAccess(data) {
    const status = normalizeStripeStatus(data?.status);
    const hasAccess = (typeof data?.has_access === "boolean") ? data.has_access : null;

    const periodEnd = pickPeriodEnd(data);
    const trialEnd = pickTrialEnd(data);
    const stillInPeriod = isFuture(periodEnd);

    if (hasAccess === true) {
      const bucket = (status === "trialing") ? "TRIAL" : "ACTIVE";
      return { bucket, access_on: true, status, has_access: hasAccess, periodEnd, trialEnd, reason: "has_access_true" };
    }

    if (status === "canceled" && stillInPeriod) {
      return { bucket: "ACTIVE", access_on: true, status, has_access: hasAccess, periodEnd, trialEnd, reason: "canceled_but_in_period" };
    }

    if (status === "trialing") {
      const end = trialEnd || periodEnd;
      const on = isFuture(end) || hasAccess !== false;
      return { bucket: "TRIAL", access_on: on, status, has_access: hasAccess, periodEnd, trialEnd, reason: "trialing" };
    }

    if ((status === "past_due" || status === "unpaid") && stillInPeriod) {
      return { bucket: "GRACE", access_on: true, status, has_access: hasAccess, periodEnd, trialEnd, reason: "billing_grace" };
    }

    if (status === "checkout_created" || status === "incomplete" || status === "checkout_pending" || status === "processing") {
      // Keep as PENDING unless backend says has_access=true
      return { bucket: "PENDING", access_on: false, status, has_access: hasAccess, periodEnd, trialEnd, reason: "pending_activation" };
    }

    if (status === "active" && hasAccess === false) {
      if (stillInPeriod) return { bucket: "ACTIVE", access_on: true, status, has_access: hasAccess, periodEnd, trialEnd, reason: "active_but_flag_false_in_period" };
      return { bucket: "ACTIVE", access_on: false, status, has_access: hasAccess, periodEnd, trialEnd, reason: "active_but_flag_false" };
    }

    if (status === "incomplete_expired" || status === "expired") {
      return { bucket: "EXPIRED", access_on: false, status, has_access: hasAccess, periodEnd, trialEnd, reason: "expired_state" };
    }

    if (!stillInPeriod && hasAccess === false) {
      return { bucket: "EXPIRED", access_on: false, status, has_access: hasAccess, periodEnd, trialEnd, reason: "no_access_and_not_in_period" };
    }

    return { bucket: "UNKNOWN", access_on: (hasAccess === true), status, has_access: hasAccess, periodEnd, trialEnd, reason: "fallback_unknown" };
  }

  function setAccessBadge(bucket) {
    const el = $(IDS.accessBadge);
    if (!el) return;

    const b = String(bucket || "UNKNOWN").toUpperCase();
    el.classList.remove("hidden");
    el.classList.remove("ACTIVE", "TRIAL", "PENDING", "GRACE", "EXPIRED", "UNKNOWN");
    el.classList.add(b);
    el.textContent = b;
  }

  function dispatchEvents(payload) {
    try { window.dispatchEvent(new CustomEvent("darrius:subscription-status", { detail: payload })); } catch (_) {}
    try {
      window.dispatchEvent(new CustomEvent("darrius:access", {
        detail: {
          user_id: payload.user_id,
          bucket: payload.bucket,
          access_on: payload.access_on,
          status: payload.status,
          plan: payload.plan || null,
        }
      }));
    } catch (_) {}
  }

  function applySubUX(data, user_id) {
    const d = data || {};
    const status = normalizeStripeStatus(d.status);
    const planKey = d.plan || d.plan_key || d.current_plan || "";

    const decision = decideAccess(d);
    const bucket = decision.bucket;

    const periodEnd = decision.periodEnd;
    const trialEnd = decision.trialEnd;

    let extra = "";
    if (bucket === "TRIAL") {
      const end = trialEnd || periodEnd;
      extra = end ? ` · ends ${fmtYMD(end)} (${fmtRemain(end)})` : " · trial";
    } else if (bucket === "ACTIVE") {
      extra = periodEnd ? ` · renews ${fmtYMD(periodEnd)} (${fmtRemain(periodEnd)})` : " · access on";
    } else if (bucket === "GRACE") {
      extra = periodEnd ? ` · payment issue, grace until ${fmtYMD(periodEnd)} (${fmtRemain(periodEnd)})` : " · payment issue (grace)";
    } else if (bucket === "PENDING") {
      extra = " · activating…";
    } else if (bucket === "EXPIRED") {
      extra = periodEnd ? ` · ended ${fmtYMD(periodEnd)}` : " · access off";
    }

    const planPart = planKey ? ` · ${planKey}` : "";
    const accessPart = (typeof decision.has_access === "boolean") ? (decision.has_access ? " · Access ON" : " · Access OFF") : "";
    const line = `${bucket}${planPart} · ${status}${accessPart}${extra}`;

    setSubStatusText(line);
    setAccessBadge(bucket);

    // Manage button: enable if user_id exists (keep your rule)
    const manageBtn = $(IDS.manageBtn);
    if (manageBtn) {
      manageBtn.disabled = !user_id;
      manageBtn.textContent = "Manage · 管理";
    }

    try {
      document.body.dataset.subBucket = bucket;
      document.body.dataset.subStatus = status;
      document.body.dataset.subAccess = String(!!decision.access_on);
    } catch (_) {}

    const payload = {
      user_id,
      bucket,
      access_on: !!decision.access_on,
      status,
      has_access: (typeof decision.has_access === "boolean") ? decision.has_access : null,
      plan: planKey || null,
      trial_end: trialEnd ? trialEnd.toISOString() : null,
      period_end: periodEnd ? periodEnd.toISOString() : null,
      reason: decision.reason,
      raw: d,
    };

    dispatchEvents(payload);
    if (isAdmin()) log(`✅ sub UX: ${line} (reason=${decision.reason})`);
  }

  async function refreshSubscriptionStatus() {
    const user_id = (($(IDS.userId) && $(IDS.userId).value) || "").trim();
    const manageBtn = $(IDS.manageBtn);

    if (!user_id) {
      setSubStatusText("UNKNOWN · please input User ID");
      const badge = $(IDS.accessBadge);
      if (badge) badge.classList.add("hidden");
      if (manageBtn) manageBtn.disabled = true;
      return;
    }

    if (manageBtn) {
      manageBtn.disabled = false;
      manageBtn.textContent = "Manage · 管理";
    }
    setSubStatusText("CHECKING...");

    try {
      const data = await apiGet(`/api/subscription/status?user_id=${encodeURIComponent(user_id)}`);
      applySubUX(data, user_id);
    } catch (e) {
      setSubStatusText("UNKNOWN · status endpoint unavailable");
      setAccessBadge("UNKNOWN");
      if (isAdmin()) log(`⚠️ status endpoint issue: ${e.message}`);
    }
  }

  function scheduleRefreshStatus() {
    window.clearTimeout(_subStatusTimer);
    _subStatusTimer = window.setTimeout(refreshSubscriptionStatus, 420);
  }

  // -----------------------------
  // Optional: Customer Portal
  // -----------------------------
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

  // -----------------------------
  // Public attach
  // -----------------------------
  function attach(opts) {
    opts = opts || {};
    if (opts.ids) Object.assign(IDS, opts.ids);

    initPlans();

    const subBtn = $(IDS.subscribeBtn);
    if (subBtn) subBtn.onclick = subscribe;

    const m = $(IDS.manageBtn);
    if (m) m.onclick = openCustomerPortal;

    $(IDS.userId)?.addEventListener("input", scheduleRefreshStatus);
    $(IDS.userId)?.addEventListener("change", scheduleRefreshStatus);

    refreshSubscriptionStatus();
  }

  window.Subscription = {
    attach,
    initPlans,
    refreshSubscriptionStatus,
    subscribe,
    openCustomerPortal,
    // Expose for debugging (admin only usage)
    _debug: {
      API_BASE,
      getDrefCode,
      getRefLanding,
      PRICE_MAP,
      TRIAL_DAYS_BY_KEY,
      createCheckoutSession,
    },
  };
})();
