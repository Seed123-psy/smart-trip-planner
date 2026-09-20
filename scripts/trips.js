(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let page = 1, query = '', generation = 0, failedPage = 1;
  const node = (tag, text, className) => { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; };
  function card(trip) {
    const article = node('article', '', 'trip-card');
    article.append(node('p', trip.city || '旅行计划', 'trip-card__city'), node('h2', trip.title || '未命名行程'));
    article.append(node('p', `${trip.startDate || '日期待定'} — ${trip.endDate || '日期待定'} · ${trip.days || '—'} 天`));
    article.append(node('p', trip.hotel && trip.hotel !== 'null' ? `住宿 · ${trip.hotel}` : '住宿 · 未指定酒店'));
    const footer = document.createElement('footer');
    const date = new Date(Number(trip.createdAt));
    footer.append(node('small', Number.isNaN(date.getTime()) ? '' : `生成于 ${date.toLocaleString('zh-CN')}`));
    const link = node('a', '查看行程 →'); link.href = `trip.html?trip=${encodeURIComponent(trip.id)}`;
    const actions = node('div', '', 'trip-card__actions');
    const remove = node('button', '删除', 'trip-card__delete');
    remove.type = 'button';
    remove.setAttribute('aria-label', `删除 ${trip.title || trip.city || '行程'}`);
    const feedback = node('p', '', 'trip-card__feedback');
    feedback.setAttribute('role', 'status');
    remove.addEventListener('click', async () => {
      if (!confirm(`确定删除「${trip.title || trip.city || '这份行程'}」吗？\n删除后无法恢复，已有分享链接也会失效。`)) return;
      remove.disabled = true; remove.textContent = '正在删除…'; feedback.textContent = '';
      try {
        const res = await fetch(`/api/trips/${encodeURIComponent(trip.id)}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.status === 401) { location.assign('login.html?next=trips.html'); return; }
        if (!res.ok && res.status !== 404) throw new Error(data.error || '删除失败');
        if (window.TripPlanStore.read()?.tripId === trip.id) window.TripPlanStore.clear();
        article.remove();
        // 删除改变分页偏移，从第一页重取，避免下一页漏掉记录。
        await load(1);
      } catch (error) {
        feedback.textContent = `删除失败：${error.message}，请重试。`;
      } finally { remove.disabled = false; remove.textContent = '删除'; }
    });
    actions.append(remove, link); footer.append(actions); article.append(footer, feedback); return article;
  }
  async function load(next = 1) {
    const token = ++generation;
    failedPage = next;
    $('history-more').disabled = true;
    $('history-retry').hidden = true;
    $('history-status').textContent = '正在找回你的行程…';
    try {
      const res = await fetch(`/api/trips?${new URLSearchParams({ page: next, q: query })}`, { headers: { Accept: 'application/json' } });
      if (token !== generation) return;
      if (res.status === 401) { location.replace('login.html?next=' + encodeURIComponent('trips.html')); return; }
      const data = await res.json();
      if (token !== generation) return;
      if (!res.ok) throw new Error(data.error || '读取失败');
      if (next === 1) $('history-list').replaceChildren();
      data.trips.forEach(trip => $('history-list').append(card(trip)));
      page = next;
      $('history-more').hidden = !data.hasMore;
      $('history-status').textContent = next === 1 && !data.trips.length
        ? (query ? '没有找到匹配的行程，换个关键词试试。' : '还没有保存的行程。点击「开始规划」，开启你的第一段旅程。') : '';
    } catch (error) {
      if (token !== generation) return;
      $('history-status').textContent = `暂时无法读取行程：${error.message}。请重试。`;
      $('history-retry').hidden = false;
    } finally { if (token === generation) $('history-more').disabled = false; }
  }
  $('history-search').addEventListener('submit', event => {
    event.preventDefault(); query = $('history-query').value.trim();
    $('history-list').replaceChildren(); $('history-more').hidden = true; load(1);
  });
  $('history-more').addEventListener('click', () => load(page + 1));
  $('history-retry').addEventListener('click', () => load(failedPage));
  load();
})();
