'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
// 数据访问契约测试不访问真实用户数据库。
const dbPath = require.resolve('./db');
let execute;
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: async () => ({ execute: (...args) => execute(...args) }) } };
const trips = require('./trips');
const valid = () => ({ city: '武汉', days: [{ visits: [{ poiId: 'a', time: '09:00' }] }], poi: { a: { name: '公园' } }, routes: { legs: [] } });

test('删除原子限定所有者，拒绝不存在或非本人记录', async () => {
  execute = async (sql, params) => {
    assert.equal(sql, 'DELETE FROM trips WHERE id = ? AND user_id = ?');
    assert.deepEqual(params, ['x', 7]);
    return [{ affectedRows: 0 }];
  };
  await assert.rejects(trips.removeForUser('x', 7), { status: 404 });
  execute = async () => [{ affectedRows: 1 }];
  assert.equal(await trips.removeForUser('x', 7), true);
});

test('历史查询绑定用户、搜索和分页，多取一条判断后续', async () => {
  execute = async (sql, params) => {
    assert.match(sql, /WHERE user_id = \?/);
    assert.deepEqual(params, [7, '武汉', '武汉', 13, 12]);
    return [Array.from({ length: 13 }, (_, i) => ({ id: String(i), created_at: 1 }))];
  };
  const result = await trips.historyForUser(7, { page: 2, q: '武汉' });
  assert.equal(result.trips.length, 12); assert.equal(result.hasMore, true);
});
test('他人或无主行程不允许写入', async () => {
  execute = async (sql, params) => { assert.match(sql, /id = \? AND user_id = \?/); assert.deepEqual(params, ['x', 7]); return [[]]; };
  await assert.rejects(trips.updateForUser('x', 7, valid(), 1), { status: 404 });
});
test('旧版本拒绝，原子更新遇到并发也拒绝', async () => {
  execute = async () => [[{ payload: JSON.stringify(valid()), updated_at: 2 }]];
  await assert.rejects(trips.updateForUser('x', 7, valid(), 1), { status: 409 });
  execute = async sql => sql.startsWith('SELECT') ? [[{ payload: JSON.stringify(valid()), updated_at: 1 }]] : [{ affectedRows: 0 }];
  await assert.rejects(trips.updateForUser('x', 7, valid(), 1), { status: 409 });
});
test('保存仅更新可编辑内容，保留原城市和生成元数据', async () => {
  const original = { ...valid(), generatedAt: 'original', repair: { status: 'verified' } };
  execute = async (sql, params) => {
    if (sql.startsWith('SELECT')) return [[{ payload: JSON.stringify(original), updated_at: 1 }]];
    const saved = JSON.parse(params[0]);
    assert.equal(saved.city, '武汉'); assert.equal(saved.generatedAt, 'original'); assert.equal(saved.repair, undefined);
    assert.deepEqual(params.slice(2), ['x', 7, 1]);
    return [{ affectedRows: 1 }];
  };
  const result = await trips.updateForUser('x', 7, { ...valid(), city: '伪造' }, 1);
  assert.equal(result.tripId, 'x'); assert.ok(result.updatedAt > 1);
});
test('拒绝损坏地点引用和空白日期', () => {
  const broken = valid(); broken.days[0].visits[0].poiId = 'missing';
  assert.throws(() => trips.validateChanges(broken), { status: 400 });
  assert.throws(() => trips.validateChanges({ ...valid(), days: [] }), { status: 400 });
});
test('允许没有地图地点的航班等文字安排', () => {
  const plan = valid();
  plan.days[0].visits.push({ time: '19:40', title: '航班起飞' });
  assert.doesNotThrow(() => trips.validateChanges(plan));
});
