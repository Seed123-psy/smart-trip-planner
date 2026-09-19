/* ============================================================
   管理后台

   【关于转义】这个文件里凡是要塞进 innerHTML 的东西，一律过 esc()。
   用户名有服务端的字符集限制（只能小写字母数字下划线连字符），但邀请码的
   备注是自由文本，管理员自己也可能被社工着填一段带标签的内容进来 ——
   而这一页跑的正是管理员的会话，一次 XSS 等于后台被完全接管。
   与其逐处判断「这个字段安全吗」，不如一律转义。
   ============================================================ */

(function () {
  'use strict';

  const state = { me: null, users: [], invites: [], audit: [], auditActions: [] };

  /* ---------- 基础 ---------- */

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const $ = (id) => document.getElementById(id);

  function say(text, tone) {
    const box = $('message');
    box.textContent = text || '';
    if (text) box.dataset.tone = tone || 'ok';
    else delete box.dataset.tone;
  }

  function fmtTime(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
  }

  /**
   * 调接口。失败时把服务端的 error 文案抛出来 —— 那些文案是精心写过的
   * （比如「至少要保留一个可用的管理员」），前端不该再自作主张换一套说法。
   */
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

    if (res.status === 401) {
      location.replace('login.html?next=' + encodeURIComponent(location.pathname));
      throw new Error('请先登录');
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

  /** 包一层：跑的时候禁用按钮，把错误显示出来，成功则刷新 */
  async function guard(button, successText, run) {
    const label = button.textContent;
    button.disabled = true;
    say('');
    try {
      await run();
      if (successText) say(successText, 'ok');
      return true;
    } catch (error) {
      say(error.message, 'error');
      return false;
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  /* ---------- 用户 ---------- */

  function renderUsers() {
    const box = $('users-body');
    $('users-note').textContent = `${state.users.length} 个账号 · ${state.adminCount} 个可用管理员`;

    if (!state.users.length) {
      box.innerHTML = '<p class="admin__empty">还没有账号。用 node tools/admin-cli.js create-admin 建第一个。</p>';
      return;
    }

    const rows = state.users
      .map((u) => {
        // isSelf 由服务端给出，与它自己的护栏同源 ——
        // 前端曾经自己算「是不是最后一个管理员」，而服务端那边后来改了判断，
        // 两处一分叉就会出现「按钮灰着但其实允许」或者「点了才报 409」。
        const isSelf = Boolean(u.isSelf);
        const selfNote = isSelf ? ' title="不能对自己操作"' : '';

        return `
        <tr>
          <td>${esc(u.username)}${isSelf ? ' <span class="admin__row-detail">（你）</span>' : ''}</td>
          <td><span class="tag tag--${u.role === 'admin' ? 'admin' : 'user'}">${u.role === 'admin' ? '管理员' : '用户'}</span></td>
          <td>${u.disabled ? '<span class="tag tag--off">已禁用</span>' : '<span class="tag tag--ok">正常</span>'}</td>
          <td class="is-muted">${u.hasDeepseekKey ? '已配' : '—'}</td>
          <td class="is-muted">${esc(fmtTime(u.createdAt))}</td>
          <td>
            <div class="btn-row">
              <button class="btn" data-act="role" data-id="${u.id}" data-role="${u.role === 'admin' ? 'user' : 'admin'}"
                      ${isSelf ? 'disabled' : ''}${selfNote}>
                ${u.role === 'admin' ? '降为用户' : '升为管理员'}
              </button>
              <button class="btn" data-act="toggle" data-id="${u.id}" data-disabled="${u.disabled ? '0' : '1'}"
                      ${isSelf ? 'disabled' : ''}${selfNote}>
                ${u.disabled ? '启用' : '禁用'}
              </button>
              <button class="btn" data-act="password" data-id="${u.id}" data-name="${esc(u.username)}">重置口令</button>
            </div>
          </td>
        </tr>`;
      })
      .join('');

    box.innerHTML = `
      <table class="admin__table">
        <thead>
          <tr><th>用户名</th><th>角色</th><th>状态</th><th>自配密钥</th><th>注册时间</th><th>操作</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  async function loadUsers() {
    const data = await api('GET', '/api/admin/users');
    state.users = data.users || [];
    state.adminCount = data.adminCount || 0;
    renderUsers();
  }

  /* ---------- 邀请码 ---------- */

  function inviteState(row) {
    const now = Date.now();
    if (row.revoked) return { label: '已撤销', cls: 'off' };
    if (row.used_count >= row.max_uses) return { label: '已用尽', cls: 'off' };
    if (row.expires_at !== null && row.expires_at <= now) return { label: '已过期', cls: 'off' };
    return { label: '可用', cls: 'ok' };
  }

  function renderInvites() {
    const box = $('invites-body');
    $('invites-note').textContent = `${state.usable} 个可用 / 共 ${state.invites.length} 个`;

    if (!state.invites.length) {
      box.innerHTML = '<p class="admin__empty">还没有邀请码。</p>';
      return;
    }

    const rows = state.invites
      .map((row) => {
        const st = inviteState(row);
        return `
        <tr>
          <td><span class="admin__code" data-copy="${esc(row.code)}" title="点击复制">${esc(row.code)}</span></td>
          <td><span class="tag tag--${st.cls}">${st.label}</span></td>
          <td class="is-muted">${row.used_count} / ${row.max_uses}</td>
          <td class="is-muted">${row.expires_at === null ? '不过期' : esc(fmtTime(row.expires_at))}</td>
          <td class="is-muted">${esc(row.note || '—')}</td>
          <td>
            <button class="btn btn--danger" data-act="revoke" data-code="${esc(row.code)}"
                    ${row.revoked ? 'disabled' : ''}>撤销</button>
          </td>
        </tr>`;
      })
      .join('');

    box.innerHTML = `
      <table class="admin__table">
        <thead>
          <tr><th>邀请码</th><th>状态</th><th>已用</th><th>有效期</th><th>备注</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  async function loadInvites() {
    const data = await api('GET', '/api/admin/invites');
    state.invites = data.invites || [];
    state.usable = data.usable || 0;
    renderInvites();
  }

  /* ---------- 密钥 ---------- */

  /** 四项密钥在界面里的字段名。WebJS 与安全密钥是一对，永远一起提交 */
  const KEY_FIELDS = {
    'amap.webjs_key': 'amapWebjs',
    'amap.security_code': 'amapSecurity',
    'amap.web_service_key': 'amapServiceKey',
    'deepseek.api_key': 'deepseekKey'
  };

  const SOURCE_TAG = { env: 'tag--env', settings: 'tag--db' };

  function renderKeys() {
    const box = $('keys-body');
    const items = state.keys || [];

    box.innerHTML = items
      .map((item) => {
        const field = KEY_FIELDS[item.key];
        const s = item.sourceLabel || item.source;

        return `
        <div class="keycard">
          <div class="keycard__head">
            <span class="keycard__name">${esc(item.label)}</span>
            <span class="tag ${SOURCE_TAG[item.source] || 'tag--file'}">${esc(s)}</span>
            ${item.lockedByEnv ? '<span class="tag tag--off">环境变量优先</span>' : ''}
          </div>
          <p class="keycard__hint">${esc(item.hint)}</p>
          <div class="keycard__row">
            <input type="text" data-field="${field}" autocomplete="off" spellcheck="false"
                   placeholder="${item.value ? '当前 ' + esc(item.value) : '未设置'}"
                   ${item.lockedByEnv ? 'disabled' : ''} />
            <button class="btn btn--danger" data-clear="${field}"
                    ${item.lockedByEnv ? 'disabled' : ''}>清除</button>
          </div>
          ${item.lockedByEnv ? '<p class="keycard__locked">已被环境变量覆盖，此处修改无效。</p>' : ''}
          ${item.problem ? `<p class="keycard__problem">${esc(item.problem)}</p>` : ''}
        </div>`;
      })
      .join('');

    box.insertAdjacentHTML(
      'beforeend',
      '<div class="admin__form" style="margin-top:16px"><button class="btn btn--primary" id="keys-save">保存</button></div>'
    );
  }

  function renderHistory() {
    const box = $('history-body');
    const rows = state.history || [];
    $('history-note').textContent = rows.length ? `${rows.length} 条` : '';

    if (!rows.length) {
      box.innerHTML = '<p class="admin__empty">还没有变更记录。</p>';
      return;
    }

    box.innerHTML = `
      <table class="admin__table">
        <thead><tr><th>时间</th><th>项目</th><th>变化</th><th></th></tr></thead>
        <tbody>
          ${rows
            .map(
              (h) => `
            <tr>
              <td class="is-muted">${esc(fmtTime(h.changedAt))}</td>
              <td>${esc(h.key)}</td>
              <td class="is-muted">${h.hadValue ? '有值' : '无'} → ${h.hasValue ? '有值' : '无'}${h.secret ? '（密文）' : ''}</td>
              <td><button class="btn" data-act="rollback" data-id="${h.id}">回滚到此</button></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`;
  }

  async function loadKeys() {
    const data = await api('GET', '/api/admin/settings');
    state.keys = data.items || [];
    renderKeys();

    const history = await api('GET', '/api/admin/settings/history');
    state.history = history.entries || [];
    renderHistory();
  }

  /** 收集要提交的字段。留空的输入一律视为「不变」—— 见下面 saveKeys 的说明 */
  function collectKeyPayload() {
    const read = (field) => {
      const el = document.querySelector(`#keys-body input[data-field="${field}"]`);
      return el && !el.disabled ? el.value.trim() : '';
    };

    const payload = {};

    const webjs = read('amapWebjs');
    const security = read('amapSecurity');
    if (webjs || security) {
      // 界面上也先拦一次，省得让人提交完才看到服务端的报错
      if (!webjs || !security) return { error: 'WebJS Key 与安全密钥要一起填 —— 只换其中一个会让高德回 INVALID_USER_SCODE' };
      payload.amap = { webjsKey: webjs, securityCode: security };
    }

    const service = read('amapServiceKey');
    if (service) payload.amapServiceKey = service;

    const deepseek = read('deepseekKey');
    if (deepseek) payload.deepseekKey = deepseek;

    if (!Object.keys(payload).length) return { error: '没有填写任何内容' };
    return { payload };
  }

  async function saveKeys(button) {
    const collected = collectKeyPayload();
    if (collected.error) {
      say(collected.error, 'error');
      return;
    }

    await guard(button, '已保存。服务端立即生效，浏览器刷新一次即可', async () => {
      const data = await api('PUT', '/api/admin/settings', collected.payload);
      state.keys = data.items || [];
      renderKeys();
      const history = await api('GET', '/api/admin/settings/history');
      state.history = history.entries || [];
      renderHistory();
    });
  }

  /** 清除某一项（或一整对）。留空=不变，所以清除必须是一个明确动作 */
  async function clearKey(field, button) {
    const isPair = field === 'amapWebjs' || field === 'amapSecurity';
    const label = isPair ? '这一对高德密钥' : (field === 'amapServiceKey' ? '高德 Web 服务密钥' : 'DeepSeek 密钥');
    if (!confirm(`清除${label}？清除后会回落到下一层来源。`)) return;

    await guard(button, '已清除', async () => {
      const payload = isPair ? { amap: null } : { [field]: null };
      const data = await api('PUT', '/api/admin/settings', payload);
      state.keys = data.items || [];
      renderKeys();
      const history = await api('GET', '/api/admin/settings/history');
      state.history = history.entries || [];
      renderHistory();
    });
  }

  /* ---------- 配额 ---------- */

  /** 把 subject 翻成人看得懂的写法：u:12 是账号，ip:x 是未登录的来访地址 */
  function subjectLabel(subject) {
    if (subject.startsWith('u:')) return `账号 #${subject.slice(2)}`;
    if (subject.startsWith('ip:')) return `${subject.slice(3)}（未登录）`;
    return subject;
  }

  function renderQuota() {
    const data = state.quota || { rows: [], limit: 0, day: '' };
    const form = $('quota-form');
    if (form && document.activeElement !== form.limit) form.limit.value = data.limit;

    $('quota-note').textContent = `${data.day} · 上限 ${data.limit} 次 · ${data.rows.length} 个来源`;

    if (!data.rows.length) {
      $('quota-body').innerHTML = '<p class="admin__empty">今天还没有人用过公共密钥。</p>';
      return;
    }

    $('quota-body').innerHTML = `
      <table class="admin__table">
        <thead><tr><th>来源</th><th>已用</th><th>进行中</th><th>剩余</th></tr></thead>
        <tbody>
          ${data.rows
            .map((r) => {
              const left = Math.max(0, data.limit - r.used - r.reserved);
              return `
            <tr>
              <td>${esc(subjectLabel(r.subject))}</td>
              <td>${r.used}</td>
              <td class="is-muted">${r.reserved || '—'}</td>
              <td class="is-muted">${left}</td>
            </tr>`;
            })
            .join('')}
        </tbody>
      </table>`;
  }

  async function loadQuota() {
    state.quota = await api('GET', '/api/admin/quota');
    renderQuota();
  }

  /* ---------- 审计 ---------- */

  function renderAudit() {
    const box = $('audit-body');
    $('audit-note').textContent = `${state.audit.length} 条`;

    if (!state.audit.length) {
      box.innerHTML = '<p class="admin__empty">还没有记录。</p>';
      return;
    }

    const rows = state.audit
      .map(
        (e) => `
        <tr>
          <td class="is-muted">${esc(fmtTime(e.at))}</td>
          <td>${esc(e.actorName)}</td>
          <td>${esc(e.actionLabel)}</td>
          <td>${esc(e.target || '—')}</td>
          <td class="is-muted">${esc(e.detail || '—')}</td>
        </tr>`
      )
      .join('');

    box.innerHTML = `
      <table class="admin__table">
        <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>说明</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  async function loadAudit() {
    const filter = $('audit-filter').value;
    const query = filter ? `?action=${encodeURIComponent(filter)}` : '';
    const data = await api('GET', '/api/admin/audit' + query);

    state.audit = data.entries || [];

    // 筛选下拉框的选项来自服务端 —— 动作清单只有一处定义（tools/audit.js），
    // 前端抄一份迟早会漏掉新增的动作
    if (!state.auditActions.length && data.actions) {
      state.auditActions = data.actions;
      const select = $('audit-filter');
      select.innerHTML =
        '<option value="">全部动作</option>' +
        data.actions.map((a) => `<option value="${esc(a.value)}">${esc(a.label)}</option>`).join('');
    }

    renderAudit();
  }

  /* ---------- 页签 ---------- */

  const PANELS = {
    users: 'panel-users',
    invites: 'panel-invites',
    keys: 'panel-keys',
    quota: 'panel-quota',
    audit: 'panel-audit'
  };
  const LOADERS = {
    users: loadUsers,
    invites: loadInvites,
    keys: loadKeys,
    quota: loadQuota,
    audit: loadAudit
  };

  function showTab(which) {
    for (const key of Object.keys(PANELS)) {
      $(PANELS[key]).hidden = key !== which;
      $('tab-' + key).setAttribute('aria-selected', String(key === which));
    }
    say('');

    LOADERS[which]().catch((error) => say(error.message, 'error'));
  }

  for (const key of Object.keys(PANELS)) {
    $('tab-' + key).addEventListener('click', () => showTab(key));
  }

  /* ---------- 事件 ---------- */

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]');

    // 邀请码点一下复制。写进剪贴板的失败是静默的（非 https 下不可用），
    // 所以失败了就把码显示在提示区，让人能手抄
    const copy = event.target.closest('[data-copy]');
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy);
        say('已复制 ' + copy.dataset.copy, 'ok');
      } catch {
        say('复制失败，请手动选中：' + copy.dataset.copy, 'error');
      }
      return;
    }

    // 密钥区的「清除」与「保存」按钮是渲染出来的，没有 data-act，单独判
    const clear = event.target.closest('button[data-clear]');
    if (clear) {
      await clearKey(clear.dataset.clear, clear);
      return;
    }
    if (event.target.id === 'keys-save') {
      await saveKeys(event.target);
      return;
    }

    if (!button) return;
    const id = button.dataset.id;

    if (button.dataset.act === 'rollback') {
      if (!confirm('把这一项恢复成这条历史记录里的值？这会再记一条新的历史，不会抹掉中间发生的事。')) return;
      await guard(button, '已回滚', async () => {
        const data = await api('POST', '/api/admin/settings/rollback', { id: Number(button.dataset.id) });
        state.keys = data.items || [];
        renderKeys();
        const history = await api('GET', '/api/admin/settings/history');
        state.history = history.entries || [];
        renderHistory();
      });
      return;
    }

    if (button.dataset.act === 'role') {
      await guard(button, '角色已更新', async () => {
        await api('POST', `/api/admin/users/${id}/role`, { role: button.dataset.role });
        await loadUsers();
      });
    }

    if (button.dataset.act === 'toggle') {
      const disabled = button.dataset.disabled === '1';
      if (disabled && !confirm('禁用后这个账号会立刻登录不了，已有的会话也会被清掉。继续？')) return;
      await guard(button, disabled ? '账号已禁用' : '账号已启用', async () => {
        await api('POST', `/api/admin/users/${id}/disabled`, { disabled });
        await loadUsers();
      });
    }

    if (button.dataset.act === 'password') {
      // 用 prompt 而不是自建弹层：这是临时口令，管理员要念给本人听，
      // 明文可见反而是必要的。而为一个低频动作引入一套模态框不值当。
      const next = prompt(`给「${button.dataset.name}」设一个新口令\n至少要 8 位。设好后他会被强制登出，需要重新登录。`);
      if (next === null) return;
      await guard(button, '口令已重置，该用户的会话已全部清除', async () => {
        await api('POST', `/api/admin/users/${id}/password`, { password: next });
        await loadUsers();
      });
    }

    if (button.dataset.act === 'revoke') {
      const code = button.dataset.code;
      if (!confirm(`撤销 ${code}？已经用它注册出来的账号不受影响。`)) return;
      await guard(button, '邀请码已撤销', async () => {
        await api('POST', `/api/admin/invites/${encodeURIComponent(code)}/revoke`);
        await loadInvites();
      });
    }
  });

  $('invite-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type=submit]');
    const data = Object.fromEntries(new FormData(form));

    await guard(button, null, async () => {
      const created = await api('POST', '/api/admin/invites', {
        note: data.note,
        maxUses: Number(data.maxUses) || 1,
        days: data.days === '' ? null : Number(data.days)
      });
      say('已生成邀请码：' + created.invite.code, 'ok');
      form.reset();
      await loadInvites();
    });
  });

  $('quota-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type=submit]');

    await guard(button, null, async () => {
      state.quota = await api('PUT', '/api/admin/quota', { limit: Number(form.limit.value) });
      renderQuota();
      say('每日配额已改为 ' + state.quota.limit + ' 次', 'ok');
    });
  });

  $('audit-filter').addEventListener('change', () => {
    loadAudit().catch((error) => say(error.message, 'error'));
  });

  $('logout').addEventListener('click', async (event) => {
    await guard(event.target, null, async () => {
      await api('POST', '/api/auth/logout');
      location.replace('login.html');
    });
  });

  /* ---------- 启动 ---------- */

  (async function boot() {
    try {
      const me = await api('GET', '/api/me');
      if (!me.user) {
        location.replace('login.html?next=' + encodeURIComponent(location.pathname));
        return;
      }
      if (me.user.role !== 'admin') {
        // 不是管理员就没必要留在这儿。服务端对 /api/admin/* 也是 403，
        // 这里只是别让人对着一个空壳后台发呆
        document.body.innerHTML =
          '<div class="admin__wrap"><p class="admin__msg" data-tone="error" style="display:block">这个页面只有管理员能打开。</p></div>';
        return;
      }

      state.me = me.user;
      $('who').textContent = me.user.username;
      showTab('users');
    } catch (error) {
      say(error.message, 'error');
    }
  })();
})();
