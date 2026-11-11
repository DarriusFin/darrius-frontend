// Older Checkout sessions still return to the Dashboard. Route them to the
// subscription recovery page without interpreting the URL as payment evidence.
(() => {
  const source = new URL(window.location.href);
  if (!['cancel', 'canceled'].includes(source.searchParams.get('checkout'))) return;
  const target = new URL('account.html', source);
  target.searchParams.set('checkout', 'cancel');
  const lang = source.searchParams.get('lang');
  if (['en','zh','zh-CN'].includes(lang)) target.searchParams.set('lang', lang);
  window.location.replace(target.href);
})();
