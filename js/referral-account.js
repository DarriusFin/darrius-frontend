'use strict';
(() => {
 const $=id=>document.getElementById(id);
 const API=(window.API_BASE||'https://api.darrius.ai').replace(/\/+$/,'');
 let saved;try{saved=localStorage.getItem('darrius_language');}catch(_){}
 let lang=(new URLSearchParams(location.search).get('lang')||saved||'en').startsWith('zh')?'zh':'en';
 let ledger=null, agreementDocument=null, agreementChecked=false;
 let account=null, user=null, busy=false, cooldown=0, requestedUser='', generation=0;
 const T=(zh,en)=>lang==='zh'?zh:en;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const errors=()=>({agreement_not_configured:T('正式协议尚未发布，暂不能站内签署。可联系管理员洽谈审核。','The agreement is not yet published. Contact an administrator about manual qualification.'),agreement_confirmation_required:T('协议版本已变更，请重新阅读并确认。','The agreement changed. Read and accept the current version.'),verification_failed:T('验证码无效或已过期，请输入最新验证码。','The code is invalid or expired. Enter the latest code.'),authentication_required:T('登录已过期，请重新登录。','Your session has expired. Please sign in again.'),referral_unavailable:T('推荐资料暂时无法读取，请稍后重试。','Referral details are temporarily unavailable. Please retry.'),invalid_origin:T('请求来源未获允许，请从正式页面重试。','This origin is not allowed. Retry from the official page.')});
 function message(text){$('message').textContent=text;}
 async function api(path,body){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  try{const response=await fetch(API+path,{credentials:'include',cache:'no-store',signal:controller.signal,...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});let data={};try{data=await response.json();}catch(_){}
   if(!response.ok){const error=new Error(errors()[data.error]||(response.status===404?T('此功能尚未部署到正式后端。登录服务仍可使用。','This feature has not been deployed to the live API yet. Sign-in remains available.'):T('请求失败，请稍后重试。','Request failed. Please try again.')));error.status=response.status;throw error;}return data;
  }catch(error){if(error.name==='AbortError'||error instanceof TypeError)throw new Error(T('无法连接账户服务，请检查网络后重试。','Unable to reach the account service. Check your connection and retry.'));throw error;}finally{clearTimeout(timer);}
 }
 function controls(){ $('send').disabled=busy||Date.now()<cooldown;$('verify').disabled=busy;$('logout').disabled=busy;$('send').textContent=Date.now()<cooldown?T('稍后重发','Resend in')+' '+Math.ceil((cooldown-Date.now())/1000)+'s':T('发送验证码','Send verification code'); }
 function signedOut(){generation++;agreementDocument=null;agreementChecked=false;user=null;account=null;ledger=null;requestedUser='';$('account').innerHTML='';$('account').hidden=true;$('login').hidden=false;$('logout').hidden=true;$('verifyForm').hidden=true;$('otp').value='';}
 function render(){
  document.documentElement.lang=lang==='zh'?'zh-CN':'en';document.title=T('DarriusAI · 推荐人中心','DarriusAI · Referral Center');$('languageLabel').textContent=T('中文','English');$('language').setAttribute('aria-label',T('选择语言','Select language'));
  $('dashboard').href='index.html?lang='+lang;$('dashboard').textContent=T('← 返回主界面','← Back to Dashboard');$('logout').textContent=T('退出登录','Sign out');$('title').textContent=T('推荐人中心','Referral Center');$('intro').textContent=T('使用您的 DarriusAI 账户管理推荐人申请与邀请信息。','Manage affiliate applications and invitation details with your DarriusAI account.');
  $('loginTitle').textContent=T('登录账户','Sign in');$('loginHelp').textContent=T('输入已注册的用户 ID，验证码将发送至账户绑定的邮箱。','Enter your registered User ID. A verification code will be sent to the email on your account.');$('userLabel').textContent=T('用户 ID','User ID');$('codeLabel').textContent=T('6 位验证码','6-digit verification code');$('verify').textContent=T('验证并登录','Verify and sign in');$('register').textContent=T('还没有账户？前往注册与订阅','New here? Go to registration and subscriptions');$('register').href='account.html?lang='+(lang==='zh'?'zh-CN':'en');$('footer').textContent=T('账户身份由登录会话验证。','Your account identity is verified by your sign-in session.');controls();
  if(user)renderAccount();
 }
 function renderLedger(){
  let h='<section class="card"><h2>'+T('绑定与佣金','Referrals and commissions')+'</h2>';
  if(!ledger)return h+'<p>'+T('推荐账本尚未开放或暂时无法读取，请稍后刷新。','The referral ledger is not available yet. Please refresh later.')+'</p></section>';
  const states={PENDING:T('等待发放','Pending'),APPLYING:T('正在处理','Processing'),GRANTED:T('已发放','Granted'),REVIEW:T('待人工核对','Under review'),AVAILABLE:T('可结算','Available'),PAID:T('已结清','Settled')};
  if(ledger.binding)h+='<p>'+T('已绑定推荐关系：','Referral linked: ')+esc(ledger.binding.referral_id)+'</p>';
  if(ledger.reward)h+='<p>'+T('额外订阅天数：','Bonus subscription days: ')+ledger.reward.days+' · '+esc(states[ledger.reward.state]||ledger.reward.state)+'</p>';
  h+='<h3>'+T('佣金明细','Commission details')+'</h3>';
  if(!ledger.commissions.length)h+='<p>'+T('暂无已入账佣金。','No recorded commissions yet.')+'</p>';
  else h+='<div style="overflow:auto"><table><thead><tr><th>'+T('来源用户（匿名）','Source (anonymous)')+'</th><th>USD</th><th>'+T('状态','Status')+'</th></tr></thead><tbody>'+ledger.commissions.map(c=>'<tr><td>'+esc(c.referral_id)+'</td><td>'+esc((c.amount/100).toFixed(2))+'</td><td>'+esc(states[c.status]||c.status)+'</td></tr>').join('')+'</tbody></table></div>';
  h+='<h3>'+T('绑定用户','Referred accounts')+'</h3><p>'+T('仅显示匿名编号，不显示用户名或邮箱。','Only anonymous IDs are shown; usernames and emails remain private.')+'</p>';
  for(const r of ledger.referrals)h+='<p>'+esc(r.referral_id)+' · '+(r.first_paid_at?T('首次付款：','First payment: ')+esc(r.first_paid_at.slice(0,10)):T('等待首次付款','Awaiting first payment'))+'</p>';
  return h+'</section>';
 }
 function renderAccount(){
  const names={NOT_APPLIED:T('尚未申请','Not applied'),PENDING:T('等待审核','Pending review'),APPROVED:T('已通过','Approved'),SUSPENDED:T('资格暂停','Suspended'),REJECTED:T('申请未通过','Not approved'),LEGACY_REVIEW_REQUIRED:T('需要重新审核','Re-review required')};
  $('account').hidden=false;$('login').hidden=true;$('logout').hidden=false;
  let html=`<section class="card"><div class="summary"><div><span>${T('当前登录账户','Signed-in account')}</span><strong>${esc(user)}</strong></div><div><span>${T('推荐人资格','Affiliate status')}</span><strong>${account?esc(names[account.affiliate_status]||account.affiliate_status):T('待加载','Awaiting details')}</strong></div></div></section>`;
  if(account){html+=`<section class="card"><h2>${T('推荐计划','Referral program')}</h2><p>${T('佣金比例 30%，佣金期从首次付款起计算 4 个自然月；每月结算一次，无最低金额。符合条件的新用户首次付款获赠 1 天订阅。','Earn 30% commission for 4 calendar months from the first payment. Settlements are monthly with no minimum. Eligible new customers receive 1 bonus subscription day after their first payment.')}</p>`;
   if(account.affiliate_status==='NOT_APPLIED'||account.affiliate_status==='REJECTED')html+=`<p>${T('提交申请后等待资格审核。申请不会自动批准，也不会代您签署协议。','Submit an application for review. Applying does not grant approval or sign an agreement on your behalf.')}</p><button id="apply" class="primary">${account.affiliate_status==='REJECTED'?T('重新提交申请','Resubmit application'):T('提交推荐人申请','Apply to become an affiliate')}</button>`;
   else if(account.affiliate_status==='PENDING')html+=`<p>${T('申请已登记，请等待资格审核与正式协议流程。','Your application is recorded. Await eligibility review and the formal agreement process.')}</p>`;
   if(account.affiliate_status==='LEGACY_REVIEW_REQUIRED')html+='<p>'+T('历史推荐人资料已保留。完成重新审核及正式协议验证后，才能启用邀请功能。','Your historical affiliate record is preserved. Invitations require a new review and a verified agreement.')+'</p>';
   if(account.affiliate_status==='APPROVED'&&account.agreement_verified&&!account.referral_code)html+='<button id="issueCode" class="primary">'+T('生成邀请链接','Create invitation link')+'</button>';
   if(account.affiliate_status==='APPROVED'&&!account.agreement_verified)html+='<p>'+T('资格审核已通过，完成正式协议验证后可启用邀请。','Your application is approved. Invitations become available after agreement verification.')+'</p>';
   if(['PENDING','APPROVED'].includes(account.affiliate_status)&&!account.agreement_verified)html+='<button id="readAgreement">'+T('阅读并确认推荐人协议','Read and accept affiliate agreement')+'</button><div id="agreementPanel"></div>';
   if(account.qualification_method==='MANUAL_REVIEW')html+='<p>'+T('认证方式：人工洽谈审核','Qualification: manual review')+'</p>';
   if(account.referral_code){const link=new URL('account.html',location.href);link.searchParams.set('ref',account.referral_code);link.searchParams.set('lang',lang);html+=`<label for="invite">${T('邀请链接','Invitation link')}</label><input id="invite" readonly value="${esc(link.href)}"><button id="copy">${T('复制链接','Copy link')}</button>`;}
   html+='</section>'+renderLedger();
  }
  html+=`<p><a href="payout.html?lang=${lang}">${T('银行收款与税务资料','Bank and tax details')}</a></p><button id="refresh">${T('刷新账户资料','Refresh account details')}</button>`;$('account').innerHTML=html;
  $('refresh').addEventListener('click',()=>run(refresh));$('apply')?.addEventListener('click',()=>run(async()=>{await api('/api/referral/account/application',{});await refresh();message(T('申请已提交。','Application submitted.'));}));
  $('issueCode')?.addEventListener('click',()=>run(async()=>{await api('/api/referral/account/code',{});await refresh();}));
  if(agreementDocument&&$('agreementPanel'))renderAgreement();
  $('readAgreement')?.addEventListener('click',()=>run(async()=>{agreementDocument=await api('/api/referral/account/agreement');agreementChecked=false;renderAgreement();}));
  $('copy')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('invite').value);message(T('邀请链接已复制。','Invitation link copied.'));}catch(_){$('invite').select();message(T('请复制选中的链接。','Please copy the selected link.'));}});
 }
 function renderAgreement(){const document=agreementDocument;
   $('agreementPanel').innerHTML='<h3>'+T('协议版本：','Agreement version: ')+esc(document.version)+'</h3><pre style="white-space:pre-wrap;max-height:400px;overflow:auto">'+esc(document.text)+'</pre><label><input id="agreementAccepted" type="checkbox"> '+T('我已阅读并同意本版本协议','I have read and agree to this version of the agreement')+'</label><button id="confirmAgreement" disabled>'+T('确认签署','Confirm acceptance')+'</button>';
   $('agreementAccepted').addEventListener('change',()=>{agreementChecked=$('agreementAccepted').checked;$('confirmAgreement').disabled=!agreementChecked;});
   $('confirmAgreement').addEventListener('click',()=>run(async()=>{if(!$('agreementAccepted').checked)return;await api('/api/referral/account/agreement',{accepted:true,version:document.version,digest:document.digest});await refresh();message(T('协议确认已保存，邀请功能仍需资格审核通过。','Acceptance saved. Invitations also require approval.'));}));
   $('agreementAccepted').checked=agreementChecked;$('confirmAgreement').disabled=!agreementChecked;
 }
 async function refresh(){agreementDocument=null;agreementChecked=false;const current=++generation;$('loading').textContent=T('正在验证登录状态…','Checking your session…');try{const session=await api('/api/auth/session');if(current!==generation)return;if(!session.authenticated||!session.user_id){signedOut();return;}user=session.user_id;account=null;renderAccount();try{const details=await api('/api/referral/account/me');if(current!==generation)return;if(details.user_id!==user||details.environment!=='account')throw new Error(T('账户资料不匹配，请重新登录。','Account details do not match. Please sign in again.'));account=details;ledger=null;renderAccount();if(details.payment_integration_enabled){ledger=await api('/api/referral/account/ledger');if(current!==generation)return;}renderAccount();}catch(e){if(e.status===401)signedOut();throw e;}}catch(e){if(e.status===401){signedOut();return;}if(!user)$('login').hidden=false;throw e;}finally{$('loading').textContent='';}}
 async function run(fn){if(busy)return;busy=true;controls();message('');try{await fn();}catch(e){message(e.message);}finally{busy=false;controls();}}
 $('requestForm').addEventListener('submit',e=>{e.preventDefault();if(Date.now()<cooldown)return;run(async()=>{const uid=$('userId').value.trim();if(!uid)return;await api('/api/auth/migration/request',{user_id:uid});requestedUser=uid;cooldown=Date.now()+60000;$('verifyForm').hidden=false;message(T('如果账户符合登录条件，验证码将发送至绑定邮箱。请使用最新验证码。','If this account is eligible, a code will be sent to its registered email. Use the latest code.'));$('otp').focus();});});
 $('userId').addEventListener('input',()=>{requestedUser='';$('verifyForm').hidden=true;$('otp').value='';});
 $('verifyForm').addEventListener('submit',e=>{e.preventDefault();run(async()=>{if(!requestedUser)return;await api('/api/auth/migration/verify',{user_id:requestedUser,code:$('otp').value.normalize('NFKC').replace(/\s+/g,'')});$('otp').value='';await refresh();});});
 $('logout').addEventListener('click',()=>run(async()=>{await api('/api/auth/logout',{});signedOut();message(T('已退出登录。','Signed out.'));}));
 function close(){$('languages').hidden=true;$('language').setAttribute('aria-expanded','false');}
 $('language').addEventListener('click',()=>{$('languages').hidden=!$('languages').hidden;$('language').setAttribute('aria-expanded',String(!$('languages').hidden));});document.querySelectorAll('[data-lang]').forEach(b=>b.addEventListener('click',()=>{lang=b.dataset.lang;try{localStorage.setItem('darrius_language',lang);}catch(_){}const url=new URL(location.href);url.searchParams.set('lang',lang);history.replaceState(null,'',url);render();close();}));document.addEventListener('click',e=>{if(!e.target.closest('.language-menu'))close();});document.addEventListener('keydown',e=>{if(e.key==='Escape')close();});
 window.addEventListener('pageshow',e=>{if(e.persisted)run(refresh);});window.addEventListener('focus',()=>{if(user&&!$('agreementAccepted'))run(refresh);});
 setInterval(controls,1000);render();run(refresh);
})();
