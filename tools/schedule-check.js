'use strict';

function clockMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null;
}

// 只解析明确的时长；范围取上限，不把无法识别的描述当作零分钟。
function stayMinutes(value) {
  const s = String(value || '').trim().replace(/约|大约/g, '').trim();
  let m = /^(\d+(?:\.\d+)?)\s*(?:[—–\-~～至到]\s*(\d+(?:\.\d+)?))?\s*(小时|分钟|h|min)$/i.exec(s);
  if (m) {
    const n = Math.max(+m[1], +(m[2] || m[1]));
    return n > 0 ? Math.ceil(n * (/小时|^h$/i.test(m[3]) ? 60 : 1)) : null;
  }
  m = /^(\d+)\s*小时\s*(半|\d+\s*分钟)?$/.exec(s);
  if (m) return +m[1] * 60 + (m[2] === '半' ? 30 : parseInt(m[2] || '0', 10));
  return s === '半小时' ? 30 : null;
}

function formatTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** 不修改地点顺序或缩短游览。无法可靠修复时保留原计划并明确报告。 */
function reconcileSchedule(days, routes, request = {}) {
  const reports = [];
  const warnings = [];
  const buffer = request.pace === 'slow' || ['family', 'seniors'].includes(request.party) ? 20 : 10;
  for (const day of days) {
    const visits = day.visits;
    const proposed = visits.map(v => clockMinutes(v.time));
    const stays = visits.map(v => stayMinutes(v.stay));
    const issues = [];
    const changes = [];
    let estimated = false;
    for (let i = 0; i < visits.length; i++) {
      if (proposed[i] === null || stays[i] === null) issues.push(`${visits[i].title}的时间或停留时长无法可靠解析`);
      if (!i) continue;
      const leg = routes.legs.find(l => l.dayId === day.id && l.fromIndex === i - 1 && l.from === visits[i - 1].poiId && l.to === visits[i].poiId);
      const metrics = leg?.modes?.[leg.primary];
      if (!metrics || !Number.isFinite(metrics.duration) || metrics.duration < 0) {
        issues.push(`${visits[i - 1].title}至${visits[i].title}缺少交通耗时`);
        continue;
      }
      estimated ||= Boolean(metrics.estimated);
      if (proposed[i - 1] === null || proposed[i] === null || stays[i - 1] === null) continue;
      const earliest = proposed[i - 1] + stays[i - 1] + Math.ceil(metrics.duration / 60) + buffer;
      if (earliest > proposed[i]) {
        changes.push({ index: i, from: visits[i].time, to: formatTime(earliest) });
        proposed[i] = earliest;
      }
    }
    // 未知预约/返程约束下，不自动把一天拖晚：以模型原先的最后游览结束为边界。
    const last = visits.length - 1;
    const originalEnd = last >= 0 && clockMinutes(visits[last].time) !== null && stays[last] !== null
      ? clockMinutes(visits[last].time) + stays[last] : null;
    if (last >= 0 && proposed[last] !== null && stays[last] !== null &&
        (proposed[last] + stays[last] >= 1440 || (originalEnd !== null && proposed[last] + stays[last] > originalEnd))) {
      issues.push('顺延后会超过原定当天结束时间，需要减少地点或调整日期');
    }
    // 有预约、抵离等自由文本时，不能把时刻擅自改成另一个承诺。
    if (changes.length && /预约|航班|火车|高铁|返程|抵达|离开|闭馆|关门/.test(
      [request.notes, request.startPoint, request.endPoint, day.summary, ...visits.map(v => `${v.desc} ${v.advice}`)].join(' '))) {
      issues.push('涉及预约、抵离或开放时段，需确认固定时刻后重新排程');
    }
    if (estimated) issues.push('含估算交通耗时，尚不能确认真实时间可行性');
    if (!visits.length) issues.push('当天没有可校验的行程点');
    if (!issues.length) {
      for (const change of changes) visits[change.index].time = change.to;
    }
    const status = issues.length ? 'needs_review' : changes.length ? 'adjusted' : 'checked';
    const note = issues.length
      ? `时间校验待确认：${issues.join('；')}。${changes.length ? '检测到时间冲突，原时刻保留，不能直接按此出行。' : ''}`
      : changes.length ? `已按交通耗时及每段 ${buffer} 分钟缓冲调整 ${changes.length} 处时间，未延长当天结束时间。` : '';
    if (note) {
      day.summary = `${day.summary || ''} ${note}`.trim();
      warnings.push(`${day.label || day.id}：${note}`);
    }
    reports.push({ dayId: day.id, status, issues, changes, applied: !issues.length, bufferMinutes: buffer });
  }
  return { reports, warnings, scope: '相邻景点停留、交通和转场缓冲；不验证开放时间、预约、餐饮或机场接驳' };
}

module.exports = { reconcileSchedule, clockMinutes, stayMinutes };
