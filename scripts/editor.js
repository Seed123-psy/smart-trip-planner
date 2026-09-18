/* ============================================================
   行程编辑模式

   让用户自己改行程：删点、加点、上下移、改时间，改完地图重新画。

   两条设计取向：

   · **不上拖拽**。触屏上拖拽和页面滚动打架，而一天也就五六个点 ——
     点两下箭头比拖一次更快，也更难误操作。
   · **位置改了就重排时间**。把一个点从第三位移到第一位时，时间跟着**位置**走
     而不是跟着那个点走：顺序变了、时刻表仍然是从早到晚的。
     否则会出现「第一个点 14:00、第二个点 09:30」这种读不通的排列。

   改动会即时落回 sessionStorage —— 改完刷新就没了是最让人恼火的一种失败。
   ============================================================ */

(function () {
  'use strict';

  const CFG = window.TRIP_CONFIG;
  const POI = window.TRIP_POI;
  const ITIN = window.TRIP_ITINERARY;
  const ROUTES = window.TRIP_ROUTES;

  const KIND_LABEL = {
    museum: '博物馆',
    park: '公园',
    food: '吃',
    landmark: '地标'
  };

  /** 步行可达的阈值：低于它就默认按走路连，省得加个隔壁的点还写「打车」 */
  const WALKABLE_METERS = 1200;

  let on = false;

  /* ------------------------------------------------------------------ */
  /* 小工具                                                              */
  /* ------------------------------------------------------------------ */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function normalizeMode(mode) {
    return ['driving', 'transit', 'walking'].includes(mode) ? mode : 'driving';
  }

  function haversine(a, b) {
    const R = 6371000;
    const rad = (n) => (n * Math.PI) / 180;
    const dLat = rad(b[1] - a[1]);
    const dLon = rad(b[0] - a[0]);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function currentDay() {
    const index = window.TripApp.currentDayIndex();
    return index >= 0 ? ITIN.days[index] : null;
  }

  /* ------------------------------------------------------------------ */
  /* 开关                                                                */
  /* ------------------------------------------------------------------ */

  function isOn() {
    return on;
  }

  function toggle() {
    on = !on;
    syncButton();
    // 进出编辑模式都要重画：操作条与时间输入框只在编辑态出现
    window.TripApp.refreshDay();
  }

  function syncButton() {
    const btn = document.getElementById('edit-open');
    if (!btn) return;
    btn.classList.toggle('is-on', on);
    const label = btn.querySelector('span:last-child');
    if (label) label.textContent = on ? '完成编辑' : '编辑行程';
    btn.setAttribute('aria-pressed', String(on));
  }

  /**
   * 交给 timeline 的编辑上下文。
   * 每个回调都绑好「哪一天」——时间轴只知道自己画的是哪一天的内容，
   * 不该再去问全局状态。
   */
  function context(dayIndex) {
    return {
      onRemove: (visitIndex) => removeVisit(dayIndex, visitIndex),
      onMove: (visitIndex, delta) => moveVisit(dayIndex, visitIndex, delta),
      onTime: (visitIndex, value) => setTime(dayIndex, visitIndex, value),
      onAdd: () => openPicker(dayIndex)
    };
  }

  /* ------------------------------------------------------------------ */
  /* 编辑动作                                                            */
  /* ------------------------------------------------------------------ */

  function removeVisit(dayIndex, visitIndex) {
    const day = ITIN.days[dayIndex];
    if (!day || visitIndex < 0 || visitIndex >= day.visits.length) return;
    day.visits.splice(visitIndex, 1);
    afterShapeChange(dayIndex);
  }

  function moveVisit(dayIndex, visitIndex, delta) {
    const day = ITIN.days[dayIndex];
    if (!day) return;
    const target = visitIndex + delta;
    if (target < 0 || target >= day.visits.length) return;

    const [item] = day.visits.splice(visitIndex, 1);
    day.visits.splice(target, 0, item);
    reflowTimes(day);
    afterShapeChange(dayIndex);
  }

  /**
   * 顺序变了之后，把时刻按位置重排一遍。
   * 时间是挂在「第几个点」上的，不是挂在地点上的 —— 换个顺序还留着原来的钟点，
   * 时间轴就会读出「14:00 → 09:30」这种顺序。
   */
  function reflowTimes(day) {
    const times = day.visits.map((v) => v.time).filter((t) => /^\d{2}:\d{2}/.test(t || '')).sort();
    if (times.length !== day.visits.length) return;
    day.visits.forEach((visit, i) => {
      visit.time = times[i];
    });
  }

  function setTime(dayIndex, visitIndex, value) {
    const day = ITIN.days[dayIndex];
    if (!day || !/^\d{2}:\d{2}$/.test(value)) return;
    const visit = day.visits[visitIndex];
    if (!visit || visit.time === value) return;

    visit.time = value;
    // 改时间不动路线：路段只跟「哪两个点相邻」有关，与钟点无关。
    // 所以这里只重画，不重新取路。
    persist();
    window.TripApp.refreshDay();
  }

  function addPoi(dayIndex, poiId) {
    const day = ITIN.days[dayIndex];
    const poi = POI[poiId];
    if (!day || !poi || !Array.isArray(poi.coords)) return;
    if (day.visits.some((v) => v.poiId === poiId)) return;

    const last = day.visits[day.visits.length - 1];
    const previous = last && POI[last.poiId] && POI[last.poiId].coords;
    const near = previous ? haversine(previous, poi.coords) < WALKABLE_METERS : false;

    day.visits.push({
      poiId,
      // 排在最后一个点之后一小时，用户觉得不合适再改 —— 比让他从零填一个时间省事
      time: nextHour(lastTimeOf(day)),
      title: poi.name,
      desc: poi.note || '',
      stay: '',
      mode: near ? 'walking' : 'driving',
      advice: '',
      hot: false
    });
    afterShapeChange(dayIndex);
  }

  function lastTimeOf(day) {
    const times = day.visits.map((v) => v.time).filter((t) => /^\d{2}:\d{2}/.test(t || '')).sort();
    return times[times.length - 1] || '16:00';
  }

  function nextHour(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const hour = Math.min(21, (Number.isFinite(h) ? h : 16) + 1);
    return `${String(hour).padStart(2, '0')}:${String(Number.isFinite(m) ? m : 0).padStart(2, '0')}`;
  }

  /* ------------------------------------------------------------------ */
  /* 改动之后的收尾：重算路段 → 存盘 → 重画                                */
  /* ------------------------------------------------------------------ */

  async function afterShapeChange(dayIndex) {
    const day = ITIN.days[dayIndex];
    if (!day) return;

    window.TripApp.setBusy(true);
    try {
      await rebuildDayLegs(day);
      persist();
      await window.TripApp.refreshDay();
    } finally {
      window.TripApp.setBusy(false);
    }
  }

  /**
   * 重算这一天的全部路段。
   *
   * 为什么整段重算而不是只补变化的那几段：增删一个点会让它之后所有点的
   * fromIndex 全部前移，旧路段整批对不上号。一天也就五六个点，
   * 全部重来比维护「哪些对还成立」的判断简单得多，也不容易错。
   */
  async function rebuildDayLegs(day) {
    const stops = window.TripTimeline.resolveStops(day);
    const otherDays = ROUTES.legs.filter((l) => l.dayId !== day.id);
    const fresh = [];
    const modes = [];
    const allPaths = [];
    let anyEstimated = false;

    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      const mode = normalizeMode((day.visits[b.visitIndex] || {}).mode);
      modes.push(mode);

      let metrics = null;
      try {
        metrics = await window.TripRoute.getLeg(a.coords, b.coords, mode);
      } catch (error) {
        // 取不到就按直线估算，并标上 estimated —— 前端会显「直线估算」，
        // 免得用户以为自己改出来的路段和别的段一样可靠
        console.warn('[编辑] 这一段没取到真实路径，按直线估算：', error && error.message);
      }

      if (metrics) {
        allPaths.push(...metrics.paths);
      } else {
        anyEstimated = true;
        allPaths.push([a.coords, b.coords]);
      }

      fresh.push({
        id: `${day.id}-leg${i + 1}`,
        dayId: day.id,
        fromIndex: a.visitIndex,
        toIndex: b.visitIndex,
        from: a.poiId,
        to: b.poiId,
        primary: mode,
        modes: {
          [mode]: metrics
            ? { distance: Math.round(metrics.distance), duration: Math.round(metrics.duration) }
            : estimateLeg(a.coords, b.coords, mode)
        }
      });
    }

    ROUTES.legs = [...otherDays, ...fresh];

    // 刚取到的折线直接喂给地图那套缓存，别让它再取一遍。
    // 键必须和地图侧 legModes() 算的一致 —— 就是上面按顺序收集的 modes。
    if (window.TripRoute.seed) window.TripRoute.seed(day.id, modes, allPaths, anyEstimated);
    // 地图自己的缓存也要清：键按「天 + 方式组合」算，顺序变了而方式没变时
    // 键是一样的，不清就会把改动前的旧路径又画回来
    if (window.TripMap.clearCache) window.TripMap.clearCache();
  }

  function estimateLeg(a, b, mode) {
    const speed = (CFG.FALLBACK_SPEED && CFG.FALLBACK_SPEED[mode]) || 25;
    const distance = Math.round(haversine(a, b));
    return { distance, duration: Math.max(60, Math.round((distance / 1000 / speed) * 3600)), estimated: true };
  }

  /**
   * 存回 sessionStorage。
   *
   * 从当前全局量拼一份快照，而不是去改内存里那份 plan ——
   * 那份 plan 还带着美食、行前准备等编辑碰不到的内容，
   * 以它为底、把行程与路段覆盖上去，两边都不会丢。
   */
  function persist() {
    const base = (window.TripApp.currentPlan && window.TripApp.currentPlan()) || {};
    const plan = {
      ...base,
      schemaVersion: 1,
      generatedAt: base.generatedAt || new Date().toISOString(),
      city: CFG.TRIP.city,
      citycode: CFG.TRIP.cityCode,
      adcode: CFG.TRIP.adcode,
      startDate: CFG.TRIP.startDate,
      endDate: CFG.TRIP.endDate,
      days: ITIN.days,
      poi: POI,
      routes: ROUTES,
      warnings: base.warnings || []
    };
    window.TripPlanStore.save(plan);
  }

  /* ------------------------------------------------------------------ */
  /* 候选景点面板                                                        */
  /* ------------------------------------------------------------------ */

  let pickerDayIndex = -1;

  function openPicker(dayIndex) {
    pickerDayIndex = dayIndex;
    // 复用抽屉壳：遮罩、面板、关闭、Esc、焦点归位那一套已经写好了
    window.TripDrawer.open('add');
  }

  /** 备选：所有有坐标、又不在这一天的点。筛选 Agent 看中过的排前面 */
  function candidates(used) {
    return Object.values(POI)
      .filter((poi) => poi && poi.id && Array.isArray(poi.coords) && !used.has(poi.id))
      .sort((a, b) => {
        const rank = (p) => (p.picked ? 0 : 1);
        return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name), 'zh');
      });
  }

  function renderPicker() {
    const frag = document.createDocumentFragment();
    const day = ITIN.days[pickerDayIndex];
    if (!day) return frag;

    const used = new Set(day.visits.map((v) => v.poiId));

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'picker__search';
    search.placeholder = '按名字筛，例如「博物馆」';
    frag.append(search);

    const hint = el('p', 'picker__hint', '带「推荐」的是筛选 Agent 挑过的候选；其余是这次检索到、但没排进行程的。');
    frag.append(hint);

    const list = el('div', 'picker__list');
    frag.append(list);

    const paint = () => {
      const q = search.value.trim();
      const items = candidates(used).filter((poi) => !q || String(poi.name).includes(q));
      list.replaceChildren();

      if (!items.length) {
        list.append(el('p', 'picker__empty', q ? `没有名字含「${q}」的备选景点` : '这次检索到的点都已经排进行程了'));
        return;
      }
      items.slice(0, 60).forEach((poi) => list.append(pickerRow(poi, day, used)));
    };

    search.addEventListener('input', paint);
    paint();
    // 打开就能直接打字筛选
    requestAnimationFrame(() => search.focus());
    return frag;
  }

  function pickerRow(poi, day, used) {
    const row = el('button', 'picker__row');
    row.type = 'button';

    const head = el('div', 'picker__head');
    head.append(el('span', 'picker__name', poi.name));
    if (poi.picked) head.append(el('span', 'picker__tag', '推荐'));
    if (poi.kind && KIND_LABEL[poi.kind]) head.append(el('span', 'picker__kind', KIND_LABEL[poi.kind]));

    row.append(head);
    if (poi.address) row.append(el('div', 'picker__addr', poi.address));

    row.addEventListener('click', () => {
      addPoi(pickerDayIndex, poi.id);
      used.add(poi.id);
      // 不关面板：连着加几个是常态，关掉再打开太啰嗦
      row.disabled = true;
      row.classList.add('is-added');
      head.append(el('span', 'picker__tag is-added', '已加入'));
    });
    return row;
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  window.TripDrawer.register('add', {
    eyebrow: () => {
      const day = ITIN.days[pickerDayIndex];
      return day ? `加到 ${day.label} · ${day.title}` : '备选景点';
    },
    title: '可选景点',
    render: renderPicker
  });

  function init() {
    const btn = document.getElementById('edit-open');
    if (btn) btn.addEventListener('click', toggle);
    syncButton();
  }

  window.TripEditor = { init, isOn, context, toggle };
})();
