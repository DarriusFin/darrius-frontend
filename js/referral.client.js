/* =========================================================================
 * DarriusAI - referral.client.js (PROD SAFE) v2026.01.28
 *
 * Goal (NO UI changes):
 *  1) Capture referral code from URL: ?ref=XXXX
 *  2) Persist it safely: localStorage + (optional) cookie
 *  3) Expose a stable API for other scripts:
 *        window.DarriusReferral.get()
 *        window.DarriusReferral.set(code)
 *        window.DarriusReferral.clear()
 *        window.DarriusReferral.attachToUrl(url)
 *
 * Rules:
 *  - Never touches Stripe / subscription logic
 *  - Never throws (safe wrapper)
 *  - Sanitizes inputs: allow [A-Za-z0-9_-], max 64
 *  - Default TTL: 30 days (cookie); localStorage has no TTL but we store ts
 * ========================================================================= */

(() => {
  'use strict';

  // -----------------------------
  // Config (safe defaults)
  // -----------------------------
  const CFG = {
    // storage keys
    LS_CODE_KEY: 'dref_code',
    LS_TS_KEY: 'dref_ts',              // unix ms when set
    // cookie
    COOKIE_NAME: 'dref',
    COOKIE_DAYS: 30,
    // input rules
    MAX_LEN: 64,
    // URL param
    QUERY_PARAM: 'ref',
    // If true, remove ?ref= from URL after capturing
    CLEAN_URL_AFTER_CAPTURE: true,
    // Enable tiny debug var (no UI impact)
    EXPOSE_DEBUG: true,
  };

  // -----------------------------
  // No-throw wrapper
  // -----------------------------
  function safe(fn) {
    try { return fn(); } catch (e) { return null; }
  }

  // -----------------------------
  // Sanitization
  // -----------------------------
  function sanitize(code) {
    if (!code) return '';
    code = String(code).trim();
    if (!code) return '';
    if (code.length > CFG.MAX_LEN) code = code.slice(0, CFG.MAX_LEN);

    let out = '';
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      const ok =
        (ch >= '0' && ch <= '9') ||
        (ch >= 'A' && ch <= 'Z') ||
        (ch >= 'a' && ch <= 'z') ||
        ch === '_' || ch === '-';
      if (ok) out += ch;
    }
    return out;
  }

  // -----------------------------
  // URL helpers
  // -----------------------------
  function getQueryParam(name) {
    return safe(() => {
      const url = new URL(window.location.href);
      return url.searchParams.get(name) || '';
    }) || '';
  }

  function removeQueryParam(name) {
    return safe(() => {
      const url = new URL(window.location.href);
      if (!url.searchParams.has(name)) return;
      url.searchParams.delete(name);
      // keep other params intact; avoid reload
      window.history.replaceState({}, document.title, url.toString());
    });
  }

  function attachToUrl(url, code) {
    return safe(() => {
      const c = sanitize(code);
      if (!c) return url;

      const u = new URL(url, window.location.origin);
      if (!u.searchParams.get(CFG.QUERY_PARAM)) {
        u.searchParams.set(CFG.QUERY_PARAM, c);
      }
      return u.toString();
    }) || url;
  }

  // -----------------------------
  // Cookie helpers
  // -----------------------------
  function setCookie(name, value, days) {
    return safe(() => {
      const d = new Date();
      d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
      // SameSite=Lax is correct for typical referral flows
      // Secure will be automatically applied by modern browsers on https origin in most cases,
      // but we keep it simple and avoid forcing it.
      document.cookie =
        `${name}=${encodeURIComponent(value)}; expires=${d.toUTCString()}; path=/; SameSite=Lax`;
      return true;
    }) || false;
  }

  function getCookie(name) {
    return safe(() => {
      const esc = name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
      const m = document.cookie.match(new RegExp('(?:^|; )' + esc + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    }) || '';
  }

  function deleteCookie(name) {
    return safe(() => {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`;
      return true;
    }) || false;
  }

  // -----------------------------
  // localStorage helpers
  // -----------------------------
  function lsSet(code) {
    return safe(() => {
      localStorage.setItem(CFG.LS_CODE_KEY, code);
      localStorage.setItem(CFG.LS_TS_KEY, String(Date.now()));
      return true;
    }) || false;
  }

  function lsGet() {
    return sanitize(safe(() => localStorage.getItem(CFG.LS_CODE_KEY)) || '');
  }

  function lsClear() {
    return safe(() => {
      localStorage.removeItem(CFG.LS_CODE_KEY);
      localStorage.removeItem(CFG.LS_TS_KEY);
      return true;
    }) || false;
  }

  // -----------------------------
  // Public API (stable)
  // -----------------------------
  function getRef() {
    // Priority: localStorage -> cookie -> URL (URL is handled on load)
    const a = lsGet();
    if (a) return a;
    const b = sanitize(getCookie(CFG.COOKIE_NAME));
    if (b) return b;
    return '';
  }

  function setRef(code) {
    const c = sanitize(code);
    if (!c) return false;
    // persist both
    lsSet(c);
    setCookie(CFG.COOKIE_NAME, c, CFG.COOKIE_DAYS);
    if (CFG.EXPOSE_DEBUG) window.__DARRIUS_REF__ = c;
    return true;
  }

  function clearRef() {
    lsClear();
    deleteCookie(CFG.COOKIE_NAME);
    if (CFG.EXPOSE_DEBUG) window.__DARRIUS_REF__ = '';
    return true;
  }

  // -----------------------------
  // Init: capture ?ref= on load
  // -----------------------------
  safe(() => {
    const q = sanitize(getQueryParam(CFG.QUERY_PARAM));
    if (q) {
      setRef(q);
      if (CFG.CLEAN_URL_AFTER_CAPTURE) removeQueryParam(CFG.QUERY_PARAM);
    } else {
      // Expose existing stored ref for debugging/consumption
      const existing = getRef();
      if (CFG.EXPOSE_DEBUG && existing) window.__DARRIUS_REF__ = existing;
    }
  });

  // Expose API
  safe(() => {
    window.DarriusReferral = {
      get: () => getRef(),
      set: (code) => setRef(code),
      clear: () => clearRef(),
      attachToUrl: (url, code) => attachToUrl(url, code || getRef()),
      _cfg: CFG, // harmless; helpful for debugging
    };
  });

})();
