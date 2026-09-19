/**
 * 行程的落库、读取与分享。
 *
 * 【为什么在服务端落库，而不是让客户端再 POST 一次】
 * 规划结果是流式推回去的，客户端拿到之后可能已经切走、关掉标签页、
 * 或者干脆崩了。让它「收到之后再存一次」意味着那种情况下行程就没了 ——
 * 而服务端这边明明已经把整份结果握在手里。所以落库就在返回结果那一步做。
 *
 * 【未登录的行程也存】
 * user_id 为 null。这类行程靠 id 本身当凭证（16 个字符、80 位随机），
 * 谁拿到 id 谁能看 —— 也就是一条 capability URL。这换来的是未登录的人
 * 也能分享自己刚规划出来的行程，而代价仅仅是「id 泄露等于内容泄露」，
 * 对一个行程来说可以接受。
 *
 * 【迁移到 MySQL 时这一层有一处不是机械改动】
 * createShare 的 catch。旧的唯一约束换成了生成列（MySQL 没有部分索引，
 * 见 tools/schema-mysql.js 的迁移 004），但**抛出来的异常类型也换了**：
 * SQLite 报的是 "UNIQUE constraint failed"，MySQL 报的是 ER_DUP_ENTRY。
 * 那个 catch 原本是「什么都接」，现在只认 ER_DUP_ENTRY ——
 * 否则一个连接断开的错误会被当成「另一个进程刚建过」，然后去查一条根本
 * 不存在的记录，最后抛出一个与真实原因无关的错。
 */

'use strict';

const crypto = require('crypto');
const { getDb } = require('./db');
const { HttpError } = require('./http');

/**
 * id 的字符集与邀请码同一套（去掉 I/O/0/1），长度 16。
 * 邀请码是人类要手抄的，行程 id 是复制粘贴的 —— 但同一套字符集少一处要记。
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ID_LENGTH = 16;
const TOKEN_LENGTH = 20;
/** 认领凭证的长度。与分享 token 同量级（100 位），但用途完全不同，见迁移 004 */
const CLAIM_LENGTH = 20;

/** 一份行程 JSON 的大小上限。正常也就几十 KB，2MB 是宽松的余量 */
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

function randomId(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  // 字符集长度正好是 32，所以取低 5 位是均匀的，不需要拒绝采样
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

/**
 * 从计划结果里抽出几个便于列表展示的字段。抽不出来就不抽，不阻断落库。
 *
 * 字段取的是 planner 返回对象的**顶层** —— 那里有 city / startDate / days，
 * 没有嵌套的 trip 对象（一开始按 plan.trip.city 取，结果每条行程的
 * city 都是 null，而列表上就看不出这是哪儿的行程）。
 */
function summarize(plan) {
  const src = plan && typeof plan === 'object' ? plan : {};
  const city = typeof src.city === 'string' && src.city.trim() ? src.city.trim().slice(0, 40) : null;
  const days = Array.isArray(src.days) ? src.days.length : 0;

  // 没有现成的标题，就拼一个 —— 列表里只有 id 认不出是哪一次
  const title = city && days ? `${city} · ${days} 天` : city || null;

  return { city, title, days };
}

/**
 * 存一份行程。失败不抛异常 —— 落库失败不该让用户拿不到刚跑出来的行程。
 * @returns {Promise<{id: string}|null>}
 */
async function save({ plan, userId }) {
  if (!plan || typeof plan !== 'object') return null;

  let payload;
  try {
    payload = JSON.stringify(plan);
  } catch {
    return null;
  }
  // 按**字节**算，不是按 .length。JS 的字符串长度是 UTF-16 码元数，
  // 一个汉字算 1，而 UTF-8 里是 3 字节 —— 按 .length 判会让实际能入库的
  // 中文行程大出三倍，与上面 2MB 这个注释对不上。
  // 顺带一提：这个上限正是 payload 列必须用 MEDIUMTEXT 的原因 ——
  // MySQL 的 TEXT 只有 64KB，用它会抛 1406，而这里的检查根本挡不住。
  if (!payload || Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    console.warn('[行程] 结果过大，未落库');
    return null;
  }

  const id = randomId(ID_LENGTH);
  const claimToken = randomId(CLAIM_LENGTH);
  const info = summarize(plan);
  const now = Date.now();

  try {
    const db = await getDb();
    await db.execute(
      `INSERT INTO trips (id, user_id, title, city, payload, created_at, updated_at, claim_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId == null ? null : userId, info.title, info.city, payload, now, now, claimToken]
    );
  } catch (error) {
    console.error('[行程] 落库失败：', error && error.message);
    return null;
  }

  // claimToken 只在这一次响应里回给客户端 —— 它是「认领」的凭证，
  // 与行程 id（读凭证，会出现在链接里）刻意分开，见迁移 004 的说明
  return { id, claimToken };
}

function rowToSummary(row) {
  return {
    id: row.id,
    city: row.city,
    title: row.title,
    createdAt: row.created_at,
    owned: row.user_id !== null
  };
}

/**
 * 取一份行程。
 *
 * 权限只有两条：
 *   · 有主人的行程 —— 只有主人（或管理员）能看
 *   · 没有主人的行程 —— 谁拿到 id 谁能看（capability URL，见文件头）
 *
 * 注意这里**不**因为「请求方没登录」就把无主行程拒掉：未登录的人分享
 * 自己的行程正是要支持的事。
 */
async function get(id, viewer) {
  const db = await getDb();
  const [rows] = await db.execute('SELECT * FROM trips WHERE id = ?', [String(id || '')]);
  const row = rows[0];
  if (!row) return null;

  if (row.user_id !== null) {
    const isOwner = viewer && viewer.id === row.user_id;
    const isAdmin = viewer && viewer.role === 'admin';
    if (!isOwner && !isAdmin) return null;
  }

  let plan = null;
  try {
    plan = JSON.parse(row.payload);
  } catch {
    return null;
  }

  return { id: row.id, plan, createdAt: row.created_at, ownerId: row.user_id };
}

/** 某个用户存过的行程，新的在前。只给自己的列表用 */
async function listForUser(userId, limit) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const db = await getDb();
  const [rows] = await db.execute(
    'SELECT * FROM trips WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [Number(userId), cap]
  );
  return rows.map(rowToSummary);
}

/**
 * 把一批匿名行程认领给某个用户。登录之后把之前规划的收进来。
 *
 * @param {Array<{id: string, token: string}>} entries  id 与它对应的认领凭证
 * @returns {Promise<number>} 真正认领成功的条数
 *
 * 【为什么必须带 token】
 * 只凭 id 的话，「读」就等价于「夺」：行程 id 按设计会出现在链接里
 * （手工发出去的 trip.html?trip=<id>、浏览器历史、截图），拿到它的人
 * 登录一次就能把行程从原主人手里抢走 —— 原主人再打开是 404。
 * 而原主人往往根本没账号，连申诉的途径都没有。
 *
 * token 只在规划那一次的响应里给过，不进 URL、不进 payload、不进分享链接。
 *
 * 每条一次往返而不是拼一条大 UPDATE：上限 50 条，而拼 SQL 要让占位符数量
 * 随入参变化，那正是这个项目在 settings 的历史查询里唯一一处字符串拼 SQL
 * （那里元素是绑定参数所以安全，但多一处就多一处要审的地方）。
 */
async function claim(entries, userId) {
  if (!Array.isArray(entries) || !entries.length) return 0;

  const db = await getDb();
  const now = Date.now();

  let n = 0;
  for (const entry of entries.slice(0, 50)) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.token !== 'string') continue;
    // WHERE 里带着 AND user_id IS NULL，命中就必然改动 —— 与 CLIENT_FOUND_ROWS 无关
    const [result] = await db.execute(
      'UPDATE trips SET user_id = ?, updated_at = ? WHERE id = ? AND claim_token = ? AND user_id IS NULL',
      [Number(userId), now, entry.id, entry.token]
    );
    n += result.affectedRows;
  }
  return n;
}

/* ---------- 分享 ---------- */

/**
 * 建一条分享链接。同一条行程重复建会复用已有的那条 ——
 * 否则点几次「分享」就会留下一串谁也记不清的链接。
 */
async function createShare(tripId, viewer) {
  const trip = await get(tripId, viewer);
  if (!trip) throw new HttpError(404, '找不到这份行程', { expose: true });

  const db = await getDb();
  const [existingRows] = await db.execute(
    'SELECT token FROM trip_shares WHERE trip_id = ? AND revoked = 0 ORDER BY created_at DESC LIMIT 1',
    [trip.id]
  );
  const existing = existingRows[0];
  if (existing) return existing.token;

  const token = randomId(TOKEN_LENGTH);
  try {
    await db.execute(
      'INSERT INTO trip_shares (token, trip_id, created_by, created_at, revoked) VALUES (?, ?, ?, ?, 0)',
      [token, trip.id, viewer && viewer.id != null ? viewer.id : null, Date.now()]
    );
    return token;
  } catch (error) {
    /* 迁移 004 的那条唯一约束挡住了「同一行程两条生效分享」。
       这不是错误，是另一个进程刚建过 —— 把它那条取回来就是了。

       只认 ER_DUP_ENTRY：别的错（连接断了、列太长、外键不满足）必须原样
       抛出去，否则会变成一个查不出来的静默失败 —— 明明是一次基础设施故障，
       表现出来的却是「分享链接建好了」，而返回的 token 是别人那条。 */
    if (!error || error.code !== 'ER_DUP_ENTRY') throw error;

    const [racedRows] = await db.execute(
      'SELECT token FROM trip_shares WHERE trip_id = ? AND revoked = 0 LIMIT 1',
      [trip.id]
    );
    if (racedRows[0]) return racedRows[0].token;
    throw error;
  }
}

/**
 * 按分享 token 取行程。**不需要登录，也看不到是不是自己人的** ——
 * 这正是分享链接的意义。撤销之后立刻取不到。
 */
async function getByShare(token) {
  const db = await getDb();
  const [rows] = await db.execute(
    `SELECT t.payload, t.city, t.title, t.created_at
       FROM trip_shares s
       JOIN trips t ON t.id = s.trip_id
      WHERE s.token = ? AND s.revoked = 0`,
    [String(token || '')]
  );

  const row = rows[0];
  if (!row) return null;

  try {
    return { plan: JSON.parse(row.payload), city: row.city, title: row.title, createdAt: row.created_at };
  } catch {
    return null;
  }
}

/** 撤销一条分享。返回真的撤销了几条 */
async function revokeShare(tripId, viewer) {
  const trip = await get(tripId, viewer);
  if (!trip) throw new HttpError(404, '找不到这份行程', { expose: true });

  const db = await getDb();
  const [result] = await db.execute(
    'UPDATE trip_shares SET revoked = 1 WHERE trip_id = ? AND revoked = 0',
    [trip.id]
  );
  return result.affectedRows;
}

/** 这份行程当前有没有生效的分享链接，有就返回 token */
async function activeShare(tripId) {
  const db = await getDb();
  const [rows] = await db.execute(
    'SELECT token FROM trip_shares WHERE trip_id = ? AND revoked = 0 ORDER BY created_at DESC LIMIT 1',
    [String(tripId || '')]
  );
  return rows[0] ? rows[0].token : null;
}

/** 删掉一份行程。分享链接靠外键级联一起走 */
async function remove(tripId, viewer) {
  const trip = await get(tripId, viewer);
  if (!trip) throw new HttpError(404, '找不到这份行程', { expose: true });
  const db = await getDb();
  await db.execute('DELETE FROM trips WHERE id = ?', [trip.id]);
  return true;
}

/** 给后台看的量 */
async function count() {
  const db = await getDb();
  const [rows] = await db.execute('SELECT count(*) AS n FROM trips');
  return rows[0].n;
}

module.exports = {
  ID_LENGTH,
  save,
  get,
  getByShare,
  listForUser,
  claim,
  createShare,
  revokeShare,
  activeShare,
  remove,
  count
};
