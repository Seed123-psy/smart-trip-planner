/**
 * 用户自己那把 DeepSeek 密钥。
 *
 * 单独成文件而不是并进 tools/user-admin.js：那边是**管理员对别人**的操作，
 * 这里是**用户对自己**的操作。权限模型完全不同，混在一起早晚会写出
 * 「管理员顺手替谁改了密钥」这种谁都没打算做的事。
 *
 * 【加密的 AAD 绑定到 userId】
 * 于是把 A 的密文粘到 B 的行里也解不开。少了这一条，一个能写库的人
 * （或者一次误操作）可以把别人的密钥搬到自己的账号下 —— 密文本身完好，
 * 系统完全看不出异常，而后果是「用别人的 key 消耗别人的额度」。
 *
 * 【迁移到 MySQL 时是机械的 async 化】注意 setUserKey 里清除分支的位置：
 * 它在 encryptionAvailable() 检查**之前**，所以没有 APP_SECRET 时也清得掉
 * 作废的密文 —— 而这恰恰是「APP_SECRET 换过、库里有解不开的僵尸密文」时
 * 最需要的那条路径（本项目已经踩过一次，见 README 与记忆）。
 */

'use strict';

const { getDb } = require('./db');
const { seal, open, encryptionAvailable } = require('./crypto-box');
const { HttpError, badRequest } = require('./http');
const { currentUser } = require('./auth');
const audit = require('./audit');

/** DeepSeek 的密钥历来是 sk- 开头的一长串。只卡下限，不卡前缀 —— 格式变了不该被这里挡住 */
const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 200;

function aadFor(userId) {
  return `u:${userId}`;
}

/**
 * 取用户的密钥明文。
 * @returns {Promise<{value: string|null, status: 'ok'|'missing'|'undecryptable'}>}
 *
 * status 必须区分「没配」与「解不开」：前者该安静地回落到全局密钥，
 * 后者**绝不能回落** —— 那会烧站长的额度，还让用户以为自己用的是自己的 key。
 */
async function getUserKey(userId) {
  let raw;
  try {
    const db = await getDb();
    const [rows] = await db.execute('SELECT deepseek_key FROM users WHERE id = ?', [Number(userId)]);
    const row = rows[0];
    raw = row && row.deepseek_key != null ? String(row.deepseek_key).trim() : null;
  } catch {
    return { value: null, status: 'missing' };
  }

  if (!raw) return { value: null, status: 'missing' };

  // 老数据或手改过的行可能不是信封格式，open 会返回 null，与「密钥换过」同一处理
  const plain = open(raw, aadFor(userId));
  return plain === null ? { value: null, status: 'undecryptable' } : { value: plain, status: 'ok' };
}

/** 掩码。只露头三位与末四位 —— 够本人确认「填的是不是那一把」，不足以拿去用 */
function maskKey(value) {
  if (!value) return null;
  if (value.length <= 12) return '•'.repeat(value.length);
  return `${value.slice(0, 3)}••••${value.slice(-4)}`;
}

/** 本人看到的提示（/api/me 用）。未配返回 null */
async function userKeyHint(userId) {
  const stored = await getUserKey(userId);
  if (stored.status === 'ok') return maskKey(stored.value);
  // 解不开时给一句能照着做的话，而不是装作没配过 ——
  // 装作没配过会让人以为「我的密钥丢了」，而实际是服务端主密钥换了
  if (stored.status === 'undecryptable') return '（无法解密，请重新填写）';
  return null;
}

/**
 * 保存 / 清除自己的密钥。
 *
 * 走的是 users.deepseek_key 这一列，不是 settings 表 —— settings 是全局的，
 * 而这一项每人一份。
 */
async function setUserKey(user, value) {
  const db = await getDb();

  if (value === null || value === undefined || String(value).trim() === '') {
    await db.execute('UPDATE users SET deepseek_key = NULL, updated_at = ? WHERE id = ?', [
      Date.now(),
      user.id
    ]);
    await audit.record({ actor: user, action: 'user.key.clear', target: `u:${user.username}` });
    return { cleared: true, hint: null };
  }

  if (!encryptionAvailable()) {
    // 明确报出来，而不是把明文存进去 —— 后者会把「没配 APP_SECRET」
    // 变成一个安静的、事后很难发现的数据泄漏
    throw new HttpError(
      409,
      '服务端未配置 APP_SECRET，暂时无法保存密钥。请联系站长。',
      { expose: true }
    );
  }

  const clean = String(value).trim();
  if (clean.length < MIN_KEY_LENGTH || clean.length > MAX_KEY_LENGTH) {
    throw badRequest(`密钥长度看起来不对（应在 ${MIN_KEY_LENGTH}—${MAX_KEY_LENGTH} 之间），请检查是否复制完整`);
  }
  // 密钥里不该有空白。复制粘贴时最常见的问题是带进了换行或空格，
  // 那种密钥要去调用时才会报一个难懂的 401
  if (/\s/.test(clean)) {
    throw badRequest('密钥里不能有空格或换行，请重新复制');
  }

  await db.execute('UPDATE users SET deepseek_key = ?, updated_at = ? WHERE id = ?', [
    seal(clean, aadFor(user.id)),
    Date.now(),
    user.id
  ]);

  // 审计只记「填了」，绝不记值
  await audit.record({ actor: user, action: 'user.key.set', target: `u:${user.username}` });

  return { cleared: false, hint: maskKey(clean) };
}

/**
 * 本次规划该用谁的密钥。路由层共同的一份判断（本地 serve.js 与线上 api/plan.js）。
 *
 * @returns {Promise<{options: {deepseekKey: string}|null, owner: 'user'|'global', user: object|null}>}
 *          options 直接透传给 plan()；owner 供日志与阶段 5 的配额区分对象。
 *
 * 【解密失败绝不回落到全局】
 * 那是烧站长的额度，同时让用户以为自己在用自己的 key —— 两件事同时错，
 * 而且都不会有人发现。宁可让这次规划失败并明确告诉他去重填。
 */
async function resolvePlanKey(req) {
  const user = await currentUser(req);
  if (!user) return { options: null, owner: 'global', user: null };

  const stored = await getUserKey(user.id);

  if (stored.status === 'ok') {
    return { options: { deepseekKey: stored.value }, owner: 'user', user };
  }

  if (stored.status === 'undecryptable') {
    throw new HttpError(
      409,
      '你配置的 DeepSeek 密钥解不开（服务端主密钥可能换过），请到账号页重新填写。' +
        '这次规划不会回落到站长的密钥。',
      { expose: true }
    );
  }

  // 没配过自己的 → 用全局的。阶段 5 会在这里挂上每日配额
  return { options: null, owner: 'global', user };
}

module.exports = {
  getUserKey,
  setUserKey,
  userKeyHint,
  resolvePlanKey,
  maskKey,
  MIN_KEY_LENGTH
};
