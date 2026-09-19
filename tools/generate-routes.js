#!/usr/bin/env node
/**
 * 行程数据生成器
 *
 * 职责（把浏览器端不该干的活挪到构建期）：
 *   1. 地理编码：把 poi.js 里的地点名称解析成经纬度，回填进 poi.js
 *   2. 批量算路：对相邻两个「地图点」计算驾车 / 公交 / 步行的距离与耗时
 *   3. 产出 data/routes-legs.js，前端只读不算，地图渲染零等待
 *
 * 用法：
 *   node tools/generate-routes.js           # 增量：命中缓存则跳过
 *   node tools/generate-routes.js --force   # 全量重算（改了地点信息后用）
 *   node tools/generate-routes.js --dry     # 只打印，不写回文件
 *
 * 依赖：Node 18+（内置 fetch），无需 npm install
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(__dirname, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'amap-cache.json');

/**
 * 高德 Web 服务 key。
 *
 * 刻意不从 config.js 读 —— 那个文件会被浏览器加载，密钥放进去就等于公开。
 * 这里走与 serve.js / planner.js 同一套解析：环境变量 > 管理后台的数据库设置 >
 * config.local.js，三个来源都不进浏览器。
 *
 * 这是个一次性生成器，所以在这里取一次并缓存下来。
 */
const WEB_SERVICE_KEY = (() => {
  const resolved = require('./keys').resolveAmapServiceKey();
  if (resolved.value) return resolved.value;

  if (resolved.problem) throw new Error(resolved.problem);
  throw new Error(
    '未找到高德 Web 服务密钥。三个来源都没有：环境变量 AMAP_WEB_SERVICE_KEY、' +
      '管理后台的密钥设置、以及本地的 config.local.js。'
  );
})();

const MODES = ['driving', 'transit', 'walking'];
const MODE_LABEL = { driving: '驾车', transit: '公交', walking: '步行' };
const FALLBACK_SPEED = { driving: 25, transit: 22, walking: 4.5 }; // km/h

const ARGS = process.argv.slice(2);
const FORCE = ARGS.includes('--force');
const DRY = ARGS.includes('--dry');

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

/** 读取前端同款数据文件：注入伪 window 后 require */
function loadBrowserData(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) throw new Error(`找不到数据文件：${relPath}`);
  const sandbox = { window: {} };
  const code = fs.readFileSync(abs, 'utf8');
  new Function('window', `${code}\n`)(sandbox.window);
  return { abs, data: sandbox.window };
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return { geocode: {}, routes: {} };
  }
}

function writeCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 串行限流：高德个人开发者 QPS 较低，320ms 间隔足够稳 */
let nextSlotAt = 0;
async function throttled(fn) {
  const now = Date.now();
  const wait = Math.max(0, nextSlotAt - now);
  nextSlotAt = Math.max(now, nextSlotAt) + 320;
  if (wait) await sleep(wait);
  return fn();
}

async function amapGet(endpoint, params) {
  const url = new URL(`https://restapi.amap.com${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key: WEB_SERVICE_KEY })) {
    url.searchParams.set(k, v);
  }

  const res = await throttled(() => fetch(url, { signal: AbortSignal.timeout(15000) }));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== '1') throw new Error(`${json.infocode || ''} ${json.info || '未知错误'}`);
  return json;
}

function leadingIndent(line) {
  const m = line.match(/^[ \t]*/);
  return m ? m[0] : '';
}

/**
 * 往 poi.js 的某个条目里写入/更新 coords 字段。
 *
 * 用逐行扫描而不是正则：POI 条目都是「平对象」（字段里不再嵌套花括号），
 * 所以 id 行之后第一个「整行只有 } 和可选逗号」的行就是本条目的结尾。
 * 不要去比对缩进层级：id 行是字段级（4 空格），闭合括号是对象级（2 空格），
 * 拿字段缩进去匹配永远匹配不上。
 *
 * 注意：不能用「返回的源码是否变化」来判断成败 —— 当写入的坐标与已有值
 * 完全相同时，源码字符串本来就不会变，会被误判成「没找到该条目」。
 *
 * @returns {{ source: string, ok: boolean }}
 */
function upsertCoords(source, id, coords) {
  const lines = source.split('\n');

  const idLine = lines.findIndex((l) => new RegExp(`\\bid:\\s*'${id}'\\s*,?\\s*$`).test(l));
  if (idLine === -1) return { source, ok: false };

  const fieldIndent = leadingIndent(lines[idLine]);

  // 往下找第一个「只有闭合括号」的行，即条目末尾
  let endLine = -1;
  for (let i = idLine + 1; i < lines.length; i++) {
    if (/^\s*\/\//.test(lines[i]) || /^\s*\*/.test(lines[i])) continue; // 跳过注释
    if (/^\s*\}\s*,?\s*$/.test(lines[i])) {
      endLine = i;
      break;
    }
  }
  if (endLine === -1) return { source, ok: false };

  const coordsLine = `${fieldIndent}coords: [${coords.join(', ')}],`;

  // 条目里已经有 coords → 原地替换
  const existAt = lines.findIndex(
    (l, i) => i > idLine && i < endLine && /^\s*coords:/.test(l)
  );
  if (existAt !== -1) {
    lines[existAt] = coordsLine;
    return { source: lines.join('\n'), ok: true };
  }

  // 否则插到闭合括号前，并确保被插入行前一个字段有尾逗号
  const prev = lines[endLine - 1];
  if (prev.trim() && !/[,\]}]$/.test(prev.trimEnd())) lines[endLine - 1] = `${prev},`;

  lines.splice(endLine, 0, coordsLine);
  return { source: lines.join('\n'), ok: true };
}

/** 两点球面直线距离（公里），仅在算路失败时兜底 */
function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ------------------------------------------------------------------ */
/* 1. 地理编码                                                         */
/* ------------------------------------------------------------------ */

/**
 * 解析地点坐标。
 *
 * 优先走 POI 检索（place/text），而不是地理编码（geocode/geo）：
 * geocode/geo 对街道级查询会静默回退到「区级质心」——实测「山海关路」
 * 「黎黄陂路」都返回江岸区质心 114.282987,30.633093，于是好几个点在地图上
 * 叠成一个，卡片上的距离也全错。place/text 给的是真实 POI 坐标，
 * 只有在它也查不到时才退回 geocode/geo。
 */
async function geocode(poi, cache) {
  const cached = cache.geocode[poi.id];
  if (cached && !FORCE) return cached;

  // 坐标已固化在 poi.js 里（人工核对过或上次回填），不再打接口。
  // 若定位不准，在 poi 上加 keyword（高德 POI ID 或更精确的地址）强制重新解析。
  if (poi.coords && poi.coords.length === 2 && !poi.keyword) {
    return {
      coords: poi.coords,
      formattedAddress: poi.name,
      cityCode: '027',
      adcode: ''
    };
  }

  const keyword = poi.keyword || [poi.name, poi.address].filter(Boolean).join('');
  const city = poi.city || '武汉';

  let result = null;
  try {
    const json = await amapGet('/v3/place/text', {
      keywords: keyword,
      city,
      citylimit: 'true',
      offset: '1',
      output: 'JSON'
    });
    const hit = json.pois && json.pois[0];
    if (hit && hit.location) {
      // 查不到地址时高德会返回空数组，直接拼进模板字符串会很难看
      const addr = typeof hit.address === 'string' ? hit.address : '';
      result = {
        coords: hit.location.split(',').map(Number),
        formattedAddress: [hit.name, addr].filter(Boolean).join(' | '),
        cityCode: hit.citycode || '',
        adcode: hit.adcode || ''
      };
    }
  } catch (err) {
    console.warn(`  · ${poi.name} POI 检索失败（${err.message}），退回地理编码`);
  }

  if (!result) {
    const json = await amapGet('/v3/geocode/geo', {
      address: keyword,
      city,
      output: 'JSON'
    });
    const geo = json.geocodes && json.geocodes[0];
    if (!geo) throw new Error(`未匹配到坐标：${keyword}`);
    result = {
      coords: geo.location.split(',').map(Number),
      formattedAddress: geo.formatted_address,
      cityCode: geo.citycode,
      adcode: geo.adcode
    };
  }

  console.log(
    `  ✓ ${poi.name}\n    ${result.formattedAddress}  [${result.coords.join(', ')}]`
  );
  return result;
}

/* ------------------------------------------------------------------ */
/* 2. 路径规划                                                         */
/* ------------------------------------------------------------------ */

async function planRoute(from, to, mode, cityCode) {
  if (mode === 'walking') {
    const json = await amapGet('/v3/direction/walking', {
      origin: from.join(','),
      destination: to.join(','),
      output: 'JSON'
    });
    const p = json.route && json.route.paths && json.route.paths[0];
    if (!p) throw new Error('无步行路径');
    return { distance: Number(p.distance), duration: Number(p.duration) };
  }

  if (mode === 'transit') {
    const json = await amapGet('/v3/direction/transit/integrated', {
      origin: from.join(','),
      destination: to.join(','),
      city: cityCode || '027',
      cityd: cityCode || '027',
      strategy: 0,
      output: 'JSON'
    });
    const t = json.route && json.route.transits && json.route.transits[0];
    if (!t) throw new Error('无公交方案');
    return { distance: Number(t.distance), duration: Number(t.duration) };
  }

  const json = await amapGet('/v3/direction/driving', {
    origin: from.join(','),
    destination: to.join(','),
    strategy: 10, // 速度优先，不堵车优先
    extensions: 'base',
    output: 'JSON'
  });
  const p = json.route && json.route.paths && json.route.paths[0];
  if (!p) throw new Error('无驾车路径');
  return { distance: Number(p.distance), duration: Number(p.duration) };
}

/* ------------------------------------------------------------------ */
/* 3. 主流程                                                           */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('── 武汉行程数据生成 ──────────────────────────────');

  const { data: poiWin } = loadBrowserData('data/poi.js');
  const { data: itinWin } = loadBrowserData('data/itinerary.js');
  const pois = poiWin.TRIP_POI;
  const days = itinWin.TRIP_ITINERARY.days;
  const cache = readCache();

  /* --- 3.1 地理编码 --- */
  console.log('\n[1/3] 地理编码');
  const locations = {};
  for (const poi of Object.values(pois)) {
    if (poi.coords && !FORCE && !poi.keyword) {
      locations[poi.id] = {
        coords: poi.coords,
        formattedAddress: poi.name
      };
      console.log(`  · ${poi.name}  使用已存坐标 [${poi.coords.join(', ')}]`);
      continue;
    }
    try {
      const r = await geocode(poi, cache);
      cache.geocode[poi.id] = r;
      locations[poi.id] = { coords: r.coords, formattedAddress: r.formattedAddress };
    } catch (err) {
      console.warn(`  ✗ ${poi.name} 定位失败：${err.message}`);
      locations[poi.id] = null;
    }
  }

  /* --- 3.2 收集相邻点对 --- */
  console.log('\n[2/3] 路径规划');
  const legs = [];
  for (const day of days) {
    // 只保留有坐标的点，它们才参与路线
    const anchors = day.visits
      .map((v, i) => ({ ...v, _i: i, loc: v.poiId ? locations[v.poiId] : null }))
      .filter((v) => v.loc);

    for (let n = 0; n < anchors.length - 1; n++) {
      const a = anchors[n];
      const b = anchors[n + 1];
      const mode = b.mode || 'driving';
      const cityCode =
        (cache.geocode[b.poiId] && cache.geocode[b.poiId].cityCode) || '027';

      const cacheKey = `${a.poiId}>${b.poiId}>${mode}`;
      let metrics = cache.routes[cacheKey];

      if (!metrics || FORCE) {
        const records = {};
        for (const m of [mode, ...MODES.filter((x) => x !== mode)]) {
          try {
            records[m] = await planRoute(a.loc.coords, b.loc.coords, m, cityCode);
            console.log(
              `  ✓ ${a.poiId} → ${b.poiId} [${MODE_LABEL[m]}] ` +
                `${(records[m].distance / 1000).toFixed(1)} km / ${Math.round(
                  records[m].duration / 60
                )} min`
            );
          } catch (err) {
            console.warn(`  ✗ ${a.poiId} → ${b.poiId} [${MODE_LABEL[m]}] ${err.message}`);
            records[m] = null;
          }
        }

        // 全部失败时用直线距离兜底，保证页面不会出现空档
        const km = haversineKm(a.loc.coords, b.loc.coords);
        for (const m of MODES) {
          if (!records[m]) {
            records[m] = {
              distance: Math.round(km * 1000),
              duration: Math.round((km / FALLBACK_SPEED[m]) * 3600),
              estimated: true
            };
          }
        }

        metrics = {
          from: a.poiId,
          to: b.poiId,
          primary: mode,
          straightLineKm: Number(km.toFixed(2)),
          modes: records
        };
        cache.routes[cacheKey] = metrics;
      } else {
        console.log(`  · ${a.poiId} → ${b.poiId} [${MODE_LABEL[mode]}] 命中缓存`);
      }

      legs.push({
        id: `${day.id}-leg${n + 1}`,
        dayId: day.id,
        fromIndex: a._i,
        toIndex: b._i,
        ...metrics
      });
    }
  }

  /* --- 3.3 落盘 --- */
  console.log('\n[3/3] 写出文件');
  if (DRY) {
    console.log('  (--dry 模式，跳过写入)');
    return;
  }

  // 回填坐标到 poi.js：逐行定位条目，只写入 coords 行，其余排版原样保留
  const poiPath = path.join(ROOT, 'data/poi.js');
  let poiSrc = fs.readFileSync(poiPath, 'utf8');
  let written = 0;

  for (const [id, loc] of Object.entries(locations)) {
    if (!loc) continue;
    const { source, ok } = upsertCoords(poiSrc, id, loc.coords);
    if (!ok) {
      console.warn(`  ⚠ poi.js 中未找到 id: '${id}' 或结构异常，跳过回填`);
      continue;
    }
    poiSrc = source;
    pois[id].coords = loc.coords;
    written++;
  }

  fs.writeFileSync(poiPath, poiSrc, 'utf8');
  console.log(`  ✓ data/poi.js        ${written} 个坐标已回填`);

  const payload = {
    generatedAt: new Date().toISOString(),
    summary: {
      days: days.length,
      legs: legs.length,
      pendingLocations: Object.entries(locations)
        .filter(([, v]) => !v)
        .map(([k]) => k)
    },
    locations,
    legs
  };
  const out =
    '/**\n' +
    ' * 自动生成，请勿手改 —— 由 tools/generate-routes.js 产出\n' +
    ` * 生成时间：${payload.generatedAt}\n` +
    ' * 修改行程后请重新运行：node tools/generate-routes.js\n' +
    ' */\n' +
    `window.TRIP_ROUTES = ${JSON.stringify(payload, null, 2)};\n`;
  fs.writeFileSync(path.join(ROOT, 'data/routes-legs.js'), out, 'utf8');
  console.log('  ✓ data/routes-legs.js  路线数据已生成');

  writeCache(cache);

  /* --- 汇总 --- */
  console.log('\n── 汇总 ──────────────────────────────────────────');
  console.log(`  天数：${days.length} | 路线段：${legs.length}`);
  if (payload.summary.pendingLocations.length) {
    console.log(`  ⚠ 未定位：${payload.summary.pendingLocations.join(', ')}`);
  }
  console.log('  完成。用浏览器打开 index.html 查看。\n');
}

main().catch((err) => {
  console.error('\n生成失败：', err.message);
  process.exit(1);
});
