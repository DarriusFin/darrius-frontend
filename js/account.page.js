(() => {
  'use strict';

  // =========================
  // Config
  // =========================
  const API_BASE =
    (window.__API_BASE__ && String(window.__API_BASE__).trim()) ||
    'https://darrius-api.onrender.com';

  const api = (path) => {
    const base = String(API_BASE || '').replace(/\/+$/, '');
    const p = String(path || '');
    return base + (p.startsWith('/') ? p : '/' + p);
  };

  // =========================
  // DOM helpers
  // =========================
  const $ = (id) => document.getElementById(id);

  // =========================
  // Safe storage (localStorage may throw)
  // =========================
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

  // =========================
  // HTTP helpers
  // =========================
  async function requestJSON(method, path, body) {
    const url = api(path);

    const opt = {
      method,
      headers: { Accept: 'application/json' },
      // NOTE: never add credentials unless you actually use cookies
    };

    if (method !== 'GET' && method !== 'HEAD') {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body || {});
    }

    let r, text, data;
    try {
      r = await fetch(url, opt);
      text = await r.text();
    } catch (e) {
      // network/CORS/DNS
      throw new Error(`Network/CORS error when calling ${method} ${url}: ${e.message || e}`);
    }

    try { data = JSON.parse(text); } catch { data = { ok: false, raw: text }; }

    if (!r.ok) {
      const msg = data?.error || data?.message || `HTTP ${r.status}`;
      const err = new Error(`${msg}`);
      err.httpStatus = r.status;
      err.url = url;
      err.method = method;
      err.raw = data;
      throw err;
    }
    return data;
  }

  const getJSON = (path) => requestJSON('GET', path);
  const postJSON = (path, body) => requestJSON('POST', path, body);

  // =========================
  // UI helpers
  // =========================
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

  function setBadge(text, kind) {
    const el = $('badgeStatus');
    if (!el) return;
    el.textContent = text;

    // optional visual: rely on your existing CSS classes if present
    el.classList.remove('good', 'warn', 'bad');
    if (kind) el.classList.add(kind);
  }

  function setDot(id, kind) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('good', 'bad');
    if (kind === 'good') el.classList.add('good');
    if (kind === 'bad') el.classList.add('bad');
  }

  // =========================
  // Route probing (关键：自动识别后端真实支持的接口/方法)
  // =========================
  let ROUTES = null; // { '/billing/checkout': ['POST'], ... }

  function normalizeRule(rule) {
    return String(rule || '').trim();
  }

  async function loadRoutes() {
    try {
      const r = await getJSON('/routes');
      const list = Array.isArray(r.routes) ? r.routes : [];
      const map = {};
      for (const it of list) {
        const rule = normalizeRule(it.rule);
        const methods = Array.isArray(it.methods) ? it.methods.map(m => String(m).toUpperCase()) : [];
        if (rule) map[rule] = methods;
      }
      ROUTES = map;

      if ($('vBuild')) $('vBuild').textContent = r.build || '—';
      if ($('vBackend')) $('vBackend').textContent = API_BASE;

      console.log('[account] routes loaded:', map);
      return true;
    } catch (e) {
      // 如果 /routes 都拿不到，说明 API_BASE 或 CORS 还没通
      ROUTES = null;
      console.warn('[account] /routes failed:', e.message);
      if ($('vBackend')) $('vBackend').textContent = API_BASE;
      if ($('vBuild')) $('vBuild').textContent = '—';
      return false;
    }
  }

  function supports(rule, method) {
    if (!ROUTES) return null; // unknown
    const m = String(method || '').toUpperCase();
    const methods = ROUTES[rule];
    if (!methods) return false;
    return methods.includes(m);
  }

  // 自动选 endpoint：不改支付系统，只做“前端兼容不同部署版本”
  function pickEndpoint(kind) {
    // kind: 'checkout' | 'portal' | 'status' | 'plans'
    // 优先你“新 app.py”定义的路径；如果当前部署没有，则 fallback
    const candidates = {
      checkout: [
        { rule: '/billing/checkout', method: 'POST' },
        { rule: '/create-checkout-session', method: 'POST' }, // 常见旧名
        { rule: '/billing/create-checkout-session', method: 'POST' },
      ],
      portal: [
        { rule: '/api/billing/portal', method: 'POST' },
        { rule: '/billing/portal', method: 'POST' },
      ],
      status: [
        { rule: '/api/subscription/status', method: 'GET' },
        { rule: '/billing/subscription/status', method: 'GET' },
      ],
      plans: [
        { rule: '/api/plans', method: 'GET' },
        { rule: '/billing/prices', method: 'GET' }, // 兼容旧接口
      ],
    }[kind] || [];

    // 如果 routes 未加载，先返回第一候选（但会在报错时给出明确提示）
    if (!ROUTES) return candidates[0] || null;

    for (const c of candidates) {
      if (supports(c.rule, c.method)) return c;
    }
    // 没有任何匹配，仍返回第一候选方便报错提示
    return candidates[0] || null;
  }

  // =========================
  // Data refresh
  // =========================
  async function refreshPlans() {
    const ep = pickEndpoint('plans');
    if (!ep) return;

    try {
      await requestJSON(ep.method, ep.rule);
      // 你页面价格写死，这里不改 UI，避免误改
    } catch (e) {
      // 404/405 只警告，不影响按钮绑定
      console.warn(`[account] plans failed (${ep.method} ${ep.rule}):`, e.message);
    }
  }

  async function refreshStatus() {
    const { user_id } = getIdentity();

    if (!user_id) {
      setText('txtLogin', 'Not logged in / 未登录');
      setDot('dotLogin', 'bad');

      setText('txtAccess', 'Access: DEMO / 演示');
      setDot('dotAccess', 'warn');

      setBadge('STATUS: DEMO', 'warn');
      setText('vSubStatus', 'not_logged_in');
      setText('vDataMode', 'Demo / 演示');
      setText('vPeriodEnd', '—');

      // Portal button disabled until subscription exists
      const btnPortal = $('btnPortal');
      if (btnPortal) {
        btnPortal.disabled = true;
        btnPortal.style.opacity = '0.55';
      }
      return;
    }

    setText('txtLogin', 'Logged in / 已登录');
    setDot('dotLogin', 'good');
    setBadge('STATUS: LOADING', 'warn');

    const ep = pickEndpoint('status');
    if (!ep) {
      setBadge('STATUS: DEMO', 'warn');
      return;
    }

    try {
      const url = `${ep.rule}?user_id=${encodeURIComponent(user_id)}`;
      const s = await requestJSON(ep.method, url);

      setText('vSubStatus', s.status || 'unknown');
      setText('vPeriodEnd', s.current_period_end ? new Date(s.current_period_end).toLocaleString() : '—');

      if (s.has_access) {
        setText('txtAccess', 'Access: MFV/Delayed / 延迟行情');
        setText('vDataMode', 'MFV/Delayed / 延迟行情');
        setDot('dotAccess', 'good');
        setBadge('STATUS: ACTIVE', 'good');
      } else {
        setText('txtAccess', 'Access: DEMO / 演示');
        setText('vDataMode', 'Demo / 演示');
        setDot('dotAccess', 'warn');
        setBadge('STATUS: DEMO', 'warn');
      }

      const btnPortal = $('btnPortal');
      if (btnPortal) {
        if (s.customer_portal) {
          btnPortal.disabled = false;
          btnPortal.style.opacity = '1';
        } else {
          btnPortal.disabled = true;
          btnPortal.style.opacity = '0.55';
          btnPortal.title = 'Complete subscription first / 先完成订阅';
        }
      }
    } catch (e) {
      console.warn('[account] status failed:', e.message);

      // status 失败不影响订阅按钮，但要给出清晰状态
      setText('vSubStatus', 'unknown');
      setText('txtAccess', 'Access: DEMO / 演示');
      setText('vDataMode', 'Demo / 演示');
      setDot('dotAccess', 'warn');
      setBadge('STATUS: DEMO', 'warn');
    }
  }

  // =========================
  // Actions (checkout / portal)
  // =========================
  let IN_FLIGHT = false;

  function setButtonsDisabled(disabled) {
    const buttons = document.querySelectorAll('button[data-action="checkout"], #btnPortal, #btnSaveIdentity, #btnRefresh');
    buttons.forEach((b) => {
      try { b.disabled = !!disabled; } catch {}
      try { b.style.opacity = disabled ? '0.70' : ''; } catch {}
    });
  }

  function explainHttpError(e, contextLabel) {
    const status = e?.httpStatus;
    const url = e?.url || '';
    const method = e?.method || '';
    const hint =
      status === 405
        ? `405 means the server at that URL does NOT accept ${method}. Usually you are NOT hitting the correct Flask backend, or backend routes are not the version you think.`
        : status === 404
        ? `404 means the endpoint does not exist on the server you reached. Backend version mismatch or wrong API_BASE.`
        : `HTTP error occurred.`;

    alert2(
      `${contextLabel} failed: ${e.message}\n(${status || '—'} ${method} ${url})\n\nHint: ${hint}\nOpen: ${API_BASE}/routes to verify methods.`,
      `${contextLabel}失败：${e.message}\n(${status || '—'} ${method} ${url})\n\n提示：${hint}\n打开：${API_BASE}/routes 核对接口与方法。`
    );
  }

  async function startCheckout(planKey) {
    const { user_id, email } = getIdentity();
    if (!user_id) return alert2('User ID required. Click Save first.', '请先填写用户ID并点击保存。');

    const ep = pickEndpoint('checkout');
    if (!ep) return alert2('Checkout endpoint not found.', '未找到可用的订阅接口（后端路由不匹配）。');

    // If we already know routes and it does NOT support POST, stop early (clear message)
    const support = supports(ep.rule, ep.method);
    if (support === false) {
      return alert2(
        `Backend does not support ${ep.method} ${ep.rule}. Open ${API_BASE}/routes and confirm your deployed backend.`,
        `后端当前不支持 ${ep.method} ${ep.rule}。请打开 ${API_BASE}/routes 确认你部署的后端版本。`
      );
    }

    if (IN_FLIGHT) return;
    IN_FLIGHT = true;
    setButtonsDisabled(true);

    try {
      console.log('[account] startCheckout:', ep, { user_id, planKey });

      // Primary (new) payload
      let body = { user_id, plan: planKey };
      if (email) body.email = email;

      const res = await requestJSON(ep.method, ep.rule, body);

      // Compatible shapes
      const checkoutUrl = res.checkout_url || res.url || res.checkoutUrl;
      if (!checkoutUrl) {
        alert2('Missing checkout_url from backend.', '后端未返回 checkout_url。');
        return;
      }
      window.location.href = checkoutUrl;
    } catch (e) {
      console.warn('[account] checkout error:', e);

      // If 405 on chosen endpoint and we have routes loaded, try fallback automatically once
      if (e?.httpStatus === 405 && ROUTES) {
        const fallback = [
          { rule: '/create-checkout-session', method: 'POST' },
          { rule: '/billing/create-checkout-session', method: 'POST' },
        ].find(c => supports(c.rule, c.method));

        if (fallback) {
          try {
            const body = { user_id, plan: planKey };
            if (email) body.email = email;

            const res2 = await requestJSON(fallback.method, fallback.rule, body);
            const checkoutUrl2 = res2.checkout_url || res2.url || res2.checkoutUrl;
            if (checkoutUrl2) {
              window.location.href = checkoutUrl2;
              return;
            }
          } catch (e2) {
            console.warn('[account] fallback checkout failed:', e2);
          }
        }
      }

      explainHttpError(e, 'Start checkout');
    } finally {
      IN_FLIGHT = false;
      setButtonsDisabled(false);
    }
  }

  async function openPortal() {
    const { user_id } = getIdentity();
    if (!user_id) return alert2('User ID required. Click Save first.', '请先填写用户ID并点击保存。');

    const ep = pickEndpoint('portal');
    if (!ep) return alert2('Portal endpoint not found.', '未找到可用的账单管理接口（后端路由不匹配）。');

    if (IN_FLIGHT) return;
    IN_FLIGHT = true;
    setButtonsDisabled(true);

    try {
      console.log('[account] openPortal:', ep, { user_id });

      const res = await requestJSON(ep.method, ep.rule, { user_id });
      const url = res.url || res.portal_url || res.portalUrl;
      if (!url) return alert2('Missing portal url.', '后端未返回账单管理链接。');
      window.location.href = url;
    } catch (e) {
      console.warn('[account] portal error:', e);
      explainHttpError(e, 'Open billing portal');
    } finally {
      IN_FLIGHT = false;
      setButtonsDisabled(false);
    }
  }

  // =========================
  // Bind (event delegation)
  // =========================
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

    // capture phase: stronger
    document.addEventListener(
      'click',
      (ev) => {
        const t = ev.target;
        if (!t) return;

        const btn = t.closest && t.closest('button[data-action]');
        if (!btn) return;

        const action = (btn.getAttribute('data-action') || '').trim();
        const plan = (btn.getAttribute('data-plan') || '').trim();

        console.log('[account] click captured:', { action, plan });

        if (action === 'checkout') {
          if (!plan) return;
          startCheckout(plan);
        } else if (action === 'learn') {
          alert2(`Plan details (${plan}) coming soon.`, `套餐详情（${plan}）后续补充。`);
        }
      },
      true
    );

    console.log('[account] bind() done. buttons=', document.querySelectorAll('button[data-action]').length);
  }

  // =========================
  // Init
  // =========================
  async function init() {
    console.log('[account] account.pages.js loaded OK. API_BASE=', API_BASE);

    renderIdentity();
    bind();

    // Try load /routes first (critical for diagnosing 404/405)
    await loadRoutes();

    // Show system info
    if ($('vBackend')) $('vBackend').textContent = API_BASE;

    await refreshPlans();
    await refreshStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
})();
