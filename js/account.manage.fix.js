// js/account.manage.fix.js
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function pick(v, fallback = '—') {
    if (v === null || v === undefined) return fallback;
    const s = String(v).trim();
    return s ? s : fallback;
  }

  function setText(id, text) {
    const el = $(id);
    if (!el) return false;
    el.textContent = pick(text, '—');
    return true;
  }

  function setBadge(ok, text) {
    const b = $('statusBadge');
    if (!b) return;
    b.textContent = text || (ok ? 'STATUS: OK' : 'STATUS: UNKNOWN');
    b.classList.toggle('bad', !ok);
  }

  function setUpdated(ts) {
    const el = $('updatedAt');
    if (!el) return;
    el.textContent = 'Updated: ' + pick(ts, new Date().toISOString().replace('T', ' ').replace('Z', 'Z'));
  }

  async function fetchStatus() {
    const base = (window.__API_BASE__ || window.API_BASE || '').replace(/\/+$/,'');
    const uid = (($('userId') && $('userId').value) || '').trim();
    const em  = (($('email') && $('email').value) || '').trim();
    const useEmail = !!($('useEmailMatch') && $('useEmailMatch').checked);

    if (!uid) return { ok:false, reason:'missing_user_id' };

    try {
      localStorage.setItem('darrius_user_id', uid);
      if (em) localStorage.setItem('darrius_email', em);
      localStorage.setItem('darrius_use_email_match', useEmail ? '1' : '0');
    } catch {}

    const qs = new URLSearchParams();
    qs.set('user_id', uid);
    if (em) qs.set('email', em);
    qs.set('use_email_match', useEmail ? '1' : '0');

    const url = `${base}/billing/status?${qs.toString()}`;

    const r = await fetch(url, { method:'GET', credentials:'include' });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { j = { ok:false, raw:text }; }

    if (!r.ok) {
      return { ok:false, http:r.status, detail:j && (j.detail || j.error || j.raw) };
    }

    if (j && j.ok === true) return j;

    const maybeOk = j && (j.subscription_status || j.current_plan || j.renews_or_ends);
    if (maybeOk) return { ok:true, ...j };

    return { ok:false, detail:(j && (j.detail || j.error || j.raw)) || 'unknown' };
  }

  function render(j) {
    setText('kvUser', j.user_id || ( $('userId')?.value || '' ));
    setText('kvPlan', j.current_plan);
    setText('kvSubStatus', j.subscription_status);
    setText('kvEnds', j.renews_or_ends);
    setText('kvDataMode', j.data_source_mode || j.data_mode || 'DELAYED');
    setUpdated(j.updated_at);
    setBadge(j && j.ok === true, (j && j.ok === true) ? 'STATUS: OK' : 'STATUS: UNKNOWN');
  }

  async function refreshStatus() {
    // 清空旧值
    render({ ok:false, user_id: $('userId')?.value || '' });

    try {
      const j = await fetchStatus();
      if (!j || j.ok !== true) {
        setBadge(false, 'STATUS: UNKNOWN');
        return;
      }
      render(j);
    } catch {
      setBadge(false, 'STATUS: UNKNOWN');
    }
  }

  window.DARRIUS_ACCOUNT_REFRESH_STATUS = refreshStatus;

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(refreshStatus, 120);
  });
})();
