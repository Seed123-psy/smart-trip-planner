/* ============================================================
   地图层：初始化高德底图 + 绘制标记 / 路线
   所有距离与耗时都来自 data/routes-legs.js（构建期算好），
   这里只负责画，不发起算路请求，切换天数时无等待。
   ============================================================ */

(function () {
  'use strict';

  const CFG = window.TRIP_CONFIG;

  /**
   * 始终从全局实时取 AMap。
   * 高德 2.0 会在加载过程中替换/扩展 window.AMap，若把 loader resolve 的返回值
   * 长期持有，可能拿到一个缺少部分类（如 Marker）的旧对象。
   */
  function amap() {
    return window.AMap;
  }

  /** 每日主题色：统一由 config.js 提供，避免和 CSS 令牌各改一份对不上 */
  const DAY_HUE = CFG.DAY_HUE;

  // poiId -> 覆盖物数组。
  // 必须存数组而不是单个对象：同一天里同一个地点可能出现多次
  // （如 Day1 的酒店既是出发地又是返回地），用 Map 覆盖会把先创建的
  // 那个标记永久泄漏在图上 —— 来回切天就会看到一摞同名标记堆在一起。
  const pins = new Map();
  const labels = new Map();

  let map = null;
  /** 地图上当前显示的路线折线（可能由多段组成，如公交的步行+乘车） */
  let routeLines = [];
  /** `${dayId}|${mode}` -> { paths, schematic }，命中即瞬时重绘 */
  const routeCache = new Map();
  /**
   * 绘制代次：换天或发起新绘制时自增。
   * 异步取路径返回后若代次已变，说明有更新的画面要画，本次结果丢弃。
   */
  let paintGen = 0;

  /* ------------------------------------------------------------------ */
  /* 初始化                                                              */
  /* ------------------------------------------------------------------ */

  async function init() {
    const { WEB_JS_KEY, SECURITY_CODE } = CFG.AMAP;
    if (!WEB_JS_KEY) throw new Error('未配置高德 WebJS Key');
    if (!window.AMapLoader) throw new Error('高德 JSAPI Loader 未加载');

    // 官方 Loader 内建 securityJsCode 处理，无需手工拼 URL / 设置 _config。
    // 不加载路线规划插件：路径改由 Web 服务获取（见 route.js），可用性更好
    const AMap = await window.AMapLoader.load({
      key: WEB_JS_KEY,
      version: '2.0',
      securityJsCode: SECURITY_CODE,
      plugins: ['AMap.Scale', 'AMap.ToolBar']
    });

    map = new AMap.Map('map', {
      center: CFG.MAP.center,
      zoom: CFG.MAP.zoom,
      viewMode: '2D',
      // 素色底图：低饱和的浅灰，让彩色标记与路线成为画面上唯一的重音
      mapStyle: 'amap://styles/whitesmoke'
    });

    map.addControl(new AMap.Scale());
    // 放右上：左下角留给高德 logo 与比例尺，右下角留给「示意直线」提示
    map.addControl(new AMap.ToolBar({ position: { right: '18px', top: '84px' } }));

    return map;
  }

  /* ------------------------------------------------------------------ */
  /* 标记                                                               */
  /* ------------------------------------------------------------------ */

  function pinHtml(poi, index, hue) {
    const kind = poi.role === 'anchor' ? poi.kind : 'spot';
    return `
      <div class="pin pin--${kind}" style="--hue:${hue}">
        <span class="pin__num">${index}</span>
      </div>`;
  }

  /**
   * 绘制一天的行程点标记。
   * stops: [{ poi, index }]，index 为当天序号，用于地图上的编号
   */
  function drawMarkers(stops, dayId) {
    clearMarkers();
    const AMap = amap();
    const hue = DAY_HUE[dayId] || '#b07510';

    stops.forEach(({ poi, index }) => {
      const position = poi.coords; // [lng, lat] 数组，2.0 直接可用

      // 不用 AMap.Pixel 做偏移：2.0 下该构造器不可靠，改用 anchor 控制定位
      const marker = new AMap.Marker({
        position,
        anchor: 'bottom-center',
        zIndex: 120 + index,
        content: pinHtml(poi, index, hue)
      });

      // 标签放标记下方：上方容易和底图自带的同名 POI 标签打架
      const label = new AMap.Text({
        text: poi.name,
        position,
        anchor: 'top-center',
        offset: [0, 4], // 不用 AMap.Pixel：2.0 下该构造器不可靠，数组形式同样被支持
        zIndex: 130,
        style: {
          'background-color': 'rgba(255, 255, 255, 0.94)',
          'border': `1px solid ${hue}44`,
          'border-radius': '6px',
          'padding': '2px 8px',
          'color': '#1f1b15',
          'font-size': '12px',
          'white-space': 'nowrap',
          'box-shadow': '0 1px 3px rgba(38, 33, 26, 0.14)'
        }
      });

      if (!pins.has(poi.id)) pins.set(poi.id, []);
      if (!labels.has(poi.id)) labels.set(poi.id, []);
      pins.get(poi.id).push(marker);
      labels.get(poi.id).push(label);
      map.add([marker, label]);
    });
  }


  function clearMarkers() {
    if (!map) return;
    // 数组要摊平，否则 map.remove 收到的是嵌套数组，清不干净
    const all = [
      ...[...pins.values()].flat(),
      ...[...labels.values()].flat(),
      ...routeLines
    ].filter(Boolean);
    if (all.length) map.remove(all);
    pins.clear();
    labels.clear();
    routeLines = [];
  }

  /**
   * 换天：只清掉地图上的标记与折线。
   * 缓存键已按 `dayId|mode` 隔离，不能整体清空 —— 否则来回切天会反复发请求，
   * 既慢又拉大「旧请求覆盖新画面」的竞态窗口。
   */
  function resetDay() {
    paintGen++; // 让在途请求的结果失效
    clearRoute(); // 先撤掉上一天的线，避免新线到达前残留旧天的路线
    clearMarkers();
  }

  /* ------------------------------------------------------------------ */
  /* 路线                                                               */
  /* ------------------------------------------------------------------ */

  /** 折线样式：真实路径用实线，降级示意用虚线且细一些 */
  function lineStyle(schematic, hue) {
    return {
      strokeColor: hue,
      strokeWeight: schematic ? 3 : 6,
      strokeOpacity: schematic ? 0.55 : 0.92,
      ...(schematic ? { strokeStyle: 'dashed', strokeDasharray: [8, 7] } : {}),
      lineJoin: 'round',
      lineCap: 'round',
      showDir: !schematic,
      zIndex: 60
    };
  }

  /** 坐标点必须是 [lng, lat] 且为有限数，否则绘制会抛错或把点丢到几内亚湾 */
  function isValidPoint(p) {
    return (
      Array.isArray(p) &&
      p.length >= 2 &&
      Number.isFinite(p[0]) &&
      Number.isFinite(p[1]) &&
      Math.abs(p[0]) <= 180 &&
      Math.abs(p[1]) <= 90
    );
  }

  /**
   * 把一组路径画成折线（不请求算路，纯渲染）。
   * 先建好新线再替换旧的：中途出错时旧路线仍在图上，不会出现空白闪烁。
   */
  function paintPaths(paths, dayId, schematic) {
    const AMap = amap();
    const hue = DAY_HUE[dayId] || '#b07510';
    const style = lineStyle(schematic, hue);
    const next = [];

    paths.forEach((path) => {
      // 脏数据整条跳过，而不是把非法坐标交给高德
      if (!Array.isArray(path)) return;
      const clean = path.filter(isValidPoint);
      if (clean.length < 2) {
        console.warn('[武汉攻略] 路径坐标非法，已跳过该段：', path.slice(0, 3));
        return;
      }
      next.push(new AMap.Polyline({ path: clean, ...style }));
    });

    clearRoute();
    if (!next.length) return false;

    routeLines = next;
    map.add(routeLines);
    return true;
  }

  /** 该天这组出行方式是否已取过路径，命中则切天无等待 */
  function hasPath(dayId, modes) {
    return routeCache.has(`${dayId}|${modes.join(',')}`);
  }

  /**
   * 绘制某天的完整路线。每段按自己的推荐方式取路径（见 route.js）。
   * 命中缓存则即时重绘，否则向高德请求并缓存。
   * @param {string[]} modes modes[i] 是 stops[i] -> stops[i+1] 的方式
   * @returns {Promise<{ok:boolean, schematic:boolean, fromCache:boolean}>}
   */
  async function drawRoute(stops, dayId, modes) {
    const gen = ++paintGen;

    if (stops.length < 2) {
      clearRoute();
      focusStops(stops.map((s) => s.coords));
      return { ok: true, schematic: false, fromCache: true, empty: true };
    }

    const key = `${dayId}|${modes.join(',')}`;
    const cached = routeCache.get(key);
    if (cached) {
      paintPaths(cached.paths, dayId, cached.schematic);
      return { ok: routeLines.length > 0, schematic: cached.schematic, fromCache: true };
    }

    const { paths, schematic } = await window.TripRoute.getPaths(dayId, stops, modes);
    routeCache.set(key, { paths, schematic });

    // 结果仍进缓存（下次切回来即可命中），但过期了就不再上屏
    if (gen !== paintGen) return { ok: false, schematic, fromCache: false, stale: true };

    paintPaths(paths, dayId, schematic);
    return { ok: routeLines.length > 0, schematic, fromCache: false };
  }

  function clearRoute() {
    if (routeLines.length && map) {
      map.remove(routeLines);
    }
    routeLines = [];
  }

  /**
   * 缩放视野以容纳当天所有点。
   * 只接受 [[lng,lat], ...] 纯坐标数组，不猜调用方的数据结构。
   * 坐标一律用数组形式：2.0 原生支持，且 LngLat 构造器在不同版本下行为不一致。
   */
  function focusStops(coordsList) {
    if (!map || !coordsList || !coordsList.length) return;
    const points = coordsList.filter(isValidPoint);
    if (!points.length) return;

    try {
      if (points.length === 1) {
        map.setZoomAndCenter(15, points[0]);
        return;
      }

      // 用 Bounds 而不是 setFitView：2.0 的 setFitView 对 LngLat 数组会抛
      // 「getBounds is not a function」，setBounds 才是稳定的那条路。
      const AMap = amap();
      const lngs = points.map((p) => p[0]);
      const lats = points.map((p) => p[1]);
      const bounds = new AMap.Bounds(
        new AMap.LngLat(Math.min(...lngs), Math.min(...lats)),
        new AMap.LngLat(Math.max(...lngs), Math.max(...lats))
      );
      map.setBounds(bounds, false, CFG.MAP.fitPadding);

      // 起点在机场、终点在市区的日子（如 Day1），全览会把市区各点挤成一团。
      // 松手后再往市区推一档，让密集点位看得清。
      const maxZoom = CFG.MAP.maxFitZoom;
      if (maxZoom && map.getZoom() < maxZoom) map.setZoom(maxZoom);
    } catch (err) {
      // 视野没调好不影响路线绘制，降级为保持当前视野
      console.warn('[武汉攻略] 视野自适应失败：', err && err.message);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 对外接口                                                            */
  /* ------------------------------------------------------------------ */

  window.TripMap = {
    init,
    resetDay,
    drawMarkers,
    drawRoute,
    focusStops,
    clearRoute,
    hasPath,
    getMap: () => map,
    /** 当前路线折线数量，供调试与自动化检查 */
    getLineCount: () => routeLines.length,
    /** 某个点的标记是否存在（地图上也画了才需要高亮） */
    hasPin: (poiId) => pins.has(poiId)
  };
})();
