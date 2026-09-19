/* ============================================================
   首页墨绘层：把规划过程画在左侧的地图上

   两种模式：
     · demo（默认）—— 22 个写死的武汉地标循环播放，说明「它是怎么工作的」
     · live（提交后）—— 一切由服务端推来的阶段事件驱动：
         discover  候选点按真实坐标撒开
         select    大多数退场，留下的亮起来
         schedule  每天按顺序连成当日路线，用当天主题色
         review    朱砂印章落下
         routes    直线换成高德真实道路几何

   live 模式下画出来的每一个点、每一条线，都是这一次规划真实产生的数据，
   不是预先摆好的素材。所以这里不接受「大概像」的画法 —— 坐标一律来自
   discover 事件里的 POI，连线的顺序一律来自 schedule 事件里的排程结果。

   ── 为什么必须按经纬度写、再投影成像素 ──
   底图虽然不可交互，但窗口一变宽高、或者抽屉开合让主视觉收窄，
   同样的 center/zoom 覆盖的地理范围就变了。按屏幕坐标硬画的墨线
   会立刻错位到马路外面去。
   ============================================================ */

(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  /* ------------------------------------------------------------------ */
  /* 演示数据：直接用内置那份武汉行程                                        */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /* 演示数据：直接用内置那份武汉行程                                        */
  /* ------------------------------------------------------------------ */

  /** routes-legs.js 里的 polyline / candidates 都是 "lng,lat;lng,lat" 的紧凑串 */
  function parsePairs(str) {
    if (typeof str !== 'string' || !str) return [];
    return str
      .split(';')
      .map((pair) => pair.split(',').map(Number))
      .filter((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  }

  /**
   * 四天的路线，从**构建期算好的** data/routes-legs.js 取。
   *
   * 【这里以前是一份手抄的 22 个坐标】
   * 那段代码只画点、不画线 —— 而线才是整件事的重点：
   * 点只是「搜到了这些地方」，线才是「排成了行程」。
   *
   * 【为什么现在读 routes-legs.js 而不是 itinerary.js】
   * 后者只有点位，照它画出来是点对点的直线，一眼就能看出不是路。
   * 真实几何是 generate-routes.js 在构建期向高德要来的，已经存在这里了 ——
   * 首页直接读，运行时一次请求都不用发，也不占用高德配额。
   *
   * 演示画的就是真实的四天闭环（含机场与酒店）：
   *   Day1 机场落地 → 酒店 → 汉口江滩一圈 → 回酒店
   *   Day2 酒店 → 省博 → 东湖 → 武大 → 回酒店
   *   Day3 酒店 → 昙华林 → 黄鹤楼 → 轮渡过江 → 回酒店
   *   Day4 酒店 → 汉阳一圈 → 回酒店 → 机场
   *
   * 数据没加载上时返回空数组，调用方退回「只画点」。
   */
  function demoDays() {
    const routes = window.TRIP_ROUTES;
    if (!routes || !Array.isArray(routes.legs) || !routes.locations) return [];

    const byDay = new Map();
    for (const leg of routes.legs) {
      if (!byDay.has(leg.dayId)) byDay.set(leg.dayId, []);
      byDay.get(leg.dayId).push(leg);
    }

    const days = [];
    for (const legs of byDay.values()) {
      legs.sort((a, b) => a.fromIndex - b.fromIndex);

      const stops = [];
      const shape = [];

      for (const leg of legs) {
        const from = routes.locations[leg.from];
        const to = routes.locations[leg.to];

        if (from && from.coords && !stops.length) {
          stops.push({ id: leg.from, name: from.formattedAddress, coords: from.coords });
        }
        if (to && to.coords) {
          stops.push({ id: leg.to, name: to.formattedAddress, coords: to.coords });
        }

        // 几何取主方式那条 —— 构建期只给主方式留了 polyline
        const primary = leg.modes && leg.modes[leg.primary];
        const pts = parsePairs(primary && primary.polyline);
        if (pts.length >= 2) {
          // 相邻两段共享一个端点，拼接时去掉重复的那个，否则线上会出现回折
          shape.push(...(shape.length ? pts.slice(1) : pts));
        } else if (from && from.coords && to && to.coords) {
          // 没有几何就退回直线。这是降级，不该让整天的线断掉
          if (!shape.length) shape.push(from.coords);
          shape.push(to.coords);
        }
      }

      if (stops.length >= 2) days.push({ stops, shape });
    }
    return days;
  }

  const svg = document.getElementById('hero-ink');
  if (!svg) return;

  let project = null;
  let parts = null;

  const state = {
    mode: 'demo',
    /** 当前画的点：[{ id, name, coords:[lng,lat] }] */
    spots: [],
    /** 被筛选留下的 poiId */
    kept: new Set(),
    /** 排程结果：[[{ id, mode }, ...], ...] */
    order: [],
    /**
     * 已经画出来的路线几何，按天存原始经纬度（不是像素）。
     * 取景要用它：真实道路会绕出点位包围盒很远，只按点位框会漏掉一截。
     * 尺寸变化时也靠它重投影 —— 像素坐标换算过一次就不能再当输入。
     */
    paths: [],
    /** 印章落点，null 表示还没到那一拍 */
    sealAt: null
  };

  /* ------------------------------------------------------------------ */
  /* 兜底投影：底图没加载出来时也要能画                                    */
  /* ------------------------------------------------------------------ */

  /**
   * 把当前这批点等比铺进容器右侧的一块区域。
   * 只求「看起来像地图上的相对位置」，不追求和真实底图对齐 ——
   * 底图一旦就位，project 会被换成 map.lngLatToContainer。
   */
  function makeFallbackProjector(width, height, list) {
    if (!list.length) return () => [width * 0.6, height * 0.5];
    const lngs = list.map((s) => s.coords[0]);
    const lats = list.map((s) => s.coords[1]);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const box = { x: width * 0.36, y: height * 0.14, w: width * 0.58, h: height * 0.68 };
    const scale = Math.min(
      box.w / (maxLng - minLng || 1),
      box.h / (maxLat - minLat || 1)
    );

    return (coords) => [
      box.x + box.w / 2 + (coords[0] - (minLng + maxLng) / 2) * scale,
      box.y + box.h / 2 - (coords[1] - (minLat + maxLat) / 2) * scale
    ];
  }

  /**
   * 画面里所有内容的经纬度包围盒 —— **点位和路线都要算上**。
   *
   * 只按点位取景是不够的：真实道路会绕桥、绕山、绕单行道，
   * 鼓出点位包围盒很远。曾经只算点位，结果一条跨江的路整段跑到屏幕外，
   * 城市越大越明显。这里把已经画出来的路线几何也并进去。
   */
  function currentBounds() {
    const list = state.mode === 'demo' ? demoSpots() : state.spots;
    const points = list.map((s) => s.coords);
    state.paths.forEach((path) => points.push(...path));
    if (!points.length) return null;

    const lngs = points.map((p) => p[0]);
    const lats = points.map((p) => p[1]);
    return {
      minLng: Math.min(...lngs),
      maxLng: Math.max(...lngs),
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats)
    };
  }

  /**
   * 演示用的**全部**点：检索回来的候选 + 被选中的行程点。
   *
   * 【为什么必须两类一起画】
   * 演示要讲的是「先检索一大批、再筛出几个排进行程」。
   * 只画行程那二十几个点的话，「筛掉」这件事根本没有对象 ——
   * 画面里只剩一撮孤零零的点，看不出「检索」这个动作曾经发生过。
   * 所以候选池是叙事的一半，不是装饰。
   *
   * 时序上：候选点先铺开（0–20% 陆续绽开），接着大多数退场变淡，
   * 被选中的那几个亮起来（30%）—— 这套节奏写在 styles/ink.css 的
   * ink-bloom / ink-bloom-keep 两个关键帧里，这里只负责标出哪些是 keep。
   */
  function demoSpots() {
    const out = [];

    // 先铺被筛掉的：它们是这幅画面的背景噪声
    const routes = window.TRIP_ROUTES || {};
    parsePairs(routes.candidates).forEach((coords, i) => {
      out.push({ id: `cand-${i}`, name: '', coords, keep: false });
    });

    // 再铺行程点。放后面是因为 --i 决定错峰的相位 ——
    // 「留下的那几个」在叙事上本来就该晚一拍出现
    demoDays().forEach((day, di) => {
      day.stops.forEach((stop, si) => {
        out.push({ id: `demo-${di}-${si}`, name: stop.name, coords: stop.coords, keep: true });
      });
    });

    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 建元素                                                              */
  /* ------------------------------------------------------------------ */

  function el(name, attrs, className) {
    const node = document.createElementNS(NS, name);
    Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, String(v)));
    if (className) node.setAttribute('class', className);
    return node;
  }

  function build() {
    svg.replaceChildren();
    const dots = el('g', {}, 'ink ink--dots');
    const lines = el('g', {}, 'ink ink--lines');
    const seal = el('g', {}, 'ink ink--seal');

    // 定位变换挂在外层，缩放动画挂在内层 ——
    // 同一个元素上 CSS transform 会盖掉 transform 属性，必须分层
    const mark = el('g', {}, 'ink__stamp');
    mark.append(
      el('rect', { x: -15, y: -15, width: 30, height: 30, rx: 4 }, 'ink__stamp-box'),
      el('circle', { r: 15 }, 'ink__stamp-ring')
    );
    const glyph = el('text', { x: 0, y: 5.5, 'text-anchor': 'middle' }, 'ink__stamp-text');
    glyph.textContent = '定';
    mark.append(glyph);
    seal.append(mark);

    svg.append(dots, lines, seal);
    parts = { dots, lines, seal, mark, dotsNodes: [] };
    svg.setAttribute('class', 'stage__ink ink--demo');
  }

  /** 按当前 spots 重建圆点。演示模式带 is-keep（预选好的），live 模式都是候选 */
  function buildDots() {
    const list = state.mode === 'demo' ? demoSpots() : state.spots;
    parts.dots.replaceChildren();
    parts.dotsNodes = list.map((spot, i) => {
      // 演示模式下只有行程点是「被排进行程的」，检索回来的其余点会退场变淡；
      // live 模式一律先是候选，由 select 事件决定谁留下
      const isKeep = state.mode === 'demo' && Boolean(spot.keep);
      const dot = el('circle', { '--i': i, r: 0 }, isKeep ? 'ink__dot is-keep' : 'ink__dot');
      dot.dataset.id = spot.id;
      if (spot.name) {
        const title = document.createElementNS(NS, 'title');
        title.textContent = spot.name;
        dot.append(title);
      }
      parts.dots.append(dot);
      return dot;
    });
    svg.setAttribute('class', `stage__ink ink--${state.mode === 'demo' ? 'demo' : 'live'}`);

    // demo 的路线与印章是固定素材，和点一起重建
    if (state.mode === 'demo') buildDemoRoute();
  }

  /**
   * demo 的路线：把预先挑好的那几个点按顺序连成一条墨线，末端落一枚朱砂印章。
   *
   * 【这条线以前不存在，而它是整个演示最要紧的一拍】
   * styles/ink.css 里 ink-draw 的关键帧写好了（30%–50% 墨线自绘）、
   * 文件头的时间轴注释里也列着这一拍、印章的 ink-stamp 同样就位 ——
   * 但 JS 从来没在 demo 模式创建过 .ink__line，state.sealAt 也一直是 null。
   * 于是循环里只有散落的点，看不到「连成一条路」。
   *
   * 点只是「搜到了这些地方」，线才是「排成了行程」——
   * 少了这一拍，整个演示就停在第一步上。
   *
   * 坐标**不在这里投影**：这里只把经纬度记进 state.paths，由 layout() 统一投影。
   * 窗口尺寸变化、抽屉开合都会让投影变，在这里算出的像素会在 resize 时被污染。
   */
  function buildDemoRoute() {
    parts.lines.replaceChildren();
    parts.seal.removeAttribute('transform');

    const days = demoDays();
    if (!days.length) return;

    // 画的是**真实道路几何**，不是点对点的直线 —— 后者一眼就能看出不是路。
    // 几何来自构建期向高德要来的数据，运行时零请求。
    state.paths = days.map((day) => day.shape);

    // 印章落在最后一天的最后一个行程点上 —— 那是机场，整趟行程的句号。
    // 与 live 模式共用同一套定位逻辑（layout() 里按投影后的坐标摆过去）。
    const lastStops = days[days.length - 1].stops;
    state.sealAt = lastStops[lastStops.length - 1].coords;

    // 四条线各用当天的主题色。它们每天都是从酒店出发再回酒店，彼此首尾重叠 ——
    // 用同一个金色会分不清哪条是哪一天，而「四天」恰恰是这份行程的骨架。
    days.forEach((day, i) => {
      /* pathLength="1" 把长度归一化，CSS 那条 stroke-dasharray: 1 才对任意长度成立。
         --i 是错峰的相位，必须给：CSS 的 animation-delay 写成
         calc(var(--i) * 0.12s)，变量缺失会让整条 calc 失效、动画直接不跑。 */
      const line = el(
        'path',
        { pathLength: 1, '--i': i, style: `stroke:${window.TRIP_CONFIG.dayHue(i)}` },
        'ink__line'
      );
      line.dataset.day = String(i);
      parts.lines.append(line);
    });
    // d 由 layout() 填 —— 那里拿着当前有效的投影器
  }

  /* ------------------------------------------------------------------ */
  /* 布局：把经纬度投影成像素，重写所有几何属性                             */
  /* ------------------------------------------------------------------ */

  function at(coords, fallback) {
    // 底图可能还没起来（project 仍是 null），也可能它给了废值（返回 null）
    return (project && project(coords)) || fallback(coords);
  }

  function layout() {
    if (!parts) return;
    const rect = svg.getBoundingClientRect();
    const width = rect.width || window.innerWidth;
    const height = rect.height || window.innerHeight;
    const list = state.mode === 'demo' ? demoSpots() : state.spots;
    const fallback = makeFallbackProjector(width, height, list);

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    list.forEach((spot, i) => {
      const node = parts.dotsNodes[i];
      if (!node) return;
      const [x, y] = at(spot.coords, fallback);
      node.setAttribute('cx', x.toFixed(1));
      node.setAttribute('cy', y.toFixed(1));
    });

    if (state.sealAt) {
      const [x, y] = at(state.sealAt, fallback);
      parts.seal.setAttribute('transform', `translate(${(x + 26).toFixed(1)} ${(y + 22).toFixed(1)}) rotate(-7)`);
    }

    // 已画出来的线也要跟着重投影。
    // 用记下来的原始经纬度重投，而不是拿当前的 d 去改 —— d 是像素，
    // 换一次尺寸就被污染了，来回切会越算越偏。
    parts.lines.querySelectorAll('.ink__line').forEach((line) => {
      const coords = state.paths[Number(line.dataset.day)];
      if (!Array.isArray(coords) || coords.length < 2) return;
      line.setAttribute('d', toPathData(coords.map((c) => at(c, fallback))));
    });
  }

  /* ------------------------------------------------------------------ */
  /* 连线                                                                */
  /* ------------------------------------------------------------------ */

  function toPathData(points) {
    return points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  }

  /** 某一天的点，按排程顺序取出经纬度（原样，不投影） */
  function dayCoords(dayIndex) {
    const day = state.order[dayIndex];
    if (!Array.isArray(day)) return [];
    const byId = new Map(state.spots.map((s) => [s.id, s]));
    return day.map((step) => byId.get(step.id)).filter(Boolean).map((spot) => spot.coords);
  }

  function fallbackProjector() {
    const rect = svg.getBoundingClientRect();
    const list = state.mode === 'demo' ? demoSpots() : state.spots;
    return makeFallbackProjector(rect.width || window.innerWidth, rect.height || window.innerHeight, list);
  }

  /** 把某一天的折线画（或重画）出来，并把它的经纬度记进 state.paths 供取景用 */
  function paintDayLine(dayIndex, coords, fallback, redraw) {
    if (!Array.isArray(coords) || coords.length < 2) return;
    state.paths[dayIndex] = coords;

    // 每画上一条线就检查一次「还在不在画面里」：
    // 真实道路会绕到点位包围盒之外，镜头得跟着退。
    // 由 hero-map 那边防抖，所以这里放心每次调。
    if (window.TripHeroMap && window.TripHeroMap.ensureVisible) window.TripHeroMap.ensureVisible();

    const px = coords.map((c) => at(c, fallback));
    let line = parts.lines.querySelector(`.ink__line[data-day="${dayIndex}"]`);

    if (!line) {
      line = el('path', { 'path-length': 1, pathLength: 1, style: `stroke:${window.TRIP_CONFIG.dayHue(dayIndex)}` }, 'ink__line');
      line.dataset.day = String(dayIndex);
      parts.lines.append(line);
      line.setAttribute('d', toPathData(px));
      // 下一帧再加 is-drawn，让 transition 真的跑起来；
      // 同一个 tick 里改两次属性浏览器会合并，线会直接出现而不自绘
      requestAnimationFrame(() => line.classList.add('is-drawn'));
      return;
    }

    if (!redraw) {
      line.setAttribute('d', toPathData(px));
      return;
    }

    // 先收笔、改完 d 再重新自绘，视觉上就是「线顺着路网重画了一遍」
    line.classList.remove('is-drawn');
    requestAnimationFrame(() => {
      line.setAttribute('d', toPathData(px));
      requestAnimationFrame(() => line.classList.add('is-drawn'));
    });
  }

  function drawDayLines() {
    const fallback = fallbackProjector();
    state.order.forEach((day, i) => paintDayLine(i, dayCoords(i), fallback, false));
  }

  /** 用高德真实道路几何替换某一天的直线 */
  function refineDay(dayIndex) {
    const day = state.order[dayIndex];
    if (!Array.isArray(day) || day.length < 2 || !window.TripRoute) return Promise.resolve();

    const byId = new Map(state.spots.map((s) => [s.id, s]));
    const stops = day.map((step) => byId.get(step.id)).filter(Boolean);
    if (stops.length < 2) return Promise.resolve();

    const modes = stops.slice(1).map((_, i) => day[i + 1].mode || 'driving');

    // 复用行程页那套取路逻辑：自带并发闸门、缓存与「取不到就退回直线」的降级
    return window.TripRoute.getPaths(`hero-day${dayIndex}`, stops, modes)
      .then(({ paths }) => {
        // 真实道路的点要留着原样经纬度 —— 取景得按它们算，
        // 否则绕桥绕山的段会跑到框外
        const coords = paths.flat().filter((p) => Array.isArray(p) && p.length >= 2);
        if (coords.length < 2) return;
        paintDayLine(dayIndex, coords, fallbackProjector(), true);
      })
      .catch((error) => {
        // 取不到真实道路就保留直线：这是降级，不是失败
        console.warn(`[首页] 第 ${dayIndex + 1} 天的真实路径没取到，保留直线示意：`, error && error.message);
      });
  }

  /* ------------------------------------------------------------------ */
  /* 阶段事件 → 画面                                                      */
  /* ------------------------------------------------------------------ */

  function enterLive() {
    state.mode = 'live';
    state.spots = [];
    state.kept = new Set();
    state.order = [];
    state.paths = [];
    state.sealAt = null;
    parts.lines.replaceChildren();
    parts.seal.removeAttribute('transform');
    buildDots();
  }

  function onStage(event) {
    if (!event || !event.stage) return;

    // discover 一开始就切到 live：清掉演示素材，等真实数据落下来
    if (event.stage === 'discover' && event.status === 'start') {
      enterLive();
      return;
    }

    if (event.stage === 'discover' && event.status === 'done') {
      const pois = (event.detail && event.detail.pois) || [];
      // 点太多会糊成一片，且逐个错峰的耗时也太长
      state.spots = pois.slice(0, 80).map((p) => ({ id: p.id, name: p.name, coords: [p.lng, p.lat] }));
      buildDots();
      layout();
      // 等点都铺好再翻 is-discovered，否则第一帧就全是终态、看不到撒开的过程
      requestAnimationFrame(() => {
        svg.classList.add('is-discovered');
        layout();
      });
      return;
    }

    if (event.stage === 'select' && event.status === 'done') {
      const ids = (event.detail && event.detail.ids) || [];
      state.kept = new Set(ids);
      parts.dotsNodes.forEach((node) => {
        if (state.kept.has(node.dataset.id)) node.classList.add('is-keep');
        else node.classList.add('is-dropped');
      });
      return;
    }

    if (event.stage === 'schedule' && event.status === 'done') {
      state.order = (event.detail && event.detail.order) || [];
      drawDayLines();
      return;
    }

    // 审校跑完（或被跳过）就落章：这一步不是「确认无误」，只是「有人复核过了」
    if (event.stage === 'review' && (event.status === 'done' || event.status === 'skipped')) {
      const firstDay = state.order[0] || [];
      const last = state.spots.find((s) => firstDay.length && s.id === firstDay[firstDay.length - 1].id);
      if (last) {
        state.sealAt = last.coords;
        layout();
        svg.classList.add('is-sealed');
      }
      return;
    }

    if (event.stage === 'routes' && event.status === 'done') {
      // 挂在 done 而不是 start：start 时服务端正拿同一个高德 key 逐段算路，
      // 两边一起发必然撞限流 —— 实测服务端的 walking 段被反复限流，
      // 退化出来的直线反而让行程页的路线变差。
      //
      // done 之后再发就不撞了，而且后面还有美食与行前准备两个阶段（十来秒）兜着，
      // 精修来得及跑完。
      //
      // 并行发即可，TripRoute 内部有并发闸门与控速，会自己压住 QPS。
      const days = Math.min(state.order.length, 6);
      Promise.all(
        Array.from({ length: days }, (_, i) => refineDay(i))
      )
        // 换完真实道路，画面上能到的地方就变了：路会绕桥绕山，
        // 鼓出点位包围盒很远。全部落定后再重新取一次景，
        // 免得每天换完都动一次镜头（那样画面会一直晃）。
        .then(() => {
          if (window.TripHeroMap && window.TripHeroMap.ensureVisible) window.TripHeroMap.ensureVisible();
        });
      return;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 对外接口                                                            */
  /* ------------------------------------------------------------------ */

  window.TripHeroInk = {
    /** 当前这批点的经纬度包围盒；没有点返回 null，调用方保持当前视野 */
    bounds: currentBounds,
    setProjector(fn) {
      project = fn;
      layout();
    },
    useFallback: layout,
    reload: layout,
    /** 接一个阶段事件 */
    stage: onStage,
    /**
     * 撤掉演示素材。
     * 用户一选定城市，地图就飞过去了，这时候武汉的地标还留在图上
     * 就会画到别的城市的位置 —— 看起来像画错了，不如留一张干净的城市底图。
     */
    clearDemo() {
      if (state.mode !== 'demo') return;
      state.mode = 'blank';
      state.spots = [];
      state.kept = new Set();
      state.order = [];
      state.paths = [];
      state.sealAt = null;
      svg.classList.remove('is-discovered', 'is-sealed');
      parts.lines.replaceChildren();
      parts.seal.removeAttribute('transform');
      buildDots();
      layout();
    },
    /** 回到演示循环（重新打开表单、或规划失败时用） */
    reset() {
      state.mode = 'demo';
      state.spots = [];
      state.kept = new Set();
      state.order = [];
      state.paths = [];
      state.sealAt = null;
      svg.classList.remove('is-discovered', 'is-sealed');
      parts.lines.replaceChildren();
      parts.seal.removeAttribute('transform');
      buildDots();
      layout();
    }
  };

  build();
  buildDots();
  layout();

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(layout, 160);
  });
})();
