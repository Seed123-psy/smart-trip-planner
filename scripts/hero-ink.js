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

  /**
   * 演示用的坐标：真实武汉地标（取自 data/routes-legs.js 的定位结果）。
   * 首页刻意不加载 data/*.js —— 它是门面，不该被某一份行程的数据拖着走。
   * 一旦开始规划，这批点会被真实检索结果整批换掉。
   */
  const DEMO_SPOTS = [
    [114.314625, 30.607245, 1], [114.310208, 30.602394, 1], [114.299831, 30.586141, 1],
    [114.299353, 30.587731, 1], [114.290521, 30.581672, 1], [114.292874, 30.547225, 1],
    [114.305298, 30.543475, 1], [114.308791, 30.551940, 0], [114.293535, 30.584931, 0],
    [114.340331, 30.554925, 0], [114.365261, 30.561633, 0], [114.376688, 30.564713, 0],
    [114.364514, 30.536243, 0], [114.363807, 30.545119, 0], [114.310451, 30.547408, 0],
    [114.302691, 30.547544, 0], [114.260079, 30.545484, 0], [114.268285, 30.556247, 0],
    [114.260166, 30.557715, 0], [114.298180, 30.575127, 0], [114.294686, 30.550602, 0],
    [114.225873, 30.618327, 0]
  ];

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

  function demoSpots() {
    return DEMO_SPOTS.map(([lng, lat]) => ({ id: `demo-${lng}-${lat}`, coords: [lng, lat] }));
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
      const demoKeep = state.mode === 'demo' && DEMO_SPOTS[i] && DEMO_SPOTS[i][2] === 1;
      const dot = el('circle', { '--i': i, r: 0 }, demoKeep ? 'ink__dot is-keep' : 'ink__dot');
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
    boundsOfDemo: () => {
      const lngs = DEMO_SPOTS.map((s) => s[0]);
      const lats = DEMO_SPOTS.map((s) => s[1]);
      return { minLng: Math.min(...lngs), maxLng: Math.max(...lngs), minLat: Math.min(...lats), maxLat: Math.max(...lats) };
    },
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
