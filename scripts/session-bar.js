/* ============================================================
   顶栏上的账号入口

   在这个之前，站点**没有任何地方能进入登录页** —— 未登录本来就能用
   （这是产品决定：没配自己密钥的人也能规划，只是占每日配额），
   所以没有拦截是对的，但也没有入口：不说的话，用户根本不会知道
   这个站点还有账号这回事。

   所以它只做两件事：告诉用户「现在是谁」，以及「不登录的话今天还剩几次」。
   拿不到就什么都不显示，绝不因为一个接口失败而在页面上留个空洞。
   ============================================================ */

(function () {
  'use strict';

  const slots = document.querySelectorAll('[data-session-slot]');
  if (!slots.length) return;

  /**
   * 造一个节点。
   * 一律走 textContent 而不是 innerHTML —— 用户名有服务端的字符集限制
   * （小写字母数字下划线连字符），但「由谁来保证这件事」不该靠在这里记得转义。
   */
  function el(className, text, href) {
    const node = document.createElement(href ? 'a' : 'span');
    node.className = className;
    if (href) node.href = href;
    node.textContent = text;
    return node;
  }

  function logoutLink() {
    const link = el('session__link', '退出');
    link.href = '#';
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch {
        /* 断网也要让人走 —— 刷新之后服务端那边其实已经清掉了 */
      }
      location.reload();
    });
    return link;
  }

  function render(me) {
    const user = me && me.user;
    const quota = me && me.quota;

    for (const slot of slots) {
      slot.replaceChildren();
      slot.append(el('session__history', '我的行程', 'trips.html'));

      // 「今天还剩几次」只对用公共密钥的人有意义。
      // 配了自己密钥的人与管理员拿到的是 null —— 给他们显示一个会一直
      // 往下掉的数字，只会让人以为自己的额度被限制了
      if (quota) {
        slot.append(
          el('session__quota', quota.left > 0 ? `今天还剩 ${quota.left} 次` : '今天的免费次数用完了')
        );
      }

      if (user) {
        // 用户名本身就是进账号页的入口：写「账号」太抽象，
        // 而用户名是用户自己认得的东西
        slot.append(el('session__link', user.username, 'account.html'));
        slot.append(el('session__sep', '·'));
        slot.append(logoutLink());

        if (user.role === 'admin') {
          slot.append(el('session__sep', '·'));
          slot.append(el('session__link', '管理', 'admin.html'));
        }
      } else {
        slot.append(el('session__link session__link--strong', '登录', 'login.html'));
      }
    }
  }

  async function load() {
    let me = null;
    try {
      const res = await fetch('/api/me', { headers: { Accept: 'application/json' } });
      if (res.ok) me = await res.json();
    } catch {
      // 拿不到就当未登录。顶栏少一个入口，比整页报错好
    }
    render(me);
  }

  load();
})();
