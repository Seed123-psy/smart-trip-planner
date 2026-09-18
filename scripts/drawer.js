/* ============================================================
   抽屉壳：一个面板，多个视图

   行前准备与当地美食是两个独立的 Agent，产出也各自独立
   （plan.prep 与 plan.food），所以界面上也该是两个入口。
   但两边要的壳完全一样 —— 遮罩、面板、标题、关闭、Esc、焦点归位。
   与其把这份壳抄两遍，不如让视图注册进来。

   约定：视图的入口按钮 id 是 `<key>-open`，比如 prep → #prep-open。
   ============================================================ */

(function () {
  'use strict';

  /** key -> { eyebrow, title, render(): Node } */
  const views = new Map();
  /** 面板内容为空时整个入口按钮藏起来，别给一个点开没东西的按钮 */
  const buttons = new Map();

  let root = null;
  let eyebrowEl = null;
  let titleEl = null;
  let bodyEl = null;
  let closeBtn = null;
  let lastFocus = null;
  let current = null;

  function register(key, view) {
    views.set(key, view);
    const btn = document.getElementById(`${key}-open`);
    if (btn) buttons.set(key, btn);
  }

  /** 按当前数据判断这个视图有没有内容可看 */
  function hasContent(key) {
    const view = views.get(key);
    if (!view) return false;
    try {
      return Boolean(view.render().childNodes.length);
    } catch (error) {
      console.warn(`[抽屉] ${key} 视图渲染失败：`, error && error.message);
      return false;
    }
  }

  function syncButtons() {
    buttons.forEach((btn, key) => {
      btn.hidden = !hasContent(key);
    });
  }

  /** 标题允许是函数：候选面板要写成「加到 Day 2」，开哪一天它才知道 */
  const resolve = (value) => (typeof value === 'function' ? value() : value);

  function open(key) {
    const view = views.get(key);
    if (!root || !view || !hasContent(key)) return;

    current = key;
    lastFocus = document.activeElement;
    eyebrowEl.textContent = resolve(view.eyebrow);
    titleEl.textContent = resolve(view.title);
    bodyEl.replaceChildren(view.render());
    root.classList.add('is-on');
    if (closeBtn) closeBtn.focus();
  }

  function close() {
    if (!root) return;
    current = null;
    root.classList.remove('is-on');
    // 焦点还给打开它的按钮，键盘用户不会掉回页面顶部
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /** 数据换了（AI 重新规划）之后重建内容；没开着就只更新按钮可见性 */
  function refresh(key) {
    syncButtons();
    if (current && (!key || key === current)) open(current);
  }

  function init() {
    root = document.getElementById('drawer');
    eyebrowEl = document.getElementById('drawer-eyebrow');
    titleEl = document.getElementById('drawer-title');
    bodyEl = document.getElementById('drawer-body');
    closeBtn = document.getElementById('drawer-close');

    if (!root || !eyebrowEl || !titleEl || !bodyEl) return;

    views.forEach((_, key) => {
      const btn = document.getElementById(`${key}-open`);
      if (btn) {
        buttons.set(key, btn);
        btn.addEventListener('click', () => open(key));
      }
    });

    if (closeBtn) closeBtn.addEventListener('click', close);

    // 点遮罩关闭；点面板内部不关
    root.addEventListener('click', (e) => {
      if (e.target === root) close();
    });

    document.addEventListener('keydown', (e) => {
      // 原生日期选择器之类弹出时 Esc 是关它，不该顺带把抽屉也收了
      if (e.key !== 'Escape' || !root.classList.contains('is-on')) return;
      if (e.target instanceof Element && e.target.matches('input[type="date"]')) return;
      close();
    });

    syncButtons();
  }

  window.TripDrawer = { register, init, open, close, refresh, hasContent };
})();
