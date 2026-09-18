/* ============================================================
   规划表单的共用件：首页抽屉与行程页弹层都用这一份

   只放「两边一模一样」的那点逻辑。字段 id 两个页面不同，所以这里
   一律接元素而不是接 id —— 谁调用谁负责找到自己的节点。
   ============================================================ */

(function () {
  'use strict';

  /**
   * 画「共 N 天 + N 个色块」。
   *
   * 天数不手填，由起止日期算（TripDate.tripDays）；顺手把每天的颜色摊开，
   * 长行程一眼就能看出配色够不够用。色块取的是 config.js 里当天真实的主题色。
   *
   * @param {HTMLElement} host 提示容器
   * @param {HTMLInputElement} startEl
   * @param {HTMLInputElement} endEl
   */
  function renderDaysHint(host, startEl, endEl) {
    if (!host) return;

    const start = startEl.value;
    const end = endEl.value;
    const days = window.TripDate.tripDays(start, end);

    if (days == null) {
      host.replaceChildren(text('span', 'dayhint__bad', '结束日期要等于或晚于开始日期'));
      return;
    }

    const chips = document.createElement('span');
    chips.className = 'dayhint__chips';
    for (let i = 0; i < days; i++) {
      const chip = document.createElement('i');
      chip.style.background = window.TRIP_CONFIG.dayHue(i);
      chip.title = `第 ${i + 1} 天`;
      chips.append(chip);
    }

    host.replaceChildren(
      text('span', 'dayhint__range num', `${start} — ${end}`),
      text('span', 'dayhint__count', `共 ${days} 天`),
      chips
    );
  }

  /** 选项组（radio / checkbox）的选中值，按表单里的顺序返回 */
  function checkedValues(form, name) {
    return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((el) => el.value);
  }

  /** 原生控件初始为未选中，`fillDefaults` 只在空表单上补默认值，别覆盖用户的选择 */
  function text(tag, className, content) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = content;
    return node;
  }

  window.TripPlanForm = { renderDaysHint, checkedValues };
})();
