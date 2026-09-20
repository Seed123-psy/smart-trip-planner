'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { repairPlan, acceptable } = require('./repair-plan');
function plan(status = 'needs_review') {
  return { days: [{ date: '2026-10-06', visits: [{ poiId: 'a', time: '09:00', stay: '2小时' }], openingWarnings: [] }],
    scheduleCheck: { reports: [{ status }] } };
}
test('实际复查通过后接受修复，修复只运行必要轮次', async () => {
  let calls = 0;
  const result = await repairPlan(plan(), { request: {}, deadline: 100000, now: () => 0,
    revise: async () => { calls++; return 'candidate'; }, validate: async raw => { assert.equal(raw, 'candidate'); return plan('checked'); } });
  assert.equal(calls, 1);
  assert.equal(result.repair.status, 'verified');
});
test('模型声称成功不够，复查仍冲突时最多两轮并保留原计划', async () => {
  let calls = 0;
  const initial = plan();
  const result = await repairPlan(initial, { request: {}, deadline: 100000, now: () => 0,
    revise: async () => { calls++; return {}; }, validate: async () => plan() });
  assert.equal(calls, 2);
  assert.equal(result, initial);
  assert.equal(result.repair.status, 'unresolved');
});
test('预算不足不发模型请求，模型失败安全回退', async () => {
  const skipped = await repairPlan(plan(), { request: {}, deadline: 100, now: () => 0,
    revise: () => assert.fail('不应调用'), validate: () => assert.fail('不应校验') });
  assert.equal(skipped.repair.attempts[0].status, 'budget_exhausted');
  const failed = await repairPlan(plan(), { request: {}, deadline: 100000, now: () => 0,
    revise: async () => { throw new Error('upstream'); } });
  assert.equal(failed.repair.attempts[0].status, 'failed');
});
test('不接受缩短游览、提前出发、延长当天或删除所有景点', () => {
  for (const change of [v => { v.stay = '1小时'; }, v => { v.time = '08:00'; }, v => { v.time = '10:00'; }]) {
    const candidate = plan('checked'); change(candidate.days[0].visits[0]);
    assert.equal(acceptable(plan(), candidate, {}), false);
  }
  const empty = plan('checked'); empty.days[0].visits = [];
  assert.equal(acceptable(plan(), empty, {}), false);
});
