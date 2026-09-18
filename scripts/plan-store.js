/* ============================================================
   行程交接层：首页规划好的行程经由 sessionStorage 交给 trip.html

   为什么用 sessionStorage 而不是 localStorage：
   行程是「这一次打开站点」的临时状态，不该在关掉标签页后还赖着不走；
   sessionStorage 天然是「同标签页刷新保留、关掉即清」，正好对上。
   点「首页」重新规划时会被新行程覆盖，想回看内置的武汉行程走首页的示例入口。

   校验放在读取端而不是写入端：写入端是自己人，读取端面对的是
   可能被别处写脏、或被旧版本残留污染的数据。任何一条不合格就整份丢弃、
   顺手删掉，否则每次加载都会重复报同一个错。
   ============================================================ */

(function () {
  'use strict';

  /** 版本进 key：将来结构变了，旧 key 直接读不到，不会拿 v1 的数据去喂 v2 的渲染 */
  const KEY = 'trip-plan-v1';
  const SCHEMA = 1;
  /** 与服务端 tools/planner.js 的天数上限一致 */
  const MAX_DAYS = 14;
  /** 超过这个体积直接放弃：正常行程 JSON 也就几十 KB */
  const MAX_BYTES = 2e6;

  function save(plan) {
    if (!plan || !Array.isArray(plan.days) || !plan.days.length) return false;
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ v: SCHEMA, savedAt: new Date().toISOString(), plan }));
      return true;
    } catch (error) {
      // Safari 隐私模式下写入会抛 QuotaExceededError。
      // 这里只报错不抛出去：能不能交接是调用方的事，不该把规划结果本身变成异常。
      console.warn('[行程交接] 写入失败，这份行程无法带到下一页：', error && error.message);
      return false;
    }
  }

  function clear() {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* 读不到 storage 时也没什么可清的 */
    }
  }

  /**
   * 读取并校验交接过来的行程。
   * @returns {object|null} 校验通过返回 plan，否则返回 null（并把脏数据删掉）
   */
  function read() {
    let raw = null;
    try {
      raw = sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
    if (!raw) return null;

    if (raw.length > MAX_BYTES) {
      console.warn('[行程交接] 数据过大，已丢弃');
      clear();
      return null;
    }

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      console.warn('[行程交接] 不是有效 JSON，已丢弃');
      clear();
      return null;
    }

    const plan = data && data.plan;
    const reason = validate(data, plan);
    if (reason) {
      console.warn(`[行程交接] 数据不可用（${reason}），已丢弃，回退到内置行程`);
      clear();
      return null;
    }
    return plan;
  }

  /** @returns {string} 不合格的原因；合格返回空串 */
  function validate(data, plan) {
    if (!data || data.v !== SCHEMA) return '版本不匹配';
    if (!plan || typeof plan !== 'object') return '缺少 plan';
    if (!Array.isArray(plan.days) || !plan.days.length) return '没有行程日';
    if (plan.days.length > MAX_DAYS) return `天数超过 ${MAX_DAYS}`;
    if (!plan.poi || typeof plan.poi !== 'object') return '缺少地点表';

    // 每天至少要有一个能落地的点：poiId 在 poi 表里找不到的访问会被直接丢掉，
    // 全丢光的那天渲染出来是个空壳，不如整份判死回退内置行程
    const hasRenderableDay = plan.days.some((day) =>
      Array.isArray(day && day.visits) &&
      day.visits.some((visit) => visit && visit.poiId && plan.poi[visit.poiId])
    );
    return hasRenderableDay ? '' : '没有任何可渲染的地点';
  }

  /** 翻页过渡用的时间戳。行程页 <head> 里的内联脚本读它，见 styles/base.css 的 .pageveil */
  const ENTER_KEY = 'trip-enter-at';

  /**
   * 记下「刚从首页出发」的时刻。
   * 行程页据此决定要不要铺那层纸 —— 直接打开 trip.html 时不该白闪一下。
   */
  function markEntering() {
    try {
      sessionStorage.setItem(ENTER_KEY, String(Date.now()));
    } catch {
      /* 存不了就算了，最多是没有过渡 */
    }
  }

  window.TripPlanStore = { save, read, clear, markEntering, KEY, ENTER_KEY };
})();
