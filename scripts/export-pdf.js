/* ============================================================
   导出 PDF：走浏览器打印，不引任何库

   【为什么是打印而不是生成 .pdf】
   生成文件只有两条路：引入 jsPDF + html2canvas（约 350KB，且结果是**图片型** ——
   文字不能选中也不能搜索，地图还可能截成空白），或者服务端跑一个 Chromium
   （几百 MB 的依赖，与这个项目的体量完全不相称）。
   浏览器打印是零依赖的那条：文字是矢量的、中文用系统字体直接渲染、
   分页与页边距交给浏览器 —— 而那些恰恰是它做得最熟的事。

   【地图为什么是静态图】
   页面上那张是 canvas，打印时多半一片空白。所以打印版面用的是
   /api/staticmap 渲染好的 PNG：路线由服务端按当天的几何重画一遍，
   和用户导出时地图停在哪个视野无关。代价是它带地名标注与高德水印 ——
   后者是使用条款要求的，不能去掉。

   【版面为什么单独造一份】
   行程页是「一次显示一天、其余靠交互切换」，而 PDF 要一次看全。
   与其用打印样式去展开页面上那些被折叠或隐藏的节点（还得跟交互状态打架），
   不如按数据重建一份只读版面。时间轴那部分直接复用 TripTimeline.renderDay ——
   传 edit: null 就是纯展示，不必再写一套渲染。
   ============================================================ */

(function () {
  'use strict';

  const SHEET_ID = 'print-sheet';

  const btn = document.getElementById('export-open');
  if (!btn) return;

  /* ------------------------------------------------------------------ */
  /* 小工具                                                              */
  /* ------------------------------------------------------------------ */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** #b07510 → 0xB07510：高德静态地图的颜色写法 */
  function amapColor(cssHex) {
    const hex = String(cssHex || '').replace(/^#/, '');
    return /^[0-9a-fA-F]{6}$/.test(hex) ? `0x${hex.toUpperCase()}` : '0x333333';
  }

  function config() {
    return window.TRIP_CONFIG || {};
  }

  function itinerary() {
    return window.TRIP_ITINERARY || { days: [] };
  }

  function prep() {
    return window.TRIP_PREP || null;
  }

  /** 2026-10-03 → 2026.10.03 */
  function dotted(date) {
    return String(date || '').replace(/-/g, '.');
  }

  /**
   * formatDistance 返回的是 {value, unit} —— 页面上要把数字和单位分开上样式，
   * 而纸上没有那种对齐需要，拼成一整串就行。
   * （formatDuration 返回的已经是字符串，不用包。）
   */
  function distText(meters) {
    const T = window.TripTimeline;
    if (!T || !T.formatDistance) return '—';
    const d = T.formatDistance(meters);
    return d.unit ? `${d.value} ${d.unit}` : String(d.value);
  }

  /* ------------------------------------------------------------------ */
  /* 版面                                                                */
  /* ------------------------------------------------------------------ */

  function buildCover(days) {
    const cover = el('header', 'sheet__cover');

    /* 城市名优先读页面上那个 #city —— 它是 app.js 按「当前这份行程」渲染的，
       规划到别的城市时它已经被换掉了。退回配置里的默认值只在页面异常时发生。 */
    const cityEl = document.getElementById('city');
    const cityName =
      (cityEl && cityEl.textContent.trim()) ||
      (config().TRIP && config().TRIP.city) ||
      '行程';

    const city = el('h1', 'sheet__city', cityName);
    cover.append(el('p', 'sheet__eyebrow', '行程手账'));
    cover.append(city);

    if (days.length) {
      const from = dotted(days[0].date);
      const to = dotted(days[days.length - 1].date);
      // 同一天出发与返程的话没必要写两遍
      cover.append(el('p', 'sheet__dates', from === to ? from : `${from} — ${to}`));
    }

    /* 总计：把每天的统计加起来。
       用 TripTimeline.dayTotals 而不是自己遍历 legs —— 那个函数已经处理了
       「哪些点算进行程」（resolveStops）与「取主方式还是备选」，是同一套口径。 */
    const T = window.TripTimeline;
    if (T && T.dayTotals && days.length) {
      const all = days.map(T.dayTotals);
      const stats = el('ul', 'sheet__stats');
      const item = (value, label) => {
        const li = el('li');
        li.append(el('b', null, value), document.createTextNode(label));
        return li;
      };
      stats.append(item(String(days.length), ' 天'));
      stats.append(item(String(all.reduce((s, t) => s + t.stops, 0)), ' 个行程点'));
      stats.append(item(distText(all.reduce((s, t) => s + t.distance, 0)), ' 总里程'));
      stats.append(item(T.formatDuration(all.reduce((s, t) => s + t.duration, 0)), ' 在途'));
      cover.append(stats);
    }

    return cover;
  }

  function buildDay(day, index) {
    const section = el('section', 'sheet__day');
    section.style.setProperty('--day-hue', config().dayHue ? config().dayHue(index) : '#333');

    const head = el('div', 'sheet__dayhead');
    head.append(el('span', 'sheet__daynum', day.label || `Day ${index + 1}`));

    const titleWrap = el('div', 'sheet__daytitle');
    titleWrap.append(el('h2', null, day.title || ''));

    const meta = [];
    if (day.dateText) meta.push(day.dateText);

    const T = window.TripTimeline;
    if (T && T.dayTotals) {
      const t = T.dayTotals(day);
      meta.push(`${t.stops} 个点`);
      meta.push(distText(t.distance));
      meta.push(T.formatDuration(t.duration));
    }
    if (meta.length) titleWrap.append(el('p', 'sheet__daymeta', meta.join(' · ')));

    head.append(titleWrap);
    section.append(head);

    if (day.summary) section.append(el('p', 'sheet__daysum', day.summary));

    // 路线图：服务端渲染的静态图，颜色跟当天主题色走
    const figure = el('figure', 'sheet__map');
    const img = el('img');
    img.src = `/api/staticmap?day=${index}&w=900&h=480&color=${amapColor(
      config().dayHue ? config().dayHue(index) : '#333333'
    )}`;
    img.alt = `${day.title || ''} 路线图`;
    img.loading = 'eager';
    figure.append(img);
    section.append(figure);

    // 时间轴：复用行程页那套渲染，edit 传 null 就是纯展示
    const timeline = el('div', 'sheet__timeline');
    if (T && T.renderDay) {
      const { fragment } = T.renderDay({ day, edit: null });
      timeline.append(fragment);
    }
    section.append(timeline);

    return section;
  }

  function buildPrep() {
    const P = prep();
    if (!P) return null;

    const section = el('section', 'sheet__prep');
    section.append(el('h2', null, '行前准备'));

    const grid = el('div', 'sheet__prepgrid');

    const block = (title, node) => {
      if (!node) return;
      const box = el('div', 'sheet__prepblock');
      box.append(el('h3', null, title));
      box.append(node);
      grid.append(box);
    };

    // 待预约：只列 must 的 —— optional 不标，免得让人以为不约就进不去
    // （与行程页抽屉同一条口径）
    if (Array.isArray(P.bookings) && P.bookings.length) {
      const list = el('ul', 'sheet__list');
      P.bookings.forEach((b) => {
        const li = el('li');
        li.append(el('b', null, b.channel || b.poiId));
        if (b.release || b.advance) {
          const when = [];
          if (b.advance) when.push(`提前 ${b.advance} 天`);
          if (b.release) when.push(`${b.release} 放票`);
          li.append(el('span', 'sheet__note', when.join(' · ')));
        }
        if (b.note) li.append(el('span', 'sheet__note', b.note));
        list.append(li);
      });
      block('待预约', list);
    }

    if (P.transport && (P.transport.summary || (P.transport.points || []).length)) {
      const box = el('div');
      if (P.transport.summary) box.append(el('p', 'sheet__note', P.transport.summary));
      if (Array.isArray(P.transport.points) && P.transport.points.length) {
        const list = el('ul', 'sheet__list');
        P.transport.points.forEach((p) => list.append(el('li', null, p)));
        box.append(list);
      }
      block('交通结论', box);
    }

    if (Array.isArray(P.packing) && P.packing.length) {
      const box = el('div');
      P.packing.forEach((g) => {
        box.append(el('p', 'sheet__group', g.group || ''));
        const list = el('ul', 'sheet__list');
        (g.items || []).forEach((item) => list.append(el('li', null, item)));
        box.append(list);
      });
      block('必带物品', box);
    }

    if (Array.isArray(P.emergency) && P.emergency.length) {
      const list = el('ul', 'sheet__list');
      P.emergency.forEach((e) => {
        const li = el('li');
        li.append(el('b', null, e.label || ''));
        if (e.value) li.append(el('span', 'sheet__note', e.value));
        if (e.note) li.append(el('span', 'sheet__note', e.note));
        list.append(li);
      });
      block('实用信息', list);
    }

    section.append(grid);
    return grid.childElementCount ? section : null;
  }

  /* ------------------------------------------------------------------ */

  function buildSheet() {
    const old = document.getElementById(SHEET_ID);
    if (old) old.remove();

    const sheet = el('article', 'sheet');
    sheet.id = SHEET_ID;

    const days = itinerary().days || [];
    sheet.append(buildCover(days));
    days.forEach((day, i) => sheet.append(buildDay(day, i)));

    const prepSection = buildPrep();
    if (prepSection) sheet.append(prepSection);

    document.body.append(sheet);
    return sheet;
  }

  /**
   * 等版面里所有图片就绪。
   *
   * **这一步不能省**：静态地图是异步取回来的，不等就 print 的话
   * 打印预览里图的位置是空的 —— 而用户多半直接点了保存，
   * 拿到一份没有地图的 PDF，还以为功能就是这样。
   * 失败也要放行（resolve 而不是 reject）：一张图没取到不该让整次导出卡死，
   * 缺图的那天至少还有时间轴。
   */
  function waitImages(sheet) {
    const images = [...sheet.querySelectorAll('img')];
    return Promise.all(
      images.map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
            })
      )
    );
  }

  let busy = false;

  async function run() {
    if (busy) return;
    busy = true;
    btn.disabled = true;

    const label = btn.querySelector('span');
    const original = label ? label.textContent : '';
    if (label) label.textContent = '正在生成…';

    try {
      const sheet = buildSheet();
      await waitImages(sheet);
      /* 打印是同步阻塞的（对话框弹出后 JS 就停在那一行），
         所以按钮状态要在调它之前恢复好，否则用户取消打印回来，
         会看到一个永远停在「正在生成…」的按钮。 */
      if (label) label.textContent = original;
      btn.disabled = false;
      busy = false;

      window.print();
    } catch (error) {
      console.error('[导出] 生成打印版面失败：', error);
      if (label) label.textContent = original;
      btn.disabled = false;
      busy = false;
      const notice = document.getElementById('notice');
      if (notice) {
        notice.textContent = `导出失败：${error && error.message ? error.message : '未知错误'}`;
        notice.hidden = false;
      }
    } finally {
      // 版面留着不删：用户在打印对话框里可能先取消、再点一次，
      // 重建一遍意味着重新取四张静态地图。下次导出会整份重建。
    }
  }

  /**
   * 只构建版面、等图片就绪，不调 print。
   * 给无头浏览器生成 PDF 用 —— 那条路上没有人去点按钮，
   * 而 --print-to-pdf 会自己按打印样式输出，不需要事先弹对话框。
   */
  async function prepare() {
    const sheet = buildSheet();
    await waitImages(sheet);
    return sheet;
  }

  btn.addEventListener('click', run);

  /* ?export=1 时自动构建。
     这是给命令行生成 PDF 留的口子：
       chrome --headless --print-to-pdf=... "trip.html?export=1"
     页面脚本跑完时 DOM 已经就绪（脚本在 body 末尾），所以直接起。 */
  if (/[?&]export=1/.test(location.search)) {
    prepare().catch((error) => console.error('[导出] 预构建打印版面失败：', error));
  }

  // 给自动化检查留一个入口，与 TripMap.getMap 同一作法
  window.TripExport = { buildSheet, prepare, run };
})();
