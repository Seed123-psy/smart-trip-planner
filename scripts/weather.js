/* ============================================================
   天气服务层：向高德 Web 服务取实况与预报

   为什么放在运行期而不是构建期（对比 data/routes-legs.js）：
   路线是行程属性，改一次算一次；天气是时效数据，构建期写死的话，
   页面放两天就过期了。所以这里和 scripts/route.js 一样，
   由浏览器直连高德接口，每次打开页面取一份新的。

   一个必须知道的接口限制：
   高德预报接口只返回「今天 + 未来 3 天」共 4 天。行程日在 10.03—10.06，
   离得远的时候根本取不到 —— 这不是错误，是接口边界。
   所以 getDay() 允许返回 null，调用方必须处理，别把 null 当成异常。

   天气描述是中文文本（「小雨」「多云」「霾」…），到图标的映射也放在这里：
   这套词汇表是高德定的，跟着数据源走，不该散到渲染层。
   ============================================================ */

(function () {
  'use strict';

  const CFG = window.TRIP_CONFIG;

  /** 高德预报接口的覆盖天数：今天 + 3 天 */
  const FORECAST_SPAN_DAYS = 3;

  const state = {
    status: 'idle', // idle | loading | ready | error
    live: null, // 实况：{ text, temp, wind, windpower, humidity, reportTime }
    forecast: {}, // 'YYYY-MM-DD' -> { date, dayText, nightText, high, low, wind, windpower }
    reportTime: null,
    error: null
  };

  /* ------------------------------------------------------------------ */
  /* 日期工具：共用 scripts/date.js，不在这里再写一份                     */
  /* ------------------------------------------------------------------ */

  const { addDays, today, daysBetween } = window.TripDate;

  /* ------------------------------------------------------------------ */
  /* 请求                                                                */
  /* ------------------------------------------------------------------ */

  const TIMEOUT_MS = 8000;

  /** 同源转发入口，由服务端补密钥。和 route.js 走的是同一条路 */
  function request(params) {
    if (location.protocol === 'file:') {
      return Promise.reject(new Error('file:// 下没有 /api/amap 代理，请用 node serve.js 打开页面'));
    }

    const url = new URL('/api/amap', location.href);
    url.searchParams.set('p', '/v3/weather/weatherInfo');
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    return fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => r.json());
  }

  /* ------------------------------------------------------------------ */
  /* 图标：高德中文天气描述 -> 简笔图标 path                              */
  /* 刻意画得很简：这枚图标最终只有 15px，笔画一多就糊成一团              */
  /* ------------------------------------------------------------------ */

  const ICON = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4 4.2 19.8M19.8 4.2l-1.4 1.4"/>',
    cloudSun:
      '<circle cx="8" cy="8" r="3"/><path d="M8 2v1.5M2 8h1.5M3.8 3.8l1 1"/><path d="M9.5 20a4 4 0 0 1 .4-8 5 5 0 0 1 9.4 1.3A3.6 3.6 0 0 1 17 20Z"/>',
    cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .4-8.98A6 6 0 0 0 6.2 11.3 4.1 4.1 0 0 0 6.8 19Z"/>',
    rain: '<path d="M17.5 15a4.5 4.5 0 0 0 .4-8.98A6 6 0 0 0 6.2 7.3 4.1 4.1 0 0 0 6.8 15Z"/><path d="M9 18.5 8 21M13 18.5 12 21M17 18.5 16 21"/>',
    rainHeavy:
      '<path d="M17.5 14a4.5 4.5 0 0 0 .4-8.98A6 6 0 0 0 6.2 6.3 4.1 4.1 0 0 0 6.8 14Z"/><path d="M8 17 6.5 21M12 17l-1.5 4M16 17l-1.5 4M20 17l-1.5 4"/>',
    thunder:
      '<path d="M17.5 14a4.5 4.5 0 0 0 .4-8.98A6 6 0 0 0 6.2 6.3 4.1 4.1 0 0 0 6.8 14Z"/><path d="m13 16-3 5h4l-3 5"/>',
    snow: '<path d="M17.5 14a4.5 4.5 0 0 0 .4-8.98A6 6 0 0 0 6.2 6.3 4.1 4.1 0 0 0 6.8 14Z"/><path d="M9 18h.01M13 20.5h.01M17 18h.01"/>',
    fog: '<path d="M17.5 13a4.5 4.5 0 0 0 .4-8.98A6 6 0 0 0 6.2 5.3 4.1 4.1 0 0 0 6.8 13Z"/><path d="M5 17h14M7 21h10"/>'
  };

  /** 描述文本 -> 图标 key。判定顺序要从「更特殊」到「更一般」 */
  function iconFor(text) {
    const s = text || '';
    if (/雷/.test(s)) return 'thunder';
    if (/雪|冰雹/.test(s)) return 'snow';
    if (/雾|霾|沙|尘/.test(s)) return 'fog';
    if (/暴雨|大雨/.test(s)) return 'rainHeavy';
    if (/雨/.test(s)) return 'rain';
    if (/云/.test(s)) return 'cloudSun';
    if (/晴/.test(s)) return 'sun';
    return 'cloud'; // 阴，以及所有没列举到的
  }

  /** 图标 path 数据，交给渲染层套 svg 外壳 */
  function iconPath(text) {
    return ICON[iconFor(text)] || ICON.cloud;
  }

  /* ------------------------------------------------------------------ */
  /* 加载                                                                */
  /* ------------------------------------------------------------------ */

  function normalizeLive(json) {
    const d = json.lives && json.lives[0];
    if (!d) return null;
    return {
      text: d.weather,
      temp: d.temperature,
      wind: d.winddirection,
      windpower: d.windpower,
      humidity: d.humidity,
      reportTime: d.reporttime
    };
  }

  function normalizeForecast(json) {
    const city = json.forecasts && json.forecasts[0];
    const casts = (city && city.casts) || [];
    const out = {};
    casts.forEach((c) => {
      out[c.date] = {
        date: c.date,
        dayText: c.dayweather,
        nightText: c.nightweather,
        high: Number(c.daytemp),
        low: Number(c.nighttemp),
        wind: c.daywind,
        windpower: c.daypower
      };
    });
    return { byDate: out, reportTime: (city && city.reporttime) || null };
  }

  async function load() {
    state.status = 'loading';
    // 重新取数（比如规划到另一座城市）时先清掉上一份：
    // 新数据回来前留着旧城市的天气，比什么都不显示更容易误导
    state.live = null;
    state.forecast = {};
    state.reportTime = null;
    state.error = null;

    const adcode = CFG.TRIP.adcode;

    // 两个接口职责不同：base 只有实况，all 只有预报，all 里不含实况字段
    const [liveRes, fcRes] = await Promise.allSettled([
      request({ city: adcode, extensions: 'base' }),
      request({ city: adcode, extensions: 'all' })
    ]);

    let ok = false;

    if (liveRes.status === 'fulfilled' && liveRes.value.status === '1') {
      state.live = normalizeLive(liveRes.value);
      ok = ok || Boolean(state.live);
    }

    if (fcRes.status === 'fulfilled' && fcRes.value.status === '1') {
      const fc = normalizeForecast(fcRes.value);
      state.forecast = fc.byDate;
      state.reportTime = fc.reportTime;
      ok = ok || Object.keys(fc.byDate).length > 0;
    }

    // 只要有一边拿到数据就算可用：实况和预报互不依赖，
    // 不能因为一边失败就把整个天气模块判死
    state.status = ok ? 'ready' : 'error';
    state.error = ok ? null : new Error('天气接口未返回数据');
    if (!ok) {
      console.warn(
        '[武汉攻略] 天气未取到。请确认该 key 已开通「天气查询」服务，' +
          '且 adcode 正确（config.js 的 TRIP.adcode）。'
      );
    }
    return state;
  }

  /* ------------------------------------------------------------------ */
  /* 查询                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 取某天的预报。
   * @returns {object|null} 超出高德 4 天窗口时返回 null —— 这是正常情况，
   *          不是错误。调用方应改用 availableFrom() 给出「何时可查」。
   */
  function getDay(dateStr) {
    return state.forecast[dateStr] || null;
  }

  /**
   * 某个日期最早能在哪天查到预报。
   * 高德覆盖 [今天, 今天+3]，所以目标日 D 进入窗口的日期是 D - 3。
   */
  function availableFrom(dateStr) {
    return addDays(dateStr, -FORECAST_SPAN_DAYS);
  }

  /** 距离某天可查还剩几天；<=0 表示已经可以查到 */
  function daysUntilAvailable(dateStr) {
    return daysBetween(today(), availableFrom(dateStr));
  }

  window.TripWeather = {
    load,
    getDay,
    availableFrom,
    daysUntilAvailable,
    iconPath,
    getLive: () => state.live,
    getStatus: () => state.status,
    getError: () => state.error,
    getReportTime: () => state.reportTime
  };
})();
