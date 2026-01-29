/* js/referral.client.js  (SAFE / UI-ONLY) v2026.01.29
 * Purpose:
 *  - Detect ?ref=CODE from URL
 *  - Store into localStorage (darr_ref_code)
 *  - Show a subtle bottom-left toast (2.2s)
 *  - Clean URL param to avoid accidental sharing
 *  - Provide getter for checkout flow without touching billing logic
 *
 * Guarantees:
 *  - No dependency on subscription/payment code
 *  - Never throws (best-effort only)
 */

(() => {
  'use strict';

  const KEY = 'darr_ref_code';
  const KEY_TS = 'darr_ref_code_ts';
  const KEY_SEEN = 'darr_ref_toast_seen'; // avoid repeated toast
  const TOAST_MS = 2200;

  function safe(fn) { try { return fn(); } catch (e) { return null; } }

  function normalizeRef(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    // allow A-Z a-z 0-9 _ - with length guard
    s = s.replace(/[^A-Za-z0-9_\-]/g, '');
    if (s.length < 4 || s.length > 64) return null;
    return s;
  }

  function getUrlRef() {
    return safe(() => {
      const u = new URL(window.location.href);
      const ref = u.searchParams.get('ref');
      return normalizeRef(ref);
    });
  }

  function saveRef(code) {
    return safe(() => {
      localStorage.setItem(KEY, code);
      localStorage.setItem(KEY_TS, String(Date.now()));
      return true;
    });
  }

  function getSavedRef() {
    return safe(() => normalizeRef(localStorage.getItem(KEY))) || null;
  }

  function cleanUrlRefParam() {
    safe(() => {
      const u = new URL(window.location.href);
      if (!u.searchParams.has('ref')) return;
      u.searchParams.delete('ref');
      const newUrl = u.pathname + (u.search ? u.search : '') + (u.hash ? u.hash : '');
      window.history.replaceState(null, '', newUrl);
    });
  }

  function alreadyShownToastFor(code) {
    return safe(() => {
      const seen = localStorage.getItem(KEY_SEEN);
      return seen === code;
    }) || false;
  }

  function markToastShown(code) {
    safe(() => localStorage.setItem(KEY_SEEN, code));
  }

  function showToast(msgLines) {
    safe(() => {
      // create container
      const el = document.createElement('div');
      el.id = 'darr-ref-toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.position = 'fixed';
      el.style.left = '16px';
      el.style.bottom = '16px';
      el.style.zIndex = '99999';
      el.style.maxWidth = '320px';
      el.style.pointerEvents = 'none';
      el.style.padding = '10px 12px';
      el.style.borderRadius = '12px';
      el.style.border = '1px solid rgba(255,255,255,0.10)';
      el.style.background = 'rgba(10, 14, 22, 0.78)';
      el.style.backdropFilter = 'blur(10px)';
      el.style.webkitBackdropFilter = 'blur(10px)';
      el.style.boxShadow = '0 10px 28px rgba(0,0,0,0.35)';
      el.style.color = 'rgba(255,255,255,0.92)';
      el.style.fontSize = '12.5px';
      el.style.lineHeight = '1.35';
      el.style.letterSpacing = '0.2px';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      el.style.transition = 'opacity 140ms ease, transform 140ms ease';

      const icon = document.createElement('span');
      icon.textContent = '✅';
      icon.style.marginRight = '8px';

      const wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'flex-start';

      const text = document.createElement('div');
      text.style.flex = '1';

      (msgLines || []).forEach((line, i) => {
        const p = document.createElement('div');
        p.textContent = line;
        if (i === 0) p.style.fontWeight = '700';
        p.style.margin = (i === 0) ? '0 0 3px 0' : '0';
        text.appendChild(p);
      });

      wrap.appendChild(icon);
      wrap.appendChild(text);
      el.appendChild(wrap);

      document.body.appendChild(el);

      // animate in
      requestAnimationFrame(() => {
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
      });

      // animate out
      setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(6px)';
        setTimeout(() => safe(() => el.remove()), 240);
      }, TOAST_MS);
    });
  }

  // Public bridge (UI only)
  // Other modules can call: window.DarriusReferral.get()
  safe(() => {
    window.DarriusReferral = window.DarriusReferral || {};
    window.DarriusReferral.get = () => getSavedRef();
    window.DarriusReferral.clear = () => safe(() => {
      localStorage.removeItem(KEY);
      localStorage.removeItem(KEY_TS);
      localStorage.removeItem(KEY_SEEN);
      return true;
    });
  });

  // ---- Main flow ----
  safe(() => {
    const urlRef = getUrlRef();
    if (!urlRef) return;

    // Save first
    saveRef(urlRef);

    // Show toast once per code
    if (!alreadyShownToastFor(urlRef)) {
      const isZh = /zh|cn/i.test(navigator.language || '');
      const msg = isZh
        ? ['已识别推荐码：' + urlRef, '下单时将自动生效']
        : ['Referral detected: ' + urlRef, 'Will be applied at checkout'];
      showToast(msg);
      markToastShown(urlRef);
    }

    // Clean URL
    cleanUrlRefParam();
  });
})();
