/* ============================================================
   路径服务层：向高德 Web 服务取「真实道路路径」用于画线

   为什么不直接用 JSAPI 的 Driving/Walking/Transit 插件：
   插件算路需要控制台单独开通「Web端 JS API 路线规划」权限，权限缺失时
   只返回一个没有信息的 error；而 Web 服务接口可用性更稳，返回的路径
   与构建期算距离用的是同一套数据，图上距离和卡片距离天然一致。

   密钥不在这里：所有请求都走同源的 /api/amap，由服务端补上 key
   （本地是 serve.js，线上是 api/amap.js）。页面上的 JS 谁都能读，
   密钥一旦内嵌就等于公开，而高德 Web 服务 key 不支持域名白名单。
   ============================================================ */

(function () {
  'use strict';

  const CFG = window.TRIP_CONFIG;

  /** 同源转发入口，见 tools/amap-proxy.js */
  const PROXY = '/api/amap';

  const cache = new Map(); // `${dayId}|${modes}` -> [paths]

  /* ------------------------------------------------------------------ */
  /* 高德折线串解析                                                      */
  /* ------------------------------------------------------------------ */

  /** 把 "114.2,30.7;114.3,30.8" 解析成 [[lng,lat], ...] */
  function parsePolyline(str) {
    if (!str || typeof str !== 'string') return [];
    return str
      .split(';')
      .map((pair) => pair.split(',').map(Number))
      .filter((c) => c.length === 2 && c.every((n) => Number.isFinite(n)));
  }

  /** 弱网下请求可能长时间挂起，设超时避免加载态一直转 */
  const TIMEOUT_MS = 8000;

  /** 两点球面直线距离（米），仅用于判断该不该走这一趟 */
  function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /**
   * 并发闸门。高德个人 key 的 QPS 很低（约 3），一次性放太多请求出去会被限流，
   * 表现为部分段拿不到路径而退化成直线。这里把在途请求压在 3 个以内：
   * 既不超限，又比纯串行快得多（一天 8 个逐段请求从 ~4.5s 降到 ~1.5s）。
   */
  const MAX_CONCURRENT = 3;
  let inFlight = 0;
  const queue = [];

  function acquire() {
    if (inFlight < MAX_CONCURRENT) {
      inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  }

  function release() {
    const next = queue.shift();
    if (next) next(); // 名额直接转交，inFlight 不变
    else inFlight--;
  }

  async function request(endpoint, params) {
    // file:// 下没有同源后端，早失败并说清原因，别让用户对着一堆失败请求猜
    if (location.protocol === 'file:') {
      throw new Error('file:// 下没有 /api/amap 代理，请用 node serve.js 打开页面');
    }

    const url = new URL(PROXY, location.href);
    url.searchParams.set('p', endpoint);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    await acquire();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`代理返回 ${res.status}`);
      return await res.json();
    } finally {
      release();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 各出行方式的路径获取                                                */
  /* ------------------------------------------------------------------ */

  async function drivingPaths(stops) {
    const origin = stops[0].coords.join(',');
    const destination = stops[stops.length - 1].coords.join(',');
    const waypoints = stops
      .slice(1, -1)
      .map((s) => s.coords.join(','))
      .join(';');

    const json = await request('/v3/direction/driving', {
      origin,
      destination,
      ...(waypoints ? { waypoints } : {}),
      strategy: 10,
      extensions: 'base'
    });

    const path = json.route && json.route.paths && json.route.paths[0];
    if (!path || !path.steps) return null;
    // 整条路串成一条折线，避免分段之间出现断点
    return [path.steps.flatMap((s) => parsePolyline(s.polyline))];
  }

  /** 超过这个距离就不查步行路线了，也不该步行 */
  const WALKABLE_METERS = 4000;

  /**
   * 逐段取步行路径。
   * 所有段一次性发出去，由 request() 的并发闸门压住 QPS —— 串行等 7 段太慢。
   */
  async function walkingPaths(stops) {
    const jobs = [];

    for (let i = 0; i < stops.length - 1; i++) {
      const from = stops[i].coords;
      const to = stops[i + 1].coords;

      // 远距离本来就不会走路，没必要为它发请求
      if (haversineMeters(from, to) > WALKABLE_METERS) {
        jobs.push(Promise.resolve([from, to]));
        continue;
      }

      jobs.push(
        request('/v3/direction/walking', {
          origin: from.join(','),
          destination: to.join(',')
        })
          .then((json) => {
            const p = json.route && json.route.paths && json.route.paths[0];
            if (!p || !p.steps) return [from, to];
            return p.steps.flatMap((s) => parsePolyline(s.polyline));
          })
          // 单段失败只降级这一段，不能把整天的路线都丢掉
          .catch(() => [from, to])
      );
    }

    return Promise.all(jobs);
  }

  /** 逐段取公交路径。轮渡段也走这里（高德把它当作一条 busline 返回） */
  async function transitPaths(stops) {
    const city = CFG.TRIP.cityCode || '027';
    const jobs = [];

    for (let i = 0; i < stops.length - 1; i++) {
      const from = stops[i].coords;
      const to = stops[i + 1].coords;

      jobs.push(
        request('/v3/direction/transit/integrated', {
          origin: from.join(','),
          destination: to.join(','),
          city,
          cityd: city,
          strategy: 0
        })
          .then((json) => {
            const transit = json.route && json.route.transits && json.route.transits[0];
            if (!transit || !transit.segments) return [from, to];

            const points = [];
            transit.segments.forEach((seg) => {
              // 步行接驳段
              const walkSteps = seg.walking && seg.walking.steps;
              if (walkSteps) {
                walkSteps.forEach((s) => points.push(...parsePolyline(s.polyline || s.path)));
              }
              // 公交 / 地铁 / 轮渡段
              const lines = seg.bus && seg.bus.buslines;
              if (lines) {
                lines.forEach((line) => points.push(...parsePolyline(line.polyline)));
              }
              // 铁路段（如城际）：只有首末站坐标，没有线路折线
              const railway = seg.railway;
              if (railway && railway.departure_stop && railway.arrival_stop) {
                points.push(...parsePolyline(railway.departure_stop.location));
                points.push(...parsePolyline(railway.arrival_stop.location));
              }
            });

            // 注意：points 的元素已经是 [lng, lat] 坐标对，绝不能再 flat()，
            // 否则会被拆成裸数字，整条路线在 map.js 的合法性校验里被丢弃。
            return points.length >= 2 ? points : [from, to];
          })
          .catch(() => [from, to])
      );
    }

    return Promise.all(jobs);
  }

  /* ------------------------------------------------------------------ */
  /* 对外接口                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 把连续同方式的路段并成一组。
   * 逐段单发请求太浪费：Day 1 有 7 段，合并后只要 3 次。
   * drivingPaths 支持途经点，一组一次就能画完整条链。
   */
  function groupLegs(modes) {
    const groups = [];
    modes.forEach((mode, i) => {
      const last = groups[groups.length - 1];
      if (last && last.mode === mode) last.end = i + 1;
      else groups.push({ mode, start: i, end: i + 1 });
    });
    return groups;
  }

  function pathsFor(mode, stops) {
    if (mode === 'walking') return walkingPaths(stops);
    if (mode === 'transit') return transitPaths(stops);
    return drivingPaths(stops);
  }

  /**
   * 取某天所有路段的路径。每段按各自的推荐方式取 ——
   * 一天里可能同时有驾车、步行和轮渡段，用同一种方式画会画错
   * （比如把轮渡画成绕桥的马路）。
   *
   * @param {string} dayId
   * @param {Array<{coords: [number,number]}>} stops 当天的点，按行程顺序
   * @param {string[]} modes modes[i] 是 stops[i] -> stops[i+1] 的方式，长度 = stops.length - 1
   * @returns {Promise<{paths: Array<Array<[number,number]>>, schematic: boolean}>}
   *          schematic 为 true 表示高德没返回路径，退回了示意直线
   */
  async function getPaths(dayId, stops, modes) {
    const key = `${dayId}|${modes.join(',')}`;
    if (cache.has(key)) return cache.get(key);

    const straight = (a, b) => [a, b];

    if (stops.length < 2) {
      const empty = { paths: [], schematic: false };
      cache.set(key, empty);
      return empty;
    }

    // 各组一起发出去，由 request() 的并发闸门统一压 QPS。
    // Promise.all 保序，所以拼出来的折线顺序仍与行程一致。
    const groups = groupLegs(modes);
    const chunks = await Promise.all(
      groups.map(async (g) => {
        const slice = stops.slice(g.start, g.end + 1);
        const fallback = straight(slice[0].coords, slice[slice.length - 1].coords);
        try {
          const sub = await pathsFor(g.mode, slice);
          // 一段失败不该带走整天：只把这一段降级成直线
          if (sub && sub.length) return { paths: sub.filter((p) => p && p.length >= 2), bad: false };
          return { paths: [fallback], bad: true };
        } catch (err) {
          console.warn(`[武汉攻略] ${g.mode} 路径获取失败，该段改用示意直线：`, err);
          return { paths: [fallback], bad: true };
        }
      })
    );

    const paths = chunks.flatMap((c) => c.paths);
    const schematic = chunks.some((c) => c.bad);

    const result = { paths, schematic };
    cache.set(key, result);
    return result;
  }

  function clearCache() {
    cache.clear();
  }

  window.TripRoute = { getPaths, clearCache, parsePolyline };
})();
