/**
 * 每日配额。
 *
 * 只管一件事：**没配自己密钥的人，一天能用公共密钥跑几次规划**。
 * 配了自己密钥的人走自己的额度，不占这里的数。
 *
 * 【为什么必须有「预留」这个概念】
 * 一次规划要跑 30—90 秒。如果只在开始时检查、结束时才记数，那并发下
 * 这条检查形同虚设：5 个请求会一起看到 used = 0，然后全部放行。
 * 所以进来先「预留」一格（reserved + 1），跑完再结算（reserved - 1，used + 1）。
 * 中途失败则退回预留，不记用量。
 *
 * 【原子性靠什么 —— 迁移到 MySQL 时这条前提换了，是本文件最需要重读的一段】
 *
 * 旧版写的是：「靠『同步、无 await』。Node 是单线程，只要预留那一步从头到尾
 * 不交出控制权，两个请求就不可能穿插。」
 *
 * 换成 MySQL 之后那句话不再成立（驱动是异步的），但**结论没有变**，只是理由
 * 换了一条：原子性现在来自 **InnoDB 的当前读 + 行锁**。UPDATE 不是快照读，
 * 它读到的是最新已提交版本并锁住那一行；第二个请求会阻塞到第一个提交，
 * 然后**基于新值重新求值 WHERE**。
 *
 * 所以「判断写在 WHERE 里、不写在 JS 里」这条设计原封不动地保住了 ——
 * 而且它现在比旧版更结实：旧版挡不住跨进程（SQLite 的单写锁挡住了，
 * 但那是因为整库串行），新版的行锁是精确到行的。
 */

'use strict';

const { getDb } = require('./db');
const { readSetting, setSettings } = require('./settings');
const { currentUser, clientIp } = require('./auth');

/** 每日次数上限在 settings 表里的键名 */
const KEY_DAILY_LIMIT = 'quota.daily_limit';

/**
 * 没配时的默认值。
 * 定成 5 是因为一次规划的模型调用成本不算低，而公共密钥是站长自己掏的 ——
 * 默认值应该偏保守，让站长主动去后台调高，而不是先敞开再收紧。
 */
const DEFAULT_DAILY_LIMIT = 5;

const MAX_DAILY_LIMIT = 1000;

/**
 * 账期标签，形如 2026-09-18，按 Asia/Shanghai 切分。
 *
 * 用 Intl 而不是自己算 +8 小时：时区规则不该手写死在代码里。
 * 用 UTC 切会让用户在北京时间早上 8 点看到额度重置 —— 那看起来就是个 bug，
 * 而「为什么我的次数没了」是那种查半天最后发现是时区的问题。
 *
 * 这个值是**在 JS 侧算好的**，库里就是定长字符串（CHAR(10)）。
 * 刻意不用 MySQL 的 CURDATE() / NOW()：那会让「哪一天」这件事有两个权威
 * （一个在 Node 的时区里、一个在 MySQL 服务器的时区里），而两者不一致时
 * 表现是「结算打不到预留那一行」，属于最难查的一类问题。
 */
function dayKey(ts) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(ts === undefined ? Date.now() : ts);

  const pick = (type) => parts.find((p) => p.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/**
 * 这次请求的用量该记在谁头上。
 *
 * 登录用户按账号，未登录按来源地址 —— **只记一个**。
 * 两个都记会让同一次使用占掉两格额度，用户看到「我明明只跑了一次，
 * 却说用了两次」。按 IP 那一档天然挡不住换 IP 的人，这是 IP 限流固有的代价，
 * 换来的是未登录的人也能用（这正是产品决定里那条「没配 key 的用户能用」）。
 */
async function subjectFor(req) {
  const user = await currentUser(req);
  return user ? `u:${user.id}` : `ip:${clientIp(req)}`;
}

/** 每日上限。后台可改；读到坏值就退回默认值，不因为一个配置项让整个规划不可用 */
async function dailyLimit() {
  const stored = (await readSetting(KEY_DAILY_LIMIT)).value;

  /* 「没配过」必须与「配成 0」分开。
     这里最初写的是 Number(readSetting(...).value)，而 **Number(null) 是 0**，
     于是全新安装的站点上限直接变成 0 —— 第一个用户点规划看到的是
     「今天的免费次数用完了（每天 0 次）」，而管理员从没动过这个设置，
     根本不会想到去看它。 */
  if (stored === null) return DEFAULT_DAILY_LIMIT;

  const n = Number(stored);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DAILY_LIMIT;
  return Math.min(Math.floor(n), MAX_DAILY_LIMIT);
}

async function setDailyLimit(value, changedBy) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_DAILY_LIMIT) {
    throw new Error(`每日上限需要是 0—${MAX_DAILY_LIMIT} 之间的整数`);
  }
  await setSettings([{ key: KEY_DAILY_LIMIT, value: String(Math.floor(n)) }], changedBy);
  return Math.floor(n);
}

/**
 * 原子预留一次。返回 { allowed, day }。
 *
 * 【这条 SQL 的形状不能随便改，理由与旧版不同但同样硬】
 *
 * 旧版是一条语句，靠 SQLite 的三个特性叠起来：
 *     INSERT ... SELECT ?, ?, 0, 1 WHERE ? > 0
 *     ON CONFLICT(subject, day) DO UPDATE SET reserved = reserved + 1
 *       WHERE (used + reserved) < ?
 * 这三个特性 MySQL 一个都不支持：无 FROM 的 SELECT 要写 FROM DUAL、
 * `excluded.` 没有对应物、以及**ON DUPLICATE KEY UPDATE 不允许在更新分支上挂 WHERE**。
 *
 * 所以拆成两条，各自承担一半：
 *   ① 保证那一行存在（幂等，结果刻意丢弃）
 *   ② 真正的判定 —— 命中则必然改动（reserved + 1），
 *      affectedRows === 1 ⇔ 放行
 *
 * 【为什么不用单条 ON DUPLICATE KEY UPDATE + IF()】
 * 那样写得出「满了就不动」的效果：
 *     ON DUPLICATE KEY UPDATE reserved = IF(used + reserved < ?, reserved + 1, reserved)
 * 但判成败只能靠 affectedRows 的 1/2/0 三态（插入 / 真改动 / 没动），
 * 而这三个数**会被 CLIENT_FOUND_ROWS 整体改写**（没动也报 1，见 tools/db.js）——
 * 等于把配额的判定挂在了一个将来别人可能调整的连接开关上。
 * 拆成两条之后，② 的 affectedRows 语义与开关无关：它命中就必然改动。
 *
 * 【限额 0 的语义】① 也带 `WHERE ? > 0`，于是限额 0 的站点不会建出 0/0 的行。
 * 旧版注释里记的「B 版限额 0 时仍放行 1 次」就是漏了这一条 ——
 * 插入路径不受约束，等于没预留就放行了。
 *
 * 【① 里为什么写 `used = used`】它必然不改动任何值，只为了拿住那一行的锁
 * （并让并发插入的那一方转为更新而不是撞主键）。它的 affectedRows 我们不读，
 * 这正是不受 FOUND_ROWS 影响的原因。
 */
async function reserve(subject, limit) {
  const day = dayKey();
  const cap = Number.isFinite(limit) ? limit : await dailyLimit();
  const db = await getDb();

  await db.execute(
    `INSERT INTO quota_usage (subject, day, used, reserved)
     SELECT ?, ?, 0, 0 FROM DUAL WHERE ? > 0
     ON DUPLICATE KEY UPDATE used = used`,
    [subject, day, cap]
  );

  const [result] = await db.execute(
    `UPDATE quota_usage SET reserved = reserved + 1
      WHERE subject = ? AND day = ? AND (used + reserved) < ?`,
    [subject, day, cap]
  );

  /* 把 day 一并带回去，结算时要用**同一个** day。
     不返回的话，settle 会自己再取一次当天 —— 而预留与结算之间隔着
     30—90 秒的规划。23:59:59 预留、00:00:01 结算时，UPDATE 打不到
     昨天那一行：这次用量不计数（白送），并且留下一条要到重启才清的孤儿预留。
     跨零点的那一次恰好是最容易发生的，因为它只需要一个正好在午夜跑完的规划。 */
  return { allowed: result.affectedRows === 1, day };
}

/**
 * 结算：预留转已用。
 *
 * 规划跑完了（不管客户端还在不在）就该记这一次用量 —— 模型调用是实实在在
 * 发生过的。用户中途关掉标签页也一样：服务端那边并不会因此停下，
 * 所以「关掉就不算数」等于把额度送给最能折腾的人。
 *
 * 条件里的 reserved > 0 是防重复结算：没预留过就不该记用量。
 * 它也顺便让 affectedRows 的语义明确 —— 命中就必然改动。
 */
async function settle(subject, day) {
  const db = await getDb();
  const [result] = await db.execute(
    'UPDATE quota_usage SET used = used + 1, reserved = reserved - 1 WHERE subject = ? AND day = ? AND reserved > 0',
    [subject, day || dayKey()]
  );
  return result.affectedRows === 1;
}

/** 退回预留：规划根本没跑起来（密钥不对、参数被拒），不该记这一次用量 */
async function release(subject, day) {
  const db = await getDb();
  const [result] = await db.execute(
    'UPDATE quota_usage SET reserved = reserved - 1 WHERE subject = ? AND day = ? AND reserved > 0',
    [subject, day || dayKey()]
  );
  return result.affectedRows === 1;
}

/**
 * 某个 subject 今天的用量。
 * 给 /api/me 用 —— 前端要显示「今天还剩几次」。
 */
async function usageOf(subject, day) {
  const db = await getDb();
  const [rows] = await db.execute(
    'SELECT used, reserved FROM quota_usage WHERE subject = ? AND day = ?',
    [subject, day || dayKey()]
  );
  const row = rows[0];
  return { used: row ? row.used : 0, reserved: row ? row.reserved : 0 };
}

/** 今天所有 subject 的用量，给后台看 */
async function todayUsage(limit) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const db = await getDb();
  const [rows] = await db.execute(
    'SELECT subject, used, reserved FROM quota_usage WHERE day = ? ORDER BY used DESC, subject ASC LIMIT ?',
    [dayKey(), cap]
  );

  return {
    day: dayKey(),
    limit: await dailyLimit(),
    rows: rows.map((r) => ({ subject: r.subject, used: r.used, reserved: r.reserved }))
  };
}

/**
 * 清掉所有预留。**启动时调一次**。
 *
 * 预留只在「一个规划正在跑」那 30—90 秒里有意义。进程重启意味着那些规划
 * 已经不在了，它们占的格子再也等不到结算 —— 不清的话，用户会看到额度
 * 被一个看不见的东西永久占着，而没有任何办法恢复。
 */
async function releaseAllOrphans() {
  const db = await getDb();
  const [result] = await db.execute('UPDATE quota_usage SET reserved = 0 WHERE reserved > 0');
  return result.affectedRows;
}

/**
 * 清掉陈旧的账期行。
 * 每天一行 × 每个访问过的来源，长期不清会慢慢堆积。
 * 保留 30 天够追溯，也够「这个月用了多少」这类问题。
 */
async function purgeOld(days) {
  const keep = Number.isFinite(days) ? days : 30;
  const cutoff = new Date(Date.now() - keep * 24 * 60 * 60 * 1000);
  const db = await getDb();
  const [result] = await db.execute('DELETE FROM quota_usage WHERE day < ?', [dayKey(cutoff.getTime())]);
  return result.affectedRows;
}

module.exports = {
  KEY_DAILY_LIMIT,
  DEFAULT_DAILY_LIMIT,
  MAX_DAILY_LIMIT,
  dayKey,
  subjectFor,
  dailyLimit,
  setDailyLimit,
  reserve,
  settle,
  release,
  releaseAllOrphans,
  usageOf,
  todayUsage,
  purgeOld
};
