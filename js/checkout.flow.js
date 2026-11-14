/* Checkout recovery uses the existing email-code authentication contract.
 * Never treat a typed User ID, saved draft, or verification response as a session.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const base = (window.__API_BASE__ || window.API_BASE || 'https://api.darrius.ai').replace(/\/+$/, '');
  const storageKey = 'darrius_checkout_draft_v1';
  const allowedPlans = ['weekly', 'monthly', 'quarterly', 'yearly'];
  let plans = [], selectedKey = '', busy = false, authBusy = false, cooldownUntil = 0;
  let statusKey = '', statusKind = 'info', statusDetail = '', signedInUser = '';
  const messages = {
    signIn: ['Already have an account? Sign in', '已有账号？登录继续付款'],
    createPay: ['Create account & go to payment', '创建账号并前往付款'],
    pay: ['Go to payment', '前往付款'],
    backToCreate: ['Back to new account', '返回新用户注册'],
    usernameTaken: ['This User ID is taken. Choose another User ID; your email and plan are unchanged.', '这个用户名已被使用。请更换用户名后重新点击付款按钮；邮箱和套餐无需重填。'],
    loginHelp: ['Already started checkout? Sign in with your original User ID. The code is sent only to the email registered to that account.', '曾经进入过付款页？请使用原用户 ID 登录。验证码只发送到该账号已登记的邮箱。'],
    user: ['Registered User ID', '已登记的用户 ID'], code: ['Email verification code', '邮箱验证码'],
    send: ['Send verification code', '发送验证码'], verify: ['Verify and sign in', '验证并登录'],
    continue: ['Continue with selected plan', '继续所选套餐付款'],
    existing: ['An account already uses this email, possibly from an earlier checkout. Verify its registered User ID below, then continue to payment. No need to create another account.', '这个邮箱已有账号，可能是在刚才进入付款页时创建的。请用该账号的用户名接收验证码，登录后继续付款，无需重复注册。'],
    checking: ['Checking sign-in status…', '正在确认登录状态…'],
    creating: ['Opening secure checkout… Please do not click again.', '正在打开安全付款页，请勿重复点击。'],
    session: ['Unable to confirm sign-in status. Please retry when your connection is stable. No new checkout was requested.', '暂时无法确认登录状态，请待网络稳定后重试。本次未请求创建新的付款页面。'],
    expired: ['Your session has expired. Sign in below to continue.', '登录已失效，请在下方重新登录后继续。'],
    sending: ['Requesting a verification code…', '正在请求验证码…'],
    sent: ['If the User ID is registered and eligible, a code will be sent to its registered email. Check your inbox and spam folder. You can request another code after 60 seconds.', '如果用户 ID 已登记且可登录，验证码会发到登记邮箱。请检查收件箱和垃圾邮件；60 秒后可重新请求。'],
    sendError: ['Unable to request a code. Check the original User ID and try again later, or contact support@darrius.ai.', '验证码请求暂未成功，请核对原用户 ID 后稍后重试，或联系 support@darrius.ai。'],
    userRequired: ['Enter your original User ID.', '请输入原用户 ID。'],
    codeRequired: ['Enter the six-digit email verification code.', '请输入邮件中的六位验证码。'],
    verifying: ['Verifying your sign-in…', '正在验证登录…'],
    verifyError: ['The code is invalid or expired. Check the User ID and code, or request a new code.', '验证码错误或已过期。请核对用户 ID 和验证码，或重新请求验证码。'],
    cookieError: ['Verification succeeded, but sign-in could not be confirmed. Allow cookies for darrius.ai and try again.', '验证码已验证，但登录状态未能确认。请允许 darrius.ai 使用 Cookie 后重试。'],
    ready: ['Signed in. Check the account shown above, then continue your selected plan below.', '已登录。请核对上方账号，再点击下方按钮继续所选套餐付款。'],
    active: ['This account already has an active subscription or trial. Use Billing Portal to manage it.', '该账号已有有效订阅或试用，请使用账单管理查看或调整。'],
    missingEmail: ['This account has no billing email. Please contact support@darrius.ai.', '该账号缺少账单邮箱，请联系 support@darrius.ai。'],
    planError: ['This plan is unavailable. Refresh the page and choose it again.', '该套餐暂不可用，请刷新页面重新选择。'],
    network: ['Checkout was not confirmed. Check your connection and retry. If you are asked to sign in, use the User ID entered here; an earlier request may have created your account.', '付款页面未能确认打开。请检查网络后重试。如提示登录，请使用刚才填写的用户 ID；之前的请求可能已创建账号。'],
    server: ['Unable to open checkout. Please retry or contact support@darrius.ai with the error code below. No payment was submitted on this page.', '暂时无法打开付款页，请重试或把下方错误代码告知 support@darrius.ai。本页面未提交任何付款。'],
    referral: ['The referral code could not be applied. Check the code, or clear this optional field and try again.', '邀请码未能使用，请核对邀请码，或清空这个选填项后重试。'],
    discountUnavailable: ['Your referral discount could not be confirmed. No full-price checkout was opened. Retry shortly; if asked to sign in, use the User ID you just entered.', '暂时无法确认推荐八折优惠，本次未打开原价付款页。请稍后重试；如提示登录，请使用刚才填写的用户 ID。'],
    paymentPending: ['A subscription or payment is already being processed. Refresh your subscription status or open Billing Portal; do not start another subscription.', '已有订阅或付款正在处理中。请刷新订阅状态，或打开账单管理查看，请勿重复订阅。'],
    discountReview: ['Your previous checkout needs verification. Contact support@darrius.ai with your User ID before paying again.', '上一笔付款页面需要核对，请提供用户 ID 联系 support@darrius.ai，核对前请勿重复付款。']
  };
  const text = key => messages[key]?.[document.documentElement.lang.startsWith('zh') ? 1 : 0] || key;
  function status(key, kind = 'info', detail = '') {
    statusKey = key; statusKind = kind; statusDetail = detail;
    const el = $('checkoutFlowStatus');
    if (el) { el.hidden = false; el.textContent = text(key) + (detail ? ' (' + detail + ')' : ''); el.dataset.kind = kind; }
  }
  function render() {
    const loggingIn = !$('checkoutLogin')?.hidden;
    if ($('plans')) $('plans').hidden = loggingIn;
    if ($('referralEntry')) $('referralEntry').hidden = loggingIn;
    document.querySelectorAll('[data-checkout-text]').forEach(el => { el.textContent = text(el.dataset.checkoutText); });
    if (statusKey) status(statusKey, statusKind, statusDetail);
    const resume = $('checkoutResume');
    if (resume) { resume.hidden = !selectedKey || !signedInUser; resume.textContent = text('continue') + (selectedKey ? ' · ' + (window.AccountI18n?.plan(selectedKey, selectedKey) || selectedKey) : ''); }
    document.querySelectorAll('[data-act="subscribe"]').forEach(el => { el.textContent = text(signedInUser ? 'pay' : 'createPay'); });
    document.body?.classList.toggle('account-authenticated',!!signedInUser);
    lock();
  }
  function lock() {
    document.querySelectorAll('[data-act="subscribe"]').forEach(el => { el.disabled = busy || authBusy; });
    for (const id of ['checkoutResume','checkoutLoginVerify','checkoutLoginUser','checkoutLoginCode']) { if ($(id)) $(id).disabled = busy || authBusy; }
    if ($('checkoutLoginSend')) $('checkoutLoginSend').disabled = busy || authBusy || Date.now() < cooldownUntil;
  }
  function remember(userId) {
    try { sessionStorage.setItem(storageKey, JSON.stringify({plan:selectedKey,user_id:userId || '',at:Date.now()})); } catch (_) {}
  }
  function restore() {
    try {
      const draft = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (!draft || Date.now() - draft.at > 86400000 || !allowedPlans.includes(draft.plan)) return;
      selectedKey = draft.plan;
      if ($('checkoutLoginUser')) $('checkoutLoginUser').value = String(draft.user_id || '').slice(0,64);
      if ($('checkoutUserId') && !$('checkoutUserId').value) $('checkoutUserId').value = String(draft.user_id || '').slice(0,64);
    } catch (_) {}
  }
  function showLogin(key = '', userId = '') {
    const panel = $('checkoutLogin');
    if (!panel) return;
    panel.hidden = false;
    if ($('checkoutIdentity')) $('checkoutIdentity').hidden = true;
    if ($('checkoutSignIn')) $('checkoutSignIn').hidden = true;
    if (userId) $('checkoutLoginUser').value = userId;
    if (key) status(key, 'warning');
    panel.scrollIntoView({behavior:'smooth',block:'center'});
    render();
    $('checkoutLoginUser').focus();
  }
  async function request(path, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(base + path, {method:payload === undefined ? 'GET' : 'POST',credentials:'include',cache:'no-store',signal:controller.signal,
        headers:payload === undefined ? {Accept:'application/json'} : {'Content-Type':'application/json'},
        ...(payload === undefined ? {} : {body:JSON.stringify(payload)})});
      const data = await response.json();
      return {response,data};
    } finally { clearTimeout(timer); }
  }
  async function session() {
    const {response,data} = await request('/api/auth/session');
    if (response.status === 401 && data.authenticated === false) return null;
    if (!response.ok || data.authenticated !== true || !data.user_id) throw new Error('session_unavailable');
    return String(data.user_id);
  }
  function publish(user, fromStatus = false) {
    if (!fromStatus) window.DARRIUS_ACCOUNT_INVALIDATE_STATUS?.();
    signedInUser = user || '';
    if (window.__AUTH_USER_ID__ !== user) window.__ENTITLEMENT__ = null;
    window.__AUTH_USER_ID__ = user;
    if ($('checkoutIdentity')) $('checkoutIdentity').hidden = !!user || !$('checkoutLogin').hidden;
    if ($('checkoutSignIn')) $('checkoutSignIn').hidden = !!user || !$('checkoutLogin').hidden;
    if (user && $('checkoutLogin')) $('checkoutLogin').hidden = true;
    render();
  }
  async function start(plan) {
    if (busy || authBusy) return;
    if (!plan || !allowedPlans.includes(plan.key) || !plan.price_id) { status('planError','error'); return; }
    selectedKey = plan.key;
    busy = true; lock(); status('checking');
    const wasSignedIn = !!window.__AUTH_USER_ID__;
    let user;
    try { user = await session(); } catch (_) { busy=false; lock(); status('session','error'); return; }
    publish(user);
    try {
      if (!user && wasSignedIn) { showLogin('expired'); return; }
      const userInput = $('checkoutUserId'), emailInput = $('checkoutEmail');
      if (!user) {
        userInput.value = userInput.value.trim(); emailInput.value = emailInput.value.trim();
        if (!userInput.reportValidity() || !emailInput.reportValidity()) return;
      }
      const payload = {plan:plan.key,price_id:plan.price_id};
      if (!user) { payload.user_id = userInput.value; payload.email = emailInput.value; }
      const code = $('checkoutReferral')?.value.trim();
      if (code) payload.dref_code = code;
      remember(user || payload.user_id);
      status('creating');
      const {response,data} = await request('/api/billing/checkout',payload);
      const url = data.checkout_url || data.url;
      if (response.ok && data.ok === true && url) {
        // Only the server may choose a Stripe checkout URL; reject unexpected destinations.
        const target = new URL(url);
        if (target.protocol !== 'https:' || target.hostname !== 'checkout.stripe.com') throw new Error('invalid_checkout_url');
        window.location.href = target.href;
        return;
      }
      const error = data.error || 'checkout_failed';
      if (error === 'user_id_unavailable') {
        $('checkoutLogin').hidden = true;
        $('checkoutIdentity').hidden = false;
        $('checkoutSignIn').hidden = false;
        status('usernameTaken','warning');
        $('checkoutUserId').scrollIntoView({behavior:'smooth',block:'center'});
        $('checkoutUserId').focus();
        return;
      }
      if (error === 'existing_account_requires_sign_in') { showLogin('existing',payload.user_id); return; }
      if (error === 'authentication_required') { publish(null); showLogin('expired'); return; }
      const mapped = {active_subscription_exists:'active',account_email_missing:'missingEmail',invalid_price_id:'planError',plan_price_mismatch:'planError',referral_discount_unavailable:'discountUnavailable',referral_checkout_changed:'discountUnavailable',subscription_payment_pending:'paymentPending',referral_checkout_requires_review:'discountReview',referral_checkout_identity_mismatch:'discountReview'};
      if (mapped[error]) status(mapped[error],'warning');
      else if (code && /referral|code|existing_paying|bound|self_referral/.test(error)) status('referral','warning');
      else status('server','error',String(error).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80));
    } catch (_) { status('network','error'); }
    finally { busy=false; render(); if (!$('checkoutLogin').hidden) $('checkoutLoginUser').focus(); }
  }
  async function sendCode() {
    if (authBusy || busy || Date.now() < cooldownUntil) return;
    const userId = $('checkoutLoginUser').value.trim();
    if (!userId) { status('userRequired','warning'); return; }
    authBusy=true;lock();status('sending');
    try {
      const {response} = await request('/api/auth/migration/request',{user_id:userId});
      if (!response.ok) { status('sendError','error'); return; }
      cooldownUntil=Date.now()+60000; setTimeout(lock,60050);
      status('sent');
    } catch (_) { status('sendError','error'); }
    finally { authBusy=false;lock(); if (statusKey === 'sent') $('checkoutLoginCode').focus(); }
  }
  async function verifyCode() {
    if (authBusy || busy) return;
    const userId=$('checkoutLoginUser').value.trim();
    const code=$('checkoutLoginCode').value.replace(/[０-９]/g,c=>String(c.charCodeAt(0)-0xFF10)).replace(/[\s-]/g,'');
    if (!userId) { status('userRequired','warning'); return; }
    if (!/^\d{6}$/.test(code)) { status('codeRequired','warning'); return; }
    authBusy=true;lock();status('verifying');
    try {
      const {response,data}=await request('/api/auth/migration/verify',{user_id:userId,code});
      if (!response.ok || data.authenticated !== true) { status('verifyError','error'); return; }
      const user=await session();
      if (!user) { status('cookieError','error'); return; }
      publish(user); $('checkoutLoginCode').value=''; remember(user);
      await window.DARRIUS_ACCOUNT_REFRESH_STATUS?.();
      status('ready');
    } catch (_) { status('cookieError','error'); }
    finally { authBusy=false;render(); $('checkoutFlowStatus')?.scrollIntoView({behavior:'smooth',block:'center'}); }
  }
  function init() {
    restore();render();
    $('checkoutSignIn')?.addEventListener('click',()=>showLogin('', $('checkoutUserId')?.value.trim()));
    $('checkoutNewAccount')?.addEventListener('click',()=>{
      $('checkoutLogin').hidden=true; $('checkoutIdentity').hidden=false; $('checkoutSignIn').hidden=false;
      statusKey=''; $('checkoutFlowStatus').hidden=true; render(); $('checkoutUserId').focus();
    });
    $('checkoutLoginSend')?.addEventListener('click',sendCode);
    $('checkoutLoginVerify')?.addEventListener('click',verifyCode);
    $('checkoutResume')?.addEventListener('click',()=>start(plans.find(p=>p.key===selectedKey)));
    $('checkoutLoginCode')?.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();verifyCode();}});
    document.addEventListener('darrius:language-changed',render);
    window.addEventListener('pageshow',()=>{busy=false;lock();});
  }
  window.DarriusCheckout = {start,showLogin,sendCode,verifyCode,setPlans(value){plans=value;render();},syncSession(user){publish(user,true);}};
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
