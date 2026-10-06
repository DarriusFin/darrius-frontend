(() => {
'use strict';
const dictionary = {"s0": ["Account & Subscription", "账户与订阅"], "s1": ["Subscription Overview", "订阅概览"], "s2": ["Status", "状态信息"], "s3": ["User", "用户"], "s4": ["Current Plan", "当前套餐"], "s5": ["Subscription Status", "订阅状态"], "s6": ["Renews / Ends", "续订 / 到期"], "s7": ["Data Source Mode", "数据模式"], "s8": ["Actions", "操作"], "s9": ["Open Billing Portal", "账单管理"], "s10": ["Go to Plans", "查看套餐"], "s11": ["Plans & Control", "套餐与订阅"], "s12": ["01 · Account details", "01 · 账户信息"], "s13": ["02 · Referral code", "02 · 邀请码"], "s14": ["03 · Choose a plan", "03 · 选择订阅套餐"], "s15": ["Optional", "选填"], "s16": ["Verified referrer's code", "已认证推荐人的邀请码"], "s17": ["← Back to Dashboard", "← 返回主界面"], "s18": ["Quick Actions", "快捷操作"], "s19": ["Open Dashboard", "打开主界面"], "s20": ["System", "系统信息"], "s21": ["Build", "版本"], "s22": ["Backend", "后端"], "s23": ["Plans Source", "计划来源"], "s24": ["Support", "支持"], "s25": ["Terms", "使用条款"], "s26": ["Privacy", "隐私政策"], "checkoutUserIdLabel": ["User ID", "用户 ID"], "checkoutEmailLabel": ["Email", "邮箱"], "identityHelp": ["Create your account with a User ID and email address. Already registered? Sign in from the Dashboard.", "填写用户 ID 和邮箱，开始创建账户。已有账户？请返回主界面登录。"], "rewardHelp": ["Use a verified referral code to receive 1 bonus subscription day after your first successful payment. Available once per eligible new account.", "填写认证推荐人的邀请码，符合条件的新用户首次成功付款后可获赠 1 天订阅，每个账户限享一次。"], "cancelHelp": ["Cancellation usually keeps access active until the current billing period ends.", "取消订阅后，通常可继续使用至当前计费周期结束。"], "supportHelp": ["Use Billing Portal for invoices, payment methods and cancellations. Technical support: support@darrius.ai", "发票、付款方式和取消订阅请使用账单管理。技术支持：support@darrius.ai"], "subscribe": ["Subscribe", "订阅"], "codePending": ["Referral code entered. Eligibility will be confirmed when your referral is linked.", "邀请码已填写，绑定时将确认是否符合条件。"], "codeOptional": ["Optional. Leave blank if you do not have a code.", "选填，无邀请码可留空。"]};
Object.assign(dictionary, {
 returnPending: ['You have returned from checkout. Payment and the bonus day are subject to confirmation by our billing system. Sign in to view your subscription; do not pay again while confirmation is pending.', '已从收银台返回。付款及赠送天数以后台核实为准，请登录查看订阅状态；等待确认期间请勿重复付款。'],
 returnSignedIn: ['You have returned from checkout. Refresh your subscription status below. Payment and any eligible bonus day may take a moment to appear; do not pay again while confirmation is pending.', '已从收银台返回，请刷新下方订阅状态。付款及符合条件的赠送天数可能稍后更新，等待期间请勿重复付款。'],
 returnCanceled: ['You have returned to subscriptions. If payment was not completed, you can choose a plan and try again.', '已返回订阅页面。如果尚未完成付款，可以选择套餐后重试。'],
 returnLogin: ['Sign in on Dashboard', '前往主界面登录'],
 returnRefresh: ['Refresh subscription status', '刷新订阅状态']
});
let language = 'en';
try { language = localStorage.getItem('darrius_language') === 'zh-CN' ? 'zh-CN' : 'en'; } catch (_) {}
const linkLanguage = new URLSearchParams(location.search).get('lang');
if (['en','zh','zh-CN'].includes(linkLanguage)) {
 language = linkLanguage.startsWith('zh') ? 'zh-CN' : 'en';
 try { localStorage.setItem('darrius_language',language); } catch (_) {}
}
const text = key => dictionary[key]?.[language === 'zh-CN' ? 1 : 0] || key;
const plans = {weekly:['Weekly','周付'],monthly:['Monthly','月付'],quarterly:['Quarterly','季付'],yearly:['Yearly','年付']};
const descriptions = {weekly:['Flexible weekly access.','按周订阅，灵活使用。'],monthly:['Access billed monthly.','每月付费使用。'],quarterly:['Access billed every three months.','每三个月付费使用。'],yearly:['Access billed annually.','按年付费使用。']};
const status = value => {
 if(language !== 'zh-CN') return value;
 const map={'Not signed in':'未登录','SIGN IN REQUIRED':'请先登录','SIGNED IN':'已登录','STATUS: UNKNOWN':'状态未知','Unable to load':'无法加载',DEMO:'演示',ACTIVE:'有效',TRIAL:'试用中',CANCELED:'已取消',EXPIRED:'已到期',UNKNOWN:'未知',REALTIME:'实时',REAL_TIME:'实时',DELAYED:'延迟',EOD:'日终'};
 return map[value] || plans[String(value).toLowerCase()]?.[1] || value;
};
function apply(){
 document.documentElement.lang=language;
 document.title=language==='zh-CN'?'DarriusAI · 账户与订阅':'DarriusAI · Account & Subscription';
 document.querySelectorAll('[data-account-text]').forEach(el=>el.textContent=text(el.dataset.accountText));
 document.getElementById('accountLanguage').value=language;
 document.getElementById('checkoutReferral').placeholder=language==='zh-CN'?'输入邀请码':'Enter referral code';
 document.getElementById('referralDraftStatus').textContent=text(document.getElementById('checkoutReferral').value.trim()?'codePending':'codeOptional');
}
window.AccountI18n={text,status,plan:(key,fallback)=>plans[key]?.[language==='zh-CN'?1:0]||fallback,
 description:key=>descriptions[key]?.[language==='zh-CN'?1:0]||'',
 trial:value=>{const days=String(value).match(/\d+/)?.[0];return days?(language==='zh-CN'?`${days} 天免费试用`:`${days}-day free trial`):'';},
 message:message=>{
 if(language!=='zh-CN')return message;
 const messages={
 'This account already has an active subscription.':'该账户已有有效订阅。',
 'Your session has expired. Please sign in again.':'登录已过期，请重新登录。',
 'Your account does not have a billing email. Please contact support.':'账户缺少账单邮箱，请联系支持。',
 'Please sign in before opening Billing Portal.':'请先登录，再打开账单管理。',
 'No active subscription is available to manage.':'当前没有可管理的有效订阅。',
 'Missing price_id for this plan.':'套餐价格信息缺失，请刷新页面或联系支持。'
 };
 return messages[message] || String(message).replace('Unable to start checkout.','无法开始订阅付款。').replace('Billing Portal is not available.','账单管理暂不可用。').replace('Error: ','错误：');
},
 updated:()=> (language==='zh-CN'?'更新：':'Updated: ')+new Date().toLocaleString(language==='zh-CN'?'zh-CN':'en-US')};
document.addEventListener('DOMContentLoaded',()=>{
 apply();
 document.getElementById('accountLanguage').addEventListener('change',event=>{
  language=event.target.value;try{localStorage.setItem('darrius_language',language);}catch(_){}
  apply();document.dispatchEvent(new CustomEvent('darrius:language-changed',{detail:{language}}));
 });
});
})();
