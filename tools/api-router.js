/**
 * 接口路由表。
 *
 * 为什么要有它：serve.js 现在的写法是一串 if (urlPath === '/api/xxx')。
 * 接口只有两个时没问题，但账号、后台、密钥、配额、分享加起来是二十几个，
 * 再堆 if 就没法看了。
 *
 * 【重要契约】handleApi 返回 true 表示「已处理，响应已写出」，调用方直接 return；
 * 返回 false 表示「没命中，调用方继续走自己的逻辑」。
 *
 * 之所以要这个 false 通路：/api/amap 与 /api/plan 目前还写在 serve.js 里，
 * 阶段 0 不动它们。如果 handleApi 对未命中的路径一律回 404，那两个接口会
 * 在路由表还是空的时候就先被吃掉。等阶段 7 把它们迁进来之后，
 * 未命中的 /api/* 才该回 JSON 404。
 *
 * 【迁移到 MySQL 时这一层改动很轻】
 * handleApi 早就是 `await route.handler(ctx)`，所以处理函数改成 async
 * **零结构成本** —— 不用动路由框架，只是每个 handler 内部多加几个 await。
 * 另外两处不是机械改动：健康检查的库表统计（sqlite_master → information_schema）、
 * 注册时判重名撞键（错误码从 SQLite 的文案换成了 MySQL 的 ER_DUP_ENTRY）。
 */

'use strict';

const { parseUrl, sendJson, sendError, readJson, badRequest, HttpError } = require('./http');
const { getDb } = require('./db');
const { resolveAmapWebConfig, describeKeys } = require('./keys');
const {
  setSettings,
  listSettingHistory,
  rollbackSetting,
  KEY_WEBJS,
  KEY_SECURITY,
  KEY_AMAP_SERVICE,
  KEY_DEEPSEEK
} = require('./settings');
const {
  redeem,
  refund,
  createInvite,
  listInvites,
  revoke: revokeInvite,
  countUsable,
  normalizeCode
} = require('./invites');
const {
  clientIp,
  validateUsername,
  validatePassword,
  createUser,
  publicUser,
  login: loginAccount,
  issueSession,
  revokeSession,
  currentUser,
  requireUser,
  requireAdmin,
  assertAdmin
} = require('./auth');
const userAdmin = require('./user-admin');
const { setUserKey, userKeyHint } = require('./user-keys');
const staticMap = require('./static-map');
const quota = require('./quota');
const trips = require('./trips');
const audit = require('./audit');

/** 注册表。顺序即匹配顺序，同路径不同方法互不干扰 */
const ROUTES = [];

function segmentsOf(pathname) {
  return String(pathname).split('/').filter(Boolean);
}

/**
 * 注册一条路由。
 *   on('GET',  '/api/trips',        listTrips)
 *   on('POST', '/api/trips/:id',    updateTrip)
 *
 * 处理函数收到一个 ctx：{ req, res, params, query, pathname }。
 * 返回什么都会被忽略 —— 响应由处理函数自己发出。
 */
function on(method, pattern, handler) {
  ROUTES.push({
    method: String(method).toUpperCase(),
    segments: segmentsOf(pattern),
    handler
  });
}

/**
 * 路径是否匹配。匹配则返回参数表，不匹配返回 null。
 * 空参数表 {} 是真值，所以判断要用 !== null 而不是真值判断。
 */
function matchPath(route, segments) {
  if (route.segments.length !== segments.length) return null;

  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const expected = route.segments[i];
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = segments[i];
      continue;
    }
    if (expected !== segments[i]) return null;
  }
  return params;
}

/**
 * 尝试用路由表处理这个请求。**本函数不抛异常** —— 它跑在请求回调的调用链上，
 * 抛出会顺着 async 边界传到 serve.js 的外层兜底，那样错误响应的形态就和
 * 这里不一致了。所以处理函数抛出的异常在这里就地渲染。
 */
async function handleApi(req, res) {
  const { pathname, query } = parseUrl(req);

  // 百分号转义不完整（/%zz 之类）—— decodeURIComponent 抛 URIError 的地方。
  // 注意：当前唯一的调用方 serve.js 在更早的地方已经解过同一个路径并回了
  // 自己的 400，所以这个分支**目前不可达**。留着是因为 handleApi 的契约是
  // 「不抛异常、任何输入都有确定的响应」，将来若多一个入口（阶段 7 的
  // catch-all 或直接单测），它就是唯一的那层保护。
  if (pathname === null) {
    sendJson(res, 400, { error: '400 Bad Request' });
    return true;
  }

  const segments = segmentsOf(pathname);
  const method = String(req.method || 'GET').toUpperCase();

  /* 管理后台的范围判断，用的是**上面这套已经归一化过的 segments**，
     不是 pathname 的字面前缀。

     这里最初写的是 pathname.startsWith('/api/admin/')，而路由匹配走的是
     segmentsOf（把空段全滤掉）。两条判断对同一个路径的看法不一致，于是
     `//api/admin/users` 与 `/%2fapi/admin/users` 能命中路由、却不满足
     startsWith —— 未认证即可拿到全部用户列表、重置任意账号的口令。
     （%2f 那一形态在 nginx 下也成立：decodeURIComponent 之后才变成 //，
     而 nginx 默认的 merge_slashes 不会折叠它。）

     教训与阶段 0 的黑名单是同一个：**同一件事不要有两套判断**。
     这里改成共用 segments，守卫与路由就不可能再对不上。 */
  const isAdminScope = segments[0] === 'api' && segments[1] === 'admin';

  /* 身份先验，再谈路由与方法。
     放在下面那个匹配循环里的话，路径命中但方法不对时会先回 405 ——
     那个响应带 Allow 头，等于告诉未认证的调用方「这个接口存在，只是方法不对」。
     先验身份之后，管理范围对任何人都只回 401。

     requireAdmin 在 MySQL 版里是 async（它要查会话与用户），所以这里必须是 await ——
     漏掉的话 adminActor 拿到的是一个 Promise，而 Promise 是真值，
     于是**任何人都能通过管理接口的身份检查**。 */
  let adminActor = null;
  if (isAdminScope) {
    try {
      adminActor = await requireAdmin(req);
    } catch (error) {
      sendError(res, error);
      return true;
    }
  }

  // 路径命中但方法不对时，要回 405 而不是 404，且必须带 Allow 头。
  // 这也是为什么先扫完所有路由再决定回什么。
  let allowed = null;

  for (const route of ROUTES) {
    const params = matchPath(route, segments);
    if (params === null) continue;

    if (!allowed) allowed = new Set();
    allowed.add(route.method);
    if (route.method !== method) continue;

    try {
      const ctx = { req, res, params, query, pathname };

      // 管理员在上面已经验过了，这里只是把结果放进 ctx，
      // 省掉每个处理函数自己再查一次
      if (isAdminScope) ctx.admin = adminActor;

      await route.handler(ctx);
    } catch (error) {
      sendError(res, error);
    }
    return true;
  }

  if (allowed) {
    const methods = [...allowed].join(', ');
    res.setHeader('Allow', methods);
    sendJson(res, 405, { error: `只支持 ${methods}` });
    return true;
  }

  return false;
}

/* ---------- 接口清单 ---------- */

/**
 * 健康检查。阶段 0 唯一的接口，用来确认「路由表接上了、库能开、迁移跑过了」
 * 这三件事同时成立 —— 这三件事任何一件坏了，后面几个阶段都是白做。
 *
 * 库开不起来时这里会抛，sendError 回 500。这是对的：健康检查的职责就是
 * 坏掉的时候响，而不是永远点头。
 */
on('GET', '/api/health', async ({ res }) => {
  const db = await getDb();

  const [applied] = await db.execute('SELECT count(*) AS n FROM schema_meta WHERE `key` LIKE ?', [
    'migration.%'
  ]);

  /* 表数量改查 information_schema。
     旧版查的是 sqlite_master 并排掉 sqlite_% 前缀（SQLite 的内部表），
     MySQL 没有对应物 —— information_schema 是独立的虚拟库，不在 DATABASE() 里。
     所以这个数字比旧版多：schema_meta 与 sequences 现在也被算进来了，
     它们确实是这个库里的表。这个接口的用途是「确认库接上了、迁移跑过了」，
     数字具体是几不重要，重要的是它不等于 0。 */
  const [tables] = await db.execute(
    'SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()'
  );

  sendJson(res, 200, {
    ok: true,
    // 期望等于 tools/schema-mysql.js 里 MIGRATIONS 的条数
    migrations: applied[0].n,
    tables: tables[0].n
  });
});

/**
 * 浏览器侧运行时配置（阶段 1）。
 *
 * 只回**有覆盖**的项：没有覆盖值就回空对象，前端保持 config.js 里的静态值。
 * 于是这个接口挂掉、超时、或者压根没实现，站点都照常跑 —— 代价只是换密钥
 * 得改代码。这是有意的降级方向：配置服务不该成为首页能不能打开的前提。
 *
 * 这一条在 MySQL 版里更重要了：**线上（Vercel）没配数据库**，readSetting
 * 会返回 unreadable 状态而不是抛错，于是这里照样回 200 + 空对象或静态值。
 *
 * 这里回的是 WebJS key，它按设计就是公开的（高德给它配域名白名单，
 * 挡的是别人拿去用自己的域名）。真正不能出服务端的两个 key ——
 * 高德 Web 服务 key 与 DeepSeek key —— 不在这个接口里，也永远不该进来。
 */
on('GET', '/api/config', async ({ res }) => {
  const { amap } = await resolveAmapWebConfig();
  sendJson(res, 200, amap ? { AMAP: amap } : {});
});

/* ---------- 账号（阶段 2） ---------- */

/**
 * 注册。凭邀请码。
 *
 * 【核销与建号的顺序】先核销、后建号，失败再把码退回去。
 * 反过来的话（先建号再核销），核销失败会留下一个没有邀请码来源的账号 ——
 * 那是「邀请制」这件事本身被绕过了。而按这个顺序，最坏情况是码被短暂占用
 * 又在同一请求内退还，不会凭空多出一个账号。
 */
on('POST', '/api/auth/register', async ({ req, res }) => {
  const body = await readJson(req);

  const username = validateUsername(body.username);
  const password = validatePassword(body.password);

  const inviteCode = String(body.inviteCode == null ? '' : body.inviteCode).trim();
  if (!inviteCode) throw badRequest('需要邀请码');

  /* 这里**不能**先查一次重名再核销邀请码。
     那样写的响应码会直接泄露用户名是否存在：
       已存在的用户名 + 乱填的邀请码 → 409「该用户名已被占用」
       不存在的用户名 + 同一个乱码   → 403「邀请码无效…」
     于是任何匿名访客都能把用户名表扫一遍，一个邀请码都不用 ——
     这与 tools/auth.js 里「登录失败一律回同一句话」和 burnPasswordTime()
     花 44ms 抹平的那点差异，是同一个目标，而这里三行就把它全送出去了。

     顺序必须是「先核销、后建号」：核销失败的人，不该从我们这里得知
     任何关于用户名的信息。重名由下面 users.username 的唯一键兜住，
     撞了会把码退还（refund），所以也不会白白废掉一个码。 */

  if (!(await redeem(inviteCode))) {
    throw new HttpError(403, '邀请码无效、已用尽或已过期', { expose: true });
  }

  let user;
  try {
    user = await createUser({ username, password });
  } catch (error) {
    // 建号失败就把码退回去。不退的话，一次重名（或一次并发竞态）就让站长
    // 手工发出去的一个邀请码白白作废，而他完全不知道为什么。
    try {
      await refund(inviteCode);
    } catch {
      /* 退不回去也不能盖住真正的错误 */
    }

    /* 重名判定。旧版匹配的是 SQLite 的文案 "UNIQUE constraint failed"，
       MySQL 的对应物是错误码 1062 / ER_DUP_ENTRY —— 而且**必须按错误码判**，
       不能去匹配文案：一方面文案随语言与版本变，另一方面这个 if 的失败方向
       很坏（撞名会被当成未知错误 500，而调用方期待 409「已被占用」）。 */
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, '该用户名已被占用', { expose: true });
    }
    throw error;
  }

  await issueSession(req, res, user.id);
  sendJson(res, 201, { user: publicUser(user) });
});

/** 登录。所有失败路径的错误文案都由 tools/auth.js 统一，避免泄露用户名是否存在 */
on('POST', '/api/auth/login', async ({ req, res }) => {
  const body = await readJson(req);

  const user = await loginAccount({
    username: body.username,
    password: body.password,
    ip: clientIp(req)
  });

  await issueSession(req, res, user.id);
  sendJson(res, 200, { user: publicUser(user) });
});

/**
 * 退出。不读请求体，所以不校验 Content-Type —— 跨站表单虽然发得出这个请求，
 * 但 SameSite=Lax 让浏览器不会带上会话 cookie，因此它是个空操作。
 */
on('POST', '/api/auth/logout', async ({ req, res }) => {
  await revokeSession(req, res);
  sendJson(res, 200, { ok: true });
});

/**
 * 当前用户。**未登录回 200 + user: null，而不是 401。**
 *
 * 这个接口的职责是回答「现在是谁」，而「没有人」是一个正常答案。
 * 回 401 会让前端每次打开页面都在控制台留一条红色错误，
 * 而它其实只是还没登录。
 */
on('GET', '/api/me', async ({ req, res }) => {
  const user = await currentUser(req);

  sendJson(res, 200, {
    user: publicUser(user),
    // 本人可以看到自己密钥的掩码，用来确认「填的是不是那一把」。
    // 它刻意不在 publicUser 里 —— 那样管理员的用户列表也会带上，
    // 而「管理员看不到任何人的密钥信息」是有意的。
    deepseekKeyHint: user ? await userKeyHint(user.id) : null,
    quota: await quotaFor(req, user)
  });
});

/**
 * 这个人今天还能免费用几次公共密钥。null 表示不受这个限制。
 *
 * 【为什么配了自己密钥的人不显示】
 * 他们跑规划花的是自己的额度。给他们显示一个会一直往下掉的数字，
 * 只会让人以为「我的次数被限制了」—— 而实际上他们的用量跟这个数毫无关系。
 * 管理员同理（豁免）。
 */
async function quotaFor(req, user) {
  if (user && user.role === 'admin') return null; // 管理员豁免
  if (user && user.deepseek_key) return null; // 配了自己的密钥：花的是自己的额度

  const limit = await quota.dailyLimit();
  if (limit <= 0) return { limit: 0, used: 0, left: 0 };

  const { used, reserved } = await quota.usageOf(await quota.subjectFor(req));
  return { limit, used, left: Math.max(0, limit - used - reserved) };
}

/**
 * 填写 / 清除自己的 DeepSeek 密钥。
 * body.key 传 null 或空串表示清除，清除后规划回落到全局密钥。
 */
on('PUT', '/api/me/key', async ({ req, res }) => {
  const user = await requireUser(req);
  const body = await readJson(req);

  const result = await setUserKey(user, body.key === undefined ? null : body.key);
  sendJson(res, 200, { deepseekKeyHint: result.hint });
});

/* ---------- 管理后台（阶段 3） ----------
   这一组全部由 handleApi 里的前缀守卫统一要求管理员，处理函数直接取 ctx.admin。 */

on('GET', '/api/admin/users', async ({ res, admin }) => {
  sendJson(res, 200, {
    users: await userAdmin.listUsers(admin),
    // 界面要用它来决定「把最后一个管理员降级 / 禁用」的按钮该不该是灰的。
    // 服务端也会拦（见 tools/user-admin.js），这里只是提前告知，避免白点一次。
    adminCount: await userAdmin.adminCount()
  });
});

on('POST', '/api/admin/users/:id/role', async ({ req, res, params, admin }) => {
  const body = await readJson(req);
  sendJson(res, 200, { user: await userAdmin.setRole(admin, params.id, body.role) });
});

on('POST', '/api/admin/users/:id/disabled', async ({ req, res, params, admin }) => {
  const body = await readJson(req);
  sendJson(res, 200, {
    user: await userAdmin.setDisabled(admin, params.id, body.disabled === true)
  });
});

on('POST', '/api/admin/users/:id/password', async ({ req, res, params, admin }) => {
  const body = await readJson(req);
  sendJson(res, 200, { user: await userAdmin.resetPassword(admin, params.id, body.password) });
});

on('GET', '/api/admin/invites', async ({ res }) => {
  sendJson(res, 200, { invites: await listInvites(200), usable: await countUsable() });
});

on('POST', '/api/admin/invites', async ({ req, res, admin }) => {
  const body = await readJson(req);

  const maxUses = body.maxUses === undefined ? 1 : Number(body.maxUses);
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
    throw badRequest('使用上限需要是 1—1000 之间的整数');
  }

  let expiresAt = null;
  if (body.days !== undefined && body.days !== null && body.days !== '') {
    const days = Number(body.days);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      throw badRequest('有效期需要是 1—3650 天之间的数字');
    }
    expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
  }

  const invite = await createInvite({
    note: typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 120) : null,
    maxUses,
    expiresAt,
    createdBy: admin.id
  });

  await audit.record({
    actor: admin,
    action: 'invite.create',
    target: `invite:${invite.code}`,
    detail: `上限 ${invite.max_uses} 次${expiresAt ? '，有期限' : ''}`
  });

  sendJson(res, 201, { invite });
});

on('POST', '/api/admin/invites/:code/revoke', async ({ res, params, admin }) => {
  const code = normalizeCode(params.code);
  if (!(await revokeInvite(code))) {
    throw new HttpError(404, '找不到这个邀请码', { expose: true });
  }

  await audit.record({ actor: admin, action: 'invite.revoke', target: `invite:${code}` });
  sendJson(res, 200, { ok: true });
});

/* ---------- 密钥与设置（阶段 3） ---------- */

on('GET', '/api/admin/settings', async ({ res }) => {
  sendJson(res, 200, await describeKeys());
});

/**
 * 保存密钥。
 *
 * 【成对约束在服务端强制，不靠前端】
 * WebJS Key 与安全密钥必须来自同一次配置，混搭会得到 INVALID_USER_SCODE ——
 * 一个比「key 缺失」难查得多的错误。界面上是把两项放在一起提交的，
 * 但界面可以被绕过，所以这里也判一次。
 *
 * 传空串表示清除该项（回落到下一层）。
 */
on('PUT', '/api/admin/settings', async ({ req, res, admin }) => {
  assertAdmin(admin);
  const body = await readJson(req);
  const entries = [];

  /* 字段的三种语义，界面与服务端必须一致：
       不带这个字段        → 不变
       传 null            → 清除（回落到下一层来源）
       传非空字符串        → 设为这个值
     空串按「不变」处理 —— 界面上留空表示「不改这一项」，
     若把空串当成清除，管理员只想改一项时会误清另一项。 */
  if (body.amap === null) {
    entries.push({ key: KEY_WEBJS, value: null }, { key: KEY_SECURITY, value: null });
  } else if (body.amap !== undefined && body.amap !== null) {
    const webjsKey = String(body.amap.webjsKey == null ? '' : body.amap.webjsKey).trim();
    const securityCode = String(body.amap.securityCode == null ? '' : body.amap.securityCode).trim();

    if (!webjsKey || !securityCode) {
      throw badRequest(
        'WebJS Key 与安全密钥必须成对提供。只写一个的话，前端会当成没配、' +
          '静默回落到 config.js 里的静态值 —— 看起来像「改了没生效」'
      );
    }
    entries.push({ key: KEY_WEBJS, value: webjsKey }, { key: KEY_SECURITY, value: securityCode });
  }

  for (const [field, settingKey] of [
    ['amapServiceKey', KEY_AMAP_SERVICE],
    ['deepseekKey', KEY_DEEPSEEK]
  ]) {
    if (!(field in body)) continue;
    if (body[field] === null) {
      entries.push({ key: settingKey, value: null });
      continue;
    }
    const value = String(body[field]).trim();
    if (!value) continue;
    entries.push({ key: settingKey, value });
  }

  if (!entries.length) throw badRequest('没有要保存的内容');

  const changes = await setSettings(entries, admin.id);
  const changedKeys = changes.filter((c) => c.changed).map((c) => c.key);

  // 审计里只记「改了哪几项」，绝不记值 —— audit_log 是要被翻出来给人看的
  await audit.record({
    actor: admin,
    action: 'settings.set',
    target: changedKeys.join(', ') || null,
    detail: changes.map((c) => `${c.key} ${c.changed ? '已更新' : '与原值相同'}`).join('；')
  });

  sendJson(res, 200, {
    changes: changes.map((c) => ({ key: c.key, changed: c.changed })),
    ...(await describeKeys())
  });
});

on('GET', '/api/admin/settings/history', async ({ res, query }) => {
  sendJson(res, 200, { entries: await listSettingHistory(null, query.limit) });
});

/**
 * 回滚到某条历史记录的旧值。
 *
 * 换个 key 是不可灰度的高风险操作 —— 没有回滚就只能靠手抄一遍旧值回去，
 * 而那时候旧值多半已经没人记得了。
 */
on('POST', '/api/admin/settings/rollback', async ({ req, res, admin }) => {
  assertAdmin(admin);
  const body = await readJson(req);

  const result = await rollbackSetting(body.id, admin.id);

  await audit.record({
    actor: admin,
    action: 'settings.rollback',
    // 成对的项会一起回滚，两个键名都记上 —— 否则审计里看不出「其实动了两项」
    target: result.keys.join(', '),
    detail: `恢复到历史记录 #${body.id}`
  });

  sendJson(res, 200, {
    keys: result.keys,
    changed: result.changes.some((c) => c.changed),
    ...(await describeKeys())
  });
});

/* ---------- 配额（阶段 5） ---------- */

on('GET', '/api/admin/quota', async ({ res }) => {
  sendJson(res, 200, await quota.todayUsage(200));
});

on('PUT', '/api/admin/quota', async ({ req, res, admin }) => {
  assertAdmin(admin);
  const body = await readJson(req);

  let limit;
  try {
    limit = await quota.setDailyLimit(body.limit, admin.id);
  } catch (error) {
    throw badRequest(error.message);
  }

  await audit.record({
    actor: admin,
    action: 'quota.limit',
    detail: `每日 ${limit} 次`
  });

  sendJson(res, 200, await quota.todayUsage(200));
});

on('GET', '/api/admin/audit', async ({ res, query }) => {
  sendJson(res, 200, {
    entries: await audit.list({ limit: query.limit, action: query.action }),
    actions: audit.actionOptions()
  });
});

/* ---------- 行程与分享（阶段 6） ---------- */

/** 我存过的行程 */
on('GET', '/api/trips', async ({ req, res }) => {
  const user = await requireUser(req);
  sendJson(res, 200, { trips: await trips.listForUser(user.id, 100) });
});

/**
 * 取一份行程。
 * 有主人的只有本人（或管理员）能看；无主人的靠 id 本身当凭证 —— 见 tools/trips.js。
 */
on('GET', '/api/trips/:id', async ({ req, res, params }) => {
  const trip = await trips.get(params.id, await currentUser(req));
  if (!trip) throw new HttpError(404, '找不到这份行程', { expose: true });

  // 把 id 一并回给客户端 —— 前端靠它决定要不要显示分享按钮。
  // 不回的话，用 ?trip=<自己的 id> 打开时前端拿不到 id，反而把分享按钮藏了：
  // 存下来的行程分享不了，只有刚规划完的那一次能分享。
  sendJson(res, 200, { plan: Object.assign({}, trip.plan, { tripId: trip.id }), readOnly: false });
});

/**
 * 认领匿名行程。
 * 登录之后把之前（还没登录时）规划的那几份收进自己名下。
 * ids 由客户端从 sessionStorage 里带过来 —— 这是唯一的线索，
 * 服务端并不知道「哪些匿名行程是同一个人的」。
 */
on('POST', '/api/trips/claim', async ({ req, res }) => {
  const user = await requireUser(req);
  const body = await readJson(req);

  // 每一项是 { id, token }。**必须有 token** —— 只凭 id 认领的话，
  // 「看得到」就等于「夺得走」，而 id 按设计会出现在链接里。
  // 见 tools/trips.js 的 claim 与迁移 004。
  const claimed = await trips.claim(body.trips, user.id);

  sendJson(res, 200, { claimed });
});

/** 当前有没有生效的分享链接，有就给出 token，供界面显示「复制链接」 */
on('GET', '/api/trips/:id/share', async ({ req, res, params }) => {
  const trip = await trips.get(params.id, await currentUser(req));
  if (!trip) throw new HttpError(404, '找不到这份行程', { expose: true });
  sendJson(res, 200, { token: await trips.activeShare(trip.id) });
});

on('POST', '/api/trips/:id/share', async ({ req, res, params }) => {
  const token = await trips.createShare(params.id, await currentUser(req));
  sendJson(res, 200, { token });
});

on('DELETE', '/api/trips/:id/share', async ({ req, res, params }) => {
  const revoked = await trips.revokeShare(params.id, await currentUser(req));
  sendJson(res, 200, { revoked });
});

/**
 * 按分享链接读一份行程。**不需要登录。**
 * 这正是分享链接的意义 —— 发微信里给同行的人，他们不该先注册。
 * 只读：这条路径不返回任何可写的能力。
 */
on('GET', '/api/share/:token', async ({ res, params }) => {
  const shared = await trips.getByShare(params.token);
  if (!shared) throw new HttpError(404, '这个分享链接不存在或已被撤销', { expose: true });
  sendJson(res, 200, { plan: shared.plan, readOnly: true, city: shared.city });
});

/* ---------- 导出 PDF 用的静态地图 ---------- */

/**
 * 某一天的路线，渲染成一张 PNG。
 *
 * 不需要登录：行程本身就有 capability URL 那套（拿到 id 就能看），
 * 这张图不过是同一份数据的另一种画法，多一道鉴权挡不住什么，
 * 却会让「未登录时导出自己的行程」这条正常路径变得别扭。
 *
 * 颜色由前端传（当天主题色），不在服务端硬编码 —— 调色板住在
 * config.js 的 DAY_HUE 里，服务端没有理由再抄一份。
 */
on('GET', '/api/staticmap', async ({ res, query }) => {
  const day = Number(query.day);
  if (!Number.isInteger(day) || day < 0 || day > 30) {
    throw badRequest('day 需要是 0—30 之间的整数');
  }

  // 高德静态地图的尺寸上限是 1024×1024
  const w = Math.min(Math.max(Number(query.w) || 750, 200), 1024);
  const h = Math.min(Math.max(Number(query.h) || 420, 150), 1024);

  const color = /^0x[0-9A-Fa-f]{6}$/.test(String(query.color || ''))
    ? String(query.color)
    : '0x333333';

  const { buffer, contentType } = await staticMap.dayMap(day, { w, h }, color);

  /* 不走 sendJson：这是二进制。也刻意不带缓存头 ——
     同一张图内容确实不变，但导出是低频操作，缓存住反而会在
     改了行程数据之后仍然给出旧图，而那种错很难被察觉。 */
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store'
  });
  res.end(buffer);
});

/* 阶段 3 到此为止。后面的接口一律由对应阶段连同它的数据层一起加，
   不放「先占个位、以后再实现」的空壳 —— 空壳会让前端探到一个看起来正常的
   响应，掩盖「其实还没做」这件事。 */

module.exports = { on, handleApi, ROUTES };
