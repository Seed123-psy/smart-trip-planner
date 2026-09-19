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
  const dayHue = (index) => CFG.dayHue(index);

  const dom = {
    city: document.getElementById('city'),
    dateRange: document.getElementById('date-range'),
    tags: document.getElementById('tags'),
    daybar: document.getElementById('daybar'),
    eyebrow: document.getElementById('day-eyebrow'),
    title: document.getElementById('day-title'),
    summary: document.getElementById('day-summary'),
    stats: document.getElementById('day-stats'),
    scroll: document.getElementById('sidebar-scroll'),
    mapStatus: document.getElementById('map-status'),
    mapNote: document.getElementById('map-note'),
    mapError: document.getElementById('map-error'),
    notice: document.getElementById('notice'),
    wxLive: document.getElementById('wx-live'),
    wxDay: document.getElementById('wx-day')
  };

  /** dayIndex 取它表示「总览」：全部天数的标记与路线同屏 */
  const VIEW_ALL = -1;

  const state = {
    dayIndex: VIEW_ALL,
    mapReady: false,
    /** 这次显示的是不是只读的分享视图（?share=）。只读时编辑与规划入口都藏掉 */
    readOnly: false,
    /** 这份行程在服务端的 id。没有就说明它还没落库（比如 sessionStorage 交接来的），分享不了 */
    tripId: null
  };

  /**
   * 请求令牌：每次画线自增。
   * 异步返回时若令牌已变，说明用户又切了天/换了方式，本次结果直接丢弃，
   * 否则会出现「慢请求后到，把新画面覆盖成旧路线」。
   */
  let paintSeq = 0;

  /**
   * 当前生效的那份规划产物。
   * 编辑模式改完之后要存回 sessionStorage，而它能改的只有行程与路段 ——
   * 以这份为底覆盖，美食、行前准备这些编辑碰不到的内容才不会丢。
   */
  let appliedPlan = null;

  /* ------------------------------------------------------------------ */
  /* 顶部信息带                                                          */
  /* ------------------------------------------------------------------ */

  function renderBand() {
    const { TRIP } = CFG;

    dom.city.textContent = TRIP.city;
    dom.dateRange.textContent = TRIP.dateRange;
    dom.tags.replaceChildren();
    TRIP.tags.forEach((t) => dom.tags.append(text('span', 'tag', t)));
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

    // 总览时 dayIndex 是 -1，days[-1] 是 undefined。
    // 天气又是异步补上来的，走到这儿时可能已经切到总览了 —— 必须挡住。
    if (!day) {
      box.hidden = true;
      return;
    }

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

  /**
   * 取一次天气并刷新两处展示。
   * 两处天气互相独立 —— 实况来自 base、当日来自预报 all，一边挂了不影响另一边。
   * 首屏和「规划到别的城市」都走这里，避免两处各写一遍取数逻辑。
   */
  function refreshWeather() {
    return window.TripWeather.load()
      .then(() => {
        renderLiveWeather();
        renderDayWeather(ITINERARY.days[state.dayIndex]);
      })
      .catch((err) => console.warn('[武汉攻略] 天气加载失败：', err));
  }

  /* ------------------------------------------------------------------ */
  /* 日切换标签                                                          */
  /* ------------------------------------------------------------------ */

  function renderDaybar() {
    dom.daybar.replaceChildren();

    // 最前面是「全部」：用户刚在首页看着几天的路线一起长出来，
    // 进来先接住那个全貌，再让他自己决定看哪天
    const all = document.createElement('button');
    all.className = 'daytab daytab--all';
    all.type = 'button';
    const allLabel = div('daytab__label');
    allLabel.append(text('span', 'daytab__dot', ''), document.createTextNode('全部'));
    all.append(allLabel, text('span', 'daytab__date', `${ITINERARY.days.length} 天 · 总览`));
    all.addEventListener('click', () => selectDay(VIEW_ALL));
    dom.daybar.append(all);

    ITINERARY.days.forEach((day, i) => {
      const tab = document.createElement('button');
      tab.className = 'daytab';
      tab.style.setProperty('--day-hue', dayHue(i));
      tab.type = 'button';

      // 用节点拼而不是 innerHTML：day.label 来自模型输出，服务端只裁长度不转义
      const label = div('daytab__label');
      label.append(text('span', 'daytab__dot', ''), document.createTextNode(day.label));
      tab.append(label, text('span', 'daytab__date', day.dateText));

      tab.addEventListener('click', () => selectDay(i));
      dom.daybar.append(tab);
    });
  }

  /** daybar 里「全部」占了第 0 位，天标签整体后移一位 */
  function syncTabs() {
    [...dom.daybar.children].forEach((tab, i) => {
      const active = i === 0 ? state.dayIndex === VIEW_ALL : state.dayIndex === i - 1;
      tab.classList.toggle('is-active', active);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 单日渲染                                                            */
  /* ------------------------------------------------------------------ */

  async function selectDay(index) {
    state.dayIndex = index;
    syncTabs();
    dom.scroll.scrollTop = 0;

    if (index === VIEW_ALL) return selectOverview();

    const day = ITINERARY.days[index];
    // 按「第几天」取色而不是按 day.id：天数由用户选，1—14 天都要有自己的颜色
    const hue = dayHue(index);


    // 主题色下推到 CSS 变量，圆点 / 卡片描边自动跟随
    dom.scroll.style.setProperty('--day-hue', hue);

    dom.eyebrow.textContent = `${day.dateText} · ${day.label}`;
    dom.title.textContent = day.title;
    dom.summary.textContent = day.summary;
    renderDayWeather(day);

    const stops = renderSidebar(day, index);

    if (!state.mapReady) return;

    // 换天：重画标记与视野，再按当前出行方式画线。
    // 地图侧的任何异常都不该影响左栏行程展示，所以单点兜住。
    try {
      window.TripMap.resetDay();
      window.TripMap.drawMarkers(
        stops.map((s) => ({ poi: POI[s.poiId], index: s.mapIndex })),
        hue
      );
      // 换天时重新框选视野，否则用户上一轮平移/缩放后，新一天的点可能在屏幕外
      if (stops.length) window.TripMap.focusStops(stops.map((s) => s.coords));
      await paintRoute(day, stops, hue);
    } catch (err) {
      console.warn('[武汉攻略] 单日地图绘制失败：', err && err.stack ? err.stack : err);
      showStatus(false);
      dom.mapNote.classList.remove('is-on');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 全旅程总览                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 总览：所有天的标记与路线同屏，左栏列出每天供点选。
   *
   * 这里也是首页那幅画面的落点 —— 用户刚看着几天的线一起长出来，
   * 进来先接上全貌，而不是立刻塌成 Day 1。
   */
  async function selectOverview() {
    const { fragment, totals } = window.TripTimeline.renderTripSummary({
      days: ITINERARY.days,
      onSelectDay: (i) => selectDay(i)
    });

    const sum = (pick) => totals.reduce((n, t) => n + pick(t), 0);
    const distance = sum((t) => t.distance);
    const duration = sum((t) => t.duration);
    const dist = window.TripTimeline.formatDistance(distance);

    dom.eyebrow.textContent = `${ITINERARY.days.length} 天 · 全旅程`;
    dom.title.textContent = '行程总览';
    dom.summary.textContent =
      `合计 ${dist.value} ${dist.unit} · 在途 ${window.TripTimeline.formatDuration(duration)}。` +
      '点下面任意一天看当天的细节。';
    // 总览没有「当天」，天气块要藏起来，否则会挂着上一次选中那天的预报
    dom.wxDay.hidden = true;
    // 总览不属于任何一天，用古铜而不是某一天的色，免得看着像「第 N 天」
    dom.scroll.style.setProperty('--day-hue', 'var(--gold)');
    dom.scroll.replaceChildren(fragment);

    dom.stats.replaceChildren(
      statEl(String(ITINERARY.days.length), '天'),
      statEl(String(sum((t) => t.stops)), '个行程点'),
      statEl(`${dist.value} ${dist.unit}`, '总路程'),
      statEl(window.TripTimeline.formatDuration(duration), '在途时间')
    );

    if (!state.mapReady) return;

    try {
      window.TripMap.resetDay();

      const days = ITINERARY.days.map((day, i) => {
        const raw = window.TripTimeline.resolveStops(day);
        return {
          id: day.id,
          hue: dayHue(i),
          // map.js 那边要的是 { poi, coords, mapIndex } 这个形状
          stops: raw
            .map((s) => ({ poi: POI[s.poiId], coords: s.coords, mapIndex: s.mapIndex }))
            .filter((s) => s.poi),
          modes: legModes(day, raw)
        };
      });

      const coords = days.flatMap((d) => d.stops.map((s) => s.coords));
      if (coords.length) window.TripMap.focusStops(coords);

      // 视野先到位，再等路线取全了一次画上 —— 中途宁可只有点、不画半截的线。
      // 这几天一起取要几秒（串行 + 控速），所以必须给加载态，
      // 否则那几秒看起来就是「路线没出来」。
      showStatus(true);
      window.TripMap.drawOverview(days)
        .catch((err) => console.warn('[武汉攻略] 总览路线绘制失败：', err && err.message))
        .finally(() => showStatus(false));
    } catch (err) {
      console.warn('[武汉攻略] 总览绘制失败：', err && err.stack ? err.stack : err);
    }
  }

  /** 画当前天的路线；首次取路径时给加载态 */
  async function paintRoute(day, stops, hue) {
    const seq = ++paintSeq;
    const stale = () => seq !== paintSeq;
    const modes = legModes(day, stops);

    if (!window.TripMap.hasPath(day.id, modes) && stops.length > 1) showStatus(true);

    let result = null;
    try {
      // dayId 仍然要给：路径缓存按「哪天 + 哪种方式组合」隔离，和颜色无关
      result = await window.TripMap.drawRoute(stops, day.id, modes, hue);
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
  function renderSidebar(day, index) {
    const { fragment, stops } = window.TripTimeline.renderDay({
      day,
      onSelect: onSelectStop,
      // 编辑模式下把操作回调交给时间轴。它只管画，改数据是编辑器的事 ——
      // 时间轴不需要知道「编辑」意味着什么。
      edit:
        window.TripEditor && window.TripEditor.isOn() ? window.TripEditor.context(index) : null
    });

    dom.scroll.replaceChildren(fragment);
    window.TripTimeline.paintBars(dom.scroll);
    renderStats(day, stops);
    return stops;
  }

  /**
   * 重画当前这天，**不重置滚动、不重新框视野**。
   *
   * 编辑模式专用：每改一次就调它。若走 selectDay，镜头会被重新拉到
   * 「刚好装下这一天」，而用户正在盯着某个点改东西 —— 画面一跳就找不着北了。
   */
  async function refreshDay() {
    if (state.dayIndex === VIEW_ALL) return selectOverview();
    const index = state.dayIndex;
    const day = ITINERARY.days[index];
    if (!day) return;

    const keepScroll = dom.scroll.scrollTop;
    const stops = renderSidebar(day, index);
    dom.scroll.scrollTop = keepScroll;

    if (!state.mapReady) return;
    try {
      window.TripMap.resetDay();
      window.TripMap.drawMarkers(
        stops.map((s) => ({ poi: POI[s.poiId], index: s.mapIndex })),
        dayHue(index)
      );
      await paintRoute(day, stops, dayHue(index));
    } catch (err) {
      console.warn('[武汉攻略] 重画失败：', err && err.message ? err.message : err);
    }
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

  let noticeTimer = 0;

  /**
   * 顶部临时提示。
   *
   * 与 showMapError 分开，而不是复用它：那个面板的标题写死了
   * 「地图暂时没能加载出来」，拿它显示「分享链接已复制」会变成
   * 一句莫名其妙的话 —— 而用户看到的正是这句标题。
   */
  function showNotice(text, tone) {
    if (!dom.notice) return;

    dom.notice.textContent = text;
    dom.notice.dataset.tone = tone || 'ok';
    dom.notice.hidden = false;

    clearTimeout(noticeTimer);
    // 成功提示自动收；失败留着不自动消失 —— 尤其分享失败时，
    // 链接是要让人抄下来的
    if (tone !== 'error') {
      noticeTimer = setTimeout(() => {
        dom.notice.hidden = true;
      }, 6000);
    }
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

  /**
   * 只把行程写进全局数据，不碰 DOM。
   *
   * 单独拆出来是给 trip.html 的启动用的：从首页带过来的行程必须在
   * renderBand / renderDaybar / TripMap.init 之前就位，首屏才能一次画对；
   * 若走整条 applyGeneratedPlan，会先按旧数据渲染一遍再被覆盖，闪一下。
   *
   * @returns {boolean} 城市是否变了 —— 天气要据此决定撤不撤下来
   */
  /** 清空目标对象再灌入新数据：保持对象身份不变，只换内容 */
  function replaceInto(target, source) {
    Object.keys(target).forEach((key) => {
      delete target[key];
    });
    Object.assign(target, source);
  }

  function applyPlanData(plan) {
    if (!plan || !Array.isArray(plan.days) || !plan.days.length) {
      throw new Error('规划结果为空');
    }

    // 换掉而不是合并。
    //
    // 这几个全局量是从 data/*.js 初始化的，装的是内置武汉行程那一套。
    // 合并的话它们会留下来 —— 规划桂林时，编辑模式的备选池里会冒出
    // 「黄鹤楼」「湖北省博物馆」这种和桂林毫无关系的选项，而且因为
    // 它们不是本次检索的结果，看起来还挺像回事。
    //
    // 注意必须**原地改写**：timeline / prep / editor / map 都在模块加载时
    // 取过 window.TRIP_POI 的引用，整个替换掉的话它们还攥着旧的空对象。
    replaceInto(window.TRIP_POI, plan.poi || {});
    replaceInto(window.TRIP_ROUTES.locations, (plan.routes && plan.routes.locations) || {});
    window.TRIP_ROUTES.legs = (plan.routes && plan.routes.legs) || [];
    window.TRIP_ITINERARY.days = plan.days;

    const cityChanged = Boolean(plan.city) && plan.city !== CFG.TRIP.city;
    CFG.TRIP.city = plan.city || CFG.TRIP.city;
    // 公交/地铁算路按城市参数走，天气按 adcode 查，两者都得跟着规划结果换。
    // 服务端没解析出编码时：公交退回城市名（高德认名字），天气置空 ——
    // 宁可让天气区隐藏，也不能继续显示上一座城市的天气。
    CFG.TRIP.cityCode = plan.citycode || (cityChanged ? CFG.TRIP.city : CFG.TRIP.cityCode);
    CFG.TRIP.adcode = plan.adcode || (cityChanged ? '' : CFG.TRIP.adcode);
    CFG.TRIP.startDate = plan.startDate || CFG.TRIP.startDate;
    CFG.TRIP.endDate = plan.endDate || CFG.TRIP.endDate;
    CFG.TRIP.dateRange = `${CFG.TRIP.startDate} — ${CFG.TRIP.endDate}`;
    CFG.TRIP.tags = [`AI 规划 · ${plan.days.length} 天`, '路线可继续调整'];

    if (window.TripRoute && window.TripRoute.clearCache) window.TripRoute.clearCache();
    if (window.TripMap && window.TripMap.clearCache) window.TripMap.clearCache();
    appliedPlan = plan;
    // 美食不是行前准备的一部分，它有自己的阶段和字段，所以两个一起传进去
    applyPrepData(plan.prep, plan.food);
    return cityChanged;
  }

  /**
   * 行前准备换成这次行程的。
   *
   * 四个键一律显式写掉，不能只赋存在的那些 —— 只赋存在的键的话，
   * 这次没产出的那块会留着上一趟（比如武汉的打包清单）继续显示，
   * 而那些条目是照着别的城市写的，比空着更误导。
   */
  function applyPrepData(prep, food) {
    const target = window.TRIP_PREP;
    if (!target) return;
    const data = prep && typeof prep === 'object' ? prep : {};

    target.bookings = Array.isArray(data.bookings) ? data.bookings : [];
    target.tickets = Array.isArray(data.tickets) ? data.tickets : [];
    target.packing = Array.isArray(data.packing) ? data.packing : [];
    target.transport =
      data.transport && typeof data.transport === 'object'
        ? data.transport
        : { summary: '', points: [] };
    target.emergency = Array.isArray(data.emergency) ? data.emergency : [];

    // 美食是另一个 Agent 的产出，有自己的全局量与自己的抽屉视图，
    // 不塞进 TRIP_PREP 里 —— 两者本来就是两回事。
    window.TRIP_FOOD = food && typeof food === 'object' ? food : { summary: '', items: [] };

    // 抽屉可能还没初始化（boot 阶段先落数据、后建 DOM），
    // refresh 里对空容器是安全的
    if (window.TripDrawer) window.TripDrawer.refresh();
  }

  /** 行程页内重新规划：写数据 + 就地重渲染 */
  async function applyGeneratedPlan(plan) {
    const cityChanged = applyPlanData(plan);

    if (cityChanged) {
      // 旧城市的天气要立刻撤下：清 state 只管住数据，DOM 得等新数据回来才会更新，
      // 中间这段时间顶栏会一直挂着上一座城市的天气
      dom.wxLive.hidden = true;
      dom.wxDay.hidden = true;
    }

    renderBand();
    renderDaybar();
    // 重新规划后回到总览：先给全貌，再让用户点进某一天。
    // 地图没起来也走这里 —— selectOverview 自己会在渲染完左栏后提前返回，
    // 行程数据本来就不受地图影响
    state.dayIndex = VIEW_ALL;
    // 换了城市就重新取那座城市的天气；同城重规划则只是刷新一次
    refreshWeather();
    await selectDay(VIEW_ALL);
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * 取一份存在服务端的行程。**任何失败都返回 null**，由调用方回落到内置行程 ——
   * 一份取不到的行程不该让整页打不开。
   */
  async function fetchPlan(url) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const body = await res.json();
      return body && body.plan ? body.plan : null;
    } catch {
      return null;
    }
  }

  /**
   * 决定这一页显示哪份行程。优先级：
   *
   *   ?share=          只读的分享链接
   *   ?trip=           存在服务端的行程
   *   ?sample=1        内置示例
   *   sessionStorage   首页刚规划好的交接
   *   内置示例
   *
   * 【?sample=1 必须排在 sessionStorage 之前】
   * 首页那个「先看看示例」的意图是「给我看内置的武汉行程」。若让交接数据
   * 抢先，它会显示成上一次规划出来的城市 —— 与按钮上写的完全不是一回事，
   * 而用户根本不会想到是「顺序」的问题。
   *
   * @returns {Promise<{plan: object|null, readOnly: boolean, notice: string|null}>}
   *   plan 为 null 表示用内置行程
   */
  async function loadItinerary() {
    const params = new URLSearchParams(location.search);

    const shareToken = params.get('share');
    if (shareToken) {
      const shared = await fetchPlan('/api/share/' + encodeURIComponent(shareToken));
      return shared
        ? { plan: shared, readOnly: true, notice: null }
        : { plan: null, readOnly: true, notice: '这个分享链接不存在，或者已经被撤销了。' };
    }

    const tripId = params.get('trip');
    if (tripId) {
      const mine = await fetchPlan('/api/trips/' + encodeURIComponent(tripId));
      return mine
        ? { plan: mine, readOnly: false, notice: null }
        : { plan: null, readOnly: false, notice: '找不到这份行程，或者你没有权限查看。' };
    }

    if (params.get('sample') === '1') {
      /* 这里**不再清掉**交接数据。
         原先清是因为「不清的话，示例会显示成上次规划出来的城市」——
         但那个问题在更上面就被解决了：这个分支直接返回内置行程，
         根本不读 sessionStorage。
         而清掉的代价是：看一眼示例（顶栏常驻入口）就把刚规划好、
         还没落盘的那份交接数据销毁了，后退或再打开行程页就只剩内置的武汉。

         不在这里清还有个好处：清空变成「下一次规划覆盖」这一个动作，
         语义比「看示例 = 丢弃」单纯得多。 */
      return { plan: null, readOnly: false, notice: null };
    }

    if (window.TripPlanStore) {
      const pending = window.TripPlanStore.read();
      if (pending) return { plan: pending, readOnly: false, notice: null };
    }

    return { plan: null, readOnly: false, notice: null };
  }

  /**
   * 分享按钮。
   *
   * 只对「已经在服务端有一份」的行程有意义 —— 从 sessionStorage 交接来的那份
   * 可能还没落库（用户没登录时服务端不知道是谁的，但 id 依然存在，
   * 见 tools/trips.js 的说明）。没有 tripId 或处于只读视图时按钮直接藏起来，
   * 而不是让人点了才看到报错。
   */
  function initShare() {
    const btn = document.getElementById('share-open');
    if (!btn) return;

    if (!state.tripId || state.readOnly) {
      btn.hidden = true;
      return;
    }

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await fetch(`/api/trips/${encodeURIComponent(state.tripId)}/share`, { method: 'POST' });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error((body && body.error) || `请求失败（${res.status}）`);

        const url = `${location.origin}${location.pathname}?share=${body.token}`;
        let copied = false;
        try {
          await navigator.clipboard.writeText(url);
          copied = true;
        } catch {
          // 非 https 下剪贴板不可用。把链接显示出来让人手抄，别只是失败
        }

        showNotice(copied ? '分享链接已复制，发给你同行的人就能打开。' : `分享链接：${url}`,
          copied ? 'ok' : 'error');
      } catch (error) {
        showNotice('生成分享链接失败：' + error.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function boot() {
    // 取数在**任何渲染之前**完成。renderBand / renderDaybar 直接读
    // CFG.TRIP 与 ITINERARY.days，先画一遍武汉再换成用户的行程会看到明显的一闪 ——
    // 而这三种来源里有两种要发请求，所以这一步是异步的。
    // 加载期间纸面（.pageveil）不揭开，见 trip.html 里那段内联脚本。
    const loaded = await loadItinerary();
    state.readOnly = loaded.readOnly;

    // 服务端落库时挂回来的 id —— 分享按钮靠它。要在 applyPlanData 之前取，
    // 因为那一步会把 plan 的内容灌进全局，之后这份对象就不该再当数据源用了
    if (loaded.plan && typeof loaded.plan.tripId === 'string') state.tripId = loaded.plan.tripId;

    if (loaded.plan) {
      try {
        applyPlanData(loaded.plan);
        console.log(`[行程] 已载入 ${loaded.plan.days.length} 天行程：${CFG.TRIP.city}`);
      } catch (error) {
        console.warn('[行程] 应用失败，回退到内置行程：', error && error.message);
      }
    }

    if (state.readOnly) document.body.classList.add('is-readonly');

    renderBand();
    renderDaybar();
    // 抽屉壳统一初始化；行前准备与当地美食是在各自文件里注册进来的视图
    window.TripDrawer.init();
    // 只读视图不初始化编辑器：分享是给人看的，不是给人改的。
    // 入口本身由 editor.css 的 body.is-readonly 藏起来
    if (!state.readOnly) window.TripEditor.init();
    initShare();
    initRail();

    // 天气不参与首屏：先让行程和地图出来，取到数据再补上
    refreshWeather();

    // 左栏先画一次，**不等任何网络**。
    // selectDay / selectOverview 在 mapReady 为假时，会把侧栏内容写完就
    // 提前返回，所以这一步既不依赖地图，也不依赖运行时配置。
    // 顺序很重要：下面的运行时配置最多要等 3 秒（超时才回落静态值），
    // 若把左栏渲染放在它之后，「配置服务挂了」就会表现为「行程页空 3 秒」——
    // 那正是运行时配置本来要避免的那种连带故障。
    await selectDay(VIEW_ALL);

    try {
      // TripMap.init 一进去就读 CFG.AMAP，服务端的覆盖必须在那之前落定。
      if (window.TripRuntimeConfig) await window.TripRuntimeConfig.ready;

      await window.TripMap.init();
      state.mapReady = true;
      // 地图就位后再画一次，把总览里与地图相关的那部分补上
      await selectDay(VIEW_ALL);
    } catch (err) {
      // 地图挂了也要能看行程：先把时间轴渲染出来，再提示地图问题
      console.warn('[武汉攻略] 地图初始化失败：', err);
      await selectDay(VIEW_ALL);
      showMapError(
        `地图初始化失败：${err.message}。请确认 index.html 中的 WebJS Key 有效，` +
          `且高德控制台已为该 Key 绑定「Web端(JS API)」平台。`
      );
    }

    // 分享链接失效之类的提示放最后说，并且优先于地图错误 ——
    // 用户更需要知道的是「这份行程为什么不是你期望的那份」，
    // 而不是「地图为什么没出来」
    // 分享链接失效之类的提示。用 error 语气（不自动消失）：
    // 它解释的是「你看到的为什么不是你期望的那份行程」，值得让人看清
    if (loaded.notice) showNotice(loaded.notice, 'error');

    // 纸面收场：等首屏（标记与视野）就位再揭开。
    // 路线是随后自己补上来的 —— 那点「线慢慢长出来」的延迟，
    // 正好接上首页最后一拍的余味，所以不等它。
    if (document.documentElement.classList.contains('is-entering')) {
      requestAnimationFrame(() => document.documentElement.classList.add('is-entered'));
    }

    // J/K 或 ←/→ 快速翻页
    document.addEventListener('keydown', (e) => {
      // 输入框、地图画布（方向键要用来平移）、已被处理的按键都不抢
      if (e.defaultPrevented) return;
      // e.target 可能是 document 而不是元素（比如别处往 document 上派发键盘事件），
      // 那时 .matches 不存在，直接抛错会让整个处理器静默失效、方向键全没反应
      if (e.target instanceof Element && e.target.matches('input, textarea, select')) return;
      if (e.target.closest && e.target.closest('.amap-container')) return;

      const key = e.key.toLowerCase();
      const next =
        e.key === 'ArrowRight' || key === 'j'
          ? state.dayIndex + 1
          : e.key === 'ArrowLeft' || key === 'k'
            ? state.dayIndex - 1
            : null;
      if (next == null) return;
      // 合法范围包含总览（VIEW_ALL = -1）：从总览往右进第一天，
      // 从第一天往左退回总览，不用再去点标签
      if (next < VIEW_ALL || next >= ITINERARY.days.length) return;
      e.preventDefault();
      selectDay(next);
    });
  }

  window.TripApp = {
    applyGeneratedPlan,
    /** 编辑模式用：当前看的是第几天，总览时为 -1 */
    currentDayIndex: () => state.dayIndex,
    /** 编辑模式用：把改动存回 sessionStorage 时要有个底稿，见 editor.js 的 persist */
    currentPlan: () => appliedPlan,
    /** 编辑模式用：重画当前这天，不动滚动与镜头 */
    refreshDay,
    /** 编辑模式用：重算路段那几秒要有个加载态，否则像卡住了 */
    setBusy: showStatus
  };
  /* boot 必须兜底。

     boot 里任何一步意外抛错，纸面（.pageveil）就永远不会揭开 ——
     页面停在纯纸色上，既没有内容也没有提示，看起来像站点整个挂了。
     之前它是个裸调用，而 boot 里除了最后那段地图的 try/catch，
     中间十几步都在裸奔。 */
  boot().catch((error) => {
    console.error('[行程] 启动失败：', error);
    document.documentElement.classList.add('is-entered');
    try {
      showNotice('页面加载时出了点问题：' + (error && error.message ? error.message : error), 'error');
    } catch {
      /* 连提示都发不出来就只能算了，但纸面已经揭开，至少能看到页面 */
    }
  });
})();
