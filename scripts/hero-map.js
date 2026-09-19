/* ============================================================
   首页底图：一张「无名城市」的静置路网

   要的是一张纸，不是一张地图产品截图。所以：
     · showLabel:false + setFeatures(['bg','road']) 去掉 POI 与文字标注，
       城市因此不可辨认 —— 首页不该看起来只在讲武汉；
     · 所有交互全部关掉，它是背景不是工具；
     · 去饱和与暖化交给 CSS（见 landing.css 的 .stage__map），
       JS 只管把图摆正。

   高德 logo 必须保留：这是 Key 的使用条款，不是可选项。

   加载策略：JSAPI 三百多 KB，绝不能用同步 <script> 卡住首屏。
   这里动态注入，并且给 3 秒硬上限 —— 超时就认输，切到纯 CSS 纸面，
   首页在任何网络条件下都有东西看。
   ============================================================ */

(function () {
  'use strict';

  const CFG = window.TRIP_CONFIG;
  const box = document.getElementById('hero-map');
  const stage = document.getElementById('stage');
  if (!box || !stage) return;

  /** 底图实例。refit 要用它重新量尺寸与取景 */
  let map = null;

  const LOADER_SRC = 'https://webapi.amap.com/loader.js';
  const TIMEOUT_MS = 3000;

  /** 只选好城市、还没有任何点位时的取景：整座城的概览 */
  const CITY_ZOOM = 11.5;

  /**
   * 把画面里的内容框进可视区。
   *
   * 这里原先自己算缩放与中心：按包围盒的米数除以目标像素数推出 zoom，
   * 再把中心反推回去。那套数学一路在出错 —— 真实道路换上之后镜头不跟，
   * 跨江绕山的段直接画出屏幕。既然高德自己就有 fitBounds，就用它：
   * 行程页的 focusStops 也是这么做的，路线从来没出过框。
   *
   * avoid 是四周的避让区，用来给文案和底部的阶段条腾地方，
   * 而不是靠位移把中心挪过去 —— 让高德一次算准，比事后挪更可靠。
   */
  function frameMap(map, box, options) {
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (!w || !h || !window.AMap) return;

    const b = window.TripHeroInk.bounds();
    // 手上还没有点（刚选了城市、还没开始检索）就保持当前视野，
    // 免得被一帧空数据拉回默认位置
    if (!b) return;

    // 必须构造 LngLat —— 直接塞数组进去 Bounds 会拿到一个退化区间，
    // setBounds 于是什么都不做（行程页 focusStops 用的也是 LngLat 这一套）
    const AMap = window.AMap;
    const bounds = new AMap.Bounds(
      new AMap.LngLat(b.minLng, b.minLat),
      new AMap.LngLat(b.maxLng, b.maxLat)
    );

    const narrow = w < 900;
    const sheetOpen = document.body.classList.contains('is-sheet-open');

    // avoid：[上, 右, 下, 左]
    //   窄屏   —— 上方留给文案、下方留给阶段条
    //   宽屏   —— 左侧留给文案（抽屉开着时文案已淡出，就没必要让了）
    //   底部一律多留一点，因为七阶段管线条压在那儿
    const avoid = narrow
      ? [Math.round(h * 0.3), 26, Math.round(h * 0.16), 26]
      : [36, 36, 74, sheetOpen ? 36 : Math.round(w * 0.42)];

    map.setBounds(bounds, !(options && options.animate), avoid);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = src;
      tag.async = true;
      tag.onload = resolve;
      tag.onerror = () => reject(new Error('高德 loader 下载失败'));
      document.head.append(tag);
    });
  }

  /** 到底给不给得出来一张底图 —— 超时也算给不出来 */
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('高德 JSAPI 超时')), ms))
    ]);
  }

  async function init() {
    // loader.js 那三百多 KB 与密钥无关，先发出去。
    // 放到下面那句 await 之后的话，配置接口一慢（最多 3 秒），
    // 整个下载就被串行化推迟 3 秒 —— 而首页墨绘要等地图 complete 才开始画。
    const loading = loadScript(LOADER_SRC);
    // 先挂一个空 catch：下面读配置时可能先抛错，那时就没人接这个 promise 了，
    // 会变成 unhandled rejection。挂上之后照样可以 await 它并拿到异常。
    loading.catch(() => {});

    // 服务端可能覆盖了密钥，必须等它落定再读。
    // 全站只有这一处与行程页的 TripMap.init 需要等 —— 其余脚本读的是
    // TRIP / DAY_HUE，与密钥无关。
    if (window.TripRuntimeConfig) await window.TripRuntimeConfig.ready;

    const { WEB_JS_KEY, SECURITY_CODE } = CFG.AMAP;
    if (!WEB_JS_KEY) throw new Error('未配置高德 WebJS Key');

    await loading;
    if (!window.AMapLoader) throw new Error('高德 JSAPI Loader 未加载');

    // 不加载任何插件：首页没有比例尺、没有工具条，一个控件都不要
    const AMap = await withTimeout(
      window.AMapLoader.load({ key: WEB_JS_KEY, version: '2.0', securityJsCode: SECURITY_CODE, plugins: [] }),
      TIMEOUT_MS
    );

    map = new AMap.Map(box, {
      zoom: 12,
      viewMode: '2D',
      mapStyle: 'amap://styles/whitesmoke',
      showLabel: false
    });
    frameMap(map, box);

    // 去掉 POI 图层，只留底与路
    map.setFeatures(['bg', 'road']);

    // 交互一律关掉 —— 但**不能用 setStatus 关**。
    // setStatus({ zoomEnable: false }) 会连程序化的 setZoom / setBounds 一起禁掉，
    // 表现是取景代码全部静默失效、只有中心点生效：缩放永远停在初始值，
    // 城市一大，点位和路线就顶出屏幕。这个坑查了很久。
    // 改用 CSS 的 pointer-events: none（见 landing.css 的 .stage__map），
    // 用户一样点不动，而 API 保持可用。
    return map;
  }

  /**
   * 投影函数：经纬度 -> 相对 #hero-ink 的像素。
   * 墨绘层铺满 .stage，容器与地图同尺寸，所以直接取容器的相对坐标。
   */
  function makeProjector(map) {
    // 2.0 返回的是 Pixel 对象（getX/getY），但不同小版本给过裸 {x,y}，
    // 两种都兜住 —— 这里挂了整条墨线就画不出来
    const pick = (p, getter) => (p && typeof p[getter] === 'function' ? p[getter]() : p && p[getter.slice(3).toLowerCase()]);
    return ([lng, lat]) => {
      const p = map.lngLatToContainer([lng, lat]);
      const x = pick(p, 'getX');
      const y = pick(p, 'getY');
      // 底图尚未排版完时这里会给 NaN 或天文数字（实测过 -37904px）。
      // 返回 null 让墨绘层退回兜底投影，总好过把点画到屏幕外。
      return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
    };
  }

  init()
    .then((map) => {
      // 必须等底图排版完成（'complete'）才把投影函数交出去。
      // 在那之前 lngLatToContainer 返回的是废值，实测会把墨点甩到 -37904px，
      // 整幅画跑到屏幕外，而且看起来「什么都没有」很难查。
      map.on('complete', () => {
        box.classList.add('is-ready');
        window.TripHeroInk.setProjector(makeProjector(map));
      });

      // 镜头一动完就重投影。视野有好几条来源（飞到城市、飞到检索结果、
      // 抽屉开合、窗口缩放），其中带动画的那些在动画途中投影都是中间态。
      // 三个事件都挂上：不同版本的高德在不同时机触发的内容不一样，
      // 重投影是幂等的，多挂一个不亏。
      const reproject = () => window.TripHeroInk.reload();
      map.on('moveend', reproject);
      map.on('zoomend', reproject);
      map.on('boundchange', reproject);

      // 窗口尺寸变了要重新框视野再重投影：只投影不重新框，
      // 从窄屏切回来时墨迹会有一半在屏幕外
      window.addEventListener('resize', () => {
        frameMap(map, box);
        window.TripHeroInk.reload();
      });
    })
    .catch((error) => {
      console.warn('[首页] 底图未加载，改用纸面兜底：', error && error.message);
      stage.classList.add('is-fallback');
      // 加守卫：墨绘层自己也可能先挂掉，那时这里再抛一次会把降级也带崩
      if (window.TripHeroInk && window.TripHeroInk.useFallback) window.TripHeroInk.useFallback();
    });

  /**
   * 容器尺寸变了（窗口缩放、抽屉开合）之后重新取景。
   *
   * 三步缺一不可：先让高德按新尺寸重排画布，再按新容器反算视野，
   * 最后让墨绘层按新视野重投影。少任何一步，墨线都会和底图错开。
   */
  let refitTimer = 0;

  function refit(options) {
    if (!map) return;
    map.resize();
    frameMap(map, box, options);
    window.TripHeroInk.reload();

    // 镜头带动画时是异步的：上面那句 reload 投到的是动画开始前的视野，
    // 落定之后必须再投一次，否则点和线会留在旧位置、跑出画面。
    window.clearTimeout(refitTimer);
    refitTimer = window.setTimeout(
      () => window.TripHeroInk.reload(),
      options && options.animate ? 1000 : 120
    );
  }

  /** 当前内容是不是完整落在画面里（留一点边距，别贴边） */
  function containsBounds(margin) {
    if (!map) return true;
    const b = window.TripHeroInk.bounds();
    if (!b) return true;

    const w = box.clientWidth;
    const h = box.clientHeight;
    const pick = (p, getter) => (p && typeof p[getter] === 'function' ? p[getter]() : p && p[getter.slice(3).toLowerCase()]);
    return [
      [b.minLng, b.minLat],
      [b.maxLng, b.minLat],
      [b.minLng, b.maxLat],
      [b.maxLng, b.maxLat]
    ].every(([lng, lat]) => {
      const p = map.lngLatToContainer([lng, lat]);
      const x = pick(p, 'getX');
      const y = pick(p, 'getY');
      return Number.isFinite(x) && Number.isFinite(y) &&
        x >= margin && x <= w - margin && y >= margin && y <= h - margin;
    });
  }

  /**
   * 内容超出画面就退一档把镜头拉开。
   *
   * 为什么需要它：取景原本只在「检索结果落下来」那一刻算一次，
   * 可真实道路是随后一天天换上的，而路会绕桥绕山、鼓出点位包围盒很远 ——
   * 于是线画着画着就冲出了屏幕，而镜头纹丝不动。
   *
   * 只退不进（已经在画面里就什么都不做），并且防抖：几天陆续画完时只动一次镜头，
   * 不会来回抽。
   */
  let fitTimer = 0;
  function ensureVisible() {
    window.clearTimeout(fitTimer);
    fitTimer = window.setTimeout(() => {
      if (!containsBounds(14)) refit({ animate: true });
    }, 220);
  }

  /**
   * 飞到某个城市。
   * 表单里选好城市时就调它 —— 用户还没提交就能看到「要去的那座城」，
   * 而不是一直盯着武汉的演示画面。
   */
  function flyToCity(coords) {
    if (!map || !Array.isArray(coords) || coords.length !== 2) return;
    map.setZoomAndCenter(CITY_ZOOM, coords, true);
  }

  // getMap 与行程页的 TripMap.getMap 同一作法：给调试与自动化检查一个入口
  window.TripHeroMap = { refit, ensureVisible, flyToCity, getMap: () => map };
})();
