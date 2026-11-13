const fs = require('fs'), vm = require('vm'), assert = require('assert');
const root = process.argv[2] || require('path').resolve(__dirname, '..');
const source = fs.readFileSync(root + '/js/checkout.flow.js', 'utf8');
const response = (status, data) => ({ok:status>=200&&status<300,status,json:async()=>data});
const guest = () => response(401,{authenticated:false});
const authenticated = () => response(200,{authenticated:true,user_id:'CheckoutQA'});
const plan = {key:'monthly',price_id:'price_monthly'};
function setup(fetcher, stored = null) {
  const elements = new Map(), events = {}, requests = [], storage = new Map();
  if(stored) storage.set('darrius_checkout_draft_v1',JSON.stringify(stored));
  const el = id => {
    if(!elements.has(id)) elements.set(id,{value:'',textContent:'',hidden:id==='checkoutLogin',dataset:{},disabled:false,
      listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},reportValidity(){return !!this.value;},focus(){},scrollIntoView(){}});
    return elements.get(id);
  };
  const buttons = [el('subscribe1'),el('subscribe2')];
  const w = {location:{href:''},addEventListener(type,fn){events[type]=fn;}};
  const document = {documentElement:{lang:'zh'},readyState:'complete',getElementById:el,
    querySelectorAll:sel=>sel==='[data-act="subscribe"]'?buttons:[],addEventListener(){}};
  vm.runInNewContext(source,{window:w,document,URL,AbortController,Date,sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
    setTimeout:()=>1,clearTimeout(){},fetch:async(url,options)=>{requests.push({url,options});return fetcher(url,options);}});
  el('checkoutUserId').value=' CheckoutQA ';el('checkoutEmail').value=' qa@example.com ';
  w.DarriusCheckout.setPlans([plan]);
  return {w,el,requests,storage,buttons,events,api:w.DarriusCheckout};
}
(async()=>{
  // Fresh customer reaches checkout; duplicate clicks cannot race a slow session lookup.
  let release;
  const a=setup(async url=>url.endsWith('/session')?new Promise(r=>release=r):response(200,{ok:true,url:'https://checkout.stripe.com/c/pay/test'}));
  const first=a.api.start(plan);await a.api.start(plan);assert.equal(a.requests.length,1);assert(a.buttons.every(b=>b.disabled));
  release(guest());await first;
  const body=JSON.parse(a.requests[1].options.body);
  assert.equal(body.user_id,'CheckoutQA');assert.equal(body.email,'qa@example.com');assert.equal(a.w.location.href,'https://checkout.stripe.com/c/pay/test');
  assert(a.requests.every(r=>r.options.credentials==='include'&&r.options.cache==='no-store'));
  assert(!a.storage.get('darrius_checkout_draft_v1').includes('example.com'));

  // Existing unpaid customer: log in, confirm cookie session, explicitly resume the original plan.
  let loggedIn=false;
  const b=setup(async(url,options)=>{
    if(url.endsWith('/session'))return loggedIn?authenticated():guest();
    if(url.endsWith('/request'))return response(202,{ok:true});
    if(url.endsWith('/verify')){assert.equal(JSON.parse(options.body).code,'123456');loggedIn=true;return response(200,{authenticated:true});}
    return loggedIn?response(200,{ok:true,url:'https://checkout.stripe.com/c/pay/resume'}):response(409,{error:'existing_account_requires_sign_in'});
  });
  b.el('checkoutReferral').value='CODE12345678';await b.api.start(plan);
  assert.equal(b.el('checkoutLogin').hidden,false);assert.equal(b.el('checkoutLoginUser').value,'CheckoutQA');
  assert(b.el('checkoutFlowStatus').textContent.includes('已有账号'));assert(!b.buttons[0].disabled);
  await b.api.sendCode();await b.api.sendCode();assert.equal(b.requests.filter(r=>r.url.endsWith('/request')).length,1);
  b.el('checkoutLoginCode').value='１２３ ４５６';await b.api.verifyCode();
  assert.equal(b.w.__AUTH_USER_ID__,'CheckoutQA');assert.equal(b.el('checkoutResume').hidden,false);assert.equal(b.el('checkoutLoginCode').value,'');
  assert.equal(b.w.location.href,'');await b.el('checkoutResume').listeners.click();
  const resumed=JSON.parse(b.requests.at(-1).options.body);
  assert.equal(resumed.plan,'monthly');assert.equal(resumed.dref_code,'CODE12345678');assert(!('user_id' in resumed));assert(!('email' in resumed));
  assert.equal(b.w.location.href,'https://checkout.stripe.com/c/pay/resume');

  // A successful OTP response alone is not authentication.
  const c=setup(async url=>url.endsWith('/verify')?response(200,{authenticated:true}):guest());
  c.el('checkoutLoginUser').value='CheckoutQA';c.el('checkoutLoginCode').value='123456';await c.api.verifyCode();
  assert(!c.w.__AUTH_USER_ID__);assert(c.el('checkoutFlowStatus').textContent.includes('未能确认'));assert.equal(c.w.location.href,'');

  // Session errors/expiry must not be converted into guest registration.
  const d=setup(async()=>response(503,{}));await d.api.start(plan);assert.equal(d.requests.length,1);assert(!d.buttons[0].disabled);
  const e=setup(async()=>guest());e.w.__AUTH_USER_ID__='CheckoutQA';await e.api.start(plan);
  assert.equal(e.requests.length,1);assert.equal(e.el('checkoutLogin').hidden,false);assert.equal(e.w.__AUTH_USER_ID__,null);

  // Active subscriptions, unsafe redirects, bad inputs and server codes have visible feedback.
  for(const [result,expected] of [[response(409,{error:'active_subscription_exists'}),'有效订阅'],[response(500,{error:'billing_down'}),'billing_down'],[response(200,{ok:true,url:'https://evil.example/'}),'未能确认']]) {
    const x=setup(async url=>url.endsWith('/session')?guest():result);await x.api.start(plan);
    assert(x.el('checkoutFlowStatus').textContent.includes(expected));assert.equal(x.w.location.href,'');assert(!x.buttons[0].disabled);
  }
  const f=setup(async()=>guest());f.el('checkoutEmail').value='';await f.api.start(plan);assert.equal(f.requests.length,1);
  await f.api.start({key:'monthly'});assert.equal(f.requests.length,1);
  const g=setup(async()=>authenticated(),{plan:'monthly',user_id:'CheckoutQA',at:Date.now()});
  assert.equal(g.el('checkoutResume').hidden,true);g.api.syncSession('CheckoutQA');assert.equal(g.el('checkoutResume').hidden,false);
  const taken=setup(async url=>url.endsWith('/session')?guest():response(409,{error:'user_id_unavailable'}));
  await taken.api.start(plan);
  assert(taken.el('checkoutFlowStatus').textContent.includes('更换用户名'));
  assert(taken.el('checkoutLogin').hidden);assert(!taken.el('checkoutIdentity').hidden);
  assert.equal(taken.el('checkoutEmail').value,'qa@example.com');
  assert(taken.buttons.every(el=>el.textContent.includes('创建账号')));
  taken.api.showLogin();assert(taken.el('checkoutIdentity').hidden);
  taken.api.syncSession(null);assert(taken.el('checkoutIdentity').hidden,'late signed-out refresh must preserve selected login mode');
  taken.el('checkoutNewAccount').listeners.click();assert(taken.el('checkoutLogin').hidden);assert(!taken.el('checkoutIdentity').hidden);
  assert(g.buttons.every(el=>el.textContent==='前往付款'));
  for (const [error, expected] of [['referral_discount_unavailable','未打开原价付款页'],
      ['subscription_payment_pending','请勿重复订阅'],['referral_checkout_requires_review','需要核对']]) {
    const x=setup(async url=>url.endsWith('/session')?guest():response(409,{error}));
    x.el('checkoutReferral').value='VALIDCODE';await x.api.start(plan);
    assert(x.el('checkoutFlowStatus').textContent.includes(expected));
    assert.equal(x.w.location.href,'');assert(!x.buttons[0].disabled);
  }
  console.log('PASS checkout recovery and clear new-account flow, username collision, login mode stability, action labels');
})().catch(error=>{console.error(error);process.exitCode=1;});
