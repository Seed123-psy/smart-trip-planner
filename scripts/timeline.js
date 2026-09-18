/* ============================================================
   时间轴层：把 itinerary + routes 数据渲染成行程卡片
   纯展示，不碰地图；交互通过 onSelect 回调交给 app.js 调度
   ============================================================ */

(function () {
  'use strict';

  const CFG = window.TRIP_CONFIG;
  const POI = window.TRIP_POI;
  const ROUTES = window.TRIP_ROUTES;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /* ------------------------------------------------------------------ */
  /* DOM 小工具                                                          */
  /* ------------------------------------------------------------------ */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** 24×24 描边图标。paths 为 path 数据串，颜色跟随 currentColor */
  function icon(paths, size = 12) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('class', 'ic');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = paths;
    return svg;
  }

  const ICON_PIN =
    '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>';
  const ICON_HINT =
    '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>';

  /**
   * 必须提前预约的地点 id。只认 must —— optional 的挂个「需预约」反而误导，
   * 让人以为不约就进不去。
   */
  const MUST_BOOK = new Set(
    ((window.TRIP_PREP && window.TRIP_PREP.bookings) || [])
      .filter((b) => b.level === 'must')
      .map((b) => b.poiId)
  );

  /* ------------------------------------------------------------------ */
  /* 格式化                                                              */
  /* ------------------------------------------------------------------ */

  /** 始终返回 {value, unit}：调用方一律按对象取值，避免出现「undefined undefined」 */
  function formatDistance(meters) {
    if (!Number.isFinite(meters)) return { value: '—', unit: '' };
    return meters < 1000
      ? { value: String(Math.round(meters)), unit: 'm' }
      : { value: (meters / 1000).toFixed(1), unit: 'km' };
  }

  function formatDuration(seconds) {
    if (seconds == null) return '—';
    const min = Math.round(seconds / 60);
    if (min < 60) return `${min} 分钟`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
  }

  /* ------------------------------------------------------------------ */
  /* 数据装配                                                            */
  /* ------------------------------------------------------------------ */

  /** 取某天的坐标点列表（只有能定位到地图上的点才参与路线） */
  function resolveStops(day) {
    return day.visits
      .map((visit, visitIndex) => {
        const loc = visit.poiId && ROUTES.locations[visit.poiId];
        return loc ? { visit, visitIndex, poiId: visit.poiId, coords: loc.coords } : null;
      })
      .filter(Boolean)
      .map((stop, i) => ({ ...stop, mapIndex: i + 1 }));
  }

  /** 取「从第 n 个点出发」的那段路 */
  function legFrom(day, stop) {
    return ROUTES.legs.find((l) => l.dayId === day.id && l.fromIndex === stop.visitIndex);
  }

  /* ------------------------------------------------------------------ */
  /* 分段渲染                                                            */
  /* ------------------------------------------------------------------ */

  function renderOverview(day, stops) {
    const legs = stops
      .map((s) => legFrom(day, s))
      .filter(Boolean);

    if (!legs.length) return null;

    // 与交通段同一口径：取每段自己推荐的那种方式
    const pick = (leg) => leg.modes[leg.primary] || {};
    const total = legs.reduce((sum, l) => sum + (pick(l).distance || 0), 0);
    const max = Math.max(...legs.map((l) => pick(l).distance || 0), 1);

    const box = el('div', 'overview');
    const head = el('div', 'overview__head');
    head.append(
      el('span', 'overview__title', '当日路线概览'),
      el('span', 'overview__total num', `合计 ${formatDistance(total).value} ${formatDistance(total).unit}`)
    );

    const track = el('div', 'overview__track');
    legs.forEach((leg) => {
      const m = pick(leg);
      const seg = el('div', 'overview__seg');
      // 用平方根压缩量级差异，避免长路段把短路段挤成一条线
      seg.style.flexGrow = String(0.25 + Math.sqrt((m.distance || 0) / max));
      seg.title = `${routeLabel(leg)} · ${formatDuration(m.duration)}`;
      track.append(seg);
    });

    const scale = el('div', 'overview__scale');
    scale.append(el('span', null, `起点 ${POI[stops[0].poiId].name}`));
    scale.append(el('span', null, `${legs.length} 段路程`));
    scale.append(el('span', null, `终点 ${POI[stops[stops.length - 1].poiId].name}`));

    box.append(head, track, scale);
    return box;
  }

  function routeLabel(leg) {
    const from = POI[leg.from] || { name: leg.from };
    const to = POI[leg.to] || { name: leg.to };
    return `${from.name} → ${to.name}`;
  }

  function renderStop(day, stop, { onSelect }) {
    const poi = POI[stop.poiId];
    const visit = stop.visit;
    const card = el('div', 'stop__card');

    const head = el('div', 'stop__head');
    head.append(el('span', 'stop__time num', visit.time || '—'));
    head.append(el('h3', 'stop__title', visit.title || poi.name));
    // 状态徽标优先级：闭馆提醒（会导致白跑）> 必玩点 > 停留时长
    const badges = [];
    if (visit.closed) {
      badges.push(el('span', 'stop__badge stop__badge--warn', visit.closed));
    } else if (visit.hot) {
      badges.push(el('span', 'stop__badge stop__badge--hot', '必玩'));
    } else if (visit.stay) {
      badges.push(el('span', 'stop__badge stop__badge--stay', visit.stay));
    }

    // 「需预约」单独标：它和「要花钱」是两件事，会同时出现在同一个点上
    if (MUST_BOOK.has(poi.id)) {
      badges.push(el('span', 'stop__badge stop__badge--book', '需预约'));
    }

    // 门票只标「要花钱」的。免费的挂上去只会让十几张卡片全是徽标，反而看不清
    if (poi.ticket && !/^免费/.test(poi.ticket)) {
      const short = poi.ticket.replace(/（.*?）/g, '').trim();
      const badge = el('span', 'stop__badge stop__badge--ticket', short);
      badge.title = poi.ticket; // 完整说明（含「以现场为准」之类的限定）放提示里
      badges.push(badge);
    }

    if (badges.length) {
      const box = el('div', 'stop__badges');
      box.append(...badges);
      head.append(box);
    }

    card.append(head);

    if (visit.desc) card.append(el('p', 'stop__desc', visit.desc));

    const addr = ROUTES.locations[stop.poiId].formattedAddress || poi.address;
    if (addr) {
      const line = el('div', 'stop__addr');
      line.append(icon(ICON_PIN, 11), el('span', null, addr));
      card.append(line);
    }

    const wrap = el('div', `stop${visit.pending ? ' stop--pending' : ''}`);
    wrap.dataset.poiId = stop.poiId;
    wrap.append(el('span', 'stop__dot'), card);

    wrap.addEventListener('click', () => onSelect(stop.poiId, wrap));
    return wrap;
  }

  /**
   * 交通段：写明这一段推荐怎么走，以及对应的距离与耗时。
   *
   * 方式是 itinerary.js 逐段定好的（生成器落到 routes-legs.js 的 primary），
   * 这里只读不算、也不做切换 —— 地图同样按这个 primary 逐段画线，
   * 两边口径天然一致，不需要再有「当前方式」这种全局状态。
   */
  function renderLeg(leg, { advice } = {}) {
    const active = leg.primary;
    const metrics = leg.modes[active] || {};
    const dist = formatDistance(metrics.distance);
    const modeMeta = CFG.MODES.find((m) => m.key === active) || CFG.MODES[0];

    const row = el('div', 'leg');
    const modeIcon = el('span', 'leg__icon');
    modeIcon.append(icon(modeMeta.icon, 13));
    row.append(modeIcon);

    const text = el('div', 'leg__text');
    text.append(el('span', 'leg__mode', modeMeta.label));
    text.append(el('span', 'leg__dist num', `${dist.value} ${dist.unit}`));
    text.append(el('span', 'leg__dur num', formatDuration(metrics.duration)));
    if (metrics.estimated) {
      const tip = el('span', 'leg__est', '直线估算');
      tip.title = '高德未返回该方式的路径，按直线距离与均速估算';
      text.append(tip);
    }
    row.append(text);

    if (metrics.distance != null) {
      const bar = el('span', 'leg__bar');
      const fill = el('i');
      fill.dataset.distance = String(metrics.distance);
      fill.style.width = '0%';
      bar.append(fill);
      row.append(bar);
    }

    // 出行提醒挂进 .leg__text，靠 flex-basis:100% 自己换行，
    // 不用为此把 .leg 从横向 flex 改成上下结构
    if (advice) {
      const tip = el('span', 'leg__advice');
      tip.append(icon(ICON_HINT, 11), el('span', null, advice));
      text.append(tip);
    }

    return row;
  }

  /* ------------------------------------------------------------------ */
  /* 对外接口                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 渲染一天的时间轴
   * @param {object} ctx { day, onSelect }
   */
  function renderDay(ctx) {
    const { day, onSelect } = ctx;
    const stops = resolveStops(day);
    const frag = document.createDocumentFragment();

    const overview = renderOverview(day, stops);
    if (overview) frag.append(overview);

    const timeline = el('div', 'timeline');
    let cursor = 0;

    day.visits.forEach((visit, visitIndex) => {
      const stop = stops.find((s) => s.visitIndex === visitIndex);

      if (stop) {
        // 两个地图点之间才画交通连接段
        if (cursor > 0) {
          const leg = legFrom(day, stops[cursor - 1]);
          if (leg) timeline.append(renderLeg(leg, { advice: visit.advice }));
        }
        timeline.append(renderStop(day, stop, { onSelect: onSelect || (() => {}) }));
        cursor++;
        return;
      }

      // 尚未定位到地图的点：仍展示，标为待规划
      timeline.append(renderPending(visit));
    });

    frag.append(timeline);

    const toPlan = day.visits.filter((v) => v.pending).length;
    const unlocated = day.visits.filter(
      (v) => !v.pending && v.poiId && !ROUTES.locations[v.poiId]
    ).length;
    if (toPlan || unlocated) frag.append(renderPendingNote(toPlan, unlocated));

    return { fragment: frag, stops };
  }

  /**
   * 没有坐标的行程点。
   * 要区分两种情况，否则会误导用户去改错文件：
   * - 真·待规划（visit.pending）：行程本身还没定
   * - 仅未定位：行程已定（如「航班起飞」），只是不需要或还没能落到地图上
   */
  function renderPending(visit) {
    const unresolved = !visit.pending && Boolean(visit.poiId);

    const wrap = el('div', 'stop stop--pending');
    const card = el('div', 'stop__card');
    const head = el('div', 'stop__head');
    head.append(el('span', 'stop__time num', visit.time || '—'));
    head.append(el('h3', 'stop__title', visit.title || '待规划'));

    const badge = el('span', 'stop__badge', unresolved ? '未定位' : '待规划');
    if (unresolved) badge.title = '该地点没有坐标，请重跑 node tools/generate-routes.js';
    head.append(badge);
    card.append(head);
    if (visit.desc) card.append(el('p', 'stop__desc', visit.desc));
    wrap.append(el('span', 'stop__dot'), card);
    return wrap;
  }

  /** 底部提示：分别说明「待规划」与「未定位」，指向各自该改的地方 */
  function renderPendingNote(toPlan, unlocated) {
    const note = el('div', 'pending-note');
    note.append(icon(ICON_HINT, 14));

    const body = el('span');
    const addCode = (parent, str) => parent.append(el('code', null, str));

    if (toPlan) {
      body.append(document.createTextNode(`本日还有 ${toPlan} 项待规划。补充步骤：在 `));
      addCode(body, 'data/poi.js');
      body.append(document.createTextNode(' 加地点 → 在 '));
      addCode(body, 'data/itinerary.js');
      body.append(document.createTextNode(' 排顺序 → 跑 '));
      addCode(body, 'node tools/generate-routes.js');
      body.append(document.createTextNode('。'));
    }
    if (unlocated) {
      if (toPlan) body.append(document.createElement('br'));
      body.append(
        document.createTextNode(
          `另有 ${unlocated} 项已定行程但没有坐标，未显示在地图上，请重跑生成器。`
        )
      );
    }

    note.append(body);
    return note;
  }

  /** 刷新距离条：按当天最长路段归一化 */
  function paintBars(container) {
    const fills = [...container.querySelectorAll('.leg__bar > i')];
    const max = Math.max(...fills.map((f) => Number(f.dataset.distance) || 0), 1);
    fills.forEach((f) => {
      const d = Number(f.dataset.distance) || 0;
      f.style.width = `${Math.round(18 + 82 * Math.sqrt(d / max))}%`;
    });
  }

  window.TripTimeline = {
    renderDay,
    paintBars,
    resolveStops,
    formatDistance,
    formatDuration,
    /** 供 app.js 渲染模式条图标，避免同一套 SVG 构造逻辑写两份 */
    svgIcon: icon
  };
})();
