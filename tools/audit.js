/**
 * 审计日志：管理员做过什么。
 *
 * 【和 settings_history 的分工】
 * settings_history 记的是「某一项设置被改成了什么」，它服务于「回滚」；
 * 这张表记的是「谁、什么时候、对谁做了什么」，服务于「追查」。
 * 两者有重叠（改设置时都会记一条），但回答的问题不同，所以都留着。
 *
 * 【绝不记录密钥明文】detail 里只放「改了哪一项」这类元信息。
 * 密钥的值一律不进审计表 —— 审计表是要被翻出来给人看的，
 * 而密钥不该出现在任何给人看的地方。
 *
 * 【迁移到 MySQL 时是纯机械的 async 化】三个函数都没有事务、
 * 也不依赖「同步执行」这条前提，所以唯一要做的就是加 async / await。
 */

'use strict';

const { getDb } = require('./db');

/**
 * 动作名 → 中文标签。
 *
 * 集中在这里而不是散在各个调用点，是为了让后台的筛选下拉框能直接列出来，
 * 也为了以后改文案时只有一处要改。
 * 命名口径：<对象>.<动作>，全小写。
 */
const ACTIONS = {
  'user.create': '创建账号',
  'user.key.set': '填写自己的密钥',
  'user.key.clear': '清除自己的密钥',
  'user.role': '修改角色',
  'user.disable': '禁用账号',
  'user.enable': '启用账号',
  'user.password': '重置口令',
  'invite.create': '生成邀请码',
  'invite.revoke': '撤销邀请码',
  'quota.limit': '调整每日配额',
  'settings.set': '修改设置',
  'settings.clear': '清除设置',
  'settings.rollback': '回滚设置'
};

/** 给界面用的一份清单 */
function actionOptions() {
  return Object.entries(ACTIONS).map(([value, label]) => ({ value, label }));
}

function labelOf(action) {
  return ACTIONS[action] || action;
}

/**
 * 记一条。
 *
 * @param {{actor?: object|null, action: string, target?: string|null, detail?: string|null}} entry
 *   actor —— 用户行（要有 id 与 username），或 null 表示系统 / 命令行。
 *            命令行操作没有登录态，用 null；但 actor_name 会写成「命令行」，
 *            不能留空，否则事后看不出这条是谁干的。
 *
 * 【调用方应当 await 它】审计写入失败不该让主流程失败（调用方自己 try 住即可），
 * 但不 await 的话失败会变成一个未处理的 promise rejection，
 * 在 Node 上是会打一整片警告甚至终止进程的。
 */
async function record(entry) {
  const actor = entry.actor || null;
  const actorName = actor && actor.username ? actor.username : '命令行';

  const db = await getDb();
  await db.execute(
    'INSERT INTO audit_log (at, actor_id, actor_name, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)',
    [
      Date.now(),
      actor ? actor.id : null,
      actorName,
      String(entry.action),
      entry.target == null ? null : String(entry.target),
      entry.detail == null ? null : String(entry.detail)
    ]
  );
}

/**
 * 列最近的记录。
 * @param {{limit?: number, action?: string}} options
 */
async function list(options) {
  const opt = options || {};
  const limit = Math.min(Math.max(Number(opt.limit) || 100, 1), 500);

  const db = await getDb();
  // 带 id 作并列时的次序：同一毫秒内的几条记录，先后不能是随机的 ——
  // 「这个管理员刚做了什么」是审计最常回答的问题
  const [rows] = opt.action
    ? await db.execute('SELECT * FROM audit_log WHERE action = ? ORDER BY at DESC, id DESC LIMIT ?', [
        String(opt.action),
        limit
      ])
    : await db.execute('SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?', [limit]);

  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    actionLabel: labelOf(row.action),
    target: row.target,
    detail: row.detail
  }));
}

async function count() {
  const db = await getDb();
  const [rows] = await db.execute('SELECT count(*) AS n FROM audit_log');
  return rows[0].n;
}

module.exports = { ACTIONS, actionOptions, labelOf, record, list, count };
