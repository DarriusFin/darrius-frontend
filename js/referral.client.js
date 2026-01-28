/* referral.client.js (MVP STEP 2)
 * Purpose:
 *  - Capture ?ref=CODE from URL
 *  - Persist it (localStorage + optional cookie)
 *  - Safe: never throws, never touches billing logic
 */
(() => {
  'use strict';

  // ---------- config ----------
  const KEY = 'dref_code';          // localStorage key
  const COOKIE = 'dref';            // cookie name (darrius.ai domain cookie)
  const MAX_LEN = 64;
  const DAYS = 30;                  // persistence window

  function safe(fn) {
    try { return fn(); } catch (e) { return null; }
  }

  function sanitize(code) {
    if (!code) return '';
    code = String(code).trim();
    if (!code) return '';
    if (code.length > MAX_LEN) code = code.slice(0, MAX_LEN);
    // allow only [A-Za-z0-9_-]
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

  function getQueryRef() {
    return safe(() => {
      const url = new URL(window.location.href);
      return url.searchParams.get('ref') || '';
    }) || '';
  }

  function setLS(code) {
    safe(() => localStorage.setItem(KEY, code));
  }

  function getLS() {
    return safe(() => localStorage.getItem(KEY)) || '';
  }

  function setCookie(name, value, days) {
    safe(() => {
      const d = new Date();
      d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
      // Lax is enough; do NOT use HttpOnly because JS might read it
      document.cookie =
        `${name}=${encodeURIComponent(value)}; expires=${d.toUTCString()}; path=/; SameSite=Lax`;
    });
  }

  function getCookie(name) {
    return safe(() => {
      const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    }) || '';
  }

  function removeRefFromUrl() {
    // Optional: keep URL clean after capturing ref
    safe(() => {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('ref')) return;
      url.searchParams.delete('ref');
      // keep other params intact
      window.history.replaceState({}, document.title, url.toString());
    });
  }

  // ---------- main ----------
  safe(() => {
    const qref = sanitize(getQueryRef());
    if (qref) {
      // persist
      setLS(qref);
      setCookie(COOKIE, qref, DAYS);
      // optional clean URL
      removeRefFromUrl();
      // tiny debug hook (no UI change)
      window.__DARRIUS_REF__ = qref;
      return;
    }

    // If no ref in URL, expose existing stored ref (for later use)
    const existing = sanitize(getLS() || getCookie(COOKIE));
    if (existing) window.__DARRIUS_REF__ = existing;
  });
})();
