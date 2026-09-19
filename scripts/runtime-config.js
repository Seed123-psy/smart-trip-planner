/* ============================================================
   运行时配置：把服务端的覆盖值灌进 CFG.AMAP

   要解决的是「换高德密钥得改代码重新部署」。config.js 仍是静态默认值 ——
   它会被浏览器加载，源码谁都能看，本来就只放可公开的 WebJS key；
   真正的变化是这两项现在可以被服务端覆盖（阶段 1 走数据库或环境变量）。

   ── 三个必须钉死的细节 ──

   1. 原地整对象替换。CFG.AMAP 这个对象被多个脚本持有同一个引用，
      所以只能改它的内容，不能把 CFG.AMAP 指向新对象 —— 那样已经读了引用
      的脚本还是拿着旧的。替换时先清空再灌入，让 key 与 code 永远来自同一次
      配置：只 merge 的话会出现「新 key + 旧 code」，高德回 INVALID_USER_SCODE，
      比 key 缺失难查得多，因为它看起来像密钥本身有问题。

   2. ready 永不 reject。它是在启动链上被 await 的（首页 hero-map 与行程页
      TripMap 各一处），一次拒绝会顺着 async 边界毁掉整个启动流程。
      宁可回落到静态值，也不能让首页白屏。

   3. 有超时。配置服务再重要也不该拖住首屏：3 秒拿不到就认输，
      和 hero-map 对 JSAPI 的 3 秒硬上限同一个思路。

   拿不到配置时**什么都不做**，CFG.AMAP 保持 config.js 里的静态值。
   ============================================================ */

(function () {
  'use strict';

  const CFG = window.TRIP_CONFIG;
  const TIMEOUT_MS = 3000;

  /** 覆盖是否真的生效了。给调试用，也可被后续阶段读来判断要不要挂横幅 */
  let applied = false;

  /**
   * 清空目标对象再灌入新数据 —— 保持对象身份不变，只换内容。
   * 与 scripts/app.js 里 applyPlanData 用的 replaceInto 是同一套做法，
   * 那边换的是行程数据，这边换的是密钥。
   */
  function replaceInto(target, source) {
    // 先把 source 拷进一个干净对象，再去动 target。
    // 若 source 上挂着会抛的 getter（今天不会 —— usable() 已保证它是
    // JSON.parse 出来的纯对象），异常会在**动手之前**抛出，CFG.AMAP
    // 保持原样。反过来先清空再灌的话，一旦灌入失败，CFG.AMAP 会停在
    // 空对象 —— 那比保持静态值更糟：hero-map 会抛「未配置高德 WebJS Key」，
    // 把排查方向指到「密钥没配」上去，而真正的原因是配置接口。
    const next = Object.assign({}, source);
    Object.keys(target).forEach((key) => {
      delete target[key];
    });
    Object.assign(target, next);
  }

  /** 形状校验。服务端已经保证成对下发，这里防的是接口被换掉或返回了半截 */
  function usable(amap) {
    return (
      amap &&
      typeof amap.WEB_JS_KEY === 'string' &&
      amap.WEB_JS_KEY &&
      typeof amap.SECURITY_CODE === 'string' &&
      amap.SECURITY_CODE
    );
  }

  async function fetchOverride() {
    const res = await fetch('/api/config', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) return null;

    const body = await res.json();
    const amap = body && body.AMAP;
    return usable(amap) ? amap : null;
  }

  const ready = (async () => {
    try {
      if (!CFG || !CFG.AMAP) return;

      const amap = await fetchOverride();
      if (!amap) return;

      replaceInto(CFG.AMAP, amap);
      applied = true;
      console.log('[运行时配置] 高德密钥已由服务端覆盖');
    } catch {
      // 超时、断网、404、返回的不是 JSON —— 全部按「没有覆盖值」处理。
      // 这个 catch 是细节 2 的落点：ready 不允许 reject。
    }
  })();

  window.TripRuntimeConfig = {
    ready,
    get applied() {
      return applied;
    }
  };
})();
