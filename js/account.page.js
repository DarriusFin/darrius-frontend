/* account.page.js
 * Account & Subscription Management (UI-only)
 * - Calls backend endpoints only
 * - Does NOT modify existing payment/subscription logic
 * - Safe: fail-closed, never throws
 *
 * Expected backend endpoints (any missing => graceful UI fallback):
 *   GET  /api/me
 *   GET  /api/subscription/status
 *   GET  /api/access/profile
 *   POST /billing/portal          -> { url }
 *   POST /billing/checkout        -> { url }  (or { checkout_url })
 *   GET  /routes                  -> optional, for build info
 *
 * Notes:
 * - This file assumes account.html contains the DOM ids used below.
 */

(() => {
  'use strict';

  // -------------------------
  // Helpers (safe by default)
  // -------------------------
  const $ = (id) => document.getElementById(id);

  function safe(fn) {
    try { return fn(); } catch (e) { return null; }
  }

  async function fetchJSON(url, opts = {}) {
    const r = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    const ct = r.headers.get('content-type') || '';
    let data = null;
    if (ct.includes('application/json')) data = await r.json().catch(() => null);
    else data = await r.text().catch(() => null);

    if (!r.ok) {
      const msg = (data && data.error) ? data.error : `HTTP ${r.status}`;
      const err = new Error(msg);
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function fmtDateFromUnix(sec) {
    if (!sec || typeof sec !== 'number') return '—';
    const d = new Date(sec * 1000);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString();
  }

  function setDot(dotId, mode) {
    // mode: good | bad | warn
    const el = $(dotId);
    if (!el) return;
    el.classList.remove('good', 'bad');
    // default is warn (yellow)
    if (mode === 'good') el.classList.add('good');
    else if (mode === 'bad') el.classList.add('bad');
  }

  function setBadge(elId, kind, text) {
    const el = $(elId);
    if (!el) return;
    el.classList.remove('good', 'warn', 'bad');
    if (kind === 'good') el.classList.add('good');
    else if (kind === 'bad') el.classList.add('bad');
    else el.classList.add('warn');
    el.textContent = text || '—';
  }

  function highlightPlan(planKey) {
    const keys = ['weekly', 'monthly', 'quarterly', 'yearly'];
    keys.forEach(k => {
      const card = $(`plan_${k}`);
      if (!card) return;
      card.classList.toggle('active', planKey === k);
    });
  }

  function setText(id, value) {
    const el = $(id);
    if (!el) return;
    el.textContent = (value === undefined || value === null || value === '') ? '—' : String(value);
  }

  function setPolicyText(profile, sub) {
    const el = $('policyText');
    if (!el) return;

    const access = profile?.access || 'demo';
    const mode = profile?.data_source?.mode || profile?.data_mode || 'demo';
    const delay = profile?.data_source?.delay_minutes ?? profile?.delay_minutes;
    const provider = profile?.data_source?.provider || profile?.provider || '—';

    const cancel = !!sub?.cancel_at_period_end;
    const endAt = sub?.current_period_end ? fmtDateFromUnix(sub.current_period_end) : '—';

    const lines = [];
    lines.push(`Access: ${access.toUpperCase()}`);
    lines.push(`Data Mode: ${String(mode).toUpperCase()}${delay ? ` (${delay}-min)` : ''}`);
    lines.push(`Provider: ${provider}`);
    if (sub?.status) lines.push(`Subscription: ${sub.status}${cancel ? ` (ends ${endAt})` : ''}`);
    lines.push('');
    lines.push('Policy: Dashboard access and data mode are enforced by backend. This page only routes you to checkout/portal and displays your current state.');

    el.textContent = lines.join('\n');
    el.style.whiteSpace = 'pre-line';
  }

  // -------------------------
  // API calls (graceful)
  // -------------------------
  async function loadMe() {
    // Expected: { logged_in: bool, user_id? ... }
    try { return await fetchJSON('/api/me'); }
    catch { return { logged_in: false }; }
  }

  async function loadSubStatus() {
    // Expected:
    // { access:"demo"|"paid", status:"active"|"trialing"|...,
    //   plan:"weekly"|"monthly"|"quarterly"|"yearly",
    //   cancel_at_period_end:boolean, current_period_end:number }
    try { return await fetchJSON('/api/subscription/status'); }
    catch { return null; }
  }

  async function loadAccessProfile() {
    // Expected:
    // { access:"demo"|"paid",
    //   data_source:{mode,label,delay_minutes,provider}, ... }
    try { return await fetchJSON('/api/access/profile'); }
    catch { return null; }
  }

  async function loadBuildInfo() {
    // optional: your backend /routes shows build timestamp (you used it before)
    try {
      const r = await fetchJSON('https://darrius-api.onrender.com/routes');
      return r;
    } catch {
      return null;
    }
  }

  // -------------------------
  // Actions: portal / checkout
  // -------------------------
  async function openPortal() {
    // POST /billing/portal -> { url }
    // You may already host backend at darrius-api.onrender.com
    // We try relative first, then fallback to full origin.
    const payload = { return_url: `${location.origin}/account.html` };

    const tryUrls = ['/billing/portal', 'https://darrius-api.onrender.com/billing/portal'];
    let lastErr = null;

    for (const u of tryUrls) {
      try {
        const data = await fetchJSON(u, { method: 'POST', body: JSON.stringify(payload) });
        const url = data?.url || data?.portal_url;
        if (url) { location.href = url; return; }
        throw new Error('Portal URL missing');
      } catch (e) { lastErr = e; }
    }
    alert(`Unable to open billing portal. ${lastErr ? lastErr.message : ''}`);
  }

  async function startCheckout(planKey) {
    // POST /billing/checkout -> { url } (or { checkout_url })
    // Plan selection is passed to backend; backend maps to price_id safely.
    const payload = { plan: planKey, origin: 'account' };

    const tryUrls = ['/billing/checkout', 'https://darrius-api.onrender.com/billing/checkout'];
    let lastErr = null;

    for (const u of tryUrls) {
      try {
        const data = await fetchJSON(u, { method: 'POST', body: JSON.stringify(payload) });
        const url = data?.url || data?.checkout_url;
        if (url) { location.href = url; return; }
        throw new Error('Checkout URL missing');
      } catch (e) { lastErr = e; }
    }
    alert(`Unable to start checkout. ${lastErr ? lastErr.message : ''}`);
  }

  // -------------------------
  // Render
  // -------------------------
  function renderLogin(me) {
    if (!me || !me.logged_in) {
      setDot('dotLogin', 'bad');
      setText('txtLogin', 'Not logged in');
      setText('vUser', '—');
      return false;
    }
    setDot('dotLogin', 'good');
    setText('txtLogin', 'Logged in');
    setText('vUser', me.user_id || me.email || 'user');
    return true;
  }

  function renderSub(sub) {
    // badgeStatus + overview kv + plan highlight
    if (!sub) {
      setBadge('badgeStatus', 'warn', 'STATUS: UNKNOWN');
      setText('vPlan', '—');
      setText('vSubStatus', '—');
      setText('vPeriodEnd', '—');
      return;
    }

    const status = sub.status || 'unknown';
    const plan = sub.plan || 'unknown';
    const cancel = !!sub.cancel_at_period_end;
    const endAt = sub.current_period_end ? fmtDateFromUnix(sub.current_period_end) : '—';

    setText('vPlan', plan);
    setText('vSubStatus', status);
    setText('vPeriodEnd', cancel ? `Ends ${endAt}` : (endAt !== '—' ? `Renews ${endAt}` : '—'));

    // Badge logic
    let kind = 'warn';
    let label = `STATUS: ${String(status).toUpperCase()}`;

    if (status === 'active' || status === 'trialing') kind = 'good';
    if (status === 'past_due' || status === 'unpaid' || status === 'incomplete') kind = 'bad';
    if (cancel && (status === 'active' || status === 'trialing')) {
      kind = 'warn';
      label = `ACTIVE (ENDS ${endAt})`;
    }

    setBadge('badgeStatus', kind, label);

    // highlight plan card
    highlightPlan(['weekly', 'monthly', 'quarterly', 'yearly'].includes(plan) ? plan : null);
  }

  function renderAccess(profile, sub) {
    const access = profile?.access || sub?.access || 'demo';

    // top pillAccess
    if (access === 'paid') {
      setDot('dotAccess', 'good');
      setText('txtAccess', 'Access: PAID');
    } else {
      setDot('dotAccess', 'warn');
      setText('txtAccess', 'Access: DEMO');
    }

    // data mode line
    const mode = profile?.data_source?.mode || profile?.data_mode || (access === 'paid' ? 'mfv_delayed' : 'demo');
    const label = profile?.data_source?.label || (mode === 'demo' ? 'Demo' : 'MFV Delayed');
    const delay = profile?.data_source?.delay_minutes ?? profile?.delay_minutes;
    const provider = profile?.data_source?.provider || profile?.provider || '';

    const modeText = `${label}${delay ? ` (${delay}-min)` : ''}${provider ? ` • ${provider}` : ''}`;
    setText('vDataMode', modeText);

    setPolicyText(profile, sub);
  }

  function renderPricesUI(me) {
    // You told the 4 plan pricing:
    // Weekly 4.90, Monthly 19.90, Quarterly 49.90, Yearly 189.00
    // Here we set placeholder display. Real authoritative price can later come from /billing/prices if you want.
    setText('price_weekly', '$4.90');
    setText('price_monthly', '$19.90');
    setText('price_quarterly', '$49.90');
    setText('price_yearly', '$189.00');

    // If not logged in, keep subscribe buttons but route to dashboard/login (or show alert).
    // We'll simply show an alert on click if not logged in.
  }

  function bindActions(state) {
    const btnPortal = $('btnPortal');
    if (btnPortal) btnPortal.onclick = () => safe(openPortal);

    const btnRefresh = $('btnRefresh');
    if (btnRefresh) btnRefresh.onclick = () => safe(init);

    const btnGoPlans = $('btnGoPlans');
    if (btnGoPlans) btnGoPlans.onclick = () => {
      // Scroll to plans section
      const wrap = $('plansWrap');
      if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    // Plan cards buttons
    const wrap = $('plansWrap');
    if (wrap) {
      wrap.addEventListener('click', (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLElement)) return;

        const action = t.getAttribute('data-action');
        const plan = t.getAttribute('data-plan');
        if (!action || !plan) return;

        if (action === 'learn') {
          alert(`Plan: ${plan}\n\nThis is a placeholder. You can add a modal later without touching payment logic.`);
          return;
        }

        if (action === 'checkout') {
          // Guard: must be logged in
          if (!state.me || !state.me.logged_in) {
            alert('Please sign in first, then choose a plan.');
            return;
          }
          // Start checkout via backend (existing logic)
          safe(() => startCheckout(plan));
        }
      });
    }
  }

  // -------------------------
  // Init
  // -------------------------
  const state = { me: null, sub: null, profile: null };

  async function init() {
    // Basic placeholders (never blank)
    setBadge('badgeStatus', 'warn', 'STATUS: LOADING');
    setText('vUser', '—');
    setText('vPlan', '—');
    setText('vSubStatus', '—');
    setText('vPeriodEnd', '—');
    setText('vDataMode', '—');
    setText('vBuild', '—');
    setText('vBackend', '—');
    setText('txtLogin', 'Checking login…');
    setText('txtAccess', 'Access: —');
    setDot('dotLogin', 'warn');
    setDot('dotAccess', 'warn');

    // Load
    state.me = await loadMe();
    const loggedIn = renderLogin(state.me);

    renderPricesUI(state.me);

    if (!loggedIn) {
      // Not logged in: show policy baseline
      setBadge('badgeStatus', 'warn', 'STATUS: DEMO');
      setText('vSubStatus', 'not_logged_in');
      renderAccess({ access: 'demo', data_source: { mode: 'demo', label: 'Demo' } }, null);
      bindActions(state);
      return;
    }

    // Logged in: fetch sub + profile
    state.sub = await loadSubStatus();
    state.profile = await loadAccessProfile();

    renderSub(state.sub);
    renderAccess(state.profile, state.sub);

    // Optional build info
    const bi = await loadBuildInfo();
    if (bi && typeof bi === 'object') {
      setText('vBuild', bi.build || '—');
      setText('vBackend', 'darrius-api.onrender.com');
    } else {
      setText('vBackend', '—');
    }

    bindActions(state);
  }

  document.addEventListener('DOMContentLoaded', () => safe(init));
})();
