/* =========================================================================
 * FILE: darrius-frontend/js/upgrade.guard.js
 * DarriusAI - Upgrade Guard (FRONTEND ENFORCER) v2026.02.05-step2
 *
 * Role:
 *  - Intercept fetch() responses
 *  - If backend returns 402 with code=UPGRADE_REQUIRED => show Upgrade modal
 *  - Keep UI isolated; never touch chart.core.js internals
 *
 * Contract:
 *  - Backend returns HTTP 402 and JSON like:
 *      { ok:false, code:"UPGRADE_REQUIRED", message:"...", meta:{...} }
 *    and/or headers: x-upgrade-required: 1
 *
 * Config (optional, set before this script loads):
 *  - window.__UPGRADE_URL__ = "account.html#plans"
 *  - window.__UPGRADE_AUTO_REDIRECT__ = false   (default false)
 *  - window.__UPGRADE_MODAL_FORCE__ = true      (default true)
 * ========================================================================= */
(() => {
  'use strict';

  // ---------- config ----------
  const UPGRADE_URL = (typeof window.__UPGRADE_URL__ === 'string' && window.__UPGRADE_URL__.trim())
    ? window.__UPGRADE_URL__.trim()
    : 'account.html#plans';

  const AUTO_REDIRECT = (typeof window.__UPGRADE_AUTO_REDIRECT__ === 'boolean')
    ? window.__UPGRADE_AUTO_REDIRECT__
    : false;

  const FORCE_MODAL = (typeof window.__UPGRADE_MODAL_FORCE__ === 'boolean')
    ? window.__UPGRADE_MODAL_FORCE__
    : true;

  // ---------- helpers ----------
  const safe = (fn) => { try { return fn(); } catch (_) { return null; } };

  function isProbablyJsonResponse(resp) {
    const ct = (resp && resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
    return (ct || '').toLowerCase().includes('application/json');
  }

  function looksLikeUpgrade(resp, json) {
    const status = resp ? resp.status : 0;
    const hdr = resp && resp.headers && resp.headers.get ? resp.headers.get('x-upgrade-required') : null;
    const hdrFlag = String(hdr || '').trim() === '1';
    const bodyFlag = json && (json.code === 'UPGRADE_REQUIRED' || json.upgrade_required === true);
    return status === 402 || hdrFlag || !!bodyFlag;
  }

  function parseTier(json) {
    // Prefer backend meta
    const metaTier = json && json.meta && (json.meta.tier || json.meta.quota_tier);
    const tier = (metaTier || json.tier || '').toString().toUpperCase();
    if (tier === 'TRIAL') return 'TRIAL';
    if (tier === 'PAID' || tier === 'PRO' || tier === 'ELITE') return 'PAID';
    return 'FREE';
  }

  function prettyReason(json) {
    const msg = (json && (json.message || json.error)) ? String(json.message || json.error) : '';
    const code = (json && json.code) ? String(json.code) : '';
    const attemptSymbol = json && json.meta && json.meta.attempt_symbol ? String(json.meta.attempt_symbol) : '';
    const hint = [];

    if (attemptSymbol) hint.push(`Attempt: ${attemptSymbol}`);
    if (code) hint.push(`Code: ${code}`);
    if (msg) hint.push(msg);

    return hint.filter(Boolean).join(' • ');
  }

  function goUpgrade() {
    try { window.location.href = UPGRADE_URL; } catch (_) {}
  }

  // ---------- modal UI (self-contained) ----------
  const MODAL_ID = '__darr__upgrade_modal__';
  const STYLE_ID = '__darr__upgrade_style__';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
#${MODAL_ID}{position:fixed;inset:0;z-index:999999;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(2px);}
#${MODAL_ID} .box{width:min(520px,92vw);border-radius:16px;background:#10131a;color:#e8eefc;box-shadow:0 12px 48px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.08);overflow:hidden;}
#${MODAL_ID} .hd{padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;gap:10px;align-items:center;}
#${MODAL_ID} .dot{width:10px;height:10px;border-radius:99px;background:#7aa2ff;box-shadow:0 0 0 6px rgba(122,162,255,.18);}
#${MODAL_ID} .ttl{font-size:16px;font-weight:700;letter-spacing:.2px;}
#${MODAL_ID} .bd{padding:14px 18px 6px 18px;font-size:13px;line-height:1.5;color:rgba(232,238,252,.92);}
#${MODAL_ID} .pill{display:inline-block;margin-top:10px;padding:6px 10px;border-radius:999px;background:rgba(122,162,255,.14);border:1px solid rgba(122,162,255,.25);font-size:12px;color:#cfe0ff;}
#${MODAL_ID} .ft{padding:14px 18px 16px 18px;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;}
#${MODAL_ID} button{appearance:none;border:0;border-radius:12px;padding:10px 12px;font-weight:700;cursor:pointer;}
#${MODAL_ID} .btn-ghost{background:rgba(255,255,255,.06);color:#e8eefc;}
#${MODAL_ID} .btn-primary{background:linear-gradient(135deg,#7aa2ff,#ff5aa5);color:#0b0f16;}
#${MODAL_ID} .small{margin-top:10px;font-size:12px;color:rgba(232,238,252,.65);}
#${MODAL_ID} .reason{margin-top:8px;font-size:12px;color:rgba(232,238,252,.75);}
    `.trim();
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function ensureModal() {
    ensureStyle();
    let el = document.getElementById(MODAL_ID);
    if (el) return el;

    el = document.createElement('div');
    el.id = MODAL_ID;
    el.innerHTML = `
      <div class="box" role="dialog" aria-modal="true" aria-label="Upgrade Required">
        <div class="hd">
          <div class="dot"></div>
          <div class="ttl" id="__darr_up_ttl__">Upgrade required</div>
        </div>
        <div class="bd">
          <div id="__darr_up_body__"></div>
          <div class="pill" id="__darr_up_pill__">Plan</div>
          <div class="reason" id="__darr_up_reason__"></div>
          <div class="small" id="__darr_up_small__"></div>
        </div>
        <div class="ft">
          <button class="btn-ghost" id="__darr_up_close__">Not now</button>
          <button class="btn-primary" id="__darr_up_go__">Upgrade</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    // close handlers
    const close = () => hideUpgrade();
    el.addEventListener('click', (e) => { if (e.target === el) close(); });
    safe(() => document.getElementById('__darr_up_close__').addEventListener('click', close));
    safe(() => document.getElementById('__darr_up_go__').addEventListener('click', () => goUpgrade()));

    // ESC
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideUpgrade();
    });

    return el;
  }

  let _locked = false; // prevent modal spam storms
  let _lastKey = '';

  function showUpgrade({ tier, reason, meta }) {
    // avoid repeated popups for same event
    const key = `${tier}|${meta && meta.attempt_symbol ? meta.attempt_symbol : ''}|${meta && meta.user_id ? meta.user_id : ''}|${reason || ''}`;
    if (_locked && key === _lastKey) return;
    _locked = true;
    _lastKey = key;
    setTimeout(() => { _locked = false; }, 1200);

    const el = ensureModal();
    const ttlEl = document.getElementById('__darr_up_ttl__');
    const bodyEl = document.getElementById('__darr_up_body__');
    const pillEl = document.getElementById('__darr_up_pill__');
    const rsnEl = document.getElementById('__darr_up_reason__');
    const smallEl = document.getElementById('__darr_up_small__');

    // copy by tier
    let title = 'Upgrade required';
    let body = 'You’ve reached your current access limit for real-time market data.';
    let pill = 'ACCESS LIMIT';
    let small = '';

    if (tier === 'FREE') {
      title = 'Upgrade to view more symbols';
      body = 'Free access is limited. Upgrade to unlock multi-symbol viewing and avoid interruptions.';
      pill = 'FREE LIMIT REACHED';
      small = 'Tip: Paid plans unlock unlimited symbols. Trial requires a card and has a daily symbol cap.';
    } else if (tier === 'TRIAL') {
      title = 'Trial limit reached';
      body = 'Trial is designed for conversion, not unlimited usage. Upgrade to keep browsing without daily caps.';
      pill = 'TRIAL CAP REACHED';
      small = 'Your trial resets daily (symbol cap). Upgrade removes symbol limits.';
    } else { // PAID
      title = 'Action required';
      body = 'We couldn’t complete this request. Please check your subscription status.';
      pill = 'SUBSCRIPTION ACTION';
      small = 'If you believe this is a mistake, refresh and try again, or open Billing to confirm status.';
    }

    if (ttlEl) ttlEl.textContent = title;
    if (bodyEl) bodyEl.textContent = body;
    if (pillEl) pillEl.textContent = pill;

    const rsn = reason ? String(reason) : '';
    if (rsnEl) rsnEl.textContent = rsn ? `Details: ${rsn}` : '';
    if (smallEl) smallEl.textContent = small;

    el.style.display = 'flex';

    if (AUTO_REDIRECT) {
      setTimeout(() => goUpgrade(), 350);
    }
  }

  function hideUpgrade() {
    const el = document.getElementById(MODAL_ID);
    if (el) el.style.display = 'none';
  }

  // ---------- fetch interceptor ----------
  const _fetch = window.fetch ? window.fetch.bind(window) : null;
  if (!_fetch) return;

  window.fetch = async function patchedFetch(input, init) {
    const resp = await _fetch(input, init);

    // Fast-path by header or status
    const status = resp.status;
    const hdr = resp.headers && resp.headers.get ? resp.headers.get('x-upgrade-required') : null;
    const hdrFlag = String(hdr || '').trim() === '1';

    if (status !== 402 && !hdrFlag) return resp;

    // Try parse JSON if possible (clone!)
    let j = null;
    if (isProbablyJsonResponse(resp)) {
      j = await safe(async () => await resp.clone().json());
    }

    if (!looksLikeUpgrade(resp, j)) return resp;

    // Show modal even if body parse failed
    const tier = parseTier(j);
    const reason = prettyReason(j) || 'upgrade_required';
    const meta = (j && j.meta) ? j.meta : {};

    // If FORCE_MODAL, always show. Otherwise rely on caller.
    if (FORCE_MODAL) {
      showUpgrade({ tier, reason, meta });
    }

    return resp;
  };

  // allow other scripts to manually trigger modal (optional)
  window.DarriusUpgrade = window.DarriusUpgrade || {};
  window.DarriusUpgrade.show = (payload) => safe(() => showUpgrade(payload || {}));
  window.DarriusUpgrade.hide = () => safe(() => hideUpgrade());

})();
