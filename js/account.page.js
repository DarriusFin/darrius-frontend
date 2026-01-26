(() => {
  'use strict';

  // ===== Config =====
  const API_BASE =
    (window.__API_BASE__ && String(window.__API_BASE__).trim()) ||
    'https://darrius-api.onrender.com';

  const api = (path) => API_BASE.replace(/\/+$/, '') + path;

  // ===== DOM helpers =====
  const $ = (id) => document.getElementById(id);

  // ===== Safe storage (关键兜底：localStorage 可能抛异常，导致整页点击全失效) =====
  const MEM = { uid: '', email: '' };
  const LS_UID = 'darrius_user_id';
  const LS_EMAIL = 'darrius_email';

  function lsGet(key) {
    try { return (localStorage.getItem(key) || ''); } catch { return ''; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, val); } catch { /* ignore */ }
  }

  function getIdentity() {
    const uid = (lsGet(LS_UID) || MEM.uid || '').trim();
    const email = (lsGet(LS_EMAIL) || MEM.email || '').trim();
    return { user_id: uid, email };
  }

  function setIdentity(user_id, email) {
    const uid = (user_id || '').trim();
    const em = (email || '').trim();
    MEM.uid = uid;
    MEM.email = em;
    lsSet(LS_UID, uid);
    lsSet(LS_EMAIL, em);
  }

  function alert2(en, zh) {
    alert(`${en}\n${zh}`);
  }

  async function getJSON(path) {
    const r = await fetch(api(path), { headers: { Accept: 'application/json' } });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { ok: false, raw: text }; }
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  async function postJSON(path, body) {
    const r = await fetch(api(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { ok: false, raw: text }; }
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  // ===== Render =====
  function renderIdentity() {
    const { user_id, email } = getIdentity();
    if ($('uidInput')) $('uidInput').value = user_id || '';
    if ($('emailInput')) $('emailInput').value = email || '';
    if ($('vUser')) $('vUser').textContent = user_id || '—';
  }

  function setText(id, v) {
    const el = $(id);
    if (el) el.textContent = v;
  }

  function setBadge(text) {
    setText('badgeStatus', text);
  }

  function setDot(id, state /* good|warn|bad */) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('good', 'bad');
    if (state === 'good') el.classList.add('good');
    if (state === 'bad') el.classList.add('bad');
  }

  async function refreshPlans() {
    // Optional display check only (do not mutate pricing/UI)
    try {
      await getJSON('/api/plans');
    } catch (e) {
      console.warn('[account] /api/plans failed:', e.message);
    }
  }

  async function refreshStatus() {
    const { user_id } = getIdentity();

    if (!user_id) {
      setText('txtLogin', 'Not logged in / 未登录');
      setDot('dotLogin', 'warn');

      setText('txtAccess', 'Access: DEMO / 演示');
      setDot('dotAccess', 'warn');

      setBadge('STATUS: DEMO');
      setText('vSubStatus', 'not_logged_in');
      setText('vDataMode', 'Demo / 演示');
      setText('vPeriodEnd', '—');
      return;
    }

    setText('txtLogin', 'Logged in / 已登录');
    setDot('dotLogin', 'good');
    setBadge('STATUS: LOADING');

    try {
      const s = await getJSON('/api/subscription/status?user_id=' + encodeURIComponent(user_id));

      setText('vSubStatus', s.status || 'unknown');
      setText('vPeriodEnd', s.current_period_end ? new Date(s.current_period_end).toLocaleString() : '—');

      if (s.has_access) {
        setText('txtAccess', 'Access: MFV/Delayed / 延迟行情');
        setDot('dotAccess', 'good');
        setText('vDataMode', 'MFV/Delayed / 延迟行情');
        setBadge('STATUS: ACTIVE');
      } else {
        setText('txtAccess', 'Access: DEMO / 演示');
        setDot('dotAccess', 'warn');
        setText('vDataMode', 'Demo / 演示');
        setBadge('STATUS: DEMO');
      }

      const btnPortal = $('btnPortal');
      if (btnPortal) {
        if (s.customer_portal) {
          btnPortal.disabled = false;
          btnPortal.style.opacity = '1';
          btnPortal.title = '';
        } else {
          // 你也可以选择不禁用它；但当前逻辑保留你的原意：没订阅就不开放 Portal
          btnPortal.disabled = true;
          btnPortal.style.opacity = '0.55';
          btnPortal.title = 'Complete subscription first / 先完成订阅';
        }
      }
    } catch (e) {
      console.warn('[account] status failed:', e.message);
      setText('vSubStatus', 'unknown');
      setText('txtAccess', 'Access: DEMO / 演示');
      setDot('dotAccess', 'warn');
      setText('vDataMode', 'Demo / 演示');
      setBadge('STATUS: DEMO');
    }
  }

  // ===== Actions =====
  async function startCheckout(planKey) {
    const { user_id, email } = getIdentity();
    if (!user_id) return alert2('User ID required. Click Save first.', '请先填写用户ID并点击保存。');

    try {
      const res = await postJSON('/billing/checkout', {
        user_id,
        email: email || undefined,
        plan: planKey,
      });
      if (!res.checkout_url) return alert2('Missing checkout_url.', '后端未返回 checkout_url。');
      window.location.href = res.checkout_url;
    } catch (e) {
      alert2('Unable to start checkout: ' + e.message, '无法发起订阅：' + e.message);
    }
  }

  async function openPortal() {
    const { user_id } = getIdentity();
    if (!user_id) return alert2('User ID required. Click Save first.', '请先填写用户ID并点击保存。');

    try {
      const res = await postJSON('/api/billing/portal', { user_id });
      if (!res.url) return alert2('Missing portal url.', '后端未返回账单管理链接。');
      window.location.href = res.url;
    } catch (e) {
      alert2('Unable to open billing portal: ' + e.message, '无法打开账单管理：' + e.message);
    }
  }

  function scrollToPlans() {
    const wrap = $('plansWrap');
    if (!wrap) return;

    // 先滚动到 plansWrap（尽量让它顶到可视区域上方）
    const y = wrap.getBoundingClientRect().top + window.pageYOffset - 18;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });

    // 再做一个明显的闪烁提示（用户肉眼确认“生效”）
    wrap.classList.remove('flash');
    // 强制 reflow 以确保重复点击也会重新触发动画
    void wrap.offsetWidth;
    wrap.classList.add('flash');
    setTimeout(() => wrap.classList.remove('flash'), 1300);

    console.log('[account] btnGoPlans clicked -> scrollToPlans()');
  }

  // ===== Bind (事件委托兜底：不怕 DOM 时机/不怕局部渲染/不怕按钮替换) =====
  function bind() {
    const btnSave = $('btnSaveIdentity');
    if (btnSave) {
      btnSave.addEventListener('click', async () => {
        const uid = ($('uidInput')?.value || '').trim();
        const email = ($('emailInput')?.value || '').trim();
        if (!uid) return alert2('User ID required.', '必须填写用户ID。');
        setIdentity(uid, email);
        renderIdentity();
        await refreshStatus();
      });
    }

    const btnRefresh = $('btnRefresh');
    if (btnRefresh) btnRefresh.addEventListener('click', refreshStatus);

    const btnPortal = $('btnPortal');
    if (btnPortal) btnPortal.addEventListener('click', openPortal);

    const btnGoPlans = $('btnGoPlans');
    if (btnGoPlans) btnGoPlans.addEventListener('click', scrollToPlans);

    // ✅ Event delegation for all plan buttons
    document.addEventListener('click', (ev) => {
      const t = ev.target;
      if (!t) return;

      const btn = t.closest && t.closest('button[data-action]');
      if (!btn) return;

      const action = (btn.getAttribute('data-action') || '').trim();
      const plan = (btn.getAttribute('data-plan') || '').trim();

      if (action === 'checkout') {
        if (!plan) return;
        startCheckout(plan);
      } else if (action === 'learn') {
        alert2(`Plan details (${plan}) coming soon.`, `套餐详情（${plan}）后续补充。`);
      }
    }, true);

    console.log('[account] bind() done. buttons=', document.querySelectorAll('button[data-action]').length);
  }

  // ===== Init (确保 DOM 就绪后再跑) =====
  async function init() {
    console.log('[account] account.page.js loaded OK. API_BASE=', API_BASE);

    renderIdentity();
    bind();

    // System panel: keep UI clean, but preserve actual backend in title for debug
    if ($('vBackend')) {
      $('vBackend').textContent = 'Connected';
      $('vBackend').title = API_BASE;
    }

    try {
      const r = await getJSON('/routes');
      if ($('vBuild')) $('vBuild').textContent = r.build || '—';
      console.log('[account] routes loaded:', r && typeof r === 'object' ? 'Object' : r);
    } catch {}

    await refreshPlans();
    await refreshStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); });
  } else {
    init();
  }
})();
