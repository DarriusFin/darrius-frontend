// js/account.manage.fix.js
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

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

    el.textContent = pick(value);
  };

  const setBadge = (state) => {
    const badge = $('statusBadge');
    if (!badge) return;

    if (state === 'signed-in') {
      badge.textContent =
        window.DARRIUS_T?.("signedIn") ||
        "SIGNED IN";
      badge.classList.remove('bad');
      return;
    }

    if (state === 'error') {
      badge.textContent =
        window.DARRIUS_T?.("statusUnknown") ||
        "STATUS: UNKNOWN";
      badge.classList.add('bad');
      return;
    }

    badge.textContent =
      window.DARRIUS_T?.("signInRequired") ||
      "SIGN IN REQUIRED";
    badge.classList.add('bad');
  };

  const setUpdated = (timestamp) => {
    const el = $('updatedAt');
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
    setText('kvUser', '—');
    setText('kvPlan', '—');
    setText('kvSubStatus', 'Not signed in');
    setText('kvEnds', '—');
    setText('kvDataMode', '—');

    setBadge('signed-out');
    setUpdated();

  }

  function renderSubscription(policy, userId) {
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
    }
  }

  window.DARRIUS_ACCOUNT_REFRESH_STATUS =
    refreshStatus;

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