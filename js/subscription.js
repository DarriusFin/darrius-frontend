/* =========================================================
 * DarriusAI · Subscription Module (FINAL - Industrial)
 * File: js/subscription.js
 *
 * Updated v2026.01.31 (Email required + DataLabel UX + Portal by email)
 * - Status: GET /api/subscription/me (session authenticated)
 * - Portal: POST /api/billing/portal (session authenticated)
 * - Checkout: POST /api/billing/checkout (hybrid guest/session auth)
 *
 * Guarantees:
 *  - NO secrets on frontend
 *  - Safe defaults & graceful fallbacks
 *  - Does NOT change your Stripe products/prices
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
  const API_BASE = (window.__API_BASE__ || window.API_BASE || "").trim() || "https://darrius-api.onrender.com";

  // -----------------------------
  // DOM ids (match your current UI)
  // ⚠️ 如果你挂在 account.html 上，需要确保这些 id 存在
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

    // Optional (if your page has a top pill text)
    accessPillText: "txtAccess",
    accessPillDot: "dotAccess",
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
    const resp = await fetch(url, {
      method: "GET",
      credentials: "include",
    });

    const txt = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 260)}`);

    const j = safeJsonParse(txt);
    return j !== null ? j : txt;
  }

  async function apiPost(path, payload) {
    const url = `${API_BASE}${path}`;
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });

    const txt = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 260)}`);

    const j = safeJsonParse(txt);
    return j !== null ? j : { raw: txt };
  }

  function normEmail(v) {
    return String(v || "").trim().toLowerCase();
  }

  // -----------------------------
  // Referral helper (dref_code)
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
    weekly:    "price_1SpJMmR84UMUVSTg0T7xfm6r",
    monthly:   "price_1SpbvRR84UMUVSTggbg0SFzi",
    quarterly: "price_1SpbwYR84UMUVSTgMQpUrE42",
    yearly:    "price_1SpbpxR84UMUVSTgapaJDjMX",
  };

  const TRIAL_DAYS_BY_KEY = {
    weekly: 0,
    monthly: 1,
    quarterly: 3,
    yearly: 5,
  };

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

    setPlanStatusText(`${PLANS.length} Plans Available`);
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
      setPlanStatusText("Loading plans...");
      const plans = await loadPlansPreferred();
      populatePlans(plans);
      setStatusBadge("API OK", true);
      log(`✅ plans: loaded from /api/plans (${plans.length})`);
      return;
    } catch (e1) {
      try {
        const plans = await loadPlansLegacy();
        populatePlans(plans);
        setPlanStatusText(`${plans.length} Plans Available`);
        log(`⚠️ plans: loaded from /billing/prices fallback (${plans.length})`);
        return;
      } catch (e2) {
        const fallback = getLocalFallbackPlans();
        populatePlans(fallback);
        setPlanStatusText("Plans Available");
        setStatusBadge("API Degraded", false);
        if (isAdmin()) log(`❌ initPlans failed: ${e1.message} / ${e2.message} -> local fallback`);
      }
    }
  }

  // =========================================================
  // ✅ Unified Checkout Session Creator (TOP-LEVEL FUNCTION)
  // =========================================================
  async function createCheckoutSession(payload) {
    const body = Object.assign({}, payload || {});

    if (body.user_id) body.user_id = String(body.user_id).trim();
    if (body.email) body.email = normEmail(body.email);
    if (body.price_id) body.price_id = String(body.price_id).trim();
    if (body.dref_code) body.dref_code = String(body.dref_code).trim().slice(0, 64);
    if (body.ref_landing) body.ref_landing = String(body.ref_landing).trim().slice(0, 256);
    if (body.plan) body.plan = String(body.plan).trim().slice(0, 24);

    setStatusBadge("Creating checkout…", true);
    if (isAdmin()) log(
      `➡️ [${nowISOTime()}] POST /api/billing/checkout ${JSON.stringify(body)}`
    );

    const resp = await fetch(`${API_BASE}/api/billing/checkout`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const txt = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 260)}`);

    const data = safeJsonParse(txt) || { raw: txt };
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
  // Hybrid checkout: guest identity or authenticated session
  // -----------------------------
  async function subscribe() {
    const signedIn = !!window.__AUTH_USER_ID__;

    const user_id = (
      (($(IDS.userId) && $(IDS.userId).value) || "")
    ).trim();

    const email = normEmail(
      (($(IDS.email) && $(IDS.email).value) || "")
    );

    const planKey = (
      (($(IDS.planSelect) && $(IDS.planSelect).value) || "")
    ).trim();

    const override = (
      (($(IDS.priceOverride) && $(IDS.priceOverride).value) || "")
    ).trim();

    // Guest checkout requires a new User ID + Email.
    // Signed-in checkout gets identity from the server session.
    if (!signedIn) {
      if (!user_id) {
        alert(
          "User ID is required to create your account."
        );
        $(IDS.userId)?.focus?.();
        return;
      }

      if (!email) {
        alert(
          "Email is required to create your account."
        );
        $(IDS.email)?.focus?.();
        return;
      }
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
      if (!price_id) price_id = PRICE_MAP[String(planKey || "").toLowerCase()] || "";
    }

    if (!price_id) {
      alert("Price ID was not found. Please refresh the page or contact support.");
      return;
    }

    const dref_code = getDrefCode();
    const ref_landing = getRefLanding();

    const payload = {
      price_id,
      ref_landing,
      plan: pickedPlanKey || "",
    };

    if (!signedIn) {
      payload.user_id = user_id;
      payload.email = email;
    }

    if (dref_code) payload.dref_code = dref_code;

    try {
      await createCheckoutSession(payload);
    } catch (e) {
      setStatusBadge("Network/API error", false);
      if (isAdmin()) log(`❌ subscribe failed: ${e.message}`);
      alert(
        "Subscription failed due to a network or server error.\n\n" +
        "Error:\n" +
        e.message
      );
    }
  }

  // -----------------------------
  // ✅ Status UX (prefer backend policy fields)
  // - Prefer query by email (more stable)
  // - Use data_label_en/zh for access display (no MFV)
  // -----------------------------
  function setAccessBadgeTextFromPolicy(policy) {
    // Backend returns: data_label_en / data_label_zh, bucket, has_access
    const en = String(policy?.data_label_en || "").trim();
    const zh = String(policy?.data_label_zh || "").trim();
    const bucket = String(policy?.bucket || "").toUpperCase().trim();
    const has = !!policy?.has_access;

    const txt = en || zh ? `${en}${zh ? " / " + zh : ""}` : `Access: ${bucket || (has ? "ACTIVE" : "DEMO")}`;
    const pill = $(IDS.accessPillText);
    if (pill) pill.textContent = txt;

    const dot = $(IDS.accessPillDot);
    if (dot) {
      dot.classList.remove("good", "bad");
      if (has) dot.classList.add("good");
      else dot.classList.add("bad");
    }
  }

  function applyPolicyToStatusText(policy, user_id, email) {
    const bucket = String(policy?.bucket || "DEMO").toUpperCase();
    const plan = String(policy?.plan_key || "").trim();
    const cpe = policy?.current_period_end ? String(policy.current_period_end) : "";

    let text = "";

    if (bucket === "ACTIVE") {
      text =
        plan && plan.toLowerCase() !== "unknown"
          ? `Active Plan: ${plan}`
          : "Active Subscription";
    } else if (bucket === "TRIAL") {
      text = "Trial Access";
    } else if (bucket === "PENDING") {
      text = "Subscription Pending";
    } else if (bucket === "GRACE") {
      text = "Payment Issue — Access Temporarily Available";
    } else if (bucket === "EXPIRED") {
      text = "Subscription Expired";
    } else {
      text = "No Active Subscription";
    }

    if (cpe && ["ACTIVE", "TRIAL", "GRACE"].includes(bucket)) {
      try {
        const d = new Date(cpe);
        if (!isNaN(d.getTime())) {
          text += ` · Ends ${d.toISOString().slice(0, 10)}`;
        }
      } catch (_) {}
    }

    setSubStatusText(text);

    const b = $(IDS.accessBadge);
    if (b) {
      b.textContent = bucket;
      b.classList.remove(
        "ACTIVE",
        "TRIAL",
        "PENDING",
        "GRACE",
        "EXPIRED",
        "UNKNOWN"
      );
      b.classList.add(bucket);
    }

    setAccessBadgeTextFromPolicy(policy);
  }

  async function refreshSubscriptionStatus() {
    const user_id =
      (($(IDS.userId) && $(IDS.userId).value) || "").trim();

    const email =
      normEmail((($(IDS.email) && $(IDS.email).value) || ""));

    const manageBtn = $(IDS.manageBtn);

    try {
      let policy = null;

      // Signed-in users: subscription identity comes from server session.
      if (window.__AUTH_USER_ID__) {
        setSubStatusText("CHECKING...");

        policy = await apiGet("/api/subscription/me");
      } else {
        // No authenticated session: never resolve access from form fields.
        window.__ENTITLEMENT__ = null;

        setSubStatusText(
          "Sign in to check your subscription"
        );

        if (manageBtn) {
          manageBtn.disabled = true;
        }

        return;
      }

      window.__ENTITLEMENT__ = policy;

      if (manageBtn) {
        manageBtn.disabled = !policy?.has_access;
      }

      applyPolicyToStatusText(
        policy,
        policy?.user_id || user_id,
        email
      );

      try {
        window.dispatchEvent(
          new CustomEvent(
            "darrius:subscription-status",
            { detail: policy }
          )
        );
      } catch (_) {}

      if (isAdmin()) {
        log(
          `✅ policy: ${JSON.stringify({
            bucket: policy?.bucket,
            has_access: policy?.has_access,
            plan_key: policy?.plan_key,
            data_mode: policy?.data_mode,
            lookup: policy?.lookup,
          })}`
        );
      }
    } catch (e) {
      window.__ENTITLEMENT__ = null;

      setSubStatusText(
        "Unable to load subscription status"
      );

      if (manageBtn) {
        manageBtn.disabled = true;
      }

      if (isAdmin()) {
        log(`⚠️ status endpoint issue: ${e.message}`);
      }
    }
  }

  function scheduleRefreshStatus() {
    window.clearTimeout(_subStatusTimer);
    _subStatusTimer = window.setTimeout(refreshSubscriptionStatus, 420);
  }

  // -----------------------------
  // Customer Portal (session authenticated)
  // -----------------------------
  async function openCustomerPortal() {
    try {
      const data = await apiPost(
        "/api/billing/portal",
        {}
      );

      if (!data || !data.url) {
        throw new Error("No portal url");
      }

      window.location.href = data.url;
    } catch (e) {
      const msg = String(e?.message || "");

      if (msg.includes('"authentication_required"')) {
        alert("Please sign in before managing your subscription.");
      } else if (msg.includes('"subscription_not_found"')) {
        alert("No active subscription was found for this account.");
      } else if (msg.includes('"no_stripe_customer_for_user"')) {
        alert("Billing management is not available for this account yet.");
      } else {
        alert(
          "Subscription management is temporarily unavailable. Please try again later."
        );
      }

      if (isAdmin()) {
        log(`❌ open portal: ${msg}`);
      }
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

    // refresh on input
    $(IDS.userId)?.addEventListener("input", scheduleRefreshStatus);
    $(IDS.userId)?.addEventListener("change", scheduleRefreshStatus);
    $(IDS.email)?.addEventListener("input", scheduleRefreshStatus);
    $(IDS.email)?.addEventListener("change", scheduleRefreshStatus);

    // AccountAuth fires this after /api/auth/session confirms the user.
    window.addEventListener(
      "darrius:auth-changed",
      () => {
        refreshSubscriptionStatus();
      }
    );

    refreshSubscriptionStatus();
  }

  window.Subscription = {
    attach,
    initPlans,
    refreshSubscriptionStatus,
    subscribe,
    openCustomerPortal,
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
