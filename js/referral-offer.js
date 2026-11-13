/* Display server-published terms only; the server verifies the actual entitlement. */
(() => {
  'use strict';
  let terms = null, plans = [];
  const zh = () => document.documentElement.lang.startsWith('zh');
  function render() {
    const help = document.querySelector('[data-account-text="rewardHelp"]');
    const discount = terms?.discount_percent === 20;
    if (help && discount) help.textContent = zh()
      ? '绑定有效推荐码，首次实际付款自动享八折，所有套餐适用，每个账户限一次。套餐自带赠送天数保留；推荐码不再赠送天数。试用零元账单不消耗优惠，后续按正常价格续费，不与其他优惠券叠加。'
      : 'Link a valid referral code for 20% off your first actual payment, once per account on any plan. Plan trial days are unchanged; referral codes no longer add days. A zero-value trial invoice does not use the offer. Renewals are at the regular price; other coupons cannot be combined.';
    else if (help && terms?.bonus_days === 1) help.textContent = zh()
      ? '有效推荐码适用旧版首次付款赠送 1 天政策，具体奖励以账户记录为准。'
      : 'Valid referral codes use the previous one-day first-payment reward. See your account record for the applicable benefit.';
    else if (help) help.textContent = zh()
      ? '前往付款时将验证推荐优惠，请在 Stripe 核对最终价格。'
      : 'Referral benefits are verified when you continue to payment. Review the final price on Stripe.';
    const entered = !!document.getElementById('checkoutReferral')?.value.trim();
    document.querySelectorAll('[data-referral-price]').forEach(el => {
      const p = plans.find(p => p.key === el.dataset.referralPrice);
      el.hidden = !discount || !entered;
      if (el.hidden) return;
      // Only preview explicitly priced USD minor units; do not guess currency.
      const amount = p?.currency === 'usd' && Number.isSafeInteger(p?.unit_amount) && p.unit_amount > 0
        ? '$' + ((p.unit_amount - Math.round(p.unit_amount * .2)) / 100).toFixed(2) : '';
      el.textContent = zh()
        ? `推荐码验证通过后，首次付款${amount ? '预估 ' + amount + '（税前）' : '享八折'}；续费原价。最终金额请在 Stripe 确认。`
        : `With an eligible referral: ${amount ? 'estimated first payment ' + amount + ' before tax' : '20% off the first payment'}; renewals at full price. Confirm the final amount on Stripe.`;
    });
  }
  window.DarriusReferralOffer = {setTerms(value) { terms = value; render(); },
    setPlans(value) { plans = value; render(); }, render};
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('checkoutReferral')?.addEventListener('input', render);
    render();
  });
  document.addEventListener('darrius:language-changed', render);
})();
