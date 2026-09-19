/**
 * 登录会话。
 *
 * 会话存在服务端的 sessions 表里，而不是签一个自包含的 JWT。理由是管理员
 * 禁用某人时，那一瞬间所有会话就该失效 —— JWT 做不到这点，除非再维护一张
 * 吊销表，那还不如一开始就存库。
 *
 * 【库里只存 sha256(token)】
 * 明文 token 只在 Set-Cookie 那一刻存在于内存里。库被读走也没法拿去冒充 ——
 * 前提是 token 本身足够随机，32 字节满足。
 * 这里用 sha256 而不是 scrypt：token 是高熵随机串，不存在字典攻击，
 * 慢哈希只会让每个请求都多花 42ms。
 *
 * 【本文件在迁移到 MySQL 时是纯机械改造】
 * 每个函数加 async、每条语句加 await，没有任何设计上的取舍要重新做 ——
 * 这一层没有依赖「同步执行」的并发假设（要读-判断-写的那些都在 auth.js 与
 * quota.js 里）。所以它是整条依赖链的最底层，先改它。
 */

'use strict';

const crypto = require('crypto');
const { getDb } = require('./db');

/** 会话有效期：30 天。低频使用的站点，太短会让每次进来都要重登 */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 剩余不足这个时长时顺延，让活跃用户不会在第 30 天被踢出去 */
const RENEW_WHEN_REMAINING_MS = TTL_MS / 2;

/**
 * last_seen_at 的写入节流。每个请求都写库会产生无意义的写放大 ——
 * 旧版这里写的是「WAL 增长」，那个说法随 SQLite 一起没了，
 * 但节流本身照样需要：热点行的写锁会让并发的会话续期互相等待。
 */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

const TOKEN_BYTES = 32;

/** Cookie 名。改这里要连同 login.html 与前端脚本一起改 */
const COOKIE_NAME = 'sid';

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * 建会话，返回明文 token —— 这是它唯一一次以明文出现。
 *
 * @returns {Promise<{token: string, expiresAt: number}>}
 */
async function createSession(userId, meta) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const now = Date.now();
  const expiresAt = now + TTL_MS;

  const db = await getDb();
  await db.execute(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      hashToken(token),
      userId,
      now,
      expiresAt,
      now,
      ((meta && meta.userAgent) || '').slice(0, 300) || null,
      (meta && meta.ip) || null
    ]
  );

  return { token, expiresAt };
}

/**
 * 按 token 取会话。取不到、已过期、用户被禁用 —— 一律返回 null。
 *
 * 顺带做两件写操作，都做了节流，避免「每个请求写两次库」：
 *   · last_seen_at 超过一小时才更新一次
 *   · 剩余有效期不足一半才顺延（活跃用户因此永远不会被踢，代价是约每 15 天写一次）
 */
async function getSession(token) {
  if (!token) return null;

  const db = await getDb();
  const [rows] = await db.execute(
    `SELECT s.token_hash, s.user_id, s.expires_at, s.last_seen_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND u.disabled = 0`,
    [hashToken(token)]
  );

  const row = rows[0];
  if (!row) return null;

  const now = Date.now();
  if (row.expires_at <= now) {
    await db.execute('DELETE FROM sessions WHERE token_hash = ?', [row.token_hash]);
    return null;
  }

  if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
    await db.execute('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', [
      now,
      row.token_hash
    ]);
  }

  if (row.expires_at - now < RENEW_WHEN_REMAINING_MS) {
    await db.execute('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', [
      now + TTL_MS,
      row.token_hash
    ]);
  }

  return { userId: row.user_id, expiresAt: row.expires_at };
}

/** 退出登录 */
async function destroySession(token) {
  if (!token) return false;
  const db = await getDb();
  const [result] = await db.execute('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
  return result.affectedRows > 0;
}

/**
 * 干掉某个用户的全部会话。
 * 禁用、改口令、降权之后都要调 —— 否则旧会话还能继续用，
 * 「管理员禁用某人」这件事就会看起来没生效。
 */
async function destroyAllForUser(userId) {
  const db = await getDb();
  const [result] = await db.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
  return result.affectedRows;
}

/** 清掉已过期的行。启动时与每天各跑一次即可，不必更频繁 */
async function purgeExpired() {
  const db = await getDb();
  const [result] = await db.execute('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
  return result.affectedRows;
}

module.exports = {
  COOKIE_NAME,
  TTL_MS,
  createSession,
  getSession,
  destroySession,
  destroyAllForUser,
  purgeExpired
};
