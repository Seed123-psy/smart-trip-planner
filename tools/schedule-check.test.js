'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileSchedule, optimizeSchedule, stayMinutes, clockMinutes } = require('./schedule-check');

function fixture(times = ['09:00', '10:00', '14:00']) {
  const days = [{ id: 'day1', label: 'Day 1', summary: '', visits: times.map((time, i) => ({
    poiId: String(i), title: `景点${i}`, time, stay: '1小时'
  })) }];
  const routes = { legs: times.slice(1).map((_, i) => ({
    dayId: 'day1', fromIndex: i, from: String(i), to: String(i + 1), primary: 'walking',
    modes: { walking: { duration: 1800 } }
  })) };
  return { days, routes };
}

test('真实耗时按秒换算，顺延冲突并保留已有空档与地点索引', () => {
  const { days, routes } = fixture();
  const report = reconcileSchedule(days, routes);
  assert.equal(days[0].visits[1].time, '10:40');
  assert.equal(days[0].visits[2].time, '14:00');
  assert.equal(report.reports[0].status, 'adjusted');
  assert.deepEqual(days[0].visits.map(v => v.poiId), ['0', '1', '2']);
});
test('冲突逐站传播，超过结束时间则不部分应用修复', () => {
  const { days, routes } = fixture(['09:00', '10:00', '11:00']);
  const report = reconcileSchedule(days, routes);
  assert.equal(report.reports[0].status, 'needs_review');
  assert.equal(report.reports[0].changes[1].to, '12:20');
  assert.deepEqual(days[0].visits.map(v => v.time), ['09:00', '10:00', '11:00']);
});
test('估算或缺失路段不能标记为校验通过', () => {
  for (const missing of [false, true]) {
    const { days, routes } = fixture();
    if (missing) routes.legs.shift();
    else routes.legs[0].modes.walking.estimated = true;
    assert.equal(reconcileSchedule(days, routes).reports[0].status, 'needs_review');
    assert.equal(days[0].visits[1].time, '10:00');
  }
});
test('预约或返程时刻不擅自顺延', () => {
  const { days, routes } = fixture();
  const report = reconcileSchedule(days, routes, { notes: '10:00预约入馆' });
  assert.equal(report.reports[0].applied, false);
  assert.equal(days[0].visits[1].time, '10:00');
});
test('慢游保留更多转场缓冲，单个深度体验不强制补点', () => {
  const f = fixture();
  reconcileSchedule(f.days, f.routes, { pace: 'slow' });
  assert.equal(f.days[0].visits[1].time, '10:50');
  const one = fixture(['09:00']);
  one.days[0].visits[0].stay = '8小时';
  assert.equal(reconcileSchedule(one.days, one.routes).reports[0].status, 'checked');
});
test('时长范围保守取上限，未知和无效时刻不能伪装成零', () => {
  assert.equal(stayMinutes('1—2小时'), 120);
  assert.equal(stayMinutes('1小时30分钟'), 90);
  assert.equal(stayMinutes('半小时'), 30);
  assert.equal(stayMinutes('半天'), null);
  assert.equal(clockMinutes('25:00'), null);
  const f = fixture();
  f.days[0].visits[0].stay = '';
  assert.equal(reconcileSchedule(f.days, f.routes).reports[0].status, 'needs_review');
});
test('跨午夜不回绕成当天时间', () => {
  const f = fixture(['23:00', '23:30']);
  assert.equal(reconcileSchedule(f.days, f.routes).reports[0].status, 'needs_review');
  assert.equal(f.days[0].visits[1].time, '23:30');
});
test('泛泛提醒需预约不阻止自动修复', () => {
  const f = fixture();
  f.days[0].visits[1].advice = '热门场馆通常需要预约，返程注意交通';
  assert.equal(reconcileSchedule(f.days, f.routes).reports[0].status, 'adjusted');
});

function alternativeFixture() {
  const f = fixture(['09:00', '10:40']);
  f.routes.legs[0].primary = 'driving';
  f.routes.legs[0].modes = { driving: { duration: 3600 }, transit: { duration: 1200 } };
  f.days[0].visits[1].mode = 'driving';
  return f;
}
test('已有真实公交备选能解除冲突时同步更新到访方式和路线', () => {
  const f = alternativeFixture();
  const result = optimizeSchedule(f.days, f.routes);
  assert.equal(result.reports[0].status, 'adjusted');
  assert.equal(result.modeChanges[0].savedMinutes, 40);
  assert.equal(f.routes.legs[0].primary, 'transit');
  assert.equal(f.days[0].visits[1].mode, 'transit');
  assert.equal(f.days[0].visits[1].time, '10:40');
  assert.doesNotMatch(f.days[0].summary, /待确认/);
});
test('更换方式仍无法消除冲突时整体回退', () => {
  const f = alternativeFixture();
  f.days[0].visits[1].time = '09:30';
  const result = optimizeSchedule(f.days, f.routes);
  assert.equal(result.reports[0].status, 'needs_review');
  assert.equal(f.routes.legs[0].primary, 'driving');
  assert.equal(f.days[0].visits[1].mode, 'driving');
  assert.deepEqual(result.modeChanges, []);
});
test('尊重明确交通要求和亲子老人出行，不自动替换估算备选', () => {
  for (const request of [{ notes: '全程打车' }, { party: 'family' }, { party: 'seniors' }]) {
    const f = alternativeFixture();
    assert.equal(optimizeSchedule(f.days, f.routes, request).modeChanges.length, 0);
    assert.equal(f.routes.legs[0].primary, 'driving');
  }
  const f = alternativeFixture();
  f.routes.legs[0].modes.transit.estimated = true;
  assert.equal(optimizeSchedule(f.days, f.routes).modeChanges.length, 0);
});
test('兼容大约时长，零停留不能当成有效体验', () => {
  assert.equal(stayMinutes('大约 1 小时'), 60);
  assert.equal(stayMinutes('0小时0分钟'), null);
});
