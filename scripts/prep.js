/* ============================================================
   行前准备抽屉：待预约、打车还是地铁、门票、雨天备选、必带物品、实用信息

   数据来源分两处，这里只负责拼装，不再维护第二份：
   - data/prep.js  行程级数据（打包清单、紧急电话、预约规则、交通结论）
   - data/poi.js   地点级数据（ticket / eat / rain），用 poiId 关联

   卡片上的门票徽标由 timeline.js 渲染，这里只管抽屉内部。
   ============================================================ */

(function () {
  'use strict';

  const POI = window.TRIP_POI;
  const PREP = window.TRIP_PREP;
  const ITIN = window.TRIP_ITINERARY;
  const D = window.TripDate;

  /** 必带物品的勾选状态存在本地。用物品文字当 key：
      改文案会丢掉勾选，但增删条目、调整顺序都不会错位 */
  const PACK_KEY = 'wuhan-trip-packed-v1';

  /* ------------------------------------------------------------------ */
  /* 小工具                                                              */
  /* ------------------------------------------------------------------ */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** 24×24 描边图标，复用 timeline.js 的构造器，避免同一套 SVG 写两遍 */
  function icon(paths, size = 15) {
    return window.TripTimeline.svgIcon(paths, size);
  }

  const ICON = {
    alert:
      '<path d="M21.7 18 13.7 4a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/>' +
      '<path d="M12 9v4M12 17h.01"/>',
    route:
      '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/>' +
      '<circle cx="18" cy="5" r="3"/>',
    ticket:
      '<path d="M2 9a3 3 0 0 1 0 6v3a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3a3 3 0 0 1 0-6V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/>' +
      '<path d="M13 5v2M13 17v2M13 11v2"/>',
    umbrella:
      '<path d="M22 12a10.06 10.06 0 0 0-20 0Z"/><path d="M12 12v8a2 2 0 0 0 4 0"/><path d="M12 2v1"/>',
    check:
      '<path d="M11 6h10M11 12h10M11 18h10"/><path d="m3 6 1.5 1.5L7 5"/>' +
      '<path d="m3 12 1.5 1.5L7 11"/><path d="m3 18 1.5 1.5L7 17"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'
  };

  /** 一个带图标标题的分区 */
  function section(title, iconPath, content) {
    const box = el('section', 'prep-sec');
    const head = el('div', 'prep-sec__head');
    head.append(icon(iconPath, 15), el('h3', 'prep-sec__title', title));
    box.append(head, content);
    return box;
  }

  /** 按行程顺序去重后的地点列表 —— 门票、雨天备选都按这个顺序展示 */
  function orderedPois() {
    const seen = new Set();
    const out = [];
    ITIN.days.forEach((day) => {
      day.visits.forEach((v) => {
        const poi = v.poiId && POI[v.poiId];
        if (!poi || seen.has(poi.id)) return;
        seen.add(poi.id);
        out.push(poi);
      });
    });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 待预约                                                              */
  /* ------------------------------------------------------------------ */

  /** 放票日 = 行程日 - 最多提前天数。没有固定放票节奏的返回 null */
  function releaseDate(booking) {
    return booking.advance ? D.addDays(booking.day, -booking.advance) : null;
  }

  function renderBookings() {
    const frag = document.createDocumentFragment();

    // 按放票日排序，没有固定节奏的沉到最后，
    // 免得它们插在「今天该抢票」中间稀释注意力
    const list = PREP.bookings
      .map((b) => ({ ...b, poi: POI[b.poiId] }))
      .filter((b) => b.poi)
      .sort((a, b) => (releaseDate(a) || '9999') < (releaseDate(b) || '9999') ? -1 : 1);

    list.forEach((b) => {
      const row = el('div', `prep-booking${b.level === 'must' ? ' is-must' : ''}`);

      const head = el('div', 'prep-booking__head');
      head.append(el('span', 'prep-booking__name', b.poi.name));
      head.append(
        el('span', `prep-booking__level${b.level === 'must' ? ' is-must' : ''}`,
          b.level === 'must' ? '必约' : '可选')
      );
      row.append(head);

      const rd = releaseDate(b);
      if (rd) {
        const left = D.daysBetween(D.today(), rd);
        const when = el('div', 'prep-booking__when');
        when.append(
          el('span', 'prep-booking__date', `${D.label(rd)}${b.release ? ' ' + b.release : ''} 放票`)
        );
        if (left != null) {
          const text = left > 0 ? `还有 ${left} 天` : left === 0 ? '就是今天' : '已开放预约';
          // 只剩三天以内就标红，这是唯一真正会错过的东西
          when.append(el('span', `prep-booking__count${left >= 0 && left <= 3 ? ' is-urgent' : ''}`, text));
        }
        row.append(when);
      }

      row.append(el('div', 'prep-booking__channel', b.channel));
      if (b.note) row.append(el('p', 'prep-booking__note', b.note));
      frag.append(row);
    });

    return frag;
  }

  /* ------------------------------------------------------------------ */
  /* 打车还是地铁                                                        */
  /* ------------------------------------------------------------------ */

  function renderTransport() {
    const frag = document.createDocumentFragment();
    frag.append(el('p', 'prep-lead', PREP.transport.summary));
    const ul = el('ul', 'prep-list');
    PREP.transport.points.forEach((p) => ul.append(el('li', null, p)));
    frag.append(ul);
    return frag;
  }

  /* ------------------------------------------------------------------ */
  /* 门票 / 雨天备选 / 实用信息                                          */
  /* ------------------------------------------------------------------ */

  function pairRow(key, value, note, wide) {
    const row = el('div', `prep-pair${wide ? ' is-wide' : ''}`);
    row.append(el('span', 'prep-pair__k', key));
    const v = el('span', 'prep-pair__v', value);
    if (note) v.append(el('span', 'prep-pair__note', note));
    row.append(v);
    return row;
  }

  function renderTickets() {
    const frag = document.createDocumentFragment();
    orderedPois()
      .filter((p) => p.ticket)
      .forEach((p) => frag.append(pairRow(p.name, p.ticket)));
    return frag;
  }

  function renderRain() {
    const frag = document.createDocumentFragment();
    orderedPois()
      .filter((p) => p.rain)
      .forEach((p) => frag.append(pairRow(p.name, p.rain, null, true)));
    return frag;
  }

  function renderEmergency() {
    const frag = document.createDocumentFragment();
    PREP.emergency.forEach((e) => frag.append(pairRow(e.label, e.value, e.note, true)));
    return frag;
  }

  /* ------------------------------------------------------------------ */
  /* 必带物品                                                            */
  /* ------------------------------------------------------------------ */

  let packCounter = null;

  function readPacked() {
    try {
      return JSON.parse(localStorage.getItem(PACK_KEY)) || {};
    } catch (err) {
      // 隐私模式或 file:// 下可能直接抛错；降级成「都没勾」，不影响看
      return {};
    }
  }

  function writePacked(map) {
    try {
      localStorage.setItem(PACK_KEY, JSON.stringify(map));
    } catch (err) {
      /* 存不下就算了，本次仍然可用 */
    }
  }

  function totalItems() {
    return PREP.packing.reduce((n, g) => n + g.items.length, 0);
  }

  function updatePackCount() {
    if (!packCounter) return;
    const packed = readPacked();
    const done = PREP.packing.reduce(
      (n, g) => n + g.items.filter((t) => packed[t]).length,
      0
    );
    const all = totalItems();
    packCounter.textContent = done ? `已备 ${done} / ${all}` : `共 ${all} 项`;
    packCounter.classList.toggle('is-done', done === all && all > 0);
  }

  function renderPacking() {
    const packed = readPacked();
    const box = el('div', 'prep-pack');

    packCounter = el('div', 'prep-pack__count');
    box.append(packCounter);

    PREP.packing.forEach((group, gi) => {
      const wrap = el('div', 'prep-pack__group');
      wrap.append(el('div', 'prep-pack__title', group.group));

      group.items.forEach((text, ii) => {
        // id 用下标而不是文字：中文和空格放进 id 不合法
        const id = `pack-${gi}-${ii}`;
        const label = el('label', 'prep-pack__item');

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = id;
        cb.checked = Boolean(packed[text]);

        // 勾号放进方框内部，才能用 input:checked + .prep-pack__box 控制显隐
        const box = el('span', 'prep-pack__box');
        box.append(icon('<path d="m5 12 4.5 4.5L19 7"/>', 12));
        label.classList.toggle('is-done', cb.checked);

        cb.addEventListener('change', () => {
          const cur = readPacked();
          if (cb.checked) cur[text] = 1;
          else delete cur[text];
          writePacked(cur);
          label.classList.toggle('is-done', cb.checked);
          updatePackCount();
        });

        label.htmlFor = id;
        label.append(cb, box, el('span', 'prep-pack__text', text));
        wrap.append(label);
      });

      box.append(wrap);
    });

    return box;
  }

  /* ------------------------------------------------------------------ */
  /* 抽屉开关                                                            */
  /* ------------------------------------------------------------------ */

  let root = null;
  let closeBtn = null;
  let lastFocus = null;

  function open() {
    if (!root) return;
    lastFocus = document.activeElement;
    root.classList.add('is-on');
    if (closeBtn) closeBtn.focus();
  }

  function close() {
    if (!root) return;
    root.classList.remove('is-on');
    // 焦点还给打开它的按钮，键盘用户不会掉回页面顶部
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function init() {
    root = document.getElementById('prep');
    const body = document.getElementById('prep-body');
    const openBtn = document.getElementById('prep-open');
    closeBtn = document.getElementById('prep-close');

    if (!root || !body || !openBtn) return;

    body.append(
      section('待预约', ICON.alert, renderBookings()),
      section('打车还是地铁', ICON.route, renderTransport()),
      section('门票一览', ICON.ticket, renderTickets()),
      section('雨天备选', ICON.umbrella, renderRain()),
      section('必带物品', ICON.check, renderPacking()),
      section('实用信息', ICON.info, renderEmergency())
    );

    openBtn.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);

    // 点遮罩关闭；点面板内部不关
    root.addEventListener('click', (e) => {
      if (e.target === root) close();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && root.classList.contains('is-on')) close();
    });

    updatePackCount();
  }

  window.TripPrep = { init, open, close, PACK_KEY };
})();
