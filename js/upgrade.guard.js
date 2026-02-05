/* upgrade.guard.js (UNLOCK FIX) v2026.02.05
 * Purpose:
 *  - Gate symbol/timeframe/load for non-entitled users
 *  - MUST unlock for ACTIVE / TRIAL users (based on DOM status)
 *
 * Safety:
 *  - Never throws
 *  - UI-only; does not touch billing/subscription logic
 */
(() => {
  'use strict';

  function safe(fn){ try { return fn(); } catch(e){ return null; } }

  function $(id){ return document.getElementById(id); }

  function txt(id){
    const el = $(id);
    return (el && el.textContent) ? String(el.textContent).toLowerCase() : '';
  }

  function domSaysEntitled(){
    const t = (txt('subStatusText') + ' ' + txt('planStatus'));
    // 支持各种显示文案
    return t.includes('active') || t.includes('trial');
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
        hint.textContent = 'Locked: subscribe to unlock Symbol/Timeframe.';
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
      if (hint) hint.textContent = 'Market snapshot loaded · 已加载市场快照';
    });
  }

  function evaluate(){
    const ok = domSaysEntitled();
    if (ok) unlockUI();
    else lockUI();
    return ok;
  }

  // 立即执行一次（页面加载时先锁/先解锁）
  safe(evaluate);

  // 复查（因为 subStatusText/planStatus 是异步填充）
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    const ok = safe(evaluate);
    if (ok) clearInterval(timer);       // 一旦解锁成功就停，避免后续覆盖回锁
    if (tries >= 120) clearInterval(timer); // 30s
  }, 250);

})();
