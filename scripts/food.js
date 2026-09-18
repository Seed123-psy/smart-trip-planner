/* ============================================================
   当地美食抽屉

   数据来自独立的美食 Agent（阶段 food，产出 plan.food）——
   和行前准备是两个不同的 Agent、两次不同的模型调用，产出也各自独立。
   所以这里单独成一个视图，不再挂在行前准备里。

   这一屏最要紧的是「按动线」：near 是行程里走过的地方，
   用户才知道自己什么时候顺路去。给一份和行程无关的「XX 必吃」，
   读起来热闹，实际上用不上。
   ============================================================ */

(function () {
  'use strict';

  /** 美食 Agent 的产出。内置示例行程没有这一步，就是空的，按钮会自动隐藏 */
  const FOOD = () => window.TRIP_FOOD || {};

  const ICON = {
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function icon(paths, size = 15) {
    return window.TripTimeline.svgIcon(paths, size);
  }

  function section(title, content) {
    if (!content || !content.childNodes.length) return null;
    const box = el('section', 'prep-sec');
    const head = el('div', 'prep-sec__head');
    head.append(icon(ICON.info, 15), el('h3', 'prep-sec__title', title));
    box.append(head, content);
    return box;
  }

  /** 「在哪 · 吃什么」一行。note 放价格区间、时段这些补充 */
  function foodRow(item) {
    const row = el('div', 'prep-pair is-wide');
    row.append(el('span', 'prep-pair__k', item.near || '行程沿线'));

    const value = el('span', 'prep-pair__v');
    value.append(el('span', null, item.place ? `${item.place} · ${item.dish}` : item.dish));
    if (item.note) value.append(el('span', 'prep-pair__note', item.note));
    row.append(value);
    return row;
  }

  function renderFood() {
    const frag = document.createDocumentFragment();
    const data = FOOD();
    const items = Array.isArray(data.items) ? data.items : [];

    if (data.summary) frag.append(el('p', 'prep-lead', data.summary));

    const list = el('div', 'food-list');
    items.forEach((item) => list.append(foodRow(item)));
    if (items.length) frag.append(section('吃什么 · 在哪吃', list));

    return frag;
  }

  window.TripDrawer.register('food', {
    eyebrow: '按你的动线排的',
    title: '当地美食',
    render: renderFood
  });

  window.TripFood = { refresh: () => window.TripDrawer.refresh('food') };
})();
