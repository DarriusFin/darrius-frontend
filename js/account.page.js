(() => {
  'use strict';

  // ===== Config =====
  const API_BASE =
    (window.__API_BASE__ && String(window.__API_BASE__).trim()) ||
    'https://darrius-api.onrender.com';

  const api = (path) => API_BASE.replace(/\/+$/, '') + path;

  // ===== DOM helpers =====
  const $ = (id) => document.getElementById(id);

  // ===== Safe storage (localStorage 可能抛异常，导致整页点击全失效) =====
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

  // ===== UI small helpers =====
  function setText(id, v) {
    const el = $(id);
    if (el) el.textContent = (v == null || v === '') ? '—' : String(v);
  }

  function setDot(id, state /* good|warn|bad */) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('good', 'bad');
    if (state === 'good') el.classList.add('good');
    if (state === 'bad') el.classList.add('bad');
  }

  function setBadge(bucket) {
    const el = $('badgeStatus');
    if (!el) return;

    // 清空已有的 good/warn/bad class（你 CSS 里是 .badge.good/.badge.warn/.badge.bad）
    el.classList.remove('good', 'warn', 'bad');

    const b = String(bucket || 'DEMO').toUpperCase();

    if (b === 'ACTIVE') el.classList.add('good');
    else if (b === 'TRIAL') el.classList.add('warn');
    else if (b === 'EXPIRED') el.classList.add('bad');
    else el.classList.add('warn'); // DEMO/UNKNOWN 走 warn

    el.textContent = `STATUS: ${b}`;
  }

  function fmtLocal(v) {
    if (!v) return '—';
    try {
      const d = new Date(v);
      if (isNaN(d.getTime())) return String(v);
      return d.toLocaleString();
    } catch {
      return String(v);
    }
  }

  function clearPlanActive() {
    const nodes = document.querySelectorAll('.plan.active');
    nodes.forEach(n => n.classList.remove('active'));
  }

  function setPlanActive(planKey) {
    clearPlanActive();
    const k = String(planKey || '').toLowerCase().trim();
    if (!k) return;
    const el = document.getElementById(`plan_${k}`);
    if (el) el.classList.add('active');
  }

  // ===== Render identity =====
  function renderIdentity() {
    const { user_id, email } = getIdentity();
    if ($('uidInput')) $('uidInput').value = user_id || '';
    if ($('emailInput')) $('emailInput').value = email || '';
    setText('vUser', user_id || '—');
  }

  // ===== Status policy render (use backend display fields first) =====
  function renderStatus(policy) {
    // 后端返回（你 app.py 里）：
    // bucket, has_access, data_mode, current_period_end, plan_key,
    // data_label_en, data_label_zh,
    // （以及你“展示字段”版本里：status_label/plan_label/data_label）
    const p = policy || {};
    const bucket = String(p.bucket || (p.has_access ? 'ACTIVE' : 'DEMO')).toUpperCase();

    // 计划显示：优先展示字段 plan_label，其次 plan_key
    const planLabel = p.plan_label || p.plan_key || 'unknown';

    // 状态显示：优先展示字段 status_label，其次 bucket
    const statusLabel = p.status_label || bucket;

    // 数据显示：优先展示字段 data_label，其次 data_label_en/zh，再退回 data_mode
    const dataLabel =
      p.data_label ||
      (p.data_label_en && p.data_label_zh ? `${p.data_label_en} / ${p.data_label_zh}` : '') ||
      (p.data_label_en ? p.data_label_en : '') ||
      (p.data_label_zh ? p.data_label_zh : '') ||
      (String(p.data_mode || 'DEMO').toUpperCase() === 'DELAYED'
        ? 'Market (Delayed) / 市场数据（延时）'
        : 'Demo / 演示');

    setBadge(bucket);
    setText('vPlan', planLabel);
    setText('vSubStatus', statusLabel);
    setText('vDataMode', dataLabel);
    setText('vPeriodEnd', p.current_period_end ? fmtLocal(p.current_period_end) : '—');

    // 顶部 pills
    setText('txtLogin', p.user_id ? 'Logged in / 已登录' : 'Not logged in / 未登录');
    setDot('dotLogin', p.user_id ? 'good' : 'warn');

    // Access pill：以 has_access 判定（但 label 用 dataLabel）
    if (p.has_access) {
      setText('txtAccess', `Access: ${dataLabel}`);
      setDot('dotAccess', 'good');
    } else {
      setText('txtAccess', `Access: ${dataLabel}`);
      setDot('dotAccess', 'warn');
    }

    // Portal button：后端 customer_portal true 才可点
    const btnPortal = $('btnPortal');
    if (btnPortal) {
      if (p.customer_portal) {
        btnPortal.disabled = false;
        btnPortal.style.opacity = '1';
        btnPortal.title = '';
      } else {
        // 保持你原意：无 customer 不开放 Portal
        btnPortal.disabled = true;
        btnPortal.style.opacity = '0.55';
        btnPortal.title = 'Complete subscription first / 先完成订阅';
      }
    }

    // plan active highlight
    setPlanActive(p.plan_key);
  }

  // ===== Load plans (optional, display-only check) =====
  async function refreshPlans() {
    // 不改 UI、不重绘 plan，只用于“后端是否联通”的检查
    try {
      const r = await getJSON('/api/plans');
      // 你也可以将 trial_days 填回页面，但你要求“不动 UI”，这里仅检查
      return !!(r && r.ok);
    } catch (e) {
      console.warn('[account] /api/plans failed:', e.message);
      return false;
    }
  }

  // ===== Refresh status =====
  async function refreshStatus() {
    const { user_id, email } = getIdentity();

    if (!user_id && !email) {
      // 未登录：给一套稳定默认
      renderStatus({
        ok: true,
        user_id: null,
        bucket: 'DEMO',
        has_access: false,
        data_mode: 'DEMO',
        data_label_en: 'Demo',
        data_label_zh: '演示',
        plan_key: 'unknown',
        customer_portal: false,
        current_period_end: null,
      });
      return;
    }

    setBadge('LOADING');

    try {
      const qs = new URLSearchParams();
      if (user_id) qs.set('user_id', user_id);
      if (email) qs.set('email', email);

      const s = await getJSON('/api/subscription/status?' + qs.toString());

      // 关键：不要再出现 MFV。完全信后端的 label。
      renderStatus(s);

    } catch (e) {
      console.warn('[account] status failed:', e.message);
      // 降级到 DEMO
      renderStatus({
        ok: true,
        user_id: user_id || null,
        bucket: 'DEMO',
        has_access: false,
        data_mode: 'DEMO',
        data_label_en: 'Demo',
        data_label_zh: '演示',
        plan_key: 'unknown',
        customer_portal: false,
        current_period_end: null,
      });
    }
  }

  // ===== Actions =====
  async function bindEmailIfProvided(user_id, email) {
    const uid = (user_id || '').trim();
    const em = (email || '').trim();
    if (!uid || !em) return;

    // 调后端绑定（不会动订阅/支付，只是把 email 绑定到 user）
    try {
      await postJSON('/api/user/bind-email', { user_id: uid, email: em });
    } catch (e) {
      // 不阻塞主流程：绑定失败也不影响页面使用
      console.warn('[account] bind-email failed:', e.message);
    }
  }

  async function startCheckout(planKey) {
    const { user_id, email } = getIdentity();
    if (!user_id) return alert2('User ID required. Click Save first.', '请先填写用户ID并点击保存。');

    try {
      // 不改你的支付逻辑：仍然走 /billing/checkout
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
    const { user_id, email } = getIdentity();
    if (!user_id && !email) return alert2('User ID or Email required. Click Save first.', '请先填写用户ID或邮箱并点击保存。');

    try {
      const res = await postJSON('/api/billing/portal', { user_id: user_id || undefined, email: email || undefined });
      if (!res.url) return alert2('Missing portal url.', '后端未返回账单管理链接。');
      window.location.href = res.url;
    } catch (e) {
      alert2('Unable to open billing portal: ' + e.message, '无法打开账单管理：' + e.message);
    }
  }

  function scrollToPlans() {
    const wrap = $('plansWrap');
    if (!wrap) return;

    const y = wrap.getBoundingClientRect().top + window.pageYOffset - 18;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });

    wrap.classList.remove('flash');
    void wrap.offsetWidth; // reflow
    wrap.classList.add('flash');
    setTimeout(() => wrap.classList.remove('flash'), 1300);
  }

  // ===== Bind =====
  function bind() {
    const btnSave = $('btnSaveIdentity');
    if (btnSave) {
      btnSave.addEventListener('click', async () => {
        const uid = ($('uidInput')?.value || '').trim();
        const em = ($('emailInput')?.value || '').trim();

        if (!uid && !em) return alert2('User ID or Email required.', '至少填写用户ID或邮箱之一。');
        if (!uid) return alert2('User ID required (recommended).', '建议必须填写用户ID（你系统的主键）。');

        setIdentity(uid, em);
        renderIdentity();

        // ✅ 自动绑定邮箱（不影响订阅/支付）
        await bindEmailIfProvided(uid, em);

        // 刷新状态
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
  }

  // ===== Init =====
  async function init() {
    console.log('[account] account.page.js loaded OK. API_BASE=', API_BASE);

    renderIdentity();
    bind();

    // System panel
    if ($('vBackend')) {
      $('vBackend').textContent = 'Connected';
      $('vBackend').title = API_BASE;
    }

    // Build
    try {
      const r = await getJSON('/routes');
      if ($('vBuild')) $('vBuild').textContent = r.build || '—';
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
