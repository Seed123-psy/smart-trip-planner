#!/usr/bin/env node
/**
 * 数据体检：改完行程后跑一下，能在打开页面前发现数据问题
 *   node tools/check-data.js
 *
 * 校验项：
 *   1. itinerary 引用的 poiId 是否都在 poi.js 里存在
 *   2. 每个 POI 是否都有可用坐标（否则不会出现在地图上）
 *   3. 相邻点的路线段是否齐全、三种出行方式是否都有距离与耗时
 *   4. 时间轴时间是否单调递增（同一天内）
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function load(rel) {
  const sandbox = { window: {} };
  new Function('window', fs.readFileSync(path.join(ROOT, rel), 'utf8'))(sandbox.window);
  return sandbox.window;
}

const errors = [];
const warnings = [];

const { TRIP_POI: POI } = load('data/poi.js');
const { TRIP_ITINERARY: ITIN } = load('data/itinerary.js');
const { TRIP_ROUTES: ROUTES } = load('data/routes-legs.js');
const { TRIP_CONFIG: CFG } = load('config.js');

const MODES = ['driving', 'transit', 'walking'];

/* 0：每日主题色的取色前提
   颜色是按「第几天」的下标取的（CFG.dayHue），所以只要天数不超过调色板长度、
   且每天的 id 是 dayN，取色就不会错位。这两条以前都没人守：
   加到第 5 天不会有任何报错，只是第 5 天静默用了第 1 天的颜色。 */
const PALETTE = CFG.DAY_HUE;
if (ITIN.days.length > PALETTE.length) {
  errors.push(
    `行程有 ${ITIN.days.length} 天，但 config.js 的 DAY_HUE 只有 ${PALETTE.length} 色；` +
      `多出来的天会回绕复用前面的颜色`
  );
}
ITIN.days.forEach((day, i) => {
  if (day.id !== `day${i + 1}`) {
    errors.push(`第 ${i + 1} 天的 id 是「${day.id}」，应为「day${i + 1}」（颜色与路线段都按这个口径关联）`);
  }
});

/* 1 + 2：POI 完整性与坐标 */
for (const day of ITIN.days) {
  for (const visit of day.visits) {
    if (!visit.poiId) continue;

    const poi = POI[visit.poiId];
    if (!poi) {
      errors.push(`[${day.id}] 引用了不存在的 poiId: ${visit.poiId}`);
      continue;
    }
    if (!ROUTES.locations[visit.poiId]) {
      errors.push(`[${day.id}] ${poi.name} 没有坐标，无法上图（跑 generate-routes.js）`);
    }
  }

  /* 4：时间单调性 */
  const times = day.visits
    .map((v) => (v.time || '').match(/^(\d{1,2}):(\d{2})/))
    .filter(Boolean)
    .map((m) => Number(m[1]) * 60 + Number(m[2]));
  for (let i = 1; i < times.length; i++) {
    if (times[i] < times[i - 1]) {
      warnings.push(`[${day.id}] 时间点疑似倒序：第 ${i} 项早于第 ${i - 1} 项`);
      break;
    }
  }
}

/* 3：路线段完整性 */
for (const day of ITIN.days) {
  const located = day.visits
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => v.poiId && ROUTES.locations[v.poiId]);

  for (let n = 0; n < located.length - 1; n++) {
    const from = located[n];
    const to = located[n + 1];
    const leg = ROUTES.legs.find((l) => l.dayId === day.id && l.fromIndex === from.i);

    if (!leg) {
      errors.push(
        `[${day.id}] 缺少路线段：${from.v.poiId} → ${to.v.poiId}（跑 generate-routes.js）`
      );
      continue;
    }

    for (const mode of MODES) {
      const m = leg.modes[mode];
      if (!m || !Number.isFinite(m.distance) || !Number.isFinite(m.duration)) {
        warnings.push(`[${day.id}] ${leg.from} → ${leg.to} 缺「${mode}」数据`);
      }
    }
    if (leg.modes[leg.primary] && leg.modes[leg.primary].estimated) {
      warnings.push(
        `[${day.id}] ${leg.from} → ${leg.to} 用的是直线估算，高德未返回真实路径`
      );
    }
  }
}

/* 汇总 */
const daysWithRoute = ITIN.days.filter((d) =>
  ROUTES.legs.some((l) => l.dayId === d.id)
).length;

console.log('── 数据体检 ─────────────────────────────');
console.log(`  POI 总数：${Object.keys(POI).length}`);
console.log(`  天数：${ITIN.days.length} | 有路线的天数：${daysWithRoute}`);
console.log(`  路线段：${ROUTES.legs.length}`);

if (warnings.length) {
  console.log('\n⚠ 提醒：');
  warnings.forEach((w) => console.log(`  · ${w}`));
}

if (errors.length) {
  console.log('\n✗ 错误：');
  errors.forEach((e) => console.log(`  · ${e}`));
  process.exit(1);
}

console.log('\n✓ 数据完好，可以打开 index.html');
