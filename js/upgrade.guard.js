/* Stock controls follow the current account's subscription policy.
 * Keep listening after login delays; displayed text is not access evidence.
 * UI-only; does not change billing or server authorization.
 */
(() => {
  'use strict';

  function safe(fn){ try { return fn(); } catch(e){ return null; } }

  function $(id){ return document.getElementById(id); }

  function domSaysEntitled(){
    const policy = window.__ENTITLEMENT__;
    return !!window.__AUTH_USER_ID__ &&
      policy?.user_id === window.__AUTH_USER_ID__ &&
      policy.has_access === true;
  }

  function setDisabled(id, disabled){
    const el = $(id);
    if (!el) return;
    el.disabled = !!disabled;
    // 防止 CSS/pointer-events 锁死
    el.style.pointerEvents = disabled ? 'none' : 'auto';
    el.style.opacity = disabled ? '0.65' : '1';
  }

  function lockTFButtons(disabled){
    safe(() => {
      const wrap = $('tfQuick');
      if (!wrap) return;
      wrap.querySelectorAll('.tfBtn').forEach(b => {
        b.disabled = !!disabled;
        b.style.pointerEvents = disabled ? 'none' : 'auto';
        b.style.opacity = disabled ? '0.65' : '1';
      });
    });
  }

  function lockUI(){
    // 未订阅：允许看默认 TSLA/1D，但禁用改品种/周期/加载
    setDisabled('symbol', true);
    setDisabled('tf', true);
    setDisabled('loadBtn', true);
    lockTFButtons(true);

    // 数据源：强制走 third（Twelve Pro），并锁定
    const ds = $('dataSource');
    if (ds){
      ds.value = 'third';
      ds.disabled = true;
      ds.style.pointerEvents = 'none';
      ds.style.opacity = '0.75';
    }

    // 给用户提示（如果页面有提示区，最好；没有也不报错）
    safe(() => {
      const hint = $('hintText');
      if (hint && !domSaysEntitled()){
        hint.textContent =
          window.DARRIUS_T?.("lockedSubscribeToUnlock") ||
          "Locked: subscribe to unlock Symbol/Timeframe.";
      }
    });
  }

  function unlockUI(){
    // 已订阅/试用：放开
    setDisabled('symbol', false);
    setDisabled('tf', false);
    setDisabled('loadBtn', false);
    lockTFButtons(false);

    // 数据源仍可锁定为 third（合规）
    const ds = $('dataSource');
    if (ds){
      ds.value = 'third';
      ds.disabled = true;
      ds.style.pointerEvents = 'none';
      ds.style.opacity = '0.9';
    }

    safe(() => {
      const hint = $('hintText');
      if (hint) {
        hint.textContent =
          window.DARRIUS_T?.(
            "marketSnapshotLoaded"
          ) || "Market snapshot loaded";
      }
    });
  }

  function evaluate(){
    const ok = domSaysEntitled();
    if (ok) unlockUI();
    else lockUI();
    return ok;
  }

  document.addEventListener(
    "darrius:language-changed",
    () => {
      evaluate();
    }
  );

  window.addEventListener(
    "darrius:subscription-status",
    () => {
      evaluate();
    }
  );

  window.addEventListener("darrius:auth-changed", () => safe(evaluate));

  // 立即执行一次（页面加载时先锁/先解锁）
  safe(evaluate);

})();
