/* ============================================================
   登录 / 注册页的交互

   刻意不用任何框架：这一页要的是「网络再差也能登进去」，
   所以它不依赖 config.js，也不依赖高德，只有这两个表单和 fetch。
   ============================================================ */

(function () {
  'use strict';

  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const formLogin = document.getElementById('form-login');
  const formRegister = document.getElementById('form-register');
  const message = document.getElementById('message');

  /**
   * 登录成功后去哪儿。默认回首页。
   *
   * 【为什么是解析后比 origin，而不是检查字符串】
   * 这里最初写的是「不以 // 开头、不匹配 scheme: 就放行」—— 一条字符串黑名单。
   * 它挡不住下面这一串，因为它们**绕过的是字符串规则，而不是解析规则**：
   *
   *   /\evil.com      → http://evil.com/     （special scheme 里 \ 等同于 /）
   *   " //evil.com"   → http://evil.com/     （前导空格被剥掉）
   *   \t//evil.com    → http://evil.com/     （同上，TAB / CR / NUL 都一样）
   *
   * location.replace 用的是 WHATWG URL 解析器，和字符串比对的规则不是一回事。
   * 所以正确做法是拿同一套解析器解开，再比 origin —— 同源才放行。
   * 这与项目里「静态资源用白名单而不是黑名单」是同一个教训，只是换了个地方。
   */
  function nextUrl() {
    const raw = new URLSearchParams(location.search).get('next') || '';

    // 空参数要单独拦，不能丢给下面的解析。
    // new URL('', location.href) 的基址就是当前页 —— 也就是登录页自己，
    // 于是「不带 next 进来」会跳回登录页，看起来像登录没生效。
    // 这个分支是改用解析后比 origin 时新引入的，原先那版字符串判断恰好覆盖了它。
    if (!raw) return 'index.html';

    try {
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin) return 'index.html';
      return url.pathname + url.search + url.hash;
    } catch {
      return 'index.html';
    }
  }

  function say(text, tone) {
    message.textContent = text;
    message.dataset.tone = tone;
  }

  function clearMessage() {
    message.textContent = '';
    delete message.dataset.tone;
  }

  function showTab(which) {
    const isLogin = which === 'login';
    tabLogin.setAttribute('aria-selected', String(isLogin));
    tabRegister.setAttribute('aria-selected', String(!isLogin));
    formLogin.hidden = !isLogin;
    formRegister.hidden = isLogin;
    clearMessage();

    const first = (isLogin ? formLogin : formRegister).querySelector('input');
    if (first) first.focus();
  }

  tabLogin.addEventListener('click', () => showTab('login'));
  tabRegister.addEventListener('click', () => showTab('register'));

  /**
   * 认领「还没登录时规划的那几份行程」。
   *
   * 服务端不知道哪些匿名行程是同一个人的 —— 客户端手里这几个 id 是唯一的线索。
   * 任何失败都不影响登录本身：最坏的结果是那几份行程留在匿名名下，
   * 而它们仍然能通过 id 打开（见 tools/trips.js），并没有丢。
   */
  async function claimTrips() {
    if (!window.TripPlanStore) return;

    const entries = window.TripPlanStore.readIds();
    if (!entries.length) return;

    try {
      const res = await fetch('/api/trips/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trips: entries })
      });
      if (!res.ok) return;

      const body = await res.json();

      // 只有**全部**认领成功才清空。部分成功时清掉的话，剩下那几个
      // （可能只是过期或已经被别人认领）就再也没机会了 —— 而这条记录
      // 是客户端仅有的线索。不全清最多是下次登录再试一遍。
      if (body && body.claimed >= entries.length) window.TripPlanStore.clearIds();
    } catch {
      /* 认领失败就算了，不该挡住登录后的跳转 */
    }
  }

  /**
   * 提交一个表单。
   *
   * 全程把服务端返回的 error 文案直接显示出来 —— 服务端那边已经统一措辞
   * （比如登录失败永远是「用户名或密码不正确」，不区分查无此人与密码错误），
   * 所以这里不需要也不应该再加工。
   */
  async function submit(form, endpoint) {
    const button = form.querySelector('.auth__submit');
    const data = Object.fromEntries(new FormData(form));

    button.disabled = true;
    clearMessage();

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      let body = null;
      try {
        body = await res.json();
      } catch {
        /* 服务端没回 JSON（502 之类的网关页）—— 下面按状态码兜底 */
      }

      if (!res.ok) {
        say((body && body.error) || `请求失败（${res.status}）`, 'error');
        return;
      }

      say('正在进入…', 'ok');
      await claimTrips();
      location.replace(nextUrl());
    } catch (error) {
      say('连不上服务器，请检查网络后重试。', 'error');
    } finally {
      button.disabled = false;
    }
  }

  formLogin.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(formLogin, '/api/auth/login');
  });

  formRegister.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(formRegister, '/api/auth/register');
  });

  // 已经登录过就直接走，别让人对着登录框再登一次。
  // 失败一律忽略：这个检查只是顺手，不该挡住页面。
  fetch('/api/me', { headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      if (body && body.user) location.replace(nextUrl());
    })
    .catch(() => {});

  showTab('login');
})();
