/* account.page.js (v2 - backend-aligned with your app.py)
 * - Uses existing endpoints in your app.py:
 *   GET  /api/plans
 *   GET  /api/subscription/status?user_id=...
 *   POST /billing/checkout              { user_id, email?, plan }
 *   POST /api/billing/portal            { user_id, return_url? }
 *
 * - No /api/me required (since backend is user_id-driven right now)
 * - Stores user_id/email in localStorage
 * - UI-only: does NOT modify payment/subscription logic
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function safe(fn) { try { return fn(); } catch { return null; } }

  async function fetchJSON(url, opts = {}) {
    const r = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await r.json().catch(() => null) : await r.text().catch(() => null);
    if (!r.ok) {
      const msg = (data && data.error) ? data.error : `HTTP ${r.status}`;
      const e = new Error(msg);
      e.status = r.status;
      e.data = data;
      throw e;
    }
    return data;
  }

  // -------------------------
  // localStorage identity
  // -------------------------
  const LS_UID = 'darrius_user_id';
  const LS_EMAIL = 'darrius_email';

  function getUID() { return (localStorage.getItem(LS_UID) || '').trim(); }
  function getEmail() { return (localStorage.getItem(LS_EMAIL) || '').trim(); }

  function setUID(uid) { localStorage.setItem(LS_UID, (uid || '').trim()); }
  function setEmail(email) { localStorage.setItem(LS_EMAIL, (email || '').trim()); }

  // -------------------------
  // DOM helpers
  // -------------------------
  function setText(id, v) {
    const el = $(id);
    if (!el) return;
    el.textContent = (v === undefined || v === null || v === '') ? '—' : String(v);
  }

  function setDot(dotId, mode) {
    const el = $(dotId);
    if (!el) return;
    el.classList.remove('good', 'bad');
    if (mode === 'good') el.classList.add('good');
    else if (mode === 'bad') el.classList.add('bad');
  }

  function setBadge(id, kind, text) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('good','warn','bad');
    if (kind === 'good') el.classList.add('good');
    else if (kind === 'bad') el.classList.add('bad');
    else el.classList.add('warn');
    el.textContent = text || '—';
  }

  function isoToLocal(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  }

  function highlightPlan(planKey) {
    ['weekly','monthly','quarterly','yearly'].forEach(k => {
      const card = $(`plan_${k}`);
      if (!card) return;
      card.classList.toggle('active', planKey === k);
    });
  }

  // -------------------------
  // Backend calls (aligned)
  // -------------------------
  async function loadPlans() {
    // { ok:true, plans:[{key,label,price_id,trial_days}] }
    try { return await fetchJSON('/api/plans'); }
    catch { return null; }
  }

  async function loadSubStatus(user_id) {
    // { ok:true, status, has_access, current_period_end, customer_portal }
    try { return await fetchJSON(`/api/subscription/status?user_id=${encodeURIComponent(user_id)}`); }
    catch { return null; }
  }

  async function openPortal(user_id) {
    const payload = { user_id, return_url: `${location.origin}/account.html` };
    const data = await fetchJSON('/api/billing/portal', { method:'POST', body: JSON.stringify(payload) });
    const url = data?.url;
    if (!url) throw new Error('Portal URL missing');
    location.href = url;
  }

  async function startCheckout(user_id, email, planKey) {
    const payload = { user_id, email: email || undefined, plan: planKey };
    const data = await fetchJSON('/billing/checkout', { method:'POST', body: JSON.stringify(payload) });
    const url = data?.checkout_url || data?.url; // backend returns checkout_url
    if (!url) throw new Error('Checkout URL missing');
    location.href = url;
  }

  // -------------------------
  // Render
  // -------------------------
  function renderIdentity() {
    const uid = getUID();
    const email = getEmail();

    // optional input fields if you add them in account.html
    const uidInput = $('uidInput');
    const emailInput = $('emailInput');
    if (uidInput && !uidInput.value) uidInput.value = uid;
    if (emailInput && !emailInput.value) emailInput.value = email;

    if (!uid) {
      setDot('dotLogin', 'bad');
      setText('txtLogin', 'Not logged in / 未登录');
      setText('vUser', '—');
      setBadge('badgeStatus', 'warn', 'STATUS: DEMO');
      return { loggedIn:false, uid:'', email:'' };
    }

    setDot('dotLogin', 'good');
    setText('txtLogin', 'Logged in / 已登录');
    setText('vUser', uid);
    return { loggedIn:true, uid, email };
  }

  function renderPlans(plansResp) {
    // If your HTML has price_* ids, fill them from /api/plans
    if (!plansResp?.ok || !Array.isArray(plansResp.plans)) return;

    const map = {};
    plansResp.plans.forEach(p => { map[p.key] = p; });

    // If you want to show exactly $4.90 etc, you can still hardcode in HTML.
    // Here we keep minimal: do nothing unless you added ids.
    // But we can set labels if you created placeholders.
    if ($('planLabel_weekly')) setText('planLabel_weekly', map.weekly?.label || 'Weekly');
    if ($('planLabel_monthly')) setText('planLabel_monthly', map.monthly?.label || 'Monthly');
    if ($('planLabel_quarterly')) setText('planLabel_quarterly', map.quarterly?.label || 'Quarterly');
    if ($('planLabel_yearly')) setText('planLabel_yearly', map.yearly?.label || 'Yearly');
  }

  function renderSub(sub) {
    if (!sub?.ok) {
      setText('vPlan', '—');
      setText('vSubStatus', 'unknown');
      setText('vPeriodEnd', '—');
      setText('vDataMode', 'Demo / 演示');
      setDot('dotAccess', 'warn');
      setText('txtAccess', 'Access: DEMO / 演示');
      return;
    }

    const hasAccess = !!sub.has_access;
    const status = sub.status || 'unknown';

    setText('vSubStatus', status);
    setText('vPeriodEnd', sub.current_period_end ? isoToLocal(sub.current_period_end) : '—');

    if (hasAccess) {
      setDot('dotAccess', 'good');
      setText('txtAccess', 'Access: PAID / 已订阅');
      setText('vDataMode', 'MFV/Delayed / 延迟行情');
      setBadge('badgeStatus', 'good', `STATUS: ${String(status).toUpperCase()}`);
    } else {
      setDot('dotAccess', 'warn');
      setText('txtAccess', 'Access: DEMO / 演示');
      setText('vDataMode', 'Demo / 演示');
      setBadge('badgeStatus', 'warn', `STATUS: ${String(status).toUpperCase()}`);
    }

    // plan_key isn't returned by your status endpoint currently; we can’t highlight yet.
    // If you later add plan_key to /api/subscription/status, we can highlight it.
    highlightPlan(null);
  }

  function bindActions(identity) {
    const btnSave = $('btnSaveIdentity');
    if (btnSave) {
      btnSave.onclick = () => safe(() => {
        const uidInput = $('uidInput');
        const emailInput = $('emailInput');
        const uid = (uidInput?.value || '').trim();
        const email = (emailInput?.value || '').trim();
        if (!uid) { alert('Please enter User ID / 请输入用户ID'); return; }
        setUID(uid);
        if (email) setEmail(email);
        location.reload();
      });
    }

    const btnPortal = $('btnPortal');
    if (btnPortal) {
      btnPortal.onclick = () => safe(async () => {
        const uid = getUID();
        if (!uid) { alert('Please enter User ID first / 请先填写用户ID'); return; }
        await openPortal(uid);
      });
    }

    const btnRefresh = $('btnRefresh');
    if (btnRefresh) btnRefresh.onclick = () => safe(init);

    // Plan subscribe buttons (data-plan="weekly" etc)
    const plansWrap = $('plansWrap');
    if (plansWrap) {
      plansWrap.addEventListener('click', (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLElement)) return;
        const action = t.getAttribute('data-action');
        const plan = t.getAttribute('data-plan');
        if (!action || !plan) return;

        if (action === 'checkout') {
          safe(async () => {
            const uid = getUID();
            const email = getEmail();
            if (!uid) { alert('Please enter User ID first / 请先填写用户ID'); return; }
            await startCheckout(uid, email, plan);
          });
        }
      });
    }
  }

  // -------------------------
  // init
  // -------------------------
  async function init() {
    // defaults
    setBadge('badgeStatus', 'warn', 'STATUS: LOADING');
    setDot('dotLogin', 'warn');
    setDot('dotAccess', 'warn');
    setText('txtLogin', 'Checking…');
    setText('txtAccess', 'Access: —');
    setText('vUser', '—');
    setText('vPlan', '—');
    setText('vSubStatus', '—');
    setText('vPeriodEnd', '—');
    setText('vDataMode', '—');

    const identity = renderIdentity();

    // load plans (optional UI fill)
    const plans = await loadPlans();
    renderPlans(plans);

    if (!identity.loggedIn) {
      renderSub({ ok:true, status:'not_logged_in', has_access:false });
      bindActions(identity);
      return;
    }

    const sub = await loadSubStatus(identity.uid);
    renderSub(sub);

    bindActions(identity);
  }

  document.addEventListener('DOMContentLoaded', () => safe(init));
})();
