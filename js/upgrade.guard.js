/* =========================================================================
 * FILE: darrius-frontend/js/upgrade.guard.js
 * DarriusAI - Upgrade Guard (PRODUCTION) v2026.02.05
 *
 * Purpose:
 * - Intercept fetch() globally
 * - If API returns 402 or {code:"UPGRADE_REQUIRED"}:
 *    - Show upgrade modal immediately
 *    - Throw to stop downstream render (chart won't draw)
 *
 * Safety:
 * - Never breaks non-API fetches
 * - Modal is injected only once
 * - No dependency on chart.core.js internals
 * ========================================================================= */
(() => {
  'use strict';

  // Allow disabling in emergencies
  if (typeof window.__UPGRADE_GUARD_ENABLED__ === 'boolean' && !window.__UPGRADE_GUARD_ENABLED__) {
    return;
  }

  const ORIG_FETCH = window.fetch ? window.fetch.bind(window) : null;
  if (!ORIG_FETCH) return;

  const STATE = {
    showing: false,
    lastShownAt: 0,
    lastKey: '',
  };

  function nowMs() { return Date.now(); }

  function isApiUrl(u) {
    try {
      const s = String(u || '');
      // only guard our backend endpoints (avoid breaking assets/CDN)
      return (
        s.includes('/api/') ||
        s.includes('darrius-api.onrender.com')
      );
    } catch (_) { return false; }
  }

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  function ensureModal() {
    if (document.getElementById('darrius-upgrade-guard-root')) return;

    const style = document.createElement('style');
    style.id = 'darrius-upgrade-guard-style';
    style.textContent = `
#darrius-upgrade-guard-root{position:fixed;inset:0;z-index:999999;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55)}
#darrius-upgrade-guard-modal{width:min(560px,92vw);border-radius:16px;background:#0b1220;color:#e8eefc;box-shadow:0 10px 35px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.10);overflow:hidden}
#darrius-upgrade-guard-hd{padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.10);display:flex;align-items:center;justify-content:space-between}
#darrius-upgrade-guard-hd h3{margin:0;font-size:16px;font-weight:700;letter-spacing:.2px}
#darrius-upgrade-guard-bd{padding:16px 18px;line-height:1.55;font-size:14px}
#darrius-upgrade-guard-bd .sub{opacity:.85;margin-top:8px;font-size:13px}
#darrius-upgrade-guard-ft{padding:14px 18px;border-top:1px solid rgba(255,255,255,.10);display:flex;gap:10px;justify-content:flex-end}
.dar-btn{cursor:pointer;border-radius:12px;padding:10px 14px;font-weight:700;font-size:14px;border:1px solid rgba(255,255,255,.16);background:transparent;color:#e8eefc}
.dar-btn.primary{background:#2b6cff;border-color:rgba(43,108,255,.45)}
.dar-btn:hover{filter:brightness(1.05)}
#darrius-upgrade-guard-x{cursor:pointer;opacity:.8;border:none;background:transparent;color:#e8eefc;font-size:18px;line-height:1}
#darrius-upgrade-guard-x:hover{opacity:1}
#darrius-upgrade-guard-code{margin-top:10px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;opacity:.85;background:rgba(255,255,255,.06);padding:8px 10px;border-radius:10px;word-break:break-word}
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'darrius-upgrade-guard-root';
    root.innerHTML = `
  <div id="darrius-upgrade-guard-modal" role="dialog" aria-modal="true">
    <div id="darrius-upgrade-guard-hd">
      <h3>Upgrade Required</h3>
      <button id="darrius-upgrade-guard-x" aria-label="Close">×</button>
    </div>
    <div id="darrius-upgrade-guard-bd">
      <div id="darrius-upgrade-guard-msg">You’ve reached your Free/Trial limit. Upgrade to continue using real market data.</div>
      <div class="sub" id="darrius-upgrade-guard-sub">No demo data will be shown.</div>
      <div id="darrius-upgrade-guard-code" style="display:none;"></div>
    </div>
    <div id="darrius-upgrade-guard-ft">
      <button class="dar-btn" id="darrius-upgrade-guard-close">Close</button>
      <button class="dar-btn primary" id="darrius-upgrade-guard-upgrade">Upgrade</button>
    </div>
  </div>
    `;
    document.body.appendChild(root);

    const close = () => { root.style.display = 'none'; STATE.showing = false; };
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    root.querySelector('#darrius-upgrade-guard-x').addEventListener('click', close);
    root.querySelector('#darrius-upgrade-guard-close').addEventListener('click', close);

    root.querySelector('#darrius-upgrade-guard-upgrade').addEventListener('click', () => {
      // choose your upgrade destination
      // 1) account page with plans
      const url = window.__UPGRADE_URL__ || 'account.html#plans';
      try { window.location.href = url; } catch (_) {}
    });
  }

  function showUpgrade(info) {
    try {
      ensureModal();
      const root = document.getElementById('darrius-upgrade-guard-root');
      if (!root) return;

      // de-dupe: avoid spamming modal if many requests fail at once
      const key = (info && (info.code || info.message || info.status || '')) + '|' + (info && info.path ? info.path : '');
      const t = nowMs();
      if (STATE.showing && (t - STATE.lastShownAt) < 800) return;
      if (STATE.lastKey === key && (t - STATE.lastShownAt) < 1200) return;

      STATE.showing = true;
      STATE.lastShownAt = t;
      STATE.lastKey = key;

      const msgEl = document.getElementById('darrius-upgrade-guard-msg');
      const codeEl = document.getElementById('darrius-upgrade-guard-code');

      const msg = (info && info.message) ? info.message : 'You’ve reached your Free/Trial limit. Upgrade to continue using real market data.';
      if (msgEl) msgEl.textContent = msg;

      const code = (info && info.code) ? info.code : '';
      if (codeEl) {
        if (code) { codeEl.style.display = 'block'; codeEl.textContent = `code: ${code}`; }
        else { codeEl.style.display = 'none'; codeEl.textContent = ''; }
      }

      root.style.display = 'flex';

      // notify app listeners (optional)
      window.dispatchEvent(new CustomEvent('darrius:upgradeRequired', { detail: info || {} }));
    } catch (_) {}
  }

  async function extractErrorInfo(res, urlStr) {
    let info = { status: res.status, path: urlStr || '' };
    try {
      const text = await res.clone().text();
      const j = safeJsonParse(text);
      if (j && typeof j === 'object') {
        info = Object.assign(info, {
          ok: j.ok,
          code: j.code,
          message: j.message || j.error || '',
          meta: j.meta || null,
        });
      }
    } catch (_) {}
    return info;
  }

  // Global fetch guard
  window.fetch = async function guardedFetch(input, init) {
    const urlStr = (typeof input === 'string') ? input : (input && input.url) ? input.url : '';
    const shouldGuard = isApiUrl(urlStr);

    const res = await ORIG_FETCH(input, init);

    if (!shouldGuard) return res;

    // 402: always upgrade
    if (res && res.status === 402) {
      const info = await extractErrorInfo(res, urlStr);
      info.code = info.code || 'UPGRADE_REQUIRED';
      showUpgrade(info);

      // Throw to stop render pipeline (chart will not draw)
      const err = new Error('UPGRADE_REQUIRED');
      err.name = 'UpgradeRequiredError';
      err.info = info;
      throw err;
    }

    // 200 but payload says UPGRADE_REQUIRED (just in case)
    try {
      const ct = (res.headers && res.headers.get) ? (res.headers.get('content-type') || '') : '';
      if (ct.includes('application/json')) {
        const text = await res.clone().text();
        const j = safeJsonParse(text);
        if (j && j.code === 'UPGRADE_REQUIRED') {
          const info = {
            status: res.status,
            path: urlStr || '',
            code: j.code,
            message: j.message || 'Upgrade required',
            meta: j.meta || null,
          };
          showUpgrade(info);
          const err = new Error('UPGRADE_REQUIRED');
          err.name = 'UpgradeRequiredError';
          err.info = info;
          throw err;
        }
      }
    } catch (_) {
      // ignore parse issues
    }

    return res;
  };

})();
