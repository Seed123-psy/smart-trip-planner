'use strict';
const { clockMinutes, stayMinutes } = require('./schedule-check');

function problems(plan) {
  return plan.days.reduce((n, day) => n + (day.openingWarnings || []).length, 0) +
    plan.scheduleCheck.reports.filter(r => r.status === 'needs_review').length;
}

function acceptable(original, candidate, request) {
  if (candidate.days.length !== original.days.length) return false;
  const fixed = text => /\d{1,2}:\d{2}/.test(text || '') && /预约|航班|火车|高铁|返程|抵达|离开|闭馆|关门/.test(text || '');
  for (let i = 0; i < original.days.length; i++) {
    const before = original.days[i];
    const after = candidate.days[i];
    if (before.date !== after.date || !after.visits.some(v => !v.anchor)) return false;
    const first = clockMinutes(before.visits[0]?.time);
    const last = before.visits.at(-1);
    const end = clockMinutes(last?.time);
    const stay = last?.anchor ? 0 : stayMinutes(last?.stay);
    const newLast = after.visits.at(-1);
    const newEnd = clockMinutes(newLast?.time);
    const newStay = newLast?.anchor ? 0 : stayMinutes(newLast?.stay);
    if (first !== null && clockMinutes(after.visits[0]?.time) < first) return false;
    if (end !== null && stay !== null && newEnd !== null && newStay !== null && newEnd + newStay > end + stay) return false;
    for (const visit of before.visits) {
      const replacement = candidate.days.flatMap(d => d.visits).find(v => !v.anchor && v.poiId === visit.poiId);
      if (!visit.anchor && replacement && stayMinutes(visit.stay) !== null &&
          (stayMinutes(replacement.stay) === null || stayMinutes(replacement.stay) < stayMinutes(visit.stay))) return false;
      if (fixed(request.notes) || fixed(`${visit.desc || ''} ${visit.advice || ''}`)) {
        if (!after.visits.some(v => v.poiId === visit.poiId && v.time === visit.time)) return false;
      }
    }
    const hadTimeIssue = original.scheduleCheck.reports[i]?.status === 'needs_review';
    if (!hadTimeIssue && candidate.scheduleCheck.reports[i]?.status === 'needs_review') return false;
    if (!(before.openingWarnings || []).length && (after.openingWarnings || []).length) return false;
  }
  return problems(candidate) < problems(original);
}

async function repairPlan(initial, { request, revise, validate, deadline, now = Date.now, onAttempt = () => {} }) {
  let result = initial;
  const attempts = [];
  for (let round = 1; round <= 2 && problems(result); round++) {
    if (deadline - now() < 15000) { attempts.push({ round, status: 'budget_exhausted' }); break; }
    onAttempt(round);
    try {
      const raw = await revise(result, round);
      if (deadline - now() < 1000) { attempts.push({ round, status: 'budget_exhausted' }); break; }
      const candidate = await validate(raw);
      if (acceptable(result, candidate, request)) {
        result = candidate;
        attempts.push({ round, status: 'improved' });
      } else { attempts.push({ round, status: 'rejected' }); }
    } catch { attempts.push({ round, status: 'failed' }); break; }
  }
  result.repair = { attempts, status: problems(result) ? 'unresolved' : 'verified' };
  return result;
}
module.exports = { repairPlan, acceptable, problems };
