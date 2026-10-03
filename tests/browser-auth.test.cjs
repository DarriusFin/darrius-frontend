const vm=require('vm'),fs=require('fs'),assert=require('assert');
const source=fs.readFileSync(process.argv[2]+'/js/account.auth.js','utf8');
const response=(status,data)=>({ok:status>=200&&status<300,status,text:async()=>JSON.stringify(data)});
function setup(fetcher){
 const els=new Map();const el=id=>{if(!els.has(id))els.set(id,{value:'',textContent:'',style:{},setAttribute(){},focus(){},addEventListener(){}});return els.get(id);};
 const w={addEventListener(){},dispatchEvent(){},location:{},API_BASE:'https://api.darrius.ai'};
 const context={window:w,document:{getElementById:el,readyState:'loading',addEventListener(){}},fetch:fetcher,AbortController,setTimeout,clearTimeout,CustomEvent:class{},console:{error(){}}};
 vm.runInNewContext(source,context);return {auth:w.AccountAuth,el,w};
}
(async()=>{
 let requests=[];let resolvers=[];
 const a=setup((url,options)=>{requests.push({url,options});return new Promise(r=>resolvers.push(r));});
 const old=a.auth.refreshSession(),fresh=a.auth.refreshSession();
 resolvers[1](response(200,{authenticated:true,user_id:'User'}));await fresh;
 resolvers[0](response(401,{authenticated:false}));await old;
 assert.equal(a.w.__AUTH_USER_ID__,'User');assert.equal(requests[0].options.cache,'no-store');assert.equal(requests[0].options.credentials,'include');
 assert(!requests[0].options.headers['Content-Type']);
 let verifyResolve;let count=0;let code;
 const b=setup(async(url,options)=>{if(url.endsWith('/verify')){count++;code=JSON.parse(options.body).code;return new Promise(r=>verifyResolve=r);}return response(200,{authenticated:true,user_id:'User'});});
 b.el('userId').value='User';b.el('verificationCode').value='１２３ ４５６';
 const verify=b.auth.verifyCode();await b.auth.verifyCode();assert.equal(count,1);assert.equal(code,'123456');
 verifyResolve(response(200,{authenticated:true}));await verify;assert.equal(b.w.__AUTH_USER_ID__,'User');
 assert.equal(b.el('verificationCode').value,'');
 await b.auth.refreshSession();assert.equal(b.el('verifyCodeBtn').disabled,false);
 let fail=false;const c=setup(async()=>{if(fail)throw Error('offline');return response(200,{authenticated:true,user_id:'User'});});
 await c.auth.refreshSession();fail=true;await c.auth.refreshSession();assert.equal(c.w.__AUTH_USER_ID__,'User');
 const d=setup(async()=>response(401,{authenticated:false}));d.w.__AUTH_USER_ID__='User';await d.auth.refreshSession();assert.equal(d.w.__AUTH_USER_ID__,null);
 console.log('PASS: stale session race, credentialed uncached GET, OTP normalization, duplicate submit guard, lock release, transient failure, real 401 logout');
})();
