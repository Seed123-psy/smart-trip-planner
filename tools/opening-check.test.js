'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calendar, checkOpeningRisks } = require('./opening-check');
test('实际星期跨月连续，不依赖模型星期标签', () => {
  assert.equal(calendar('2026-10-03', 5)[2].weekdayLabel, '周一');
  assert.equal(calendar('2026-12-31', 2)[1].date, '2027-01-01');
  assert.throws(() => calendar('2026-02-30', 1));
});
test('假期周一仍提示核实，不宣称确定闭馆或开放', () => {
  const days = [{ date: '2026-10-05', visits: [{ poiId: 'museum' }, { poiId: 'museum' }, { poiId: 'park' }] }];
  const warnings = checkOpeningRisks(days, { museum: { name: '湖北省博物馆', kind: 'museum' }, park: { name: '东湖公园', kind: 'park' } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /节假日可能例外/);
  assert.doesNotMatch(warnings[0], /东湖公园/);
  assert.equal(days[0].openingWarnings.length, 1);
});
test('非周一不误报，名称能补足美术馆类型识别', () => {
  const days = ['2026-10-05', '2026-10-06'].map(date => ({ date, visits: [{ poiId: 'art' }] }));
  checkOpeningRisks(days, { art: { name: '测试美术馆', kind: 'landmark' } });
  assert.equal(days[0].openingWarnings.length, 1);
  assert.equal(days[1].openingWarnings.length, 0);
});
