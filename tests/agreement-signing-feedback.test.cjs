const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../js/referral-account.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

// Minimal DOM for the real prepared-signing submit handler; no production requests.
function setup(language='zh'){
 const nodes=new Map(),requests=[];
 class Element{
  constructor(tag='div'){this.tag=tag;this.children=[];this.handlers={};this.dataset={};this.attrs={};this.textContent='';this.hidden=false;this.disabled=false;}
  set id(value){this._id=value;nodes.set(value,this);}get id(){return this._id;}
  set innerHTML(value){this.html=value;if(this.tag==='form'){
   this.elements={};for(const name of ['signer_name','details','intent']){const el=new Element('input');el.value=name==='signer_name'?'Test Signer':'';el.checked=true;this.elements[name]=el;this.children.push(el);}
   this.submit=new Element('button');this.submit.textContent='Confirm';this.children.push(this.submit);
  }}
  get innerHTML(){return this.html;}
  addEventListener(type,fn){this.handlers[type]=fn;}
  appendChild(el){this.children.push(el);return el;}
  after(el){this.sibling=el;}
  querySelector(selector){if(selector==='button[type="submit"]')return this.submit;if(selector==='input[name="signer_name"]')return this.elements.signer_name;throw new Error(selector);}
  querySelectorAll(selector){return selector==='input,button'?this.children.filter(el=>['input','button'].includes(el.tag)):[];}
  setAttribute(key,value){this.attrs[key]=value;}removeAttribute(key){delete this.attrs[key];}
  scrollIntoView(){this.scrolled=true;}focus(){this.focused=true;}
  reset(){this.resetCalled=true;}remove(){this.removed=true;nodes.delete(this.id);}
 }
 const el=id=>{if(!nodes.has(id)){const node=new Element();node.id=id;}return nodes.get(id);};
 const context={window:{addEventListener(){}},document:{getElementById:el,createElement:tag=>new Element(tag),querySelectorAll:()=>[],addEventListener(){}},location:{search:'?lang='+language},URLSearchParams,AbortController,setTimeout,clearTimeout,TypeError,fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}))};
 // Expose the entry point without logging in or changing production source exports.
 vm.runInNewContext(source.replace('setInterval(controls,1000);render();run(refresh);','window.signingTest={preparedSigningForm};'),context);
 context.window.signingTest.preparedSigningForm({id:7,number:'FICTIONAL-7',pdf_sha256:'fictional-hash'});
 const form=el('preparedSignForm'),status=el('preparedSignStatus');
 return {el,form,status,requests,submit:()=>form.handlers.submit({preventDefault(){}}),respond(code,data){requests.shift().resolve({ok:code>=200&&code<300,status:code,json:async()=>data});}};
}

test('name mismatch is visible beside the form, retains inputs and allows correction',async()=>{
 const app=setup();app.submit();
 assert.match(app.status.textContent,/正在提交/);assert.equal(app.form.submit.disabled,true);
 assert.equal(JSON.parse(app.requests[0].options.body).signer_name,'Test Signer');
 app.respond(400,{error:'agreement_identity_required'});await tick();
 assert.equal(app.status.dataset.state,'error');assert.match(app.status.textContent,/大小写、空格和姓名顺序/);
 assert.equal(app.status.hidden,false);assert.equal(app.status.scrolled,true);
 assert.equal(app.form.elements.signer_name.value,'Test Signer');assert.equal(app.form.elements.signer_name.focused,true);
 assert.equal(app.form.elements.signer_name.attrs['aria-invalid'],'true');assert.equal(app.form.submit.disabled,false);
 app.form.elements.signer_name.value='TEST SIGNER';app.form.elements.signer_name.handlers.input();
 assert.equal(app.form.elements.signer_name.attrs['aria-invalid'],undefined);
 app.submit();assert.equal(JSON.parse(app.requests[0].options.body).signer_name,'TEST SIGNER');
 app.respond(400,{error:'agreement_identity_required'});await tick();
});

test('duplicate submission is blocked and saved signature remains successful if receipts fail',async()=>{
 const app=setup();app.submit();app.submit();assert.equal(app.requests.length,1);
 app.respond(200,{ok:true,receipt_id:99});await tick();
 assert.equal(app.form.removed,true);assert.equal(app.status.dataset.state,'success');
 assert.match(app.status.textContent,/本人签署已保存/);assert.match(app.requests[0].url,/agreement\/receipts$/);
 app.respond(503,{error:'referral_unavailable'});await tick();
 assert.equal(app.status.dataset.state,'success');assert.match(app.status.textContent,/记录暂时无法刷新/);
 assert.equal(app.requests.length,0);
});

test('network failure and expired sessions display inline and restore retry',async()=>{
 const app=setup('en');app.submit();app.requests.shift().reject(new TypeError('offline'));await tick();
 assert.match(app.status.textContent,/Unable to reach/);assert.equal(app.form.submit.disabled,false);
 app.submit();app.respond(401,{error:'authentication_required'});await tick();
 assert.match(app.status.textContent,/session has expired/);assert.equal(app.status.dataset.state,'error');
 assert.equal(app.form.removed,undefined);assert.equal(app.form.submit.disabled,false);
});

test('successful signature shows pending company status and preserves exact signed payload',async()=>{
 const app=setup('en');app.submit();const payload=JSON.parse(app.requests[0].options.body);
 assert.deepEqual(payload,{pdf_sha256:'fictional-hash',signer_name:'Test Signer',details_confirmed:true,intent_to_sign:true});
 app.respond(200,{ok:true});await tick();app.respond(200,{receipts:[]});await tick();
 assert.match(app.status.textContent,/signature is saved, pending company/);
 assert.equal(app.status.dataset.state,'success');assert.equal(app.form.removed,true);
});
