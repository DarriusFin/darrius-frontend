// js/account.manage.fix.js  (FINAL - tolerant mapping)
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const pick = (v, fallback = '—') => {
    if (v === null || v === undefined) return fallback;
    const s = String(v).trim();
    return s ? s : fallback;
  };

  const setText = (id, text) => {
    const el = $(id);
    if (!el) return;
    el.textContent = pick(text, '—');
  };

  const setBadge = (ok) => {
    const b = $('statusBadge');
    if (!b) return;
    b.textContent = ok ? 'STATUS: OK' : 'STATUS: UNKNOWN';
    b.classList.toggle('bad', !ok);
  };

  const setUpdated = (ts) => {
    const el = $('updatedAt');
    if (!el) return;
    el.textContent = 'Updated: ' + pick(ts, new Date().toISOString().replace('T',' ').replace('Z','Z'));
  };

  function normalizeStatus(j, uidInput) {
    // 兼容不同后端字段名
    const currentPlan =
      j.current_plan ?? j.plan ?? j.plan_name ?? j.product ?? j.tier ?? '—';

    const subStatus =
      j.subscription_status ?? j.status ?? j.sub_status ?? '—';

    const renewsOrEnds =
      j.renews_or_ends ?? j.renew_end ?? j.period ?? j.current_period_end ?? j.ends_at ?? '—';

    const dataMode =
      j.data_source_mode ?? j.data_mode ?? j.mode ?? 'DELAYED';

    const updatedAt =
      j.updated_at ?? j.updated ?? j.ts ?? null;

    return {
      ok: j.ok === true,
      user_id: j.user_id ?? uidInput ?? '',
      current_plan: currentPlan,
      subscription_status: subStatus,
      renews_or_ends: renewsOrEnds,
      data_source_mode: dataMode,
      updated_at: updatedAt,
    };
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

    if (!r.ok) return { ok:false, http:r.status, detail:(j && (j.detail || j.error || j.raw)) };

    // ok:true or has meaningful fields
    if (j && j.ok === true) return j;

    const maybe = j && (j.subscription_status || j.status || j.current_plan || j.plan || j.current_period_end);
    if (maybe) return { ok:true, ...j };

    return { ok:false, detail:(j && (j.detail || j.error || j.raw)) || 'unknown' };
  }

  function render(norm) {
    setText('kvUser', norm.user_id);
    setText('kvPlan', norm.current_plan);
    setText('kvSubStatus', norm.subscription_status);
    setText('kvEnds', norm.renews_or_ends);
    setText('kvDataMode', norm.data_source_mode || 'DELAYED');
    setUpdated(norm.updated_at);
    setBadge(norm.ok);
  }

  async function refreshStatus() {
    const uid = (($('userId') && $('userId').value) || '').trim();
    render({ ok:false, user_id: uid, current_plan:'—', subscription_status:'—', renews_or_ends:'—', data_source_mode:'DELAYED' });

    try {
      const raw = await fetchStatus();
      const norm = normalizeStatus(raw || {}, uid);
      // 如果后端 ok=false 或字段空，仍然保持 UNKNOWN
      if (!norm.ok && pick(norm.current_plan) === '—' && pick(norm.subscription_status) === '—') {
        setBadge(false);
        return;
      }
      // 若后端没显式 ok:true 但有字段，则当作 ok
      if (!norm.ok && (pick(norm.current_plan) !== '—' || pick(norm.subscription_status) !== '—')) {
        norm.ok = true;
      }
      render(norm);
    } catch {
      setBadge(false);
    }
  }

  window.DARRIUS_ACCOUNT_REFRESH_STATUS = refreshStatus;

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(refreshStatus, 120);
  });
})();
