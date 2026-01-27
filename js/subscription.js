/* =========================================================
 * DarriusAI · Subscription Module (Final)  ✅ FINAL CHECKED+
 * File: js/subscription.js
 * Purpose:
 *  - Load plans from backend: /api/plans (preferred)
 *  - Fallback: /billing/prices (legacy)
 *  - Fallback: local default plans
 *  - Create checkout: POST /billing/checkout
 *  - Subscription status UX: GET /api/subscription/status?user_id=
 *  - (Optional) Customer portal: POST /api/billing/portal
 *
 * Notes:
 *  - NO secrets on frontend
 *  - Safe defaults & graceful fallbacks
 *  - Does NOT change payment/subscription business logic
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
    accessBadge: "accessBadge", // ✅ new
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

   // =========================================================
  // Permission UX (Robust)  ✅ NO MORE FALSE "EXPIRED"
  // - Handles: active / trialing / checkout_created / canceled-with-access / past_due grace
  // - Renders badge #accessBadge if present
  // - Dispatches:
  //    1) darrius:subscription-status (detail: full payload)
  //    2) darrius:access (detail: access decision)
  // =========================================================
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
    // best-effort from backend
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

  /**
   * Robust access decision:
   * - has_access=true => ACTIVE/TRIAL
   * - canceled but period_end in future => ACTIVE (still valid)
   * - past_due/unpaid but period_end in future => GRACE (treat as active UX, but warn)
   * - checkout_created/incomplete => PENDING (NOT expired)
   * - else => EXPIRED/UNKNOWN
   */
  function decideAccess(data) {
    const status = normalizeStripeStatus(data?.status);
    const hasAccess = (typeof data?.has_access === "boolean") ? data.has_access : null;

    const periodEnd = pickPeriodEnd(data);
    const trialEnd = pickTrialEnd(data);

    // Treat "still within paid period" as access-on even if has_access is false (webhook delay / mapping delay).
    // This prevents false EXPIRED.
    const stillInPeriod = isFuture(periodEnd);

    // 1) Strong signal from backend
    if (hasAccess === true) {
      const bucket = (status === "trialing") ? "TRIAL" : "ACTIVE";
      return { bucket, access_on: true, status, has_access: hasAccess, periodEnd, trialEnd, reason: "has_access_true" };
    }

    // 2) Canceled but still in period => still active access UX
    if (status === "canceled" && stillInPeriod) {
      return { bucket: "ACTIVE", access_on: true, status, has_access: hasAccess, periodEnd, trialEnd, reason: "canceled_but_in_period" };
    }

    // 3) Trialing but backend didn't flip has_access yet (rare) => TRIAL
    if (status === "trialing") {
      const end = trialEnd || periodEnd;
      const on = isFuture(end) || hasAccess !== false; // optimistic
      return { bucket: "TRIAL", access_on: on, status, has_access: hasAccess, periodEnd, trialEnd, reason: "trialing" };
    }

    // 4) Past due / unpaid: if still in period => GRACE (show access-on but warn)
    if ((status === "past_due" || status === "unpaid") && stillInPeriod) {
      return { bucket: "GRACE", access_on: true, status, has_access: hasAccess, periodEnd, trialEnd, reason: "billing_grace" };
    }

    // 5) Checkout created / incomplete: pending activation (NOT expired)
    if (status === "checkout_created" || status === "incomplete" || status === "checkout_pending") {
      // If periodEnd exists & future => active; else pending
      if (stillInPeriod) return { bucket: "ACTIVE", access_on: true, status, has_access: hasAccess, periodEnd, trialEnd, reason: "checkout_created_but_in_period" };
      return { bucket: "PENDING", access_on: true, status, has_access: hasAccess, periodEnd, trialEnd, reason: "pending_activation" };
    }

    // 6) Active but has_access false (webhook delay) => treat as ACTIVE (but note)
    if (status === "active" && hasAccess === false) {
      if (stillInPeriod) return { bucket: "ACTIVE", access_on: true, status, has_access: hasAccess, periodEnd, trialEnd, reason: "active_but_access_flag_false_in_period" };
      return { bucket: "ACTIVE", access_on: false, status, has_access: hasAccess, periodEnd, trialEnd, reason: "active_but_access_flag_false" };
    }

    // 7) Explicit expired-like states
    if (status === "incomplete_expired" || status === "expired") {
      return { bucket: "EXPIRED", access_on: false, status, has_access: hasAccess, periodEnd, trialEnd, reason: "expired_state" };
    }

    // 8) If period ended and backend says no access => expired
    if (!stillInPeriod && hasAccess === false) {
      // includes canceled, unpaid, etc.
      return { bucket: "EXPIRED", access_on: false, status, has_access: hasAccess, periodEnd, trialEnd, reason: "no_access_and_not_in_period" };
    }

    // 9) Unknown fallback
    // If backend doesn't know, keep unknown but do NOT call it expired
    return { bucket: "UNKNOWN", access_on: (hasAccess === true), status, has_access: hasAccess, periodEnd, trialEnd, reason: "fallback_unknown" };
  }

  function setAccessBadge(bucket) {
    const el = document.getElementById("accessBadge");
    if (!el) return;

    const b = String(bucket || "UNKNOWN").toUpperCase();

    // show
    el.classList.remove("hidden");

    // remove prior bucket classes
    el.classList.remove("ACTIVE", "TRIAL", "PENDING", "GRACE", "EXPIRED", "UNKNOWN");
    el.classList.add(b);

    el.textContent = b;
  }

  function dispatchEvents(payload) {
    // 1) rich event
    try {
      window.dispatchEvent(new CustomEvent("darrius:subscription-status", { detail: payload }));
    } catch (_) {}

    // 2) access event (lightweight, for gating / UI)
    try {
      window.dispatchEvent(
        new CustomEvent("darrius:access", {
          detail: {
            user_id: payload.user_id,
            bucket: payload.bucket,
            access_on: payload.access_on,
            data_mode: payload.data_mode || null,
            status: payload.status,
            plan: payload.plan || null,
          },
        })
      );
    } catch (_) {}
  }

  function applySubUX(data, user_id) {
    const d = data || {};
    const status = normalizeStripeStatus(d.status);
    const planKey = d.plan || d.plan_key || d.current_plan || "";

    const decision = decideAccess(d);
    const bucket = decision.bucket;

    // Compose UX line
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
    } else {
      extra = "";
    }

    const planPart = planKey ? ` · ${planKey}` : "";
    const accessPart =
      (typeof decision.has_access === "boolean")
        ? (decision.has_access ? " · Access ON" : " · Access OFF")
        : "";

    const line = `${bucket}${planPart} · ${status}${accessPart}${extra}`;
    setSubStatusText(line);

    // Badge
    setAccessBadge(bucket);

    // Manage button behavior: enabled if user_id exists (keep your current rule)
    const manageBtn = $(IDS.manageBtn);
    if (manageBtn) {
      manageBtn.disabled = !user_id;
      manageBtn.textContent = "Manage · 管理";
    }

    // Expose to DOM datasets (optional for other modules)
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
      customer_portal: !!d.customer_portal,
      data_mode: d.data_mode || d.access_mode || null,
      reason: decision.reason,
      raw: d,
    };

    dispatchEvents(payload);

    if (isAdmin()) log(`✅ sub UX: ${line} (reason=${decision.reason})`);
  }

  // -------- Optional: subscription status --------
  async function refreshSubscriptionStatus() {
    const user_id = (($(IDS.userId) && $(IDS.userId).value) || "").trim();
    const manageBtn = $(IDS.manageBtn);

    // no user_id => unknown + hide badge + disable manage
    if (!user_id) {
      setSubStatusText("UNKNOWN · please input User ID");
      const badge = document.getElementById("accessBadge");
      if (badge) badge.classList.add("hidden");
      if (manageBtn) manageBtn.disabled = true;
      return;
    }

    // optimistic enable manage (your existing behavior)
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
      const badge = document.getElementById("accessBadge");
      if (badge) {
        badge.classList.remove("hidden");
        badge.classList.remove("ACTIVE", "TRIAL", "PENDING", "GRACE", "EXPIRED");
        badge.classList.add("UNKNOWN");
        badge.textContent = "UNKNOWN";
      }
      if (isAdmin()) log(`⚠️ status endpoint issue: ${e.message}`);
    }
  }

  function scheduleRefreshStatus() {
    window.clearTimeout(_subStatusTimer);
    _subStatusTimer = window.setTimeout(refreshSubscriptionStatus, 420);
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

  function mapAccessBucket(status, hasAccess) {
    // priority: has_access from backend
    if (hasAccess === true) {
      if (status === "trialing") return "TRIAL";
      return "ACTIVE";
    }
    if (hasAccess === false) {
      if (status === "trialing") return "EXPIRED";
      if (status === "active") return "PENDING";
      if (
        status === "canceled" ||
        status === "unpaid" ||
        status === "past_due" ||
        status === "incomplete_expired" ||
        status === "expired"
      ) return "EXPIRED";
      return "EXPIRED";
    }
    // unknown has_access
    if (status === "trialing") return "TRIAL";
    if (status === "active") return "ACTIVE";
    if (
      status === "canceled" ||
      status === "unpaid" ||
      status === "past_due" ||
      status === "incomplete_expired" ||
      status === "expired"
    ) return "EXPIRED";
    if (status === "incomplete" || status === "checkout_created") return "PENDING";
    return "UNKNOWN";
  }

  // ✅ Badge renderer (reads #accessBadge)
  function setAccessBadge(bucket) {
    const el = $(IDS.accessBadge);
    if (!el) return; // if page doesn't have it, silently ignore

    const b = String(bucket || "UNKNOWN").toUpperCase();

    // ensure visible
    el.classList.remove("hidden");

    // reset state classes
    el.classList.remove("ACTIVE", "TRIAL", "EXPIRED", "PENDING", "UNKNOWN");
    el.classList.add(b);

    // set text
    el.textContent = b;
  }

  // ✅ dispatch both events
  function dispatchAccessEvents(payload) {
    try {
      window.dispatchEvent(new CustomEvent("darrius:subscription-status", { detail: payload }));
    } catch (_) {}

    // you asked for this name:
    try {
      window.dispatchEvent(new CustomEvent("darrius:access", { detail: payload }));
    } catch (_) {}
  }

  function applySubUX(data, user_id) {
    const status = normalizeStripeStatus(data?.status);
    const hasAccess = data?.has_access;
    const bucket = mapAccessBucket(status, hasAccess);

    // ✅ update badge
    setAccessBadge(bucket);

    // Optional fields that backend MAY provide
    const planKey = data?.plan || data?.plan_key || data?.current_plan || "";
    const trialEnd = toDateObj(data?.trial_end || data?.trial_ends_at);
    const periodEnd = toDateObj(data?.current_period_end || data?.ends_at || data?.access_end);

    // Compose UX text
    let extra = "";
    if (bucket === "TRIAL") {
      const end = trialEnd || periodEnd;
      if (end) extra = ` · ends ${fmtYMD(end)} (${fmtRemain(end)})`;
      else extra = " · trial";
    } else if (bucket === "ACTIVE") {
      if (periodEnd) extra = ` · renews ${fmtYMD(periodEnd)} (${fmtRemain(periodEnd)})`;
      else extra = " · access on";
    } else if (bucket === "EXPIRED") {
      if (periodEnd) extra = ` · ended ${fmtYMD(periodEnd)}`;
      else extra = " · access off";
    } else if (bucket === "PENDING") {
      extra = " · pending confirmation";
    } else {
      extra = "";
    }

    const planPart = planKey ? ` · ${planKey}` : "";
    const hasPart = typeof hasAccess === "boolean" ? (hasAccess ? " · Access ON" : " · Access OFF") : "";
    const line = `${bucket}${planPart} · ${status}${hasPart}${extra}`;

    setSubStatusText(line);

    // Keep Manage behavior: if user_id exists, allow Manage (account.html / portal entry)
    const manageBtn = $(IDS.manageBtn);
    if (manageBtn) {
      manageBtn.disabled = !user_id;
      manageBtn.textContent = "Manage · 管理";
    }

    // Optional: expose to other modules
    try {
      document.body.dataset.subBucket = bucket;
      document.body.dataset.subStatus = status;
      document.body.dataset.subAccess = String(!!hasAccess);
    } catch (_) {}

    const payload = {
      user_id,
      bucket,
      status,
      has_access: hasAccess,
      plan: planKey,
      trial_end: trialEnd ? trialEnd.toISOString() : null,
      period_end: periodEnd ? periodEnd.toISOString() : null,
      raw: data || null,
    };

    // ✅ events
    dispatchAccessEvents(payload);

    if (isAdmin()) log(`✅ sub UX: ${line}`);
  }

  // -------- Optional: subscription status --------
  async function refreshSubscriptionStatus() {
    const user_id = (($(IDS.userId) && $(IDS.userId).value) || "").trim();
    const manageBtn = $(IDS.manageBtn);

    // 1) 没 user_id：Unknown + 禁用 Manage + ✅ show badge UNKNOWN
    if (!user_id) {
      setSubStatusText("UNKNOWN · please input User ID");
      setAccessBadge("UNKNOWN");
      if (manageBtn) manageBtn.disabled = true;

      // still dispatch so other modules can react
      dispatchAccessEvents({
        user_id: "",
        bucket: "UNKNOWN",
        status: "unknown",
        has_access: undefined,
        plan: "",
        trial_end: null,
        period_end: null,
        raw: null,
      });
      return;
    }

    // 2) 有 user_id：先“乐观启用” Manage（你主页会跳 account.html；这里不阻断）
    if (manageBtn) {
      manageBtn.disabled = false;
      manageBtn.textContent = "Manage · 管理";
    }
    setSubStatusText("CHECKING...");
    setAccessBadge("PENDING");

    // 3) 再拉 status（失败也不影响 Manage）
    try {
      const data = await apiGet(`/api/subscription/status?user_id=${encodeURIComponent(user_id)}`);
      applySubUX(data, user_id);
    } catch (e) {
      setSubStatusText("UNKNOWN · status endpoint unavailable");
      setAccessBadge("UNKNOWN");
      if (isAdmin()) log(`⚠️ status endpoint issue: ${e.message}`);

      dispatchAccessEvents({
        user_id,
        bucket: "UNKNOWN",
        status: "unknown",
        has_access: undefined,
        plan: "",
        trial_end: null,
        period_end: null,
        raw: { error: e.message },
      });
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
      // 默认：绑定 portal（主页通常会被 boot.js 改写成跳 account.html）
      m.onclick = openCustomerPortal;
    }

    // userId typing triggers status refresh (non-blocking)
    $(IDS.userId)?.addEventListener("input", scheduleRefreshStatus);
    $(IDS.userId)?.addEventListener("change", scheduleRefreshStatus);

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
