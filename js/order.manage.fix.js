// js/order.manage.fix.js  (FULL REPLACEMENT) v2026-02-01
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // -----------------------------
  // helpers
  // -----------------------------
  function normText(s) {
    return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function pick(obj, keys, fallback = null) {
    for (const k of keys) {
      if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    }
    return fallback;
  }

  function setTextAny(ids, v) {
    const val = (v == null || v === '') ? '-' : String(v);
    for (const id of ids) {
      const el = $(id);
      if (el) el.textContent = val;
    }
  }

  function enableBtnAny(ids, enabled) {
    for (const id of ids) {
      const b = $(id);
      if (!b) continue;
      b.disabled = !enabled;
      b.style.pointerEvents = enabled ? 'auto' : 'none';
      b.style.opacity = enabled ? '1' : '0.55';
      b.style.cursor = enabled ? 'pointer' : 'not-allowed';
    }
  }

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
    data.__http = { ok: r.ok, status: r.status, url };
    return data;
  }

  async function tryPOST(urls, bodyObj) {
    for (const url of urls) {
      const resp = await fetchJSON(url, { method: 'POST', body: JSON.stringify(bodyObj || {}) });
      // “有些后端不带 ok”，但只要给了 url 就算成功
      const gotUrl = resp && (resp.url || (resp.data && resp.data.url) || (resp.portal && resp.portal.url));
      if (gotUrl) return { ok: true, url: gotUrl, resp };
      // 401/403 直接返回（避免重复打）
      if (resp.__http && (resp.__http.status === 401 || resp.__http.status === 403)) return { ok: false, resp };
      // 其他情况继续试下一个 endpoint
    }
    return { ok: false, resp: null };
  }

  // -----------------------------
  // Step A: patch missing button IDs by text
  // -----------------------------
  function patchButtonIds() {
    const btns = Array.from(document.querySelectorAll('button'));
    if (!btns.length) return;

    const want = [
      {
        id: 'btnBillingPortal',
        any: ['open billing portal', 'billing portal', '账单管理', '账单', 'billing'],
      },
      {
        id: 'btnSubscribe',
        any: ['subscribe', '订阅', '购买', '开通'],
      },
      {
        id: 'btnRefreshSub',
        any: ['refresh status', 'refresh', '刷新状态', '刷新'],
      },
    ];

    for (const rule of want) {
      if ($(rule.id)) continue; // already exists
      const hit = btns.find(b => {
        const t = normText(b.textContent);
        return rule.any.some(k => t.includes(normText(k)));
      });
      if (hit) hit.id = rule.id;
    }
  }

  // -----------------------------
  // Step B: load + render status (兼容你两套字段)
  // -----------------------------
  async function loadAllAndRender() {
    // 你 routes 里有 /api/me、/api/me/entitlements、/api/subscription/status
    const me = await fetchJSON('/api/me');
    const entResp = await fetchJSON('/api/me/entitlements');
    const subResp = await fetchJSON('/api/subscription/status');

    // ---- me email ----
    const email = pick(me, ['email', 'user_email'], pick(me.user || {}, ['email'], '-'));
    setTextAny(['om_userEmail', 'subUserEmail', 'userEmail', 'accountEmail'], email);

    // ---- entitlements ----
    const ent = entResp.entitlement || entResp.data || entResp || {};
    const plan = pick(ent, ['plan', 'tier', 'product'], '-');
    const active = !!pick(ent, ['active', 'is_active', 'entitled'], null);
    const customerId = pick(ent, ['stripe_customer_id', 'customer_id'], '-');
    const subscriptionId = pick(ent, ['stripe_subscription_id', 'subscription_id'], '-');

    // 兼容两套 DOM id
    setTextAny(['om_plan', 'subLocalPlan', 'currentPlan'], plan);
    setTextAny(['om_customerId', 'subStripeCustomer'], customerId);
    setTextAny(['om_subscriptionId', 'subStripeSub'], subscriptionId);
    if (active !== null) setTextAny(['subLocalActive'], active ? 'ACTIVE' : 'DEMO');

    // ---- subscription status ----
    const s = subResp.subscription || subResp.data || subResp || {};
    const status = pick(s, ['status', 'subscription_status'], 'UNKNOWN');
    const cpe = pick(s, ['current_period_end', 'period_end'], null);
    const trialEnd = pick(s, ['trial_end'], null);
    const cancelAtPeriodEnd = !!pick(s, ['cancel_at_period_end'], false);

    const tsToLocal = (ts) => (typeof ts === 'number') ? new Date(ts * 1000).toLocaleString() : (ts || '-');

    setTextAny(['om_subStatus', 'subStripeStatus', 'subscriptionStatus'], status);
    setTextAny(['om_periodEnd', 'subCurrentPeriodEnd', 'currentPeriodEnd'], tsToLocal(cpe));
    setTextAny(['om_trialEnd', 'subTrialEnd', 'trialEnd'], tsToLocal(trialEnd));
    setTextAny(['subCancelAtPeriodEnd'], cancelAtPeriodEnd ? 'YES' : 'NO');

    // ---- buttons enable ----
    // Portal：宁可先放开（后端会 401/403），避免“看起来死了”
    enableBtnAny(['btnBillingPortal'], true);
    // Subscribe：永远可点（跳 checkout）
    enableBtnAny(['btnSubscribe'], true);
    // Refresh：可选
    enableBtnAny(['btnRefreshSub'], true);
  }

  // -----------------------------
  // Step C: bind actions
  // -----------------------------
  function bindActions() {
    // Billing Portal
    const portalBtn = $('btnBillingPortal');
    if (portalBtn) {
      portalBtn.onclick = async () => {
        enableBtnAny(['btnBillingPortal'], false);
        try {
          // 你的 routes 里同时出现了 /api/billing/portal 和 /billing/portal
          const res = await tryPOST(
            ['/api/billing/portal', '/billing/portal'],
            { return_url: window.location.href }
          );

          if (res.ok && res.url) {
            window.location.href = res.url;
            return;
          }

          const st = res.resp && res.resp.__http ? res.resp.__http.status : null;
          if (st === 401 || st === 403) {
            alert('Please sign in again, then retry Billing Portal.');
            return;
          }

          const detail = (res.resp && (res.resp.error || res.resp.detail || res.resp.raw)) || 'unknown';
          alert('Billing portal error: ' + detail);
        } finally {
          enableBtnAny(['btnBillingPortal'], true);
        }
      };
    }

    // Subscribe（走你现有后端 checkout / create-checkout-session）
    const subBtn = $('btnSubscribe');
    if (subBtn) {
      subBtn.onclick = async () => {
        enableBtnAny(['btnSubscribe'], false);
        try {
          // 你页面上每个 plan 的按钮应该已有逻辑；
          // 这里做“兜底”：如果按钮上带 data-price-id，我们就直接拉 Stripe Checkout。
          const priceId = subBtn.getAttribute('data-price-id') || '';

          // 优先新接口 /billing/create-checkout-session（你刚贴出来的就是它）
          // 兼容旧接口 /billing/checkout
          const resp1 = await fetchJSON('/billing/create-checkout-session', {
            method: 'POST',
            body: JSON.stringify({ price_id: priceId || undefined })
          });
          const url1 = resp1.url || (resp1.data && resp1.data.url);
          if (url1) { window.location.href = url1; return; }

          const resp2 = await fetchJSON('/billing/checkout', {
            method: 'POST',
            body: JSON.stringify({ price_id: priceId || undefined })
          });
          const url2 = resp2.url || (resp2.data && resp2.data.url);
          if (url2) { window.location.href = url2; return; }

          alert('Checkout not ready: backend did not return {url}. Please check /billing/create-checkout-session or /billing/checkout response.');
        } finally {
          enableBtnAny(['btnSubscribe'], true);
        }
      };
    }

    // Refresh (optional)
    const refreshBtn = $('btnRefreshSub');
    if (refreshBtn) {
      refreshBtn.onclick = async () => {
        enableBtnAny(['btnRefreshSub'], false);
        try {
          await fetchJSON('/api/subscription/refresh'); // routes 里是 GET
          await loadAllAndRender();
        } finally {
          enableBtnAny(['btnRefreshSub'], true);
        }
      };
    }
  }

  // -----------------------------
  // bootstrap
  // -----------------------------
  window.addEventListener('DOMContentLoaded', () => {
    patchButtonIds();     // ✅ 关键：先补 id
    bindActions();        // ✅ 再绑定
    loadAllAndRender().catch(() => {});
  });
})();
