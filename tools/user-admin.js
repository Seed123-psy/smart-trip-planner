/**
 * 管理员对账号的操作：改角色、禁用/启用、重置口令。
 *
 * 单独成文件而不是塞进 tools/auth.js：那边讲的是「怎么证明你是你」，
 * 这里讲的是「证明之后你能对别人做什么」。两者的失败模式完全不同 ——
 * 前者的漏洞是被人冒充，后者的漏洞是**管理员把自己关在门外**。
 *
 * 本文件的每条写操作都满足三件事：
 *   1. 有护栏（见下面各函数的注释）
 *   2. 记审计
 *   3. 只在确有必要时才动会话 —— 见 setDisabled / resetPassword
 *
 * 【迁移到 MySQL 时是机械的 async 化】唯一需要留意的是一处严格比较：
 * setDisabled 里的 `target.disabled === next`。它成立的前提是驱动把
 * TINYINT(1) 读成 JS number（1/0）而不是 boolean —— mysql2 的默认行为正是
 * 前者。tools/db.js 里刻意**没有**开 bigNumberStrings / typeCast 之类的选项，
 * 一旦有人加了，这里会静默地永远不相等（于是重复禁用会多写一次库、
 * 多删一次会话），所以那一处的注释里留了提示。
 */

'use strict';

const { getDb } = require('./db');
const { hashPassword } = require('./crypto-box');
const { findById, publicUser, validatePassword, assertAdmin } = require('./auth');
const { destroyAllForUser } = require('./sessions');
const { HttpError, badRequest } = require('./http');
const audit = require('./audit');

async function mustFind(id) {
  const user = await findById(Number(id));
  if (!user) throw new HttpError(404, '找不到这个账号', { expose: true });
  return user;
}

/** 当前可用的管理员数量（不含被禁用的） */
async function adminCount() {
  const db = await getDb();
  const [rows] = await db.execute("SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled = 0");
  return rows[0].n;
}

/**
 * 除开某人之后，还剩几个可用的管理员。
 *
 * 护栏必须用这个而不是 adminCount()。原先的条件是 `adminCount() <= 1`，
 * 而它只数「可用的」管理员 —— 于是当 A（在用）与 B（已禁用）两个管理员并存时，
 * adminCount() 返回 1，A 想把 B 降级会被误拦（B 本来就不可用，降他的级
 * 不影响可用管理员的数量）。改成「除开目标之后还剩几个」，条件才对准了它
 * 真正要保护的东西。
 */
async function usableAdminsExcluding(excludeId) {
  const db = await getDb();
  const [rows] = await db.execute(
    "SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?",
    [Number(excludeId)]
  );
  return rows[0].n;
}

/**
 * 账号列表。
 *
 * 每条带上 isSelf —— 界面据此把「改角色」「禁用」两个按钮置灰。
 *
 * 【为什么由服务端给这个标志，而不是前端自己算】
 * 前端原来算的是「role === 'admin' && adminCount <= 1」，而服务端的护栏
 * 后来改成了 usableAdminsExcluding（因为前者会误拦「降级一个已禁用的管理员」）。
 * 两处判断一分叉，界面就会出现「按钮灰着但其实允许」或者反过来
 * 「点了才报 409」。这里让服务端把结论直接给出来，前端不再自己算。
 *
 * 服务端真正的护栏是「不能对自己操作」—— 另一条「至少保留一个可用管理员」
 * 在今天的调用路径下到不了（操作者本身必然是可用管理员，目标又不是他自己，
 * 所以至少还剩他一个）。详见 setRole / setDisabled 里的说明。
 */
async function listUsers(viewer) {
  const db = await getDb();
  const [rows] = await db.execute('SELECT * FROM users ORDER BY created_at ASC');
  return rows.map((row) =>
    Object.assign(publicUser(row), { isSelf: Boolean(viewer) && viewer.id === row.id })
  );
}

/**
 * 改角色。
 *
 * 【为什么这里不需要销毁会话】
 * 会话里只存 userId，角色是每个请求现查的（tools/auth.js 的 currentUser）。
 * 所以降权立刻生效 —— 那个人的下一个请求就会被 requireAdmin 挡下。
 * 这正是「会话存服务端」相对 JWT 的好处：JWT 会把角色签进令牌里，
 * 改角色要等令牌过期才生效，除非再维护一张吊销表。
 */
async function setRole(actor, targetId, role) {
  assertAdmin(actor);
  if (role !== 'user' && role !== 'admin') throw badRequest('角色只能是 user 或 admin');

  const target = await mustFind(targetId);
  if (target.role === role) return publicUser(target);

  /* 两道护栏。

     第一道「不能改自己」是主力：没有它，唯一的管理员一次误点就把自己降成
     普通用户，从此没人能进后台，只能去机器上敲命令行恢复。

     第二道只在该触发的时候触发：目标是**可用的**管理员，且去掉他之后
     一个可用管理员都不剩。这里必须用 usableAdminsExcluding 而不是
     adminCount() —— 后者只数可用管理员，会在「A 在用、B 已禁用」时
     误拦 A 去降级 B（而 B 本来就不可用）。 */
  if (actor.id === target.id) {
    throw new HttpError(409, '不能修改自己的角色', { expose: true });
  }
  if (target.role === 'admin' && !target.disabled && (await usableAdminsExcluding(target.id)) === 0) {
    throw new HttpError(409, '至少要保留一个可用的管理员', { expose: true });
  }

  const db = await getDb();
  await db.execute('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', [
    role,
    Date.now(),
    target.id
  ]);

  await audit.record({
    actor,
    action: 'user.role',
    target: `u:${target.username}`,
    detail: `${target.role} → ${role}`
  });

  return publicUser(await findById(target.id));
}

/**
 * 禁用 / 启用。
 *
 * 【禁用时要把会话一起删掉，理由不是「立刻生效」】
 * 立刻生效这一点 sessions.getSession 里那句 `u.disabled = 0` 已经保证了。
 * 删会话是为了**启用之后**：不删的话，对方半年前那个 cookie 会随着
 * 「解除禁用」一起复活 —— 而管理员按下启用，想表达的显然是「他可以重新登录」，
 * 不是「他那些旧会话又都算数了」。
 */
async function setDisabled(actor, targetId, disabled) {
  assertAdmin(actor);
  const target = await mustFind(targetId);
  const next = disabled ? 1 : 0;
  // 严格比较：next 是 number，target.disabled 也必须是 number（见文件头）
  if (target.disabled === next) return publicUser(target);

  if (next === 1) {
    if (actor.id === target.id) {
      throw new HttpError(409, '不能禁用自己的账号', { expose: true });
    }
    // 同 setRole：判的是「去掉这个可用管理员之后还剩不剩」
    if (target.role === 'admin' && !target.disabled && (await usableAdminsExcluding(target.id)) === 0) {
      throw new HttpError(409, '至少要保留一个可用的管理员', { expose: true });
    }
  }

  const db = await getDb();
  await db.execute('UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?', [
    next,
    Date.now(),
    target.id
  ]);

  const killed = next === 1 ? await destroyAllForUser(target.id) : 0;

  await audit.record({
    actor,
    action: next === 1 ? 'user.disable' : 'user.enable',
    target: `u:${target.username}`,
    detail: next === 1 ? `已清除 ${killed} 个会话` : null
  });

  return publicUser(await findById(target.id));
}

/**
 * 重置口令。返回新口令本身，由调用方负责交给用户 —— 这里不做「生成随机口令」
 * 那种事，因为那就得把明文口令存在某个地方或显示一次，反而多一份泄漏面。
 * 管理员自己想一个临时口令，让用户登录后改。
 *
 * 和禁用同理，重置口令要清掉全部会话：提起这件事的场合，
 * 十有八九是「我怀疑号被人登了」。
 */
async function resetPassword(actor, targetId, newPassword) {
  assertAdmin(actor);
  const target = await mustFind(targetId);
  const plain = validatePassword(newPassword);

  const hash = await hashPassword(plain);
  const db = await getDb();
  await db.execute('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
    hash,
    Date.now(),
    target.id
  ]);

  const killed = await destroyAllForUser(target.id);

  await audit.record({
    actor,
    action: 'user.password',
    target: `u:${target.username}`,
    // 只记「重置了」，绝不记口令本身
    detail: `已清除 ${killed} 个会话`
  });

  return publicUser(await findById(target.id));
}

module.exports = { listUsers, setRole, setDisabled, resetPassword, adminCount, usableAdminsExcluding };
