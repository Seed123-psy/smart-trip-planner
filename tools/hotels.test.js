'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { searchHotels, resolveHotel, attachHotel, hotelPoi } = require('./hotels');
const { optimizeSchedule } = require('./schedule-check');
const raw = { id: 'B012345678', name: '测试酒店', typecode: '100100', cityname: '武汉市', address: '测试路1号', location: '114.3,30.5' };

test('酒店数据只接受住宿分类和有效坐标', () => {
  assert.equal(hotelPoi(raw).kind, 'hotel');
  assert.equal(hotelPoi({ ...raw, typecode: '050000' }), null);
  assert.equal(hotelPoi({ ...raw, location: 'bad' }), null);
  assert.equal(hotelPoi({ ...raw, name: '测试酒店-大堂' }), null);
});
test('非法查询和返回时间在外部请求前拒绝', async () => {
  await assert.rejects(searchHotels('', '测试酒店'), { status: 400 });
  await assert.rejects(resolveHotel({ amapId: raw.id, departure: '21:00', returnBy: '09:00' }, '武汉'), { status: 400 });
  assert.equal(await resolveHotel(null, '武汉'), null);
});
test('重查酒店 ID、城市和坐标，不采用客户端伪造地点', async (t) => {
  const originalFetch = global.fetch;
  const originalKey = process.env.AMAP_WEB_SERVICE_KEY;
  process.env.AMAP_WEB_SERVICE_KEY = 'unit-test-key';
  t.after(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.AMAP_WEB_SERVICE_KEY;
    else process.env.AMAP_WEB_SERVICE_KEY = originalKey;
  });
  const urls = [];
  global.fetch = async url => {
    urls.push(url);
    return { ok: true, json: async () => ({ status: '1', pois: [raw] }) };
  };
  const hotel = await resolveHotel({ amapId: raw.id, name: '伪造', coords: [0, 0], departure: '09:00', returnBy: '21:00' }, '武汉');
  assert.equal(hotel.name, raw.name);
  assert.deepEqual(hotel.coords, [114.3, 30.5]);
  assert.equal(urls[1].searchParams.get('citylimit'), 'true');
  global.fetch = async url => ({ ok: true, json: async () => ({ status: '1', pois: url.pathname.endsWith('/detail') ? [raw] : [] }) });
  await assert.rejects(resolveHotel({ amapId: raw.id, departure: '09:00', returnBy: '21:00' }, '北京'), { status: 400 });
});
test('住宿首尾路段参加校验，返回截止不可顺延', () => {
  const hotel = { ...hotelPoi(raw), departure: '09:00', returnBy: '18:00' };
  const days = [{ id: 'day1', visits: [{ poiId: 'spot', time: '09:10', stay: '8小时', title: '景点', mode: 'driving' }] }];
  attachHotel(days, hotel);
  assert.equal(days[0].visits.length, 3);
  const routes = { legs: [0, 1].map(i => ({ dayId: 'day1', fromIndex: i,
    from: days[0].visits[i].poiId, to: days[0].visits[i + 1].poiId,
    primary: 'driving', modes: { driving: { duration: 3600 } } })) };
  const result = optimizeSchedule(days, routes);
  assert.equal(result.reports[0].status, 'needs_review');
  assert.equal(days[0].visits[2].time, '18:00');
});
test('未选择酒店不修改日程', () => {
  const days = [{ visits: [] }];
  attachHotel(days, null);
  assert.deepEqual(days, [{ visits: [] }]);
});
