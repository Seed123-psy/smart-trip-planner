(function () {
  'use strict';
  const button = document.getElementById('trip-save');
  const status = document.getElementById('trip-save-status');
  const shared = new URLSearchParams(location.search).has('share');
  let draft = null, revision = null, counter = 0, busy = false, loading = 0;
  function paint(message) {
    button.hidden = shared || !draft;
    button.disabled = busy || !draft?._dirty || !Number.isSafeInteger(revision);
    button.textContent = busy ? '正在保存…' : '保存修改';
    status.textContent = shared ? '' : message || (draft?._dirty ? '未保存' : draft?.tripId ? '已保存' : draft ? '仅保存在本地，未写入历史记录' : '');
  }
  async function loaded(plan) {
    const token = ++loading;
    if (shared) return;
    draft = structuredClone(plan); counter++;
    revision = Number.isSafeInteger(plan.updatedAt) ? plan.updatedAt : null;
    paint();
    if (!plan.tripId || revision !== null) return;
    try {
      const res = await fetch(`/api/trips/${encodeURIComponent(plan.tripId)}`);
      const data = await res.json();
      if (token !== loading || draft.tripId !== plan.tripId) return;
      if (!res.ok) throw new Error(data.error || '无法读取保存版本');
      revision = data.plan.updatedAt;
      draft.updatedAt = revision;
      window.TripApp.savedRevision(revision);
      if (draft._dirty) window.TripPlanStore.save(draft);
      paint();
    } catch (error) { if (token === loading) paint(error.message); }
  }
  window.addEventListener('trip:loaded', event => loaded(event.detail));
  window.addEventListener('trip:changed', event => {
    const currentRevision = revision;
    if (draft?.tripId !== event.detail.tripId) { loaded(event.detail); return; }
    draft = structuredClone(event.detail); revision = currentRevision; counter++;
    if (revision !== null) draft.updatedAt = revision;
    window.TripPlanStore.save(draft);
    paint(draft.tripId ? null : '本地草稿：示例行程尚未保存到账号');
  });
  window.addEventListener('beforeunload', event => {
    if (draft?._dirty) { event.preventDefault(); event.returnValue = ''; }
  });
  button.addEventListener('click', async () => {
    if (busy || !draft?._dirty || !draft.tripId || revision === null) return;
    const sent = counter, id = draft.tripId;
    busy = true; paint();
    try {
      const res = await fetch(`/api/trips/${encodeURIComponent(id)}`, { method: 'PUT',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: draft, updatedAt: revision }) });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          status.replaceChildren(document.createTextNode('请先登录，本地修改已保留。 '));
          const link = document.createElement('a'); link.textContent = '去登录';
          link.href = 'login.html?next=' + encodeURIComponent(`trip.html?trip=${id}`); status.append(link);
          return;
        }
        throw new Error(data.error || '保存失败');
      }
      if (draft.tripId !== id) return;
      revision = data.plan.updatedAt;
      window.TripApp.savedRevision(revision, data.plan);
      if (sent === counter) draft = { ...data.plan, _dirty: false };
      else draft.updatedAt = revision;
      window.TripPlanStore.save(draft);
      paint(sent === counter ? '已保存' : '已保存上次修改，仍有新改动未保存');
    } catch (error) { paint(`${error.message} · 本地修改已保留，可重试`); }
    finally { busy = false; button.disabled = !draft?._dirty || revision === null; button.textContent = '保存修改'; }
  });
  const existing = window.TripApp?.currentPlan();
  if (existing) loaded(existing);
})();
