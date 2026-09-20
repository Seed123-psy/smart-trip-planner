'use strict';

function calendar(startDate, count) {
  const start = new Date(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== startDate) throw new Error('行程开始日期无效');
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start.getTime() + index * 86400000);
    return { date: date.toISOString().slice(0, 10), weekday: date.getUTCDay(), weekdayLabel: `周${'日一二三四五六'[date.getUTCDay()]}` };
  });
}

// 常见闭馆模式是待核实风险，不是某个场馆当天闭馆的权威证据。
function checkOpeningRisks(days, poi) {
  const warnings = [];
  for (const day of days) {
    day.openingWarnings = [];
    if (calendar(day.date, 1)[0].weekday !== 1) continue;
    const names = [...new Set(day.visits.filter(v => !v.anchor).map(v => poi[v.poiId])
      .filter(p => p && (p.kind === 'museum' || /博物馆|美术馆|科技馆|纪念馆/.test(p.name)))
      .map(p => p.name))];
    if (!names.length) continue;
    const message = `${day.date}（周一）安排了${names.join('、')}。此类场馆常见周一闭馆，但节假日可能例外；尚未核实当天官方公告，请确认开放及预约后再出发，优先考虑改到其他日期。`;
    day.openingWarnings.push(message);
    warnings.push(message);
  }
  return warnings;
}
module.exports = { calendar, checkOpeningRisks };
