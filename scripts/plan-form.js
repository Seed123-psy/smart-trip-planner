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

  function hotelPicker(form, city) {
    const box = document.createElement('fieldset');
    box.className = 'hotel-picker';
    box.innerHTML = '<legend>已订酒店（可选）</legend><p>选好具体分店，把每天出发和回酒店的路程一起算进去。</p><label>酒店名称<input type="search" maxlength="80" placeholder="例如：酒店名称 + 分店"></label><button type="button">搜索酒店</button><p role="status" aria-live="polite"></p><div class="hotel-picker__results"></div><button type="button" hidden>取消酒店选择</button><div class="hotel-picker__times" hidden><label>每天从酒店出发<input type="time" value="09:00"></label><label>最晚回到酒店<input type="time" value="21:00"></label><p>适用于全程住同一酒店。抵离接驳、入住及中午回酒店暂不自动安排。</p></div>';
    form.querySelector('textarea[name="notes"]').closest('label').before(box);
    const keyword = box.querySelector('input[type="search"]');
    const [search, clear] = box.querySelectorAll('button');
    const status = box.querySelector('[role="status"]');
    const results = box.querySelector('.hotel-picker__results');
    const times = box.querySelector('.hotel-picker__times');
    const [departure, returnBy] = times.querySelectorAll('input');
    let selected = null;
    let version = 0;
    function reset() {
      version++;
      selected = null;
      clear.hidden = times.hidden = true;
      results.replaceChildren();
      status.textContent = '';
      search.disabled = false;
    }
    city.addEventListener('input', reset);
    city.addEventListener('change', reset);
    keyword.addEventListener('input', reset);
    keyword.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!search.disabled) search.click();
      }
    });
    clear.addEventListener('click', reset);
    search.addEventListener('click', async () => {
      reset();
      if (!city.value.trim() || keyword.value.trim().length < 2) {
        status.textContent = '先填写目的地和至少两个字的酒店名称。';
        return;
      }
      const token = version;
      const cityValue = city.value;
      status.textContent = '正在查找酒店…';
      search.disabled = true;
      try {
        const response = await fetch(`/api/hotels?${new URLSearchParams({ city: cityValue.trim(), keyword: keyword.value.trim() })}`, { signal: AbortSignal.timeout(12000) });
        const body = await response.json();
        if (token !== version || city.value !== cityValue) return;
        if (!response.ok) throw new Error(body.error || '酒店查询失败');
        const hotels = Array.isArray(body.hotels) ? body.hotels : [];
        status.textContent = hotels.length ? '请核对地址，选择你预订的分店。' : '没有找到，试试酒店全名或附近地标。也可以不选酒店继续规划。';
        for (const hotel of hotels) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = `${hotel.name} · ${hotel.address || hotel.city}`;
          button.addEventListener('click', () => {
            selected = { ...hotel, selectedCity: city.value };
            status.textContent = `已选择：${hotel.name} · ${hotel.address || hotel.city}`;
            results.replaceChildren();
            clear.hidden = times.hidden = false;
          });
          results.append(button);
        }
      } catch (error) {
        if (token === version) status.textContent = `${error.name === 'TimeoutError' ? '搜索超时，请重试' : error.message}。也可以不选酒店继续规划。`;
      } finally { if (token === version) search.disabled = false; }
    });
    return () => {
      if (!selected || selected.selectedCity !== city.value) return null;
      if (!departure.value || !returnBy.value || departure.value >= returnBy.value) throw new Error('回酒店时间需要晚于出发时间');
      return { amapId: selected.amapId, departure: departure.value, returnBy: returnBy.value };
    };
  }

  window.TripPlanForm = { renderDaysHint, checkedValues, hotelPicker };
})();
