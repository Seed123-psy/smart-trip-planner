/**
 * 静态地图：把某一天的路线渲染成一张 PNG，供导出 PDF 使用。
 *
 * 【为什么走服务端】
 * 静态地图接口必须带 key，而 Web 服务 key 不能进浏览器 —— 与 /api/amap 同一个理由。
 *
 * 【为什么用静态地图，而不是把页面上那张地图截下来】
 * 页面上的是 canvas，打印时多半一片空白。而且它只显示**当前视野**：
 * 导出那一刻用户停在总览还是某一天、缩放到哪一级，都不确定。
 * 静态地图是服务端渲染好的位图，用 paths 参数直接画折线，
 * 路线必然是完整且正确的那一条，与用户当时的操作无关。
 *
 * 【代价】
 * 它带地名标注，不像首页那样是一张干净的纸；右下角还有「高德地图」水印 ——
 * 那是使用条款要求的，不能去掉。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { resolveAmapServiceKey } = require('./keys');

const ROOT = path.resolve(__dirname, '..');
const ROUTES_FILE = path.join(ROOT, 'data', 'routes-legs.js');
const UPSTREAM = 'https://restapi.amap.com/v3/staticmap';
const TIMEOUT_MS = 8000;

/**
 * 每天最多画这么多个点。
 *
 * 静态地图的 paths 是塞在 URL 查询串里的，太长会被上游拒。
 * 而一天的几何有几百个点（构建期为了画得准保留的），
 * 抽到这么多在 750px 宽的图上肉眼已经看不出差别。
 */
const MAX_POINTS_PER_DAY = 60;

/** 行程是构建期定死的，同一张图每次请求都一样 —— 值得缓存 */
const cache = new Map();

/**
 * 读构建期生成的路由数据。
 *
 * data/routes-legs.js 是浏览器脚本（挂 window），这里给它一个假的 window 求值。
 * 不另写一份 JSON 导出，是为了保证服务端与前端读的**是同一份数据** ——
 * 两处各存一份，迟早会漂移。
 *
 * 用 new Function 而不是 vm：文件是我们自己构建期生成的，内容可信；
 * vm 只是多一层沙箱，在这里换不来实际的安全收益。
 */
function loadRoutes() {
  const source = fs.readFileSync(ROUTES_FILE, 'utf8');
  const sandbox = {};
  new Function('window', source)(sandbox);
  return sandbox.TRIP_ROUTES || null;
}

/** "lng,lat;lng,lat" → 点列 */
function parsePairs(str) {
  if (typeof str !== 'string' || !str) return [];
  return str
    .split(';')
    .map((pair) => pair.split(',').map(Number))
    .filter((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

/** 某一天的完整几何：把当天各段的首尾相接（相邻两段共享端点，拼接时去掉重复的） */
function shapeOfDay(routes, dayId) {
  const out = [];
  for (const leg of routes.legs || []) {
    if (leg.dayId !== dayId) continue;
    const primary = leg.modes && leg.modes[leg.primary];
    const pairs = parsePairs(primary && primary.polyline);
    if (pairs.length >= 2) out.push(...(out.length ? pairs.slice(1) : pairs));
  }
  return out;
}

/**
 * 均匀抽稀，但**首尾一定保留** —— 那是当天的起点与终点，
 * 丢了的话路线会凭空短一截。
 */
function thin(points, max) {
  if (points.length <= max) return points;
  const out = [points[0]];
  const step = (points.length - 1) / (max - 1);
  for (let i = 1; i < max - 1; i++) out.push(points[Math.round(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

/**
 * 算中心点与缩放级别。
 *
 * 高德的静态地图只收 location + zoom，没有「按包围盒适配」这一说，
 * 所以适配得自己算：先把经纬度跨度换算成「在 zoom z 下占多少像素」，
 * 反解出刚好塞得进目标尺寸的那个 z。
 *
 * 纬度方向要乘 cos(lat)：墨卡托投影下同一度数在纬度上被拉长，
 * 忽略这一项的话高纬度城市会算出偏大的 zoom，路线顶出图外。
 */
function frameOf(points, size) {
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);

  const centerLng = (minLng + maxLng) / 2;
  const centerLat = (minLat + maxLat) / 2;

  // 留 18% 的边：路线贴着图边很难看，也容易和标注叠在一起
  const pad = 1.18;
  const lngSpan = Math.max((maxLng - minLng) * pad, 1e-4);
  const latSpan = Math.max((maxLat - minLat) * pad, 1e-4);
  const latRad = (centerLat * Math.PI) / 180;

  const TILE = 256;
  const zoomLng = Math.log2((size.w * 360) / (lngSpan * TILE));
  const zoomLat = Math.log2((size.h * 360 * Math.cos(latRad)) / (latSpan * TILE));

  // 取整而不是四舍五入：宁可小一级（图里多留点空），也不要大一级把路线切掉
  const zoom = Math.max(3, Math.min(17, Math.floor(Math.min(zoomLng, zoomLat))));

  return { location: `${centerLng.toFixed(6)},${centerLat.toFixed(6)}`, zoom };
}

/**
 * 取某一天的静态地图。
 *
 * @param {number} dayIndex 从 0 起
 * @param {{w: number, h: number}} size 图片尺寸（高德上限 1024×1024）
 * @param {string} color 折线颜色，形如 `0xB07510` —— 由前端按当天主题色传进来
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
async function dayMap(dayIndex, size, color) {
  const key = `${dayIndex}|${size.w}x${size.h}|${color}`;
  if (cache.has(key)) return cache.get(key);

  const resolved = await resolveAmapServiceKey();
  if (!resolved.value) {
    throw new Error(resolved.problem || '未配置高德 Web 服务密钥');
  }

  const routes = loadRoutes();
  if (!routes) throw new Error('读不到路线数据（data/routes-legs.js）');

  const dayId = `day${Number(dayIndex) + 1}`;
  const full = shapeOfDay(routes, dayId);
  if (full.length < 2) throw new Error(`第 ${dayId} 天没有可画的路线`);

  const points = thin(full, MAX_POINTS_PER_DAY);
  const { location, zoom } = frameOf(points, size);

  const url = new URL(UPSTREAM);
  url.searchParams.set('location', location);
  url.searchParams.set('zoom', String(zoom));
  url.searchParams.set('size', `${size.w}*${size.h}`);
  // paths 的格式是 weight,color,transparency,fillcolor,fillTransparency:点列
  url.searchParams.set(
    'paths',
    `5,${color},1,,:${points.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(';')}`
  );
  url.searchParams.set('key', resolved.value);

  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`静态地图上游返回 ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || 'image/png';

  // 高德出错时也回 200，但正文是 JSON —— 不拦住的话会 print 出一张写着错误码的图
  if (!contentType.startsWith('image/')) {
    const text = buffer.toString('utf8').slice(0, 200);
    throw new Error(`静态地图返回的不是图片：${text}`);
  }

  const result = { buffer, contentType };
  cache.set(key, result);
  return result;
}

module.exports = { dayMap, MAX_POINTS_PER_DAY };
