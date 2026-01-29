(() => {
  const REF_KEY = 'darrius_ref_code';
  const params = new URLSearchParams(window.location.search);
  const ref = params.get('ref');

  if (!ref) return;

  // 已记录的不再重复提示
  if (localStorage.getItem(REF_KEY) === ref) return;

  localStorage.setItem(REF_KEY, ref);

  // ---------- Toast ----------
  const toast = document.createElement('div');
  toast.innerHTML = `
    <div style="
      position: fixed;
      left: 18px;
      bottom: 18px;
      z-index: 99999;
      background: rgba(20,30,45,0.95);
      color: #e6f0ff;
      padding: 10px 14px;
      border-radius: 10px;
      font-size: 13px;
      box-shadow: 0 10px 30px rgba(0,0,0,.35);
      border: 1px solid rgba(80,160,255,.25);
      backdrop-filter: blur(6px);
      animation: darriusFadeIn .25s ease-out;
    ">
      ✅ Referral detected: <b>${ref}</b><br/>
      <span style="opacity:.75;font-size:12px;">Will be applied at checkout</span>
    </div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes darriusFadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = 'opacity .3s ease';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 350);
  }, 2200);
})();
