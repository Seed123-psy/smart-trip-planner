/**
 * 邀请码。
 *
 * 注册必须凭邀请码，所以这个文件里最要紧的一件事是**核销必须是原子的**。
 * 「先查还能不能用，再 UPDATE」这种写法在并发下会把同一个码用掉两次：
 * 两个请求同时查到 used_count=0，然后各自 +1。
 *
 * 【原子性靠什么 —— 迁移到 MySQL 时这条理由换了】
 * 旧版写的是：「SQLite 是单线程执行语句，所以把判断塞进 UPDATE 的 WHERE 里、
 * 靠 changes 判定结果，就是原子的一条。这里不能插任何 await。」
 *
 * 现在本文件里到处都是 await（驱动是异步的），但**结论没变**，因为真正提供
 * 原子性的从来不是「单线程」，而是「判断和修改在同一条 UPDATE 里」：
 * InnoDB 执行这条 UPDATE 时会锁住匹配的行，读到的是最新已提交版本，
 * 第二个请求要么等锁、要么在重新求值 WHERE 后不匹配。两种结果都对。
 *
 * 反过来说，「先 getInvite() 再决定要不要更新」依然是错的 —— 那不是因为
 * 中间有 await，而是因为那是两条独立语句，中间必然存在窗口。
 */

'use strict';

const crypto = require('crypto');
const { getDb } = require('./db');

/**
 * 邀请码字符集：32 个字符，去掉了容易看错的 I / O / 0 / 1。
 * 邀请码是要手抄、要念给别人听的，认错一个字符的代价是被拒一次。
 *
 * 长度正好是 32 是有意的：取字节的低 5 位就能均匀映射，不需要做拒绝采样
 * （对非 2 的幂的长度取模会让前面的字符出现得更频繁）。
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

/** 用户手抄时可能写成小写，统一按大写存与比 */
function normalizeCode(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

/**
 * 建邀请码。
 * @param {{note?: string, maxUses?: number, expiresAt?: number|null, createdBy?: number|null}} options
 */
async function createInvite(options) {
  const opt = options || {};
  const code = opt.code ? normalizeCode(opt.code) : generateCode();
  const maxUses = Number.isFinite(opt.maxUses) && opt.maxUses > 0 ? Math.floor(opt.maxUses) : 1;

  const db = await getDb();
  await db.execute(
    'INSERT INTO invite_codes (code, note, created_by, created_at, expires_at, max_uses, used_count, revoked) VALUES (?, ?, ?, ?, ?, ?, 0, 0)',
    [
      code,
      opt.note || null,
      opt.createdBy == null ? null : opt.createdBy,
      Date.now(),
      opt.expiresAt || null,
      maxUses
    ]
  );

  return getInvite(code);
}

async function getInvite(code) {
  const db = await getDb();
  const [rows] = await db.execute('SELECT * FROM invite_codes WHERE code = ?', [normalizeCode(code)]);
  return rows[0] || null;
}

/**
 * 核销一个邀请码。成功返回 true，码不存在 / 已撤销 / 用尽 / 过期都返回 false。
 *
 * 全部条件都在 WHERE 里，由数据库一次性判定。调用方**不要**先 getInvite()
 * 再决定要不要调这个函数 —— 那样又变回了「先查后改」，中间隔着一次
 * 网络往返的话，并发窗口比想象的大得多。
 *
 * 返回值的依据是 affectedRows === 1。这条 UPDATE 的 WHERE 里带着
 * `used_count < max_uses`，命中就必然把值改掉，所以它与
 * CLIENT_FOUND_ROWS 开不开无关。
 */
async function redeem(code) {
  const db = await getDb();
  const [result] = await db.execute(
    `UPDATE invite_codes
        SET used_count = used_count + 1
      WHERE code = ?
        AND revoked = 0
        AND used_count < max_uses
        AND (expires_at IS NULL OR expires_at > ?)`,
    [normalizeCode(code), Date.now()]
  );

  return result.affectedRows === 1;
}

/**
 * 退还一次核销。
 *
 * 唯一的调用点是注册流程：核销成功但建号失败（用户名撞车、库出错）时，
 * 不退的话一次重名就白白废掉一个邀请码 —— 而那是站长手工发出去的。
 *
 * 条件写 `used_count > 0` 是防重入：退款只应该抵消一次真实核销。
 */
async function refund(code) {
  const db = await getDb();
  const [result] = await db.execute(
    'UPDATE invite_codes SET used_count = used_count - 1 WHERE code = ? AND used_count > 0',
    [normalizeCode(code)]
  );
  return result.affectedRows === 1;
}

/**
 * 撤销。已用掉的不退还 —— 用它注册出来的账号不会因此消失。
 *
 * 【这里返回值依赖 CLIENT_FOUND_ROWS】
 * `SET revoked = 1 WHERE code = ?` 不带让值必然改变的谓词：对一个**已经撤销**
 * 的码再调一次，MySQL 默认的 affectedRows 是 0（没有行被改动），
 * 而 SQLite 的 changes 是 1。打开 CLIENT_FOUND_ROWS 后两者一致 ——
 * 那正是这里的原意：false 只应该表示「找不到这个码」，
 * 调用方据此回 404（见 tools/api-router.js 的撤销接口）。
 */
async function revoke(code) {
  const db = await getDb();
  const [result] = await db.execute('UPDATE invite_codes SET revoked = 1 WHERE code = ?', [
    normalizeCode(code)
  ]);
  return result.affectedRows > 0;
}

/** 列出邀请码，新的在前。不回 code 以外的任何敏感信息（本来也没有） */
async function listInvites(limit) {
  const db = await getDb();
  const [rows] = await db.execute('SELECT * FROM invite_codes ORDER BY created_at DESC LIMIT ?', [
    Math.min(Math.max(Number(limit) || 50, 1), 500)
  ]);
  return rows;
}

/** 还能用的码还有几个。用于后台首页与「该发新码了」的提醒 */
async function countUsable() {
  const db = await getDb();
  const [rows] = await db.execute(
    `SELECT count(*) AS n FROM invite_codes
      WHERE revoked = 0 AND used_count < max_uses
        AND (expires_at IS NULL OR expires_at > ?)`,
    [Date.now()]
  );
  return rows[0].n;
}

module.exports = {
  CODE_LENGTH,
  generateCode,
  normalizeCode,
  createInvite,
  getInvite,
  redeem,
  refund,
  revoke,
  listInvites,
  countUsable
};
