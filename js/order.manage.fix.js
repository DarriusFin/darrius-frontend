// js/order.manage.fix.js (AUTO-BIND BY BUTTON TEXT) v2026.02.01
(() => {
  'use strict';

  // -----------------------------
  // helpers
  // -----------------------------
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const lower = (s) => norm(s).toLowerCase();

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
  const jpost = (url, body) => fetchJSON(url, { method: 'POST', body: JSON.stringify(body || {}) });

  function enableBtn(btn, enabled) {
    if (!btn) return;
    btn.disabled = !enabled;
    btn.style.pointerEvents = enabled ? 'auto' : 'none';
    btn.style.opacity = enabled ? '1' : '0.55';
    btn.style.cursor = enabled ? 'pointer' : 'not-allowed';
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
  // find buttons by text
  // -----------------------------
  function findButtonByTextIncludes(needles) {
    const btns = Array.from(document.querySelectorAll('button'));
    for (const b of btns) {
      const t = lower(b.textContent);
      if (!t) continue;
      if (needles.some(n => t.includes(n))) return b;
    }
    return null;
  }

  function getButtons() {
    const portalBtn = findButtonByTextIncludes([
      'open billing portal', 'billing portal', '账单管理'
    ]);

    const subscribeBtn = findButtonByTextIncludes([
      'subscribe', '订阅'
    ]);

    const refreshBtn = findButtonByTextIncludes([
      'refresh status', '刷新状态', 'refresh'
    ]);

    return { portalBtn, subscribeBtn, refreshBtn };
  }

  // -----------------------------
  // render panel (fallback UI)
  // -----------------------------
  function ensurePanel() {
    let panel = document.getElementById('om_autoPanel');
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'om_autoPanel';
    panel.style.cssText = [
      'position:relative',
      'margin:12px 0',
      'padding:12px 14px',
      'border:1px solid rgba(255,255,255,0.12)',
      'border-radius:12px',
      'background:rgba(0,0,0,0.25)',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif',
      'font-size:13px',
      'line-height:1.35'
    ].join(';');

    panel.innerHTML = `
      <div style="font-weight:700; font-size:14px; margin-bottom:8px;">Order / Subscription Status</div>
      <div style="display:grid; grid-template-columns: 140px 1fr; gap:6px 10px;">
        <div style="opacity:.8;">User Email</div><div id="om_auto_email">-</div>
        <div style="opacity:.8;">Entitlement Plan</div><div id="om_auto_plan">-</div>
        <div style="opacity:.8;">Stripe Customer</div><div id="om_auto_cus">-</div>
        <div style="opacity:.8;">Stripe Subscription</div><div id="om_auto_sub">-</div>
        <div style="opacity:.8;">Stripe Status</div><div id="om_auto_status">-</div>
        <div style="opacity:.8;">Period End</div><div id="om_auto_cpe">-</div>
        <div style="opacity:.8;">Trial End</div><div id="om_auto_trial">-</div>
        <div style="opacity:.8;">Cancel At Period End</div><div id="om_auto_cancel">-</div>
      </div>
      <div id="om_auto_hint" style="margin-top:10px; opacity:.75;"></div>
    `;

    // insert near top of main content
    const target =
      document.querySelector('main') ||
      document.querySelector('#main') ||
      document.body;

    if (target.firstChild) target.insertBefore(panel, target.firstChild);
    else target.appendChild(panel);

    return panel;
  }

  function setPanelText(id, v) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = (v == null || v === '') ? '-' : String(v);
  }

  // -----------------------------
  // data load + render
  // -----------------------------
  async function loadAndRender() {
    const panel = ensurePanel();

    const [me, entResp, subResp] = await Promise.all([
      jget('/api/me'),
      jget('/api/me/entitlements'),
      jget('/api/subscription/status')
    ]);

    // me
    const email = pick(me, ['email', 'user_email'], pick(me.user || {}, ['email'], '-'));
    setPanelText('om_auto_email', email);

    // entitlement
    const ent = entResp.entitlement || entResp.data || entResp || {};
    const plan = pick(ent, ['plan', 'tier', 'product'], '-');
    const customerId = pick(ent, ['stripe_customer_id', 'customer_id'], '-');
    const subscriptionId = pick(ent, ['stripe_subscription_id', 'subscription_id'], '-');

    setPanelText('om_auto_plan', plan);
    setPanelText('om_auto_cus', customerId);
    setPanelText('om_auto_sub', subscriptionId);

    // subscription
    const s = subResp.subscription || subResp.data || subResp || {};
    const status = pick(s, ['status', 'subscription_status'], 'UNKNOWN');
    const cpe = pick(s, ['current_period_end', 'period_end'], null);
    const trialEnd = pick(s, ['trial_end'], null);
    const cancelAtPeriodEnd = !!pick(s, ['cancel_at_period_end'], false);

    setPanelText('om_auto_status', status);
    setPanelText('om_auto_cpe', tsToLocal(cpe));
    setPanelText('om_auto_trial', tsToLocal(trialEnd));
    setPanelText('om_auto_cancel', cancelAtPeriodEnd ? 'YES' : 'NO');

    // buttons: make sure clickable
    const { portalBtn, subscribeBtn, refreshBtn } = getButtons();
    if (portalBtn) enableBtn(portalBtn, true);
    if (subscribeBtn) enableBtn(subscribeBtn, true);
    if (refreshBtn) enableBtn(refreshBtn, true);

    // hint
    const hintEl = document.getElementById('om_auto_hint');
    if (hintEl) {
      const h = [];
      if (me && me.__http && !me.__http.ok) h.push(`me: HTTP ${me.__http.status}`);
      if (entResp && entResp.__http && !entResp.__http.ok) h.push(`entitlements: HTTP ${entResp.__http.status}`);
      if (subResp && subResp.__http && !subResp.__http.ok) h.push(`subscription: HTTP ${subResp.__http.status}`);
      hintEl.textContent = h.length ? `API hints: ${h.join(' | ')}` : '';
    }
  }

  // -----------------------------
  // bind actions
  // -----------------------------
  function bindActions() {
    const { portalBtn, refreshBtn } = getButtons();

    if (portalBtn && !portalBtn.__om_bound) {
      portalBtn.__om_bound = true;
      portalBtn.onclick = async () => {
        enableBtn(portalBtn, false);
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
          enableBtn(portalBtn, true);
        }
      };
    }

    if (refreshBtn && !refreshBtn.__om_bound) {
      refreshBtn.__om_bound = true;
      refreshBtn.onclick = async () => {
        enableBtn(refreshBtn, false);
        try {
          // optional sync first
          await jget('/api/subscription/refresh');
          await loadAndRender();
        } finally {
          enableBtn(refreshBtn, true);
        }
      };
    }
  }

  // -----------------------------
  // boot
  // -----------------------------
  window.addEventListener('DOMContentLoaded', () => {
    try {
      bindActions();
      loadAndRender().catch(() => {});
    } catch (_) {}
  });
})();
