/* ============================================================
   首页编排：CTA → 表单抽屉 → 调规划接口 → 交给 trip.html

   首页只做编排，别的都分出去了：
     · 底图与墨绘  → hero-map.js / hero-ink.js
     · 表单共用件  → plan-form.js
     · 跨页交接    → plan-store.js
   ============================================================ */

(function () {
  'use strict';

  const CFG = window.TRIP_CONFIG;

  const stage = document.getElementById('stage');
  const sheet = document.getElementById('plan-sheet');
  const form = document.getElementById('plan-form');
  const status = document.getElementById('plan-status');
  const submit = document.getElementById('plan-submit');
  const cta = document.getElementById('cta-start');
  const pipeline = document.getElementById('pipeline');

  if (!sheet || !form || !cta) return;

  const fields = {
    city: document.getElementById('plan-city'),
    startDate: document.getElementById('plan-start'),
    endDate: document.getElementById('plan-end'),
    pace: document.getElementById('plan-pace'),
    budget: document.getElementById('plan-budget'),
    interests: document.getElementById('plan-interests'),
    notes: document.getElementById('plan-notes')
  };
  const daysHint = document.getElementById('plan-days-hint');

  /** 顺序必须与 tools/sse.js 的 STAGES 一致，两边靠 id 对应 */
  const STAGE_LABELS = {
    discover: '检索 POI',
    select: '筛选候选',
    schedule: '排程',
    review: '审校',
    routes: '高德算路',
    food: '当地美食',
    prep: '行前准备'
  };
  const STAGES = window.TripPlanClient.STAGES.map((key) => ({ key, label: STAGE_LABELS[key] }));

  // 阶段序号用中文数字。数量必须跟得上 STAGES —— 少一个就会渲染成 undefined
  const NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八'];

  /**
   * 并行跑的阶段：同一组里的几条是同时开始的，管线上要画成一个分叉。
   *
   * 这不是装饰。服务端 `plan()` 最后是 `Promise.all([runFood(), runPrep()])`，
   * 画成七个依次排列的节点，等于在说假话。
   * 那边一改并行、这边不改，两边就对不上了。
   */
  const PARALLEL_GROUPS = [['food', 'prep']];

  /* ------------------------------------------------------------------ */
  /* 阶段管线                                                            */
  /* ------------------------------------------------------------------ */

  function stageNode(stage, numeral, animIndex) {
    const node = document.createElement('div');
    node.className = 'pipeline__item';
    node.setAttribute('role', 'listitem');
    node.dataset.stage = stage.key;
    node.style.setProperty('--i', animIndex);

    const num = document.createElement('span');
    num.className = 'pipeline__num';
    num.textContent = numeral;

    const label = document.createElement('span');
    label.className = 'pipeline__label';
    label.textContent = stage.label;

    node.append(num, label);
    return node;
  }

  /**
   * 一个分叉：组里的阶段并排画成上下两行，共用一个左侧括号、标上「并行」。
   * 两行的错峰序号故意取自同一个值 —— 不提交时的循环动画也因此会同时亮，
   * 把「它们是同时发生的」这件事在动效里也说一遍。
   */
  function forkNode(stages, numeralFrom, animIndex) {
    const fork = document.createElement('div');
    fork.className = 'pipeline__fork';
    fork.title = '这两个阶段同时开始';

    const mark = document.createElement('span');
    mark.className = 'pipeline__fork-label';
    mark.textContent = '并行';

    const rows = document.createElement('div');
    rows.className = 'pipeline__branches';
    stages.forEach((stage, i) => {
      const node = stageNode(stage, NUMERALS[numeralFrom + i], animIndex);
      // 分叉里的两行不做等分、不带内边距，样式上需要和主序列区分开
      node.classList.add('is-branch');
      rows.append(node);
    });

    fork.append(mark, rows);
    return fork;
  }

  function renderPipeline() {
    const caption = document.createElement('span');
    caption.className = 'pipeline__caption';
    caption.textContent = '工作方式';

    const nodes = [caption];
    let anim = 0;

    for (let i = 0; i < STAGES.length; ) {
      const group = PARALLEL_GROUPS.find((keys) => keys[0] === STAGES[i].key);
      if (!group) {
        nodes.push(stageNode(STAGES[i], NUMERALS[i], anim++));
        i += 1;
        continue;
      }
      const members = group.map((key) => STAGES.find((s) => s.key === key)).filter(Boolean);
      nodes.push(forkNode(members, i, anim));
      anim += 1;
      i += group.length;
    }

    pipeline.replaceChildren(...nodes);
  }

  /* ------------------------------------------------------------------ */
  /* 抽屉开关                                                            */
  /* ------------------------------------------------------------------ */

  let lastFocus = null;

  /**
   * 抽屉开合时主视觉要让位或复位。
   *
   * 让位是 CSS 做的（.landing.is-sheet-open .stage 收窄），但底图与墨绘
   * 都是按像素定位的，必须等收窄的过渡走完再重新取景，否则量到的是
   * 过渡中间那个宽度，墨线会偏。380ms 比 CSS 里的 340ms 略长一点。
   */
  let refitTimer = 0;

  function syncStage(sheetOpen) {
    document.body.classList.toggle('is-sheet-open', sheetOpen);
    window.clearTimeout(refitTimer);
    refitTimer = window.setTimeout(() => {
      if (window.TripHeroMap && window.TripHeroMap.refit) window.TripHeroMap.refit();
    }, 380);
  }

  function open() {
    lastFocus = document.activeElement;
    fillDefaults();
    sheet.hidden = false;
    cta.setAttribute('aria-expanded', 'true');
    syncStage(true);
    fields.city.focus();
  }

  function close() {
    sheet.hidden = true;
    cta.setAttribute('aria-expanded', 'false');
    syncStage(false);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /**
   * 默认日期取两周后出发、玩四天。
   * 直接留空会逼用户从零选，而默认填上示例行程的日期又会让人以为只能那个日子走。
   */
  function fillDefaults() {
    if (fields.city.value) return;
    const { addDays, today } = window.TripDate;
    fields.city.value = '';
    fields.startDate.value = addDays(today(), 14);
    fields.endDate.value = addDays(today(), 17);
    renderDaysHint();
  }

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  }

  function renderDaysHint() {
    window.TripPlanForm.renderDaysHint(daysHint, fields.startDate, fields.endDate);
  }

  /* ------------------------------------------------------------------ */
  /* 选好城市就把地图飞过去                                               */
  /* ------------------------------------------------------------------ */

  /** 上一次已经飞过的城市名，避免同一座城反复请求 */
  let flownCity = '';
  let cityTimer = 0;

  function resolveCityCenter(city) {
    const url = new URL('/api/amap', location.href);
    url.searchParams.set('p', '/v3/geocode/geo');
    url.searchParams.set('address', city);
    return fetch(url, { signal: AbortSignal.timeout(6000) })
      .then((res) => res.json())
      .then((body) => {
        const geo = body && body.geocodes && body.geocodes[0];
        const point = String((geo && geo.location) || '').split(',').map(Number);
        return point.length === 2 && point.every(Number.isFinite) ? point : null;
      });
  }

  /**
   * 表单里一选定城市就把底图飞过去。
   * 用 change 而不是 input：input 每敲一个字都会触发，
   * 「武汉」两个字会先查「武」再查「武汉」，既费配额又闪。
   */
  function onCityChange() {
    const city = fields.city.value.trim();
    if (!city || city === flownCity) return;
    window.clearTimeout(cityTimer);
    // 打字停下再查，免得中途几个半截词各发一次
    cityTimer = window.setTimeout(() => {
      resolveCityCenter(city)
        .then((coords) => {
          if (!coords) return;
          flownCity = city;
          if (window.TripHeroMap && window.TripHeroMap.flyToCity) window.TripHeroMap.flyToCity(coords);
          // 地图换城市了，演示用的那批武汉地标必须撤掉
          if (window.TripHeroInk && window.TripHeroInk.clearDemo) window.TripHeroInk.clearDemo();
        })
        .catch((error) => console.warn('[首页] 城市定位失败，地图停在原处：', error && error.message));
    }, 420);
  }

  /* ------------------------------------------------------------------ */
  /* 提交                                                                */
  /* ------------------------------------------------------------------ */

  function requestBody() {
    const days = window.TripDate.tripDays(fields.startDate.value, fields.endDate.value);
    if (days == null) throw new Error('结束日期要等于或晚于开始日期');

    const pick = (name) => window.TripPlanForm.checkedValues(form, name);
    return {
      city: fields.city.value.trim(),
      days,
      startDate: fields.startDate.value,
      endDate: fields.endDate.value,
      party: pick('party')[0] || '',
      styles: pick('styles'),
      timing: pick('timing'),
      interests: fields.interests.value,
      notes: fields.notes.value,
      pace: fields.pace.value,
      budget: fields.budget.value
    };
  }

  /* ---------------- 真实阶段进度 ---------------- */

  /**
   * 按事件点亮某个节点。
   *
   * 只动这一个节点，不做「它之前的都算完成」的推断 ——
   * 美食与行前准备是并行跑的，靠位置推断会把还在跑的节点误标成已完成。
   */
  function markStage(id, state) {
    const node = pipeline.querySelector(`.pipeline__item[data-stage="${id}"]`);
    if (!node) return;

    if (state === 'start') {
      node.classList.remove('is-done', 'is-skipped');
      node.classList.add('is-active');
      return;
    }

    // skipped 与 done 都要落地：跳过 ≠ 完成，样式上另有区分
    node.classList.remove('is-active');
    node.classList.add('is-done');
    node.classList.toggle('is-skipped', state === 'skipped');
  }

  /** 退化成一次性结果时用：整体点亮，不伪造逐节点耗时 */
  function markAllDone() {
    pipeline.querySelectorAll('.pipeline__item').forEach((li) => {
      li.classList.remove('is-active', 'is-skipped');
      li.classList.add('is-done');
    });
  }

  /**
   * 已等待秒数。
   * 这不是装饰：拿不到逐阶段进度时（线上很可能被缓冲成一次性），
   * 界面必须让等待看起来是「活着」的，否则几十秒的一动不动会被当成卡死。
   */
  let ticker = 0;

  function startTicker(note) {
    const t0 = Date.now();
    window.clearInterval(ticker);
    ticker = window.setInterval(() => {
      const sec = Math.round((Date.now() - t0) / 1000);
      setStatus(`${note} · 已等待 ${sec} 秒`);
    }, 1000);
    setStatus(`${note} · 已等待 0 秒`);
  }

  function stopTicker() {
    window.clearInterval(ticker);
    ticker = 0;
  }

  async function generate(event) {
    event.preventDefault();
    submit.classList.add('is-loading');
    pipeline.classList.add('is-live');
    pipeline.querySelectorAll('.pipeline__item').forEach((li) =>
      li.classList.remove('is-active', 'is-done', 'is-skipped')
    );
    // 不清墨迹：discover 一开始墨绘层自己会切到 live 并清空。
    // 在这里先 reset 反而会闪一下演示用的武汉地标。

    try {
      const result = await window.TripPlanClient.generate(requestBody(), {
        onOpen: ({ streaming }) => {
          if (streaming) startTicker('六个 Agent 正在接力');
          // 没有流式就明说没有实时进度，别拿「已等待」冒充进度
          else startTicker('正在规划（该环境没有实时进度）');
        },
        onStage: (ev) => {
          if (!ev || !ev.stage) return;
          if (ev.status === 'start') markStage(ev.stage, 'start');
          else if (ev.status === 'done') markStage(ev.stage, 'done');
          else if (ev.status === 'skipped') markStage(ev.stage, 'skipped');
          // 公交段的路径要按城市算，先把服务端解析出的编码换上 ——
          // 否则首页会拿武汉的 027 去算别的城市的公交
          if (ev.stage === 'discover' && ev.status === 'done' && ev.detail && ev.detail.citycode) {
            CFG.TRIP.cityCode = ev.detail.citycode;
          }
          // 同一条事件也交给墨绘层：左边那张图就是这一步步画出来的
          if (window.TripHeroInk && window.TripHeroInk.stage) window.TripHeroInk.stage(ev);
          // 检索结果落下来后，视野要从「整座城」飞向这批点所在的范围
          if (ev.stage === 'discover' && ev.status === 'done' && window.TripHeroMap) {
            window.TripHeroMap.refit({ animate: true });
          }
        }
      });

      stopTicker();
      if (!result.streamed) markAllDone();

      if (!window.TripPlanStore.save(result.plan)) {
        throw new Error('这份行程没能存进浏览器，无法带到下一页。请检查是否处于隐私模式。');
      }
      setStatus(`已生成 ${result.plan.days.length} 天行程，正在打开…`);

      // 先收成一张纸再走：首页是暖化的淡墨纸、行程页是中性底图，
      // 硬切一刀会像换了个网站。等纸面盖住再跳，读起来就是「翻过一页」。
      window.TripPlanStore.markEntering();
      document.body.classList.add('is-leaving');
      window.setTimeout(() => { window.location.href = 'trip.html'; }, 340);
    } catch (error) {
      stopTicker();
      pipeline.classList.remove('is-live');
      setStatus(error && error.message ? error.message : '规划失败，请稍后重试', true);
      submit.classList.remove('is-loading');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 绑定                                                                */
  /* ------------------------------------------------------------------ */

  renderPipeline();

  cta.addEventListener('click', open);
  document.getElementById('sheet-close').addEventListener('click', close);
  form.addEventListener('submit', generate);
  fields.startDate.addEventListener('input', renderDaysHint);
  fields.endDate.addEventListener('input', renderDaysHint);
  fields.city.addEventListener('change', onCityChange);

  // 点抽屉以外的地方收起它。CTA 自己会开抽屉，别被这条顺手关掉。
  document.addEventListener('click', (event) => {
    if (sheet.hidden || sheet.contains(event.target) || cta.contains(event.target)) return;
    close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || sheet.hidden) return;
    // 原生日期选择器弹出时 Esc 是关它，不该顺带把抽屉也收了
    if (event.target.matches('input[type="date"]')) return;
    close();
  });

  // Esc 之外的收起路径都走 close()，这里只兜住「抽屉自己变了 hidden」的情况
  // （比如将来某个分支直接改 hidden）。让位状态必须跟着 hidden 走，不能各管各的。
  const observer = new MutationObserver(() => syncStage(!sheet.hidden));
  observer.observe(sheet, { attributes: true, attributeFilter: ['hidden'] });
})();
