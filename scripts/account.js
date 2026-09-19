/* ============================================================
   账号页

   只做一件事：让用户能填、能换、能清掉自己那把 DeepSeek 密钥。
   密钥一旦保存就不会再回显明文，页面只显示掩码 —— 所以这里的输入框
   保存后要清空，否则「框里还有字」会让人以为那是服务端存着的值。
   ============================================================ */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function say(text, tone) {
    const box = $('message');
    box.textContent = text || '';
    if (text) box.dataset.tone = tone || 'ok';
    else delete box.dataset.tone;
  }

  const ROLE_LABEL = { admin: '管理员', user: '普通用户' };

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new Error('连不上服务器');
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      /* 网关页之类，按状态码兜底 */
    }

    if (!res.ok) throw new Error((data && data.error) || `请求失败（${res.status}）`);
    return data;
  }

  async function guard(button, run) {
    const label = button.textContent;
    button.disabled = true;
    say('');
    try {
      await run();
    } catch (error) {
      say(error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  /** 刷新密钥那一行的提示文案 */
  function showHint(hint) {
    $('key-hint').textContent = hint
      ? `当前已配置：${hint}`
      : '当前没有配置自己的密钥，规划会使用站点的公共密钥（可能受每日次数限制）。';
  }

  async function load() {
    const me = await api('GET', '/api/me');

    if (!me.user) {
      location.replace('login.html?next=' + encodeURIComponent(location.pathname));
      return;
    }

    $('fact-name').textContent = me.user.username;
    $('fact-role').textContent = ROLE_LABEL[me.user.role] || me.user.role;
    showHint(me.deepseekKeyHint);
  }

  $('key-save').addEventListener('click', (event) => {
    const value = $('key-input').value.trim();

    if (!value) {
      say('请先填入密钥，或用右边的「清除」。', 'error');
      return;
    }

    guard(event.target, async () => {
      const data = await api('PUT', '/api/me/key', { key: value });
      // 立刻清空输入框：页面上从此只留掩码，明文不再停在 DOM 里
      $('key-input').value = '';
      showHint(data.deepseekKeyHint);
      say('已保存。下次规划会用你自己的密钥。', 'ok');
    });
  });

  $('key-clear').addEventListener('click', (event) => {
    if (!confirm('清除自己配置的密钥？之后规划会回落到站点的公共密钥。')) return;

    guard(event.target, async () => {
      const data = await api('PUT', '/api/me/key', { key: null });
      $('key-input').value = '';
      showHint(data.deepseekKeyHint);
      say('已清除。', 'ok');
    });
  });

  $('logout').addEventListener('click', (event) => {
    event.preventDefault();
    guard(event.target, async () => {
      await api('POST', '/api/auth/logout');
      location.replace('login.html');
    });
  });

  load().catch((error) => say(error.message, 'error'));
})();
