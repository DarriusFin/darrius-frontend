const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../js/payout.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){
 const nodes=new Map();
 const el=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',value:'',files:[],addEventListener(){},dispatchEvent(){}});return nodes.get(id);};
 const requests=[];
 vm.runInNewContext(source,{location:{pathname:'/payout.html',search:'?lang=zh'},window:{addEventListener(){}},document:{getElementById:el,documentElement:{},querySelectorAll:()=>[],querySelector:()=>null},URLSearchParams,AbortController,setTimeout,clearTimeout,TypeError,Event,fetch:()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))});
 const respond=(status,data)=>requests.shift().resolve({ok:status===200,json:async()=>data});
 return {el,requests,respond};
}
test('disabled payout never shows bank inputs, including language switch; retry can recover',async()=>{
 const app=setup();
 assert(!app.el('content').innerHTML.includes('<form'));
 app.respond(503,{error:'payout_not_configured'});await tick();
 assert(!app.el('content').innerHTML.includes('<form'));
 assert.match(app.el('message').textContent,/暂未开放/);
 app.el('language').onclick();
 assert.match(app.el('message').textContent,/not available yet/);
 assert(!app.el('content').innerHTML.includes('<form'));
 app.el('retry').onclick();app.respond(200,{version:0,status:'NOT_SUBMITTED'});await tick();
 assert.match(app.el('content').innerHTML,/<form/);
 app.el('refresh').onclick();
 assert(!app.el('content').innerHTML.includes('<form'));
 app.respond(401,{error:'authentication_required'});await tick();
 assert(!app.el('content').innerHTML.includes('<form'));
 assert.match(app.el('message').textContent,/Sign in/);
});
test('network failure keeps sensitive form hidden and offers retry',async()=>{
 const app=setup();app.requests.shift().reject(new TypeError('offline'));await tick();
 assert(!app.el('content').innerHTML.includes('<form'));
 assert.match(app.el('content').innerHTML,/id="retry"/);
 assert.match(app.el('message').textContent,/网络连接失败/);
});
