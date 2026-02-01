// js/order.manage.fix.js
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  async function jget(url) {
    const r = await fetch(url, { credentials: 'include' });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { ok:false, raw:t, status:r.status }; }
  }
  async function jpost(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body || {})
    });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { ok:false, raw:t, status:r.status }; }
  }

  function setText(id, v) {
    const el = $(id);
    if (el) el.textContent = (v == null ? '' : String(v));
  }
  function enableBtn(id, enabled) {
    const b = $(id);
    if (!b) return;
    b.disabled = !enabled;
    b.style.pointerEvents = enabled ? 'auto' : 'none';
    b.style.opacity = enabled ? '1' : '0.55';
    b.style.cursor = enabled ? 'pointer' : 'not-allowed';
  }

  function pick(obj, keys, fallback = '') {
    for (const k of keys) {
      if (obj && obj[k] != null && obj[k] !== '') return obj[k];
    }
    return fallback;
  }

  async function loadEntitlements() {
    // ✅ 现有接口：/api/me/entitlements
    const ent = await jget('/api/me/entitlements');
    return ent || {};
  }

  async function loadSubStatus() {
    // ✅ 现有接口：/api/subscription/status
    const st = await jget('/api/subscription/status');
    return st || {};
  }

  async function refreshStripeSync() {
    // ✅ 现有接口：/api/subscription/refresh（如果你实现了刷新同步）
    // 这个接口是 GET（按你 routes 显示）
    return await jget('/api/subscription/refresh');
  }

  async function render() {
    // 1) entitlement
    const entResp = await loadEntitlements();

    // 这里字段名你项目可能不同，我做了容错 pick
    const ent = entResp.entitlement || entResp.data || entResp;
    const active = !!pick(ent, ['active', 'is_active', 'entitled'], false);
    const plan = pick(ent, ['plan', 'tier', 'product'], active ? 'ACTIVE' : 'DEMO');
    const customerId = pick(ent, ['stripe_customer_id', 'customer_id'], '');
    const subId = pick(ent, ['stripe_subscription_id', 'subscription_id'], '');

    setText('subLocalActive', active ? 'ACTIVE' : 'DEMO');
    setText('subLocalPlan', plan);
    setText('subStripeCustomer', customerId || '-');
    setText('subStripeSub', subId || '-');

    // 2) subscription status（可选：先 refresh 一次再读）
    // 如果你希望每次都对齐 Stripe，就打开下面两行
    // await refreshStripeSync();
    const subResp = await loadSubStatus();
    const s = subResp.subscription || subResp.data || subResp;

    const status = pick(s, ['status', 'subscription_status'], 'UNKNOWN');
    const cpe = pick(s, ['current_period_end', 'period_end'], null);
    const trialEnd = pick(s, ['trial_end'], null);
    const cancelAtPeriodEnd = !!pick(s, ['cancel_at_period_end'], false);

    setText('subStripeStatus', status);
    setText('subCancelAtPeriodEnd', cancelAtPeriodEnd ? 'YES' : 'NO');

    if (typeof cpe === 'number') setText('subCurrentPeriodEnd', new Date(cpe * 1000).toLocaleString());
    else setText('subCurrentPeriodEnd', cpe || '-');

    if (typeof trialEnd === 'number') setText('subTrialEnd', new Date(trialEnd * 1000).toLocaleString());
    else setText('subTrialEnd', trialEnd || '-');

    // 3) buttons
    enableBtn('btnBillingPortal', !!customerId);
    enableBtn('btnSubscribe', true); // 订阅按钮交给你现有 checkout 流程
  }

  function bind() {
    const portalBtn = $('btnBillingPortal');
    if (portalBtn) {
      portalBtn.onclick = async () => {
        enableBtn('btnBillingPortal', false);
        try {
          // ✅ 现有接口：POST /api/billing/portal
          const resp = await jpost('/api/billing/portal', { return_url: window.location.href });
          const url = resp.url || (resp.data && resp.data.url);
          if (url) window.location.href = url;
          else alert('Billing portal error: ' + (resp.error || resp.raw || 'unknown'));
        } finally {
          enableBtn('btnBillingPortal', true);
        }
      };
    }

    // 如果你有“刷新状态”按钮，也可以绑定到 /api/subscription/refresh
    const refreshBtn = $('btnRefreshSub');
    if (refreshBtn) {
      refreshBtn.onclick = async () => {
        enableBtn('btnRefreshSub', false);
        try {
          await refreshStripeSync();
          await render();
        } finally {
          enableBtn('btnRefreshSub', true);
        }
      };
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    bind();
    render().catch(() => {});
  });
})();
