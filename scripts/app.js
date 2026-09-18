/* ============================================================
   应用编排：日切换、时间轴渲染、地图联动
   ============================================================ */

(function () {
  'use strict';

  const CFG = window.TRIP_CONFIG;
  const ITINERARY = window.TRIP_ITINERARY;
  const ROUTES = window.TRIP_ROUTES;
  const POI = window.TRIP_POI;

  /** 每日主题色：统一由 config.js 提供，避免和 CSS 令牌各改一份对不上 */
  const DAY_HUE = CFG.DAY_HUE;

  const dom = {
    city: document.getElementById('city'),
    dateRange: document.getElementById('date-range'),
    tags: document.getElementById('tags'),
    anchors: document.getElementById('anchors'),
    daybar: document.getElementById('daybar'),
    eyebrow: document.getElementById('day-eyebrow'),
    title: document.getElementById('day-title'),
    summary: document.getElementById('day-summary'),
    stats: document.getElementById('day-stats'),
    scroll: document.getElementById('sidebar-scroll'),
    mapStatus: document.getElementById('map-status'),
    mapNote: document.getElementById('map-note'),
    mapError: document.getElementById('map-error'),
    wxLive: document.getElementById('wx-live'),
    wxDay: document.getElementById('wx-day')
  };

  const state = {
    dayIndex: 0,
    mapReady: false
  };

  /**
   * 请求令牌：每次画线自增。
   * 异步返回时若令牌已变，说明用户又切了天/换了方式，本次结果直接丢弃，
   * 否则会出现「慢请求后到，把新画面覆盖成旧路线」。
   */
  let paintSeq = 0;

  /* ------------------------------------------------------------------ */
  /* 顶部信息带                                                          */
  /* ------------------------------------------------------------------ */

  function renderBand() {
    const { TRIP, ANCHORS } = CFG;

    dom.city.textContent = TRIP.city;
    dom.dateRange.textContent = TRIP.dateRange;
    TRIP.tags.forEach((t) => dom.tags.append(text('span', 'tag', t)));

    const icons = {
      arrival:
        '<path d="M17.8 19.2 16 11l3.5-3.5a2.1 2.1 0 1 0-3-3L13 8 4.8 6.2a1 1 0 0 0-.9 1.7L9 11l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.1 5.1a1 1 0 0 0 1.7-.9Z"/>',
      hotel: '<path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-6h6v6"/>',
      departure:
        '<path d="M9 3v6l-5 3v4l5-2v4l-2 2v2l4-1 4 1v-2l-2-2v-4l5 2v-4l-5-3V3Z"/>'
    };

    Object.entries(icons).forEach(([key, path]) => {
      const data = ANCHORS[key];
      if (!data) return;

      const card = div('anchor');
      const iconBox = div('anchor__icon');
      iconBox.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none"
        stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">${path}</svg>`;

      const body = div('anchor__body');
      const head = div('anchor__head');
      head.append(
        text('span', 'anchor__label', data.label),
        text('span', 'anchor__time num', data.time)
      );
      body.append(head, text('div', 'anchor__place', data.place));
      if (data.note) body.append(text('div', 'anchor__note', data.note));

      card.append(iconBox, body);
      dom.anchors.append(card);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 天气                                                                */
  /* ------------------------------------------------------------------ */

  function wxIcon(desc, size) {
    return window.TripTimeline.svgIcon(window.TripWeather.iconPath(desc), size);
  }

  /** 顶栏：武汉此刻的实况。取不到就整块隐藏，不留空壳 */
  function renderLiveWeather() {
    const live = window.TripWeather.getLive();
    if (!live) {
      dom.wxLive.hidden = true;
      return;
    }

    dom.wxLive.replaceChildren(
      wxIcon(live.text, 15),
      text('span', 'wx__temp num', `${live.temp}°`),
      text('span', 'wx__text', live.text)
    );
    dom.wxLive.title =
      `武汉实况 · ${live.text} ${live.temp}°C · ${live.wind}风 ${live.windpower} 级` +
      (live.humidity ? ` · 湿度 ${live.humidity}%` : '') +
      (live.reportTime ? `\n${live.reportTime}` : '');
    dom.wxLive.hidden = false;
  }

  /**
   * 侧栏：当前选中那天的天气。
   * 高德预报只覆盖今天起 4 天，行程日多半不在窗口内 ——
   * 那不是错误，所以这里改写成「预报哪天起可查」，而不是显示空白或报错。
   */
  function renderDayWeather(day) {
    const W = window.TripWeather;
    const box = dom.wxDay;
    const status = W.getStatus();

    // 尚未取到 / 接口挂了：不动声色地隐藏。
    // 接口失败时不能退化成「预报 X 日起可查」的提示，那是在陈述一个未知的事实。
    if (status !== 'ready') {
      box.hidden = true;
      return;
    }

    const fc = W.getDay(day.date);

    if (fc) {
      box.className = 'wx wx--day';
      box.replaceChildren(
        wxIcon(fc.dayText, 16),
        text('span', 'wx__text', fc.dayText),
        text('span', 'wx__temp num', `${fc.low}~${fc.high}°C`),
        text('span', 'wx__meta', `${fc.wind}风 ${fc.windpower} 级`)
      );
      const night = fc.nightText && fc.nightText !== fc.dayText ? `，夜间转${fc.nightText}` : '';
      box.title = `高德预报 · ${fc.date}${night}`;
      box.hidden = false;
      return;
    }

    const left = W.daysUntilAvailable(day.date);
    if (left == null) {
      box.hidden = true;
      return;
    }

    box.className = 'wx wx--day is-pending';
    const [, m, d] = W.availableFrom(day.date).split('-');
    box.replaceChildren(wxIcon('', 16));
    box.append(
      text(
        'span',
        'wx__text',
        left > 0 ? `预报 ${Number(m)} 月 ${Number(d)} 日起可查` : '该日暂无预报'
      )
    );
    if (left > 0) box.append(text('span', 'wx__meta', `还有 ${left} 天`));
    box.title = '高德天气预报只覆盖今天起 4 天；行程日临近后这里会自动变成真实预报';
    box.hidden = false;
  }

  /* ------------------------------------------------------------------ */
  /* 日切换标签                                                          */
  /* ------------------------------------------------------------------ */

  function renderDaybar() {
    ITINERARY.days.forEach((day, i) => {
      const tab = document.createElement('button');
      tab.className = 'daytab';
      tab.style.setProperty('--day-hue', DAY_HUE[day.id] || '#b07510');
      tab.type = 'button';

      const label = div('daytab__label');
      label.innerHTML = `<span class="daytab__dot"></span>${day.label}`;
      tab.append(label, text('span', 'daytab__date', day.dateText));

      tab.addEventListener('click', () => selectDay(i));
      dom.daybar.append(tab);
    });
  }

  function syncTabs() {
    [...dom.daybar.children].forEach((tab, i) => {
      tab.classList.toggle('is-active', i === state.dayIndex);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 单日渲染                                                            */
  /* ------------------------------------------------------------------ */

  async function selectDay(index) {
    state.dayIndex = index;
    const day = ITINERARY.days[index];
    const hue = DAY_HUE[day.id] || '#b07510';

    syncTabs();
    dom.scroll.scrollTop = 0;

    // 主题色下推到 CSS 变量，圆点 / 卡片描边自动跟随
    dom.scroll.style.setProperty('--day-hue', hue);

    dom.eyebrow.textContent = `${day.dateText} · ${day.label}`;
    dom.title.textContent = day.title;
    dom.summary.textContent = day.summary;
    renderDayWeather(day);

    const stops = renderSidebar(day);

    if (!state.mapReady) return;

    // 换天：重画标记与视野，再按当前出行方式画线。
    // 地图侧的任何异常都不该影响左栏行程展示，所以单点兜住。
    try {
      window.TripMap.resetDay(day.id);
      window.TripMap.drawMarkers(
        stops.map((s) => ({ poi: POI[s.poiId], index: s.mapIndex })),
        day.id
      );
      // 换天时重新框选视野，否则用户上一轮平移/缩放后，新一天的点可能在屏幕外
      if (stops.length) window.TripMap.focusStops(stops.map((s) => s.coords));
      await paintRoute(day, stops);
    } catch (err) {
      console.warn('[武汉攻略] 地图绘制失败：', err && err.stack ? err.stack : err);
      showStatus(false);
      dom.mapNote.classList.remove('is-on');
    }
  }

  /** 画当前天的路线；首次取路径时给加载态 */
  async function paintRoute(day, stops) {
    const seq = ++paintSeq;
    const stale = () => seq !== paintSeq;
    const modes = legModes(day, stops);

    if (!window.TripMap.hasPath(day.id, modes) && stops.length > 1) showStatus(true);

    let result = null;
    try {
      result = await window.TripMap.drawRoute(stops, day.id, modes);
    } finally {
      // 无论成功、失败还是被取代，都要复位加载态，否则会一直转圈
      if (!stale()) {
        showStatus(false);
        dom.mapNote.classList.toggle('is-on', Boolean(result && result.schematic));
      }
    }
  }

  function renderStats(day, stops) {
    const legs = dayLegs(day, stops);

    // 与交通段、地图同一口径：取每段自己推荐的那种方式
    const pick = (leg) => leg.modes[leg.primary] || {};
    const total = legs.reduce((sum, l) => sum + (pick(l).distance || 0), 0);
    const minutes = legs.reduce((sum, l) => sum + (pick(l).duration || 0), 0);

    dom.stats.replaceChildren();
    if (!legs.length) {
      dom.stats.append(statEl('—', '路线待规划'));
      return;
    }

    const d = window.TripTimeline.formatDistance(total);
    dom.stats.append(
      statEl(String(stops.length), '个行程点'),
      statEl(`${d.value} ${d.unit}`, '总路程'),
      statEl(window.TripTimeline.formatDuration(minutes), '在途时间'),
      statEl(String(legs.length), '段交通')
    );
  }

  function statEl(value, unit) {
    const box = div('daystat');
    box.append(text('span', 'daystat__value', value), text('span', 'daystat__unit', unit));
    return box;
  }

  /* ------------------------------------------------------------------ */
  /* 路段                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 当天相邻两点之间的路段，按行程顺序。
   * 出行方式是逐段定死在 routes-legs.js 的 primary 上的（由 itinerary.js 的
   * mode 字段决定），没有全局切换这回事 —— 所以这里没有「当前方式」这种状态。
   */
  function dayLegs(day, stops) {
    return stops
      .map((s) => ROUTES.legs.find((l) => l.dayId === day.id && l.fromIndex === s.visitIndex))
      .filter(Boolean);
  }

  /** 每段推荐的方式，长度 = stops.length - 1，交给地图逐段取路径 */
  function legModes(day, stops) {
    return dayLegs(day, stops).map((l) => l.primary || 'driving');
  }

  /** 渲染左栏（时间轴 + 统计），与地图解耦 */
  function renderSidebar(day) {
    const { fragment, stops } = window.TripTimeline.renderDay({
      day,
      onSelect: onSelectStop
    });

    dom.scroll.replaceChildren(fragment);
    window.TripTimeline.paintBars(dom.scroll);
    renderStats(day, stops);
    return stops;
  }

  /* ------------------------------------------------------------------ */
  /* 联动：时间轴 ↔ 地图                                                 */
  /* ------------------------------------------------------------------ */

  function onSelectStop(poiId, node) {
    dom.scroll
      .querySelectorAll('.stop.is-active')
      .forEach((n) => n.classList.remove('is-active'));
    node.classList.add('is-active');

    if (!state.mapReady || !window.TripMap.hasPin(poiId)) return;

    const coords = ROUTES.locations[poiId].coords;
    const map = window.TripMap.getMap();
    map.setZoomAndCenter(Math.max(map.getZoom(), 14), coords, false, 420);
  }

  /* ------------------------------------------------------------------ */
  /* 工具                                                               */
  /* ------------------------------------------------------------------ */

  function div(className) {
    const node = document.createElement('div');
    node.className = className;
    return node;
  }

  function text(tag, className, content) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = content;
    return node;
  }

  function showStatus(on) {
    dom.mapStatus.classList.toggle('is-on', on);
  }

  function showMapError(message) {
    dom.mapError.classList.add('is-on');
    if (message) dom.mapError.querySelector('p').textContent = message;
  }

  /* ------------------------------------------------------------------ */
  /* 侧栏折叠                                                            */
  /* ------------------------------------------------------------------ */

  /** 鼠标进到左侧这个宽度以内就浮出侧栏 */
  const PEEK_ZONE = 16;
  /** 浮出后，鼠标要越过侧栏右缘这么多像素才收回。留余量，免得在边界上抖 */
  const PEEK_HYSTERESIS = 10;

  /** 行前准备抽屉开着的时候不要抢鼠标和 Esc */
  function drawerOpen() {
    const prep = document.getElementById('prep');
    return Boolean(prep && prep.classList.contains('is-on'));
  }

  function initRail() {
    const body = document.querySelector('.body');
    const side = document.getElementById('sidebar');
    const toggle = document.getElementById('rail-toggle');
    if (!body || !side || !toggle) return;

    let collapsed = false;
    let peek = false;

    /** 容器宽度变了必须让高德重算画布，否则瓦片和折线会错位 */
    function resizeMap() {
      const map = window.TripMap && window.TripMap.getMap();
      if (map) map.resize();
    }

    function apply() {
      body.classList.toggle('is-collapsed', collapsed);
      body.classList.toggle('is-peek', peek);
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
      // 等过渡结束再量宽度：中途 resize 量到的是过渡中的中间值
      window.setTimeout(resizeMap, 320);
    }

    function setCollapsed(next) {
      collapsed = next;
      if (!collapsed) peek = false;
      apply();
    }

    toggle.addEventListener('click', () => setCollapsed(!collapsed));

    // 用 mousemove 统一判定，而不是 enter/leave 配对：
    // 侧栏浮出后正好盖住触发它的那条边，enter/leave 会立刻来回抖。
    //
    // 必须用捕获阶段：高德在地图画布上挂了自己的鼠标处理，冒泡到 document
    // 的这条监听会被它截断，表现为「鼠标移开侧栏不收回」。
    document.addEventListener(
      'mousemove',
      (e) => {
        if (!collapsed || drawerOpen()) return;
        if (e.clientX <= PEEK_ZONE && !peek) {
          peek = true;
          apply();
        } else if (peek && e.clientX > side.offsetWidth + PEEK_HYSTERESIS) {
          peek = false;
          apply();
        }
      },
      true
    );

    // 收起状态下 Esc 直接展开，键盘用户不用去找那颗小按钮
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && collapsed && !drawerOpen()) setCollapsed(false);
    });

    window.addEventListener('resize', () => {
      if (peek) {
        peek = false;
        apply();
      }
      resizeMap();
    });
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                               */
  /* ------------------------------------------------------------------ */

  async function boot() {
    renderBand();
    renderDaybar();
    window.TripPrep.init();
    initRail();

    // 天气不参与首屏：先让行程和地图出来，取到数据再补两处天气。
    // 两处天气互相独立 —— 实况来自 base，当日来自预报 all，一边挂了不影响另一边。
    window.TripWeather.load()
      .then(() => {
        renderLiveWeather();
        renderDayWeather(ITINERARY.days[state.dayIndex]);
      })
      .catch((err) => console.warn('[武汉攻略] 天气加载失败：', err));

    try {
      await window.TripMap.init();
      state.mapReady = true;
      await selectDay(0);
    } catch (err) {
      // 地图挂了也要能看行程：先把时间轴渲染出来，再提示地图问题
      console.warn('[武汉攻略] 地图初始化失败：', err);
      await selectDay(0);
      showMapError(
        `地图初始化失败：${err.message}。请确认 index.html 中的 WebJS Key 有效，` +
          `且高德控制台已为该 Key 绑定「Web端(JS API)」平台。`
      );
    }

    // J/K 或 ←/→ 快速翻页
    document.addEventListener('keydown', (e) => {
      // 输入框、地图画布（方向键要用来平移）、已被处理的按键都不抢
      if (e.defaultPrevented) return;
      if (e.target.matches('input, textarea, select')) return;
      if (e.target.closest && e.target.closest('.amap-container')) return;

      const key = e.key.toLowerCase();
      const next =
        e.key === 'ArrowRight' || key === 'j'
          ? state.dayIndex + 1
          : e.key === 'ArrowLeft' || key === 'k'
            ? state.dayIndex - 1
            : null;
      if (next == null) return;
      if (next < 0 || next >= ITINERARY.days.length) return;
      e.preventDefault();
      selectDay(next);
    });
  }

  boot();
})();
