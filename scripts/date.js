/* ============================================================
   日期工具：一律用 'YYYY-MM-DD' 字符串进出

   为什么不直接用 Date 做运算：
   new Date('2026-10-03') 会按 UTC 解析，在东八区本地时间下变成 10-03 08:00
   之前的那一天，跨时区或跨夏令时都可能整体偏一天。
   所以解析一律走 new Date(y, m-1, d) 的本地时间构造，比较与加减都在本地时间上做。

   单独成文件是因为 weather.js（判断预报窗口）和 prep.js（算放票倒计时）
   都要用，与其各写一份不如共用。
   ============================================================ */

(function () {
  'use strict';

  /** 'YYYY-MM-DD' -> Date（本地时间零点）；格式不对返回 null */
  function parse(str) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }

  /** Date -> 'YYYY-MM-DD' */
  function format(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** 日期字符串加减天数；输入非法返回 null */
  function addDays(str, days) {
    const d = parse(str);
    if (!d) return null;
    d.setDate(d.getDate() + days);
    return format(d);
  }

  /** 今天的 'YYYY-MM-DD' */
  function today() {
    return format(new Date());
  }

  /** b - a 的天数差；任一非法返回 null。用本地零点做差，不受时分秒影响 */
  function daysBetween(a, b) {
    const da = parse(a);
    const db = parse(b);
    if (!da || !db) return null;
    return Math.round((db - da) / 86400000);
  }

  /** 'YYYY-MM-DD' -> '10 月 3 日'，用于展示 */
  function label(str) {
    const d = parse(str);
    return d ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : '';
  }

  /**
   * 含首尾的行程天数：10-03 → 10-09 是 7 天。
   * 表单只让用户选起止日期，天数一律由这里派生 —— 服务端也是同一个口径
   * （tools/planner.js 的 dateDiff + 1），两边不能各算一套。
   * 任一边非法、或终点早于起点时返回 null，由调用方决定怎么提示。
   */
  function tripDays(start, end) {
    const diff = daysBetween(start, end);
    return diff == null || diff < 0 ? null : diff + 1;
  }

  window.TripDate = { parse, format, addDays, today, daysBetween, label, tripDays };
})();
