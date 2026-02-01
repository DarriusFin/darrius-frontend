// js/order.manage.fix.js (UNIFIED - FULL REPLACE) v2026.02.01
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // -----------------------------
  // fetch helpers (GET/POST JSON)
  // -----------------------------
  async function fetchJSON(url, opts = {}) {
    const r = await fetch(url, {
      credentials: 'include',
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });

    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { ok: false, raw: text }; }

    data.__http = { ok: r.ok, status: r.status };
    return data;
  }

  const jget = (url) => fetchJSON(url, { method: 'GET' });
  const jpost = (url, body) => fetchJSON(url, {
    method: 'POST',
    body: JSON.stringify(body || {})
  });

  // -----------------------------
  // dom helpers
  // -----------------------------
  function setText(id, v, dash = true) {
    const el = $(id);
    if (!el) return;
    const val = (v == null || v === '') ? (dash ? '-' : '') : String(v);
    el.textContent = val;
  }

  function enableBtn(id, enabled) {
    const b = $(id);
    if (!b) return;
    b.disabled = !enabled;
    b.style.pointerEvents = enabled ? 'auto' : 'none';
    b.style.opacity = enabled ? '1' : '0.55';
    b.style.cursor = enabled ? 'pointer' : 'not-allowed';
  }

  function pick(obj, keys, fallback = null) {
    for (const k of keys) {
      if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    }
    return fallback;
  }

  function tsToLocal(ts) {
    if (typeof ts === 'number') return new Date(ts * 1000).toLocaleString();
    return ts || '-';
  }

  // -----------------------------
  // API loaders (your real routes)
  // -----------------------------
  async function loadMe() {
    // /api/me exists now
    const me = await jget('/api/me');
    return me || {};
  }

  async function loadEntitlements() {
    // /api/me/entitlements
    const ent = await jget('/api/me/entitlements');
    return ent || {};
  }

  async function loadSubStatus() {
    // /api/subscription/status
    const st = await jget('/api/subscription/status');
    return st || {};
  }

  async function refreshStripeSync() {
    // /api/subscription/refresh (GET) - optional
    const r = await jget('/api/subscription/refresh');
    return r || {};
  }

  // -----------------------------
  // unified render (supports both UI-id schemas)
  // -----------------------------
  async function renderAll() {
    // 1) me
    const me = await loadMe();
    const email = pick(me, ['email', 'user_email'], pick(me.user || {}, ['email'], '-'));
    // schema B
    setText('om_userEmail', email);
    // (如果你旧 UI 没这个字段，就跳过)

    // 2) entitlement
    const entResp = await loadEntitlements();
    const ent = entResp.entitlement || entResp.data || entResp || {};

    const active = !!pick(ent, ['active', 'is_active', 'entitled'], false);
    const plan = pick(ent, ['plan', 'tier', 'product'], active ? 'ACTIVE' : 'DEMO');
    const customerId = pick(ent, ['stripe_customer_id', 'customer_id'], '');
    const subId = pick(ent, ['stripe_subscription_id', 'subscription_id'], '');

    // old schema ids (your existing)
    setText('subLocalActive', active ? 'ACTIVE' : 'DEMO', false);
    setText('subLocalPlan', plan, false);
    setText('subStripeCustomer', customerId || '-', true);
    setText('subStripeSub', subId || '-', true);

    // new schema ids (patch schema)
    setText('om_plan', plan);
    setText('om_customerId', customerId || '-');
    setText('om_subscriptionId', subId || '-');

    // 3) subscription status
    const subResp = await loadSubStatus();
    const s = subResp.subscription || subResp.data || subResp || {};

    const status = pick(s, ['status', 'subscription_status'], 'UNKNOWN');
    const cpe = pick(s, ['current_period_end', 'period_end'], null);
    const trialEnd = pick(s, ['trial_end'], null);
    const cancelAtPeriodEnd = !!pick(s, ['cancel_at_period_end'], false);

    // old schema ids
    setText('subStripeStatus', status);
    setText('subCancelAtPeriodEnd', cancelAtPeriodEnd ? 'YES' : 'NO');
    setText('subCurrentPeriodEnd', tsToLocal(cpe));
    setText('subTrialEnd', tsToLocal(trialEnd));

    // new schema ids
    setText('om_subStatus', status);
    setText('om_periodEnd', tsToLocal(cpe));
    setText('om_trialEnd', tsToLocal(trialEnd));

    // 4) buttons
    // Billing Portal：你旧逻辑是 “有 customerId 才开放”，这个很合理，保留
    enableBtn('btnBillingPortal', !!customerId);

    // Subscribe：永远不要灰（跳转由你原 checkout 流程负责）
    enableBtn('btnSubscribe', true);

    // Refresh（如果存在）
    enableBtn('btnRefreshSub', true);
  }

  // -----------------------------
  // bindings
  // -----------------------------
  function bindAll() {
    // Billing Portal
    const portalBtn = $('btnBillingPortal');
    if (portalBtn) {
      portalBtn.onclick = async () => {
        enableBtn('btnBillingPortal', false);
        try {
          const resp = await jpost('/api/billing/portal', { return_url: window.location.href });
          const url = resp.url || (resp.data && resp.data.url) || (resp.portal && resp.portal.url);

          if (url) {
            window.location.href = url;
            return;
          }

          if (resp.__http && (resp.__http.status === 401 || resp.__http.status === 403)) {
            alert('Please sign in again, then retry Billing Portal.');
            return;
          }

          alert('Billing portal error: ' + (resp.error || resp.detail || resp.raw || 'unknown'));
        } finally {
          // 注意：这里不要强行 enable=true；应该按 entitlement 再决定
          await renderAll().catch(() => {});
        }
      };
    }

    // Refresh status
    const refreshBtn = $('btnRefreshSub');
    if (refreshBtn) {
      refreshBtn.onclick = async () => {
        enableBtn('btnRefreshSub', false);
        try {
          await refreshStripeSync();
          await renderAll();
        } finally {
          enableBtn('btnRefreshSub', true);
        }
      };
    }

    // Subscribe：这里不改 onclick（你已有 checkout），只确保它别被灰
    const subBtn = $('btnSubscribe');
    if (subBtn) enableBtn('btnSubscribe', true);
  }

  // -----------------------------
  // boot
  // -----------------------------
  window.addEventListener('DOMContentLoaded', () => {
    bindAll();
    renderAll().catch(() => {});
  });
})();
