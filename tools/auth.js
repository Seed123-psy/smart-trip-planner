/**
 * 账号与登录。
 *
 * 覆盖三件事：用户表的读写、登录流程（含失败锁定），以及请求到用户的解析。
 *
 * 【两条贯穿全文的规矩】
 *
 * 1. 对外只给 publicUser()。users 行里有 password_hash 与 deepseek_key，
 *    任何一处「顺手把 user 回给前端」都是泄漏。所以这个文件里所有返回给
 *    路由层的用户对象都必须是 publicUser 的结果，而不是原始行。
 *
 * 2. 登录失败一律回同一句话「用户名或密码不正确」。「查无此人」与「密码错误」
 *    分开说，等于免费送出一个用户名枚举接口。
 *
 * 【迁移到 MySQL 时改了什么】
 * 大部分是机械的 async 化，但有**一处是结构性重做**：takeAttempt。
 * 它原先的正确性完全建立在「全程同步、无 await」之上（见那里的长注释），
 * 而 mysqli 驱动是异步的，那个前提消失了。换成事务 + FOR UPDATE 行锁来保证，
 * 并额外加了排序以避免死锁。
 */

'use strict';

const { getDb, withTransaction } = require('./db');
const { hashPassword, verifyPassword, needsRehash, burnPasswordTime } = require('./crypto-box');
const {
  HttpError,
  unauthorized,
  badRequest,
  getCookie,
  appendCookie,
  serializeCookie,
  clearCookie
} = require('./http');
const { COOKIE_NAME, getSession, createSession, destroySession } = require('./sessions');

/* ---------- 策略常量 ---------- */

/** 连续失败达到这个次数就锁定。与 tools/admin-cli.js 的说明、README 保持一致 */
const LOCK_THRESHOLD = 5;

/** 锁定时长：15 分钟。够挡住在线爆破，本人输错几次等一会儿能自己恢复 */
const LOCK_MS = 15 * 60 * 1000;

/** 口令最低长度。不限组成 —— 强制字符类别只会逼出 Passw0rd! 这类可预测写法 */
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 32;

/* ---------- 来源地址 ---------- */

function normalizeIp(ip) {
  // IPv4-mapped IPv6：::ffff:1.2.3.4 与 1.2.3.4 是同一个地址，
  // 不归一化的话同一台机器会在限流表里占两行，配额凭空翻倍
  return String(ip || '').replace(/^::ffff:/, '');
}

function isLoopback(ip) {
  const value = normalizeIp(ip);
  return value === '127.0.0.1' || value === '::1' || value.startsWith('127.');
}

/**
 * 该不该信任 X-Forwarded-* 系列请求头。
 *
 * 【为什么默认只在「对端是本机」时才信】
 * 这些头是客户端可以随便写的。无条件信任 XFF，等于让任何人伪造来源地址；
 * 无条件信任 X-Forwarded-Proto，则会在明文 HTTP 上被哄着种下 Secure cookie。
 * 而 nginx 与 Node 同机部署时，对端确实是 127.0.0.1，那时这些头才可信 ——
 * 这正是计划里的 CentOS 部署形态，所以不需要额外配置。
 *
 * 【TRUST_PROXY 是地址名单，不是开关】
 * 它最初被写成 TRUST_PROXY=1 就无条件信任。那不是「信任这台代理」，
 * 而是「信任所有人」：任何人直连 Node 端口再自带一个 X-Forwarded-For
 * 就能伪造来源地址，按 IP 的锁定与限流整条失效（实测：每请求换一个伪造
 * 的 XFF，8 次尝试零 429）。现在它接受逗号分隔的地址，只有对端确实
 * 在名单里才信任；代理在别的机器上时才需要设它。
 */
function trustedProxies() {
  return String(process.env.TRUST_PROXY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function trustsForwardedHeaders(req) {
  const peer = normalizeIp((req.socket && req.socket.remoteAddress) || '');
  if (isLoopback(peer)) return true;
  return trustedProxies().includes(peer);
}

/**
 * 取真实来源地址。
 *
 * 【取最后一段，不是第一段】
 * 这条一开始正好写反了，注释还理直气壮地写着「必须取第一段」。反了的原因是
 * 只想到了「代理覆盖写 XFF」那一种配置。而 nginx 最常见的写法是：
 *
 *   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
 *
 * 它是**把客户端自带的头原样保留，再把自己看到的来源追加在后面**。
 * 于是 `X-Forwarded-For: <攻击者随便写>, <真实来源>` —— 第一段完全由客户端
 * 控制，取第一段等于把伪造权交给对方。最后一段才是 nginx 自己追加的
 * $remote_addr，也就是真实来源。
 *
 * 这个取法在「代理覆盖写」的配置下同样正确（那时只有一段，首尾相同），
 * 所以它不挑 nginx 的写法。前提是**恰好一跳**可信代理；
 * 多跳时要改成「从右往左数第 (跳数) 段」。
 */
function clientIp(req) {
  const socketIp = normalizeIp((req.socket && req.socket.remoteAddress) || '');
  if (!trustsForwardedHeaders(req)) return socketIp;

  const header = String((req.headers && req.headers['x-forwarded-for']) || '');
  const parts = header.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return socketIp;

  return normalizeIp(parts[parts.length - 1]);
}

/**
 * 会话 cookie 该不该带 Secure。
 *
 * COOKIE_SECURE=auto（默认）按 X-Forwarded-Proto 判定，也就是「浏览器到 nginx
 * 那一段是不是 HTTPS」。nginx 会把真实协议放在这个头里，前提是配置了
 * proxy_set_header X-Forwarded-Proto $scheme —— 计划里的 nginx 配置片段有这一行。
 *
 * 【为什么这件事值得单独一个函数】
 * 判错的后果是「登录成功，一刷新就登出」：带 Secure 的 cookie 在 http 页面上
 * 发不出去，而服务端日志一切正常。这个现象极难查，所以 serve.js 在启动时
 * 会就这件事打一条醒目告警。
 */
function shouldSecureCookie(req) {
  const mode = String(process.env.COOKIE_SECURE || 'auto').toLowerCase();

  if (mode === '1' || mode === 'true' || mode === 'always') return true;
  if (mode === '0' || mode === 'false' || mode === 'never') return false;

  if (!trustsForwardedHeaders(req)) return false;
  const proto = String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim();
  return proto.toLowerCase() === 'https';
}

/* ---------- 校验 ---------- */

/**
 * 用户名归一化。
 *
 * 库里 username 列是 ascii_general_ci —— 那是 SQLite 版 COLLATE NOCASE 的对应物，
 * Alice 与 alice 本来就撞唯一键。
 *
 * 这里再显式转小写存，是为了让「比对口径」只有一处：那道 SQL 约束是**第二道**
 * 防线（防手改库、防日后有人放松 validateUsername 的正则），不是唯一的一道。
 * 旧版注释担心的「NOCASE 只对 ASCII 生效、塞进非 ASCII 名字会让约束静默失效」，
 * 在 MySQL 侧由列的字符集本身解决了 —— ascii 字符集根本不接受非 ASCII 字节。
 */
function normalizeUsername(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function validateUsername(value) {
  const name = normalizeUsername(value);
  if (name.length < MIN_USERNAME_LENGTH || name.length > MAX_USERNAME_LENGTH) {
    throw badRequest(`用户名需要 ${MIN_USERNAME_LENGTH}—${MAX_USERNAME_LENGTH} 个字符`);
  }
  // 只收 ASCII 字母数字与 _ - 。放开中文会带来同形字问题：
  // 西里尔字母 а 与拉丁 a 看起来一样，但大小写不敏感的比对认不出它们相等。
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw badRequest('用户名只能用小写字母、数字、下划线和连字符，且以字母或数字开头');
  }
  return name;
}

/**
 * 校验口令。
 *
 * @param {object} [options] allowShort —— 跳过最低长度要求。
 *
 * 【allowShort 只给一个地方用：create-admin --weak】
 * 那是站点的初始引导，在自己机器上、对着自己的库跑，口令定成什么由站长
 * 自己负责（本机试用时常用 admin/admin 这类）。**注册页与后台的「重置口令」
 * 都不传它** —— 那两条路面对的是真实用户，长度下限在那里才是有意义的。
 *
 * 空口令一律拒绝，允许短口令不等于允许没有口令。
 */
function validatePassword(value, options) {
  const password = String(value == null ? '' : value);
  const allowShort = Boolean(options && options.allowShort);

  if (!password) throw badRequest('口令不能为空');
  if (!allowShort && password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`口令至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw badRequest(`口令不能超过 ${MAX_PASSWORD_LENGTH} 位`);
  }
  return password;
}

/* ---------- 用户读写 ---------- */

async function findByUsername(username) {
  const db = await getDb();
  const [rows] = await db.execute('SELECT * FROM users WHERE username = ?', [
    normalizeUsername(username)
  ]);
  return rows[0] || null;
}

async function findById(id) {
  const db = await getDb();
  const [rows] = await db.execute('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0] || null;
}

/**
 * 建用户。口令在这里散列 —— 调用方永远不该碰 password_hash。
 * 用户名重复会撞唯一键抛错，由调用方转成「已被占用」。
 */
async function createUser({ username, password, role = 'user' }, options) {
  const name = validateUsername(username);
  const plain = validatePassword(password, options);

  const hash = await hashPassword(plain);
  const now = Date.now();

  const db = await getDb();
  // 旧版这里是 lastInsertRowid（node:sqlite 的形状），mysql2 给的是 insertId。
  // 这是全项目唯一一处需要取自增主键的插入。
  const [result] = await db.execute(
    'INSERT INTO users (username, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    [name, hash, role, now, now]
  );

  return findById(result.insertId);
}

/**
 * 去敏后的用户对象。**唯一可以回给客户端的形状。**
 *
 * 注意它不包含 deepseek_key，连密文也不给 —— 密文本身虽然解不开，
 * 但把它发到浏览器没有任何用处，而一旦流出去了，将来任何一次
 * 「换密钥忘了重新加密」都会变成可离线攻击的目标。
 * 需要展示「配没配」时用 hasDeepseekKey 这个布尔。
 */
function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    disabled: Boolean(user.disabled),
    hasDeepseekKey: Boolean(user.deepseek_key),
    createdAt: user.created_at
  };
}

/* ---------- 尝试额度与锁定 ---------- */

/**
 * 占一次尝试额度。返回 { allowed, until }。
 *
 * 【原子性的来源变了，这是迁移 MySQL 时唯一真正需要重新设计的地方】
 * 旧版的注释写着「全程同步、无 await —— 这就是它原子的全部理由」。异步化之后
 * 那句话不成立了，而它挡的正是下面记的那个实测。换来的保证是：
 * **整段放进一个事务，两个 subject 行按名称升序加写锁**。
 *
 * 为什么按名称排序：两个并发登录，一个先锁 u:alice 再锁 ip:A、另一个先锁
 * u:alice 再锁 ip:B —— 同序就不会成环。Node 只有一个线程，但这里并发的是
 * 两个**连接**，InnoDB 眼里它们是真并发，成环就是 ER_LOCK_DEADLOCK。
 *
 * 为什么是 SELECT ... FOR UPDATE 而不是一条 upsert：判断逻辑有四五个分支
 * （锁定中 / 锁刚过期 / 继续累加 / 首次），压进一条 SQL 要写成 IF() 嵌套 + 三态
 * affectedRows，可读性和可验证性都会显著变差 —— 而这块代码的正确性只能靠
 * 并发实测来确认，写成谜语就没法测了。
 *
 * 【为什么要把「判断 + 记账」压成一个函数】
 * 原来是「先读 locked_until 判断 → await verifyPassword（约 42ms）→ 失败后记账」。
 * 检查与记账之间隔着一次 await，于是同一批并发请求会**全部**通过那道检查，
 * 再各自去真校验 —— 阈值 5 只约束得住串行尝试。
 * 实测：40 个并发请求拿到 40 个 401（本该 5 个），之后等 15 分钟再来一批。
 *
 * 【语义变化】这里记的是**尝试**次数，不只是失败次数。
 * 成功登录会 clearFailures 把行删掉，所以「连续 5 次错口令就锁」的原意不变 ——
 * 中间成功一次即清零。代价是 6 个并发的**成功**登录里会有一个被挡；
 * 这个场景在私人站点上可以接受，换来的是阈值真的挡得住并发批量。
 *
 * 锁过期后从 1 重新数：否则一个账号被锁过一次，之后再错一次就立刻又被锁，
 * 那种「越用越紧」的规则很难向用户解释。
 */
async function takeAttempt(subjects) {
  const list = [...new Set(subjects.filter(Boolean))].sort();
  if (!list.length) return { allowed: true, until: 0 };

  return withTransaction(async (conn) => {
    const now = Date.now();

    let allowed = true;
    let until = 0;

    for (const subject of list) {
      /* FOR UPDATE：拿住这一行。行**不存在**时它锁的是间隙 ——
         这是这条语句唯一的边角：两个并发的首次尝试会有一个阻塞，
         阻塞的那个随后走 INSERT 分支，结果与串行执行一致。
         （不这么做的话两边都读到「没有行」，然后各插一条，其中一条撞主键。）*/
      const [rows] = await conn.execute(
        'SELECT fails, first_fail_at, locked_until FROM login_attempts WHERE subject = ? FOR UPDATE',
        [subject]
      );
      const row = rows[0];

      // 三列都要查出来。曾经只查了 fails 与 locked_until，于是下面的
      // row.first_fail_at 是 undefined —— 而**驱动拒绝绑定 undefined**
      // （null 是接受的），报出来的错完全看不出是漏选了一列。
      // mysql2 在这件事上比 node:sqlite 更严格：它直接抛
      // "Bind parameters must not contain undefined"，整条登录流程 500。
      if (row && row.locked_until !== null && row.locked_until > now) {
        allowed = false;
        until = Math.max(until, row.locked_until);
        continue;
      }

      const expired = Boolean(row) && row.locked_until !== null && row.locked_until <= now;
      const continuing = Boolean(row) && !expired;

      const fails = continuing ? row.fails + 1 : 1;
      const firstFailAt = continuing ? row.first_fail_at : now;
      const lockedUntil = fails >= LOCK_THRESHOLD ? now + LOCK_MS : null;

      if (lockedUntil) until = Math.max(until, lockedUntil);

      if (row) {
        await conn.execute(
          'UPDATE login_attempts SET fails = ?, first_fail_at = ?, locked_until = ? WHERE subject = ?',
          [fails, firstFailAt, lockedUntil, subject]
        );
      } else {
        await conn.execute(
          'INSERT INTO login_attempts (subject, fails, first_fail_at, locked_until) VALUES (?, ?, ?, ?)',
          [subject, fails, firstFailAt, lockedUntil]
        );
      }
    }

    return { allowed, until };
  });
}

async function clearFailures(subject) {
  if (!subject) return;
  const db = await getDb();
  await db.execute('DELETE FROM login_attempts WHERE subject = ?', [subject]);
}

/** 清掉早已失效的记录。没有它这张表只增不减，而伪造来源地址的请求能让它无限增长 */
async function purgeStaleAttempts() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const db = await getDb();
  const [result] = await db.execute(
    'DELETE FROM login_attempts WHERE (locked_until IS NULL OR locked_until <= ?) AND first_fail_at <= ?',
    [Date.now(), cutoff]
  );
  return result.affectedRows;
}

/* ---------- 登录 ---------- */

const WRONG_CREDENTIALS = '用户名或密码不正确';

/**
 * 校验用户名口令。成功返回用户行，失败抛 HttpError。
 *
 * 【为什么每条失败路径都要跑一次 scrypt】
 * 「查无此人」如果立刻返回，而「密码错误」要等 42ms，那时间差本身就是一个
 * 用户名枚举接口。所以未知用户走 burnPasswordTime()，被锁定的账号同理。
 *
 * @returns {Promise<object>} 用户行（尚未去敏，调用方要用 publicUser）
 */
async function login({ username, password, ip }) {
  const name = normalizeUsername(username);
  const accountSubject = name ? `u:${name}` : null;
  const ipSubject = ip ? `ip:${ip}` : null;

  // 额度先扣、再校验。顺序反过来的话，并发请求会一起穿过锁定检查 —— 见 takeAttempt 的说明
  const gate = await takeAttempt([accountSubject, ipSubject]);

  if (!gate.allowed) {
    /* 这条路径**不跑 scrypt**。

       原先跑了，理由是「别让 429 变成免费信号」。但 429 这个状态码本身
       就已经把状态说出去了，而代价是每个被限流的请求仍要占满一个线程池槽位
       约 42ms —— 攻击者只用廉价请求就能把 libuv 线程池（默认 4 个）打满，
       把静态资源读取与上游 DNS 一起拖住。
       实测：40 个被限流的请求让 styles/base.css 的响应从 2ms 涨到 395ms。

       少一个几乎无意义的计时信号，换掉一个真实的放大面，这笔账是划算的。 */
    const minutes = Math.max(1, Math.ceil((gate.until - Date.now()) / 60000));
    throw new HttpError(429, `尝试次数过多，请 ${minutes} 分钟后再试`, { expose: true });
  }

  const user = name ? await findByUsername(name) : null;

  if (!user) {
    await burnPasswordTime();
    throw unauthorized(WRONG_CREDENTIALS);
  }

  const ok = await verifyPassword(String(password == null ? '' : password), user.password_hash);

  // 失败不在这里再记一次 —— 额度已经在 takeAttempt 里扣过了。
  // 这也正是并发能挡住的原因：额度在 await verifyPassword 之前就已经落库了。
  if (!ok) throw unauthorized(WRONG_CREDENTIALS);

  // 被禁用的账号：口令先验过再说「已禁用」。
  // 顺序反过来的话，任何人输入任意口令都能问出「这个账号存在且被禁用了」。
  if (user.disabled) {
    throw new HttpError(403, '该账号已被禁用', { expose: true });
  }

  await clearFailures(accountSubject);
  await clearFailures(ipSubject);

  // 散列参数升级：scrypt 的 N 调大之后，老用户登录成功时顺手重算一遍。
  // 这一步失败不该影响登录本身 —— 用户已经证明了自己是谁。
  if (needsRehash(user.password_hash)) {
    try {
      const upgraded = await hashPassword(String(password));
      const db = await getDb();
      await db.execute('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
        upgraded,
        Date.now(),
        user.id
      ]);
    } catch {
      /* 升级失败就下次再说 */
    }
  }

  return user;
}

/* ---------- 会话 cookie ---------- */

/**
 * 种下会话 cookie 并返回明文 token。
 *
 * HttpOnly  —— JS 读不到，XSS 拿不走 token。
 * SameSite=Lax —— 挡住跨站表单带 cookie；不选 Strict 是因为那会让「从外部
 *   链接点进来」的第一次请求不带 cookie，表现为「点开分享链接显示未登录，
 *   刷新一下又好了」。Lax 已经挡掉了所有非 GET 的跨站提交。
 * Path=/    —— 全站可用。
 * Secure    —— 由 shouldSecureCookie 判定，见那里的说明。
 */
async function issueSession(req, res, userId) {
  const { token, expiresAt } = await createSession(userId, {
    userAgent: req.headers && req.headers['user-agent'],
    ip: clientIp(req)
  });

  appendCookie(
    res,
    serializeCookie(COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: shouldSecureCookie(req),
      maxAge: Math.floor((expiresAt - Date.now()) / 1000)
    })
  );

  return token;
}

/** 退出：服务端删会话 + 让浏览器丢掉 cookie。属性必须与种下时一致，否则删不掉 */
async function revokeSession(req, res) {
  const token = sessionToken(req);
  if (token) await destroySession(token);

  clearCookie(res, COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldSecureCookie(req)
  });
}

/* ---------- 请求 → 用户 ---------- */

/** 请求里带来的会话 token，没有则 null */
function sessionToken(req) {
  return getCookie(req, COOKIE_NAME) || null;
}

/**
 * 从请求里取当前用户行。未登录返回 null。
 *
 * 禁用的账号在 sessions.getSession 那一层就被挡掉了（那句 SQL 里带着
 * u.disabled = 0），所以这里不必再判一次 —— 管理员一禁用，对方手上的
 * cookie 下一个请求就失效。
 */
async function currentUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const session = await getSession(token);
  if (!session) return null;
  return findById(session.userId);
}

/** 必须已登录，否则 401 */
async function requireUser(req) {
  const user = await currentUser(req);
  if (!user) throw unauthorized('请先登录');
  return user;
}

/** 必须是管理员，否则 403（未登录则是 401，两者含义不同，不要合并） */
async function requireAdmin(req) {
  const user = await requireUser(req);
  if (user.role !== 'admin') throw new HttpError(403, '需要管理员权限', { expose: true });
  return user;
}

/**
 * 断言某个已经拿到手的用户对象确实是管理员。
 *
 * 纵深防御用：调用方（管理接口）本该已经过 requireAdmin，但那是**一次**
 * 判断。一旦那次判断被绕过（路径变体、将来多一个入口），没有这一层的后果
 * 不是「多看到一个列表」，而是「未认证的人重置了管理员的口令」——
 * 前面的教训是 handleApi 的 `//api/admin/users` 绕过，未认证就能改任意口令。
 *
 * 所以凡是无条件信任 ctx.admin 的处理函数，开头都该过一下这里。
 *
 * 它是**同步**的：只检查一个已经在手里的对象，不碰库。所以即便调用方漏了
 * await 也不会静默失效 —— 这是个有意保留的差异。
 */
function assertAdmin(actor) {
  if (!actor || actor.disabled || actor.role !== 'admin') {
    throw new HttpError(403, '需要管理员权限', { expose: true });
  }
  return actor;
}

module.exports = {
  LOCK_THRESHOLD,
  LOCK_MS,
  MIN_PASSWORD_LENGTH,
  clientIp,
  shouldSecureCookie,
  sessionToken,
  normalizeUsername,
  validateUsername,
  validatePassword,
  findByUsername,
  findById,
  createUser,
  publicUser,
  takeAttempt,
  clearFailures,
  purgeStaleAttempts,
  login,
  issueSession,
  revokeSession,
  currentUser,
  requireUser,
  requireAdmin,
  assertAdmin
};
