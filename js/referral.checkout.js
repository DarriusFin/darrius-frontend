/* referral.checkout.js (NO-TOUCH SUBSCRIPTION) v2026.01.29
 * Purpose: Inject ref_code into checkout session creation request
 * Safe: only wraps window.fetch for specific endpoints, otherwise no-op
 */
(() => {
  'use strict';

  const REF_KEY = 'darrius_ref_code';
  const refCode = (() => {
    try { return localStorage.getItem(REF_KEY) || ''; } catch (e) { return ''; }
  })();

  if (!refCode) return;

  const shouldPatch = (url) => {
    try {
      const u = (typeof url === 'string') ? url : (url && url.url) || '';
      // 兼容你项目里可能存在的创建 checkout 路由命名
      return (
        u.includes('/create-checkout-session') ||
        u.includes('/billing/checkout') ||
        u.includes('/api/billing/checkout')
      );
    } catch (e) { return false; }
  };

  const origFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    if (!shouldPatch(input)) return origFetch(input, init);

    try {
      // 只处理 JSON body 的 POST
      const method = (init.method || 'GET').toUpperCase();
      if (method !== 'POST') return origFetch(input, init);

      const headers = new Headers(init.headers || {});
      const ct = (headers.get('Content-Type') || headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('application/json')) {
        // 如果你的订阅逻辑不是 json body，这里就不动，避免误伤
        return origFetch(input, init);
      }

      let bodyObj = {};
      if (init.body) {
        try { bodyObj = JSON.parse(init.body); } catch (e) { bodyObj = {}; }
      }

      // ✅ 注入：ref_code（不覆盖已有值）
      if (!bodyObj.ref_code) bodyObj.ref_code = refCode;

      // 可选：把当前落地页也传给后端（未来统计用）
      if (!bodyObj.ref_landing) bodyObj.ref_landing = window.location.pathname + window.location.search;

      const newInit = {
        ...init,
        headers,
        body: JSON.stringify(bodyObj),
      };

      return origFetch(input, newInit);
    } catch (e) {
      // 任何异常都不影响原逻辑
      return origFetch(input, init);
    }
  };
})();
