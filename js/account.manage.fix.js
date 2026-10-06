// js/account.manage.fix.js
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const checkoutReturn = new URLSearchParams(location.search).get('checkout');
  function renderCheckoutReturn(signedIn = false) {
    const notice = $('checkoutReturnNotice');
    if (!notice) return;
    notice.hidden = !['success', 'cancel', 'canceled'].includes(checkoutReturn);
    if (notice.hidden) return;
    // Query parameters describe navigation only, never payment or authentication.
    const key = checkoutReturn === 'success'
      ? (signedIn ? 'returnSignedIn' : 'returnPending') : 'returnCanceled';
    $('checkoutReturnMessage').textContent = window.AccountI18n.text(key);
    $('checkoutReturnLogin').hidden = signedIn;
  }

  const API_BASE = (
    window.__API_BASE__ ||
    window.API_BASE ||
    ''
  ).replace(/\/+$/, '');

  const pick = (value, fallback = '—') => {
    if (value === null || value === undefined) {
      return fallback;
    }

    const text = String(value).trim();
    return text || fallback;
  };

  const setText = (id, value) => {
    const el = $(id);
    if (!el) return;

    el.textContent = window.AccountI18n?.status(pick(value)) || pick(value);
  };

  const setBadge = (state) => {
    const badge = $('statusBadge');
    if (!badge) return;

    if (state === 'signed-in') {
      badge.textContent =
        window.DARRIUS_T?.("signedIn") ||
        (window.AccountI18n?.status("SIGNED IN") || "SIGNED IN");
      badge.classList.remove('bad');
      return;
    }

    if (state === 'error') {
      badge.textContent =
        window.DARRIUS_T?.("statusUnknown") ||
        (window.AccountI18n?.status("STATUS: UNKNOWN") || "STATUS: UNKNOWN");
      badge.classList.add('bad');
      return;
    }

    badge.textContent =
      window.DARRIUS_T?.("signInRequired") ||
      (window.AccountI18n?.status("SIGN IN REQUIRED") || "SIGN IN REQUIRED");
    badge.classList.add('bad');
  };

  const setUpdated = (timestamp) => {
    const el = $('updatedAt');
    if (el && window.AccountI18n) { el.textContent=window.AccountI18n.updated(); return; }
    if (!el) return;

    const value =
      timestamp ||
      new Date().toISOString();

    const updatedTemplate =
      window.DARRIUS_T?.("updatedStatus") ||
      "Updated: {value}";

    el.textContent = updatedTemplate.replace(
      "{value}",
      String(value)
    );
  };

  async function fetchJSON(path) {
    const response = await fetch(
      `${API_BASE}${path}`,
      {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    const text = await response.text();

    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      data = {
        ok: false,
        raw: text,
      };
    }

    return {
      response,
      data,
    };
  }

  function renderSignedOut() {
    renderCheckoutReturn(false);
    window.__AUTH_USER_ID__ = null;
    window.__ENTITLEMENT__ = null;
    const identity = $('checkoutIdentity'); if (identity) identity.hidden = false;
    setText('kvUser', '—');
    setText('kvPlan', '—');
    setText('kvSubStatus', 'Not signed in');
    setText('kvEnds', '—');
    setText('kvDataMode', '—');

    setBadge('signed-out');
    setUpdated();

  }

  function renderSubscription(policy, userId) {
    renderCheckoutReturn(true);
    window.__AUTH_USER_ID__ = userId;
    window.__ENTITLEMENT__ = policy;
    const identity = $("checkoutIdentity"); if (identity) identity.hidden = true;
    const plan =
      policy?.plan_key &&
      String(policy.plan_key).toLowerCase() !== 'unknown'
        ? policy.plan_key
        : '—';

    const status =
      String(policy?.bucket || 'DEMO')
        .toUpperCase();

    const ends =
      policy?.current_period_end ||
      '—';

    const dataMode =
      policy?.data_mode ||
      '—';

    setText('kvUser', userId);
    setText('kvPlan', plan);
    setText('kvSubStatus', status);
    setText('kvEnds', ends);
    setText('kvDataMode', dataMode);

    setBadge('signed-in');
    setUpdated(policy?.updated_at);

  }

  async function refreshStatus() {
    renderCheckoutReturn(!!window.__AUTH_USER_ID__);
    const refreshButton = $('checkoutReturnRefresh');
    if (refreshButton) refreshButton.disabled = true;
    try {
      const sessionResult = await fetchJSON(
        '/api/auth/session'
      );

      if (
        !sessionResult.response.ok ||
        sessionResult.data?.authenticated !== true ||
        !sessionResult.data?.user_id
      ) {
        renderSignedOut();
        return;
      }

      const userId = String(
        sessionResult.data.user_id
      ).trim();

      window.__AUTH_USER_ID__ = userId;
      const identity = $('checkoutIdentity'); if (identity) identity.hidden = true;
      const subscriptionResult = await fetchJSON(
        '/api/subscription/me'
      );

      if (!subscriptionResult.response.ok) {
        setText('kvUser', userId);
        setText('kvPlan', '—');
        setText(
          'kvSubStatus',
          window.DARRIUS_T?.("unableToLoad") ||
          "Unable to load"
        );
        setText('kvEnds', '—');
        setText('kvDataMode', '—');

        setBadge('error');
        setUpdated();

        return;
      }

      renderSubscription(
        subscriptionResult.data || {},
        userId
      );
    } catch (error) {
      console.error(
        '[Account] status refresh failed',
        error
      );

      setBadge('error');
      setUpdated();
    } finally {
      if (refreshButton) refreshButton.disabled = false;
    }
  }

  window.DARRIUS_ACCOUNT_REFRESH_STATUS =
    refreshStatus;
  $('checkoutReturnRefresh')?.addEventListener('click', refreshStatus);
  $('checkoutReturnLogin')?.addEventListener('click', () => {
    window.location.href = '/index.html?lang=' + (document.documentElement.lang.startsWith('zh') ? 'zh' : 'en');
  });

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        refreshStatus();
      }
    );
  } else {
    refreshStatus();
  }

  document.addEventListener(
    'darrius:language-changed',
    () => {
      refreshStatus();
    }
  );

})();
