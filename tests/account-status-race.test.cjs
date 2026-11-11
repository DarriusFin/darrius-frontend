const fs=require('fs'),vm=require('vm'),assert=require('assert');
const root=process.argv[2]||require('path').resolve(__dirname,'..');
const source=fs.readFileSync(root+'/js/account.manage.fix.js','utf8');
const response=(status,data)=>({status,ok:status===200,text:async()=>JSON.stringify(data)});
function setup(){
 const pending=[],els=new Map();const el=id=>{if(!els.has(id))els.set(id,{classList:{add(){},remove(){}},addEventListener(){}});return els.get(id);};
 const w={__API_BASE__:'https://api.example',DarriusCheckout:{syncSession(user){w.__AUTH_USER_ID__=user;}}};
 vm.runInNewContext(source,{window:w,document:{readyState:'loading',getElementById:el,addEventListener(){}},location:{search:''},URLSearchParams,console:{error(){}},fetch:()=>new Promise(r=>pending.push(r))});
 return {w,pending};
}
(async()=>{
 const a=setup(),old=a.w.DARRIUS_ACCOUNT_REFRESH_STATUS(),fresh=a.w.DARRIUS_ACCOUNT_REFRESH_STATUS();
 a.pending[1](response(200,{authenticated:true,user_id:'QA'}));await new Promise(r=>setImmediate(r));
 a.pending[2](response(200,{has_access:false,user_id:'QA'}));await fresh;
 a.pending[0](response(401,{authenticated:false}));await old;assert.equal(a.w.__AUTH_USER_ID__,'QA');
 const b=setup(),stale=b.w.DARRIUS_ACCOUNT_REFRESH_STATUS();b.w.DARRIUS_ACCOUNT_INVALIDATE_STATUS();b.w.__AUTH_USER_ID__='VerifiedQA';
 b.pending[0](response(401,{authenticated:false}));await stale;assert.equal(b.w.__AUTH_USER_ID__,'VerifiedQA');
 const transient=b.w.DARRIUS_ACCOUNT_REFRESH_STATUS();b.pending[1](response(503,{}));await transient;assert.equal(b.w.__AUTH_USER_ID__,'VerifiedQA');
 console.log('PASS account status: stale logout ignored, verified checkout session supersedes old refresh, outage does not clear identity');
})().catch(e=>{console.error(e);process.exitCode=1;});
