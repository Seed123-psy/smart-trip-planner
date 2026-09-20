'use strict';
const { resolveAmapServiceKey } = require('./keys');
const { HttpError } = require('./http');
const { clockMinutes } = require('./schedule-check');

async function queryAmap(path, params) {
  const { value } = await resolveAmapServiceKey();
  if (!value) throw new HttpError(503, '酒店搜索暂不可用', { expose: true });
  const url = new URL(path, 'https://restapi.amap.com');
  for (const [k, v] of Object.entries({ ...params, key: value, output: 'JSON' })) url.searchParams.set(k, v);
  let body;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    body = await response.json();
    if (!response.ok || body.status !== '1') throw new Error('upstream');
  } catch { throw new HttpError(502, '酒店搜索暂时失败，请稍后重试', { expose: true }); }
  return Array.isArray(body.pois) ? body.pois : [];
}

function hotelPoi(poi) {
  const coords = String(poi.location || '').split(',').map(Number);
  if (!poi.id || !poi.name || !String(poi.location || '').includes(',') ||
      /[-－](?:大堂|前台|停车场|餐厅|会议室)$/.test(poi.name) ||
      !String(poi.typecode || '').startsWith('10') || coords.length !== 2 || !coords.every(Number.isFinite) ||
      Math.abs(coords[0]) > 180 || Math.abs(coords[1]) > 90) return null;
  return { id: `hotel-${poi.id}`, amapId: poi.id, name: String(poi.name || ''),
    address: typeof poi.address === 'string' ? poi.address : '', city: String(poi.cityname || ''),
    coords, role: 'anchor', kind: 'hotel', source: 'amap' };
}

async function searchHotels(city, keyword) {
  if (typeof city !== 'string' || !city.trim() || city.length > 40 ||
      typeof keyword !== 'string' || keyword.trim().length < 2 || keyword.length > 80) {
    throw new HttpError(400, '请填写城市和至少两个字的酒店名称');
  }
  const pois = await queryAmap('/v3/place/text', { city: city.trim(), keywords: keyword.trim(),
    types: '100000', citylimit: 'true', offset: '8', page: '1', extensions: 'base' });
  return pois.map(hotelPoi).filter(Boolean);
}

async function resolveHotel(input, city) {
  if (!input) return null;
  if (typeof input !== 'object' || !/^[A-Za-z0-9]{5,40}$/.test(input.amapId || '') ||
      clockMinutes(input.departure) === null || clockMinutes(input.returnBy) === null ||
      clockMinutes(input.departure) >= clockMinutes(input.returnBy)) throw new HttpError(400, '酒店或每日出发、返回时间无效');
  // 用 ID 重新查证，不信任浏览器提交的名称和坐标；城市内再检索确保不串城市。
  const details = await queryAmap('/v3/place/detail', { id: input.amapId, extensions: 'base' });
  const poi = details.map(hotelPoi).find(p => p && p.amapId === input.amapId);
  if (!poi) throw new HttpError(400, '酒店信息已失效，请重新搜索选择');
  const local = await searchHotels(city, poi.name.slice(0, 80));
  if (!local.some(p => p.amapId === poi.amapId)) throw new HttpError(400, '酒店不在当前城市搜索结果中，请重新确认分店');
  return { ...poi, departure: input.departure, returnBy: input.returnBy };
}

function attachHotel(days, hotel) {
  if (!hotel) return;
  for (const day of days) {
    day.visits = day.visits.filter(v => v.poiId !== hotel.id);
    const anchor = (time, kind, title) => ({ poiId: hotel.id, time, title, stay: '', mode: 'driving',
      anchor: kind, desc: '按同一酒店每日往返安排；抵离日如需机场或车站接驳，请另行预留时间。', advice: '', hot: false });
    day.visits.unshift(anchor(hotel.departure, 'hotel-departure', `从${hotel.name}出发`));
    day.visits.push(anchor(hotel.returnBy, 'hotel-return', `返回${hotel.name}（最晚 ${hotel.returnBy}）`));
  }
}
module.exports = { searchHotels, resolveHotel, attachHotel, hotelPoi };
