/* ============================================================
   AI 行程规划：表单 -> /api/plan -> 结构化行程 -> 现有时间轴/地图
   ============================================================ */

(function () {
  'use strict';

  const CFG = window.TRIP_CONFIG;
  const panel = document.getElementById('planner');
  const form = document.getElementById('planner-form');
  const status = document.getElementById('planner-status');
  const result = document.getElementById('planner-result');
  const submit = form && form.querySelector('.planner__submit');

  if (!panel || !form || !submit) return;

  const fields = {
    city: document.getElementById('planner-city'),
    startDate: document.getElementById('planner-start'),
    endDate: document.getElementById('planner-end'),
    interests: document.getElementById('planner-interests'),
    notes: document.getElementById('planner-notes'),
    pace: document.getElementById('planner-pace'),
    budget: document.getElementById('planner-budget')
  };

  /** 选项组取值与首页共用，见 scripts/plan-form.js */
  const checkedValues = (name) => window.TripPlanForm.checkedValues(form, name);
  /** 随日期实时更新的「共 N 天 + N 个色块」提示 */
  const daysHint = document.getElementById('planner-days-hint');
  const selectedHotel = window.TripPlanForm.hotelPicker(form, fields.city);

  /** 当前表单所选的天数；日期不合法或终点早于起点时为 null */
  function selectedDays() {
    return window.TripDate.tripDays(fields.startDate.value, fields.endDate.value);
  }

  function open() {
    panel.hidden = false;
    fields.city.focus();
  }

  function close() {
    panel.hidden = true;
  }

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  }

  function fillDefaults() {
    fields.city.value = CFG.TRIP.city || '武汉';
    fields.startDate.value = CFG.TRIP.startDate || '';
    fields.endDate.value = CFG.TRIP.endDate || '';
    renderDaysHint();
  }

  /** 天数提示的绘制与首页共用，见 scripts/plan-form.js */
  function renderDaysHint() {
    window.TripPlanForm.renderDaysHint(daysHint, fields.startDate, fields.endDate);
  }

  function requestBody() {
    const days = selectedDays();
    if (days == null) throw new Error('结束日期要等于或晚于开始日期');
    // 天数由日期派生，前端算一次只是为了即时提示；服务端同样会按日期重算并钳制上限
    return {
      city: fields.city.value,
      days,
      startDate: fields.startDate.value,
      endDate: fields.endDate.value,
      // 旅行偏好是单选，取第一个；风格与时间安排可多选
      party: checkedValues('party')[0] || '',
      styles: checkedValues('styles'),
      timing: checkedValues('timing'),
      interests: fields.interests.value,
      notes: fields.notes.value,
      hotel: selectedHotel(),
      pace: fields.pace.value,
      budget: fields.budget.value
    };
  }

  /**
   * 结果摘要用 DOM 拼而不是拼 HTML 串：
   * day.title 来自模型输出（并受用户填的兴趣、高德 POI 名称影响），
   * 服务端只做长度裁剪不做转义，走 innerHTML 就等于把模型输出当代码执行。
   */
  function showResult(plan) {
    const warningCount = Array.isArray(plan.warnings) ? plan.warnings.length : 0;

    const head = document.createElement('strong');
    head.textContent = `已生成 ${plan.days.length} 天行程`;

    result.replaceChildren(head, document.createTextNode(` · ${plan.days.map((day) => day.title).join(' · ')}`));

    if (warningCount) {
      result.append(document.createElement('br'), document.createTextNode(`有 ${warningCount} 条信息需要出发前再确认。`));
    }
    result.hidden = false;
  }

  /** 与首页管线同一套阶段名，只是这里没有节点可点，就写成一行字 */
  const STAGE_TEXT = {
    discover: '正在检索地点',
    select: '正在筛选候选',
    schedule: '正在排程',
    review: '正在审校',
    routes: '正在逐段算路'
  };

  /**
   * 等待期间持续刷新「已等待 N 秒」。
   * 拿不到逐阶段事件时（线上可能被缓冲成一次性），这行字是界面上
   * 唯一能说明「它还活着」的东西 —— 否则几十秒的一动不动会被当成卡死。
   */
  let ticker = 0;
  let currentNote = '正在规划';

  function stopTicker() {
    window.clearInterval(ticker);
    ticker = 0;
  }

  function startTicker(t0) {
    window.clearInterval(ticker);
    const paint = () => setStatus(`${currentNote}… 已等待 ${Math.round((Date.now() - t0) / 1000)} 秒`);
    paint();
    ticker = window.setInterval(paint, 1000);
  }

  async function generate(event) {
    event.preventDefault();
    submit.classList.add('is-loading');
    result.hidden = true;
    currentNote = '正在规划';
    const t0 = Date.now();

    try {
      const out = await window.TripPlanClient.generate(requestBody(), {
        onOpen: () => startTicker(t0),
        onStage: (ev) => {
          if (ev.status === 'start' && STAGE_TEXT[ev.stage]) {
            currentNote = STAGE_TEXT[ev.stage];
          } else if (ev.status === 'skipped') {
            currentNote = '审校已跳过（时间预算不足）';
          }
        }
      });

      stopTicker();
      await window.TripApp.applyGeneratedPlan(out.plan);
      showResult(out.plan);
      setStatus('行程已更新');
      window.setTimeout(close, 900);
    } catch (error) {
      stopTicker();
      setStatus(error && error.message ? error.message : '规划失败，请稍后重试', true);
    } finally {
      submit.classList.remove('is-loading');
    }
  }

  document.getElementById('planner-open').addEventListener('click', () => {
    fillDefaults();
    open();
  });
  document.getElementById('planner-close').addEventListener('click', close);
  // 天数与配色都跟着日期走，改日期要立刻反映出来
  fields.startDate.addEventListener('input', renderDaysHint);
  fields.endDate.addEventListener('input', renderDaysHint);
  panel.addEventListener('click', (event) => {
    if (event.target === panel) close();
  });
  form.addEventListener('submit', generate);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) close();
  });
})();
