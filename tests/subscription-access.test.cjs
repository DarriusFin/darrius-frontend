const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function fixture() {
  const window = new EventTarget(), document = new EventTarget();
  const elements = new Map(), intervals = new Map();
  let nextTimer = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', style: {}, disabled: false,
      classList: {add(){}, remove(){}}, removeAttribute(){},
      addEventListener(){}, appendChild(){},
    });
    return elements.get(id);
  };
  const quick = [element('quick1'), element('quick2')];
  element('tfQuick').querySelectorAll = () => quick;
  document.getElementById = id => id === 'planSelect' ? null : element(id);
  document.createElement = () => ({textContent: ''});
  document.readyState = 'complete';
  window.API_BASE = 'https://api.example.test';
  window.location = {search: ''};
  window.setTimeout = setTimeout; window.clearTimeout = clearTimeout;
  class CustomEvent extends Event {constructor(type, opts = {}) {super(type);this.detail = opts.detail;}}
  const context = vm.createContext({window, document, CustomEvent, console,
    URLSearchParams, AbortController, setTimeout, clearTimeout,
    location: window.location,
    setInterval(fn){const id = ++nextTimer;intervals.set(id, fn);return id;},
    clearInterval(id){intervals.delete(id);},
  });
  const run = file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, {detail}));
  const policy = (has_access, bucket = 'TRIAL') => ({ok:true, user_id:'Fixture', has_access, bucket});
  const installGate = () => {
    run('js/upgrade.guard.js');
    // Exercise any legacy second gate too, so competing writers cannot hide a failure.
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      if (match[1].includes('function darriusGateEnforcer')) vm.runInContext(match[1], context);
    }
  };
  const tick = count => {for(let i=0;i<count;i++) for(const fn of [...intervals.values()]) fn();};
  const assertControls = locked => {
    for(const id of ['symbol','tf','loadBtn','quick1','quick2']) {
      assert.equal(element(id).disabled, locked, id+' disabled');
      assert.equal(element(id).style.pointerEvents, locked ? 'none' : 'auto', id+' pointer events');
    }
  };
  return {window, context, element, run, emit, policy, installGate, tick, assertControls};
}

test('trial confirmed after the old 30-second window unlocks all stock controls', () => {
  const f=fixture();f.installGate();f.tick(121);
  f.window.__AUTH_USER_ID__='Fixture';f.window.__ENTITLEMENT__=f.policy(true);
  f.emit('darrius:subscription-status', f.window.__ENTITLEMENT__);f.tick(1);
  f.assertControls(false);
});

test('logout and expired access relock controls after a trial was unlocked', () => {
  const f=fixture();f.window.__AUTH_USER_ID__='Fixture';f.window.__ENTITLEMENT__=f.policy(true);
  f.installGate();f.tick(1);f.assertControls(false);
  f.window.__ENTITLEMENT__=f.policy(false,'EXPIRED');
  f.emit('darrius:subscription-status',f.window.__ENTITLEMENT__);f.tick(1);f.assertControls(true);
  f.window.__ENTITLEMENT__=f.policy(true);f.emit('darrius:subscription-status',f.window.__ENTITLEMENT__);
  f.window.__AUTH_USER_ID__=null;f.emit('darrius:auth-changed',{authenticated:false});
  f.assertControls(true);
});

test('successful API response or translated display text does not grant access', () => {
  const f=fixture();f.window.__AUTH_USER_ID__='Fixture';f.window.__ENTITLEMENT__=f.policy(false,'DEMO');
  f.element('subStatusText').textContent='No active subscription';
  f.installGate();f.tick(1);f.assertControls(true);
});

test('a policy for another account cannot unlock stock controls', () => {
  const f=fixture();f.window.__AUTH_USER_ID__='Other';f.window.__ENTITLEMENT__=f.policy(true);
  f.installGate();f.tick(1);f.assertControls(true);
});

test('homepage without a plan selector still finishes the plans label', async () => {
  const f=fixture();f.context.fetch=async()=>({ok:true,text:async()=>JSON.stringify({ok:true,plans:[{key:'monthly',price_id:'price_fixture'}]})});
  f.run('js/subscription.js');await f.window.Subscription.initPlans();
  assert.equal(f.element('planStatus').textContent,'1 Plans Available');
});

const response = policy => ({ok:true, text:async()=>JSON.stringify(policy)});
test('late subscription response after logout cannot restore trial access', async () => {
  const f=fixture();let resolve;
  f.context.fetch=()=>new Promise(r=>{resolve=r;});
  f.run('js/subscription.js');f.installGate();f.window.__AUTH_USER_ID__='Fixture';
  const pending=f.window.Subscription.refreshSubscriptionStatus();
  f.window.__AUTH_USER_ID__=null;
  await f.window.Subscription.refreshSubscriptionStatus();
  resolve(response(f.policy(true)));await pending;
  assert.equal(f.window.__ENTITLEMENT__,null);f.assertControls(true);
});

test('newer denied policy wins over a slow older trial response', async () => {
  const f=fixture(), resolvers=[];
  f.context.fetch=()=>new Promise(r=>resolvers.push(r));
  f.run('js/subscription.js');f.installGate();f.window.__AUTH_USER_ID__='Fixture';
  const older=f.window.Subscription.refreshSubscriptionStatus();
  const newer=f.window.Subscription.refreshSubscriptionStatus();
  resolvers[1](response(f.policy(false,'EXPIRED')));await newer;
  resolvers[0](response(f.policy(true)));await older;
  assert.equal(f.window.__ENTITLEMENT__.has_access,false);f.assertControls(true);
});

test('subscription refresh failure relocks a previously enabled trial', async () => {
  const f=fixture();let fail=false;
  f.context.fetch=async()=>{if(fail)throw Error('offline');return response(f.policy(true));};
  f.run('js/subscription.js');f.installGate();f.window.__AUTH_USER_ID__='Fixture';
  await f.window.Subscription.refreshSubscriptionStatus();f.assertControls(false);
  fail=true;await f.window.Subscription.refreshSubscriptionStatus();f.assertControls(true);
});
