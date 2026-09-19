/**
 * settings 表的读写：取值、成批写、历史与回滚。
 *
 * 只做「表」这一层的事 —— 某项设置该怎么在各层之间解析、后台该怎么呈现，
 * 那是 tools/keys.js 的事。分开是因为这个文件关心的是「值有没有正确落盘」，
 * 而那个文件关心的是「到底该用哪一份」，两者的失败模式完全不同。
 *
 * 【哪些值要加密】
 * SECRET_KEYS 里的项在落库前用 AES-256-GCM 封装（见 tools/crypto-box.js）。
 * 名单放在这里而不是调用点上，是因为「写入时封、读出时拆」必须成对出现 ——
 * 漏掉任何一边都会得到一个看起来正常、实际不可用的值。
 *
 * settings_history 存的是**库里原本的那个值**（密文项就是密文），
 * 这样回滚就是把旧值原样搬回去，不需要在任何地方重新加密。
 * 也因此，密钥的明文从不进入历史表。
 *
 * 【为什么设置读取永不抛异常】
 * 设置的缺失是正常状态（没配过就是没配过），不是错误。而 /api/config 是每个
 * 页面加载都会打的接口，它绝不能因为「库还没建好」或「表结构对不上」而 500 ——
 * 取不到就返回 null，让调用方回落到 config.js 里的静态值，站点照常能跑。
 * 迁移到 MySQL 之后这条更重要了：**线上（Vercel）根本没配数据库**，
 * 那里 getDb() 会直接抛，而 /api/config 仍然要能正常返回静态值。
 *
 * 【迁移到 MySQL 时这一层改了什么】
 *   · 全部函数变 async
 *   · readSetting / getSetting 多了一个可选的 conn 形参 —— 见 setSettings 里的说明，
 *     这是整个异步化里最容易漏、且漏了**不会报错只会偶尔判错**的一处
 *   · BEGIN IMMEDIATE → withTransaction
 *   · ON CONFLICT(key) DO UPDATE ... excluded.x → ON DUPLICATE KEY UPDATE ... AS incoming
 *   · batch 的取值从 MAX(batch)+1 换成 sequences 表（理由见下）
 *   · 列名 key 是 MySQL 保留字，一律加反引号
 */

'use strict';

const { getDb, withTransaction } = require('./db');
const { seal, open } = require('./crypto-box');
const { HttpError } = require('./http');

/* ---------- 键名 ---------- */

/** 浏览器侧的一对（按设计就是公开的） */
const KEY_WEBJS = 'amap.webjs_key';
const KEY_SECURITY = 'amap.security_code';

/** 服务端持有的两把（绝不发给浏览器） */
const KEY_AMAP_SERVICE = 'amap.web_service_key';
const KEY_DEEPSEEK = 'deepseek.api_key';

/**
 * 需要加密落库的项。
 * 浏览器侧那两项按设计就是公开的，加密没有意义，反而让后台无法直接显示 ——
 * 而管理员恰恰需要核对自己填进去的是不是那一串。
 */
const SECRET_KEYS = new Set([KEY_AMAP_SERVICE, KEY_DEEPSEEK]);

function isSecret(key) {
  return SECRET_KEYS.has(key);
}

/**
 * 必须成对写入的项。给其中一项就必须同时给另一项。
 *
 * 【为什么这条约束在数据层，而不是只在 HTTP 接口上】
 * 写入入口已经有三个了（后台接口、命令行、回滚），将来还会更多。
 * 「成对」如果只是一条「每个入口都要记得」的约定，迟早会漏 —— 而漏掉的
 * 后果不是报错，是一个**静默失效**的状态：只配了一半，运行时当作没配，
 * 页面照常打开、只是用的还是 config.js 里的静态值。
 * 这条教训在阶段 3 的鉴权守卫上刚吃过一次（同一件事有两套判断就会对不上）。
 */
const PAIRS = [[KEY_WEBJS, KEY_SECURITY]];

function partnerOf(key) {
  for (const [a, b] of PAIRS) {
    if (key === a) return b;
    if (key === b) return a;
  }
  return null;
}

/** 检查这批写入有没有碰到「一对里只给一个」 */
function assertPairsWhole(entries) {
  const touched = new Set(entries.map((e) => e.key));

  for (const [a, b] of PAIRS) {
    const onlyA = touched.has(a) && !touched.has(b);
    const onlyB = touched.has(b) && !touched.has(a);
    if (onlyA || onlyB) {
      throw new HttpError(
        400,
        `${a} 与 ${b} 必须一起写。只写一个会造出「只配了一半」的状态，` +
          '而那个状态在运行时是静默失效的 —— 页面照常打开，用的却还是旧的配置',
        { expose: true }
      );
    }
  }
}

/**
 * 密文的附加认证数据。
 * 绑定到具体的键名，于是**把高德那项的密文粘到 DeepSeek 那一行也解不开** ——
 * 少了它，一次误操作就能让两个密钥互串，而系统完全看不出异常。
 */
function aadFor(key) {
  return `setting:${key}`;
}

/* ---------- 读 ---------- */

/** 「读设置失败」只提醒一次。每次请求都打会把日志刷满，而这件事只需要知道一次 */
let warned = false;

function warnOnce(error) {
  if (warned) return;
  warned = true;
  console.warn('[设置] 读取失败，将全部回落到静态配置：', error && error.message);
}

const MISSING = 'missing';
const BROKEN = 'undecryptable';

/**
 * 读**库本身**就失败了（连不上、库没建、迁移没过）。
 *
 * 【为什么必须与 MISSING 分开】
 * 对**公开项**（浏览器侧那一对）来说两者可以一视同仁：取不到就回落静态值，
 * 站点照常跑。但对**服务端密钥**来说不能 —— 那会让人在刚轮换完密钥之后，
 * 因为一次库故障而静默用回本地文件里那把已经作废的 key，而他以为换成了。
 * 所以这里区分开，由调用方按「这一项泄漏了会怎样」各自决定。
 *
 * 线上（Vercel）没配数据库时走的正是这一条 —— 于是 /api/config 照常返回静态值。
 */
const UNREADABLE = 'unreadable';

/**
 * 读一条设置，返回 { value, status }：
 *   status 'ok'            —— 读到，且密文项成功拆封
 *   status 'missing'       —— 没配过
 *   status 'undecryptable' —— 配过但拆不开（APP_SECRET 换过、或密文被改过）
 *
 * 【为什么必须把后两种分开】
 * 混在一起的话，运维看到「未配置」会跑去重新填一遍密钥 —— 而复填也解不开，
 * 因为问题出在主密钥上。这两种情况的处置完全不同，不能在返回时就抹平。
 *
 * @param {string} key
 * @param {object} [conn] 事务连接。**事务内调用必须传它** ——
 *        池里另取一条连接读到的是事务外的快照，而那正是 setSettings 判断
 *        「值变没变」的依据，读错了不会报错，只会偶尔判错。
 */
async function readSetting(key, conn) {
  let raw;
  try {
    const db = conn || (await getDb());
    const [rows] = await db.execute('SELECT value FROM settings WHERE `key` = ?', [key]);
    const row = rows[0];
    raw = row && row.value != null ? String(row.value).trim() : null;
  } catch (error) {
    warnOnce(error);
    return { value: null, status: UNREADABLE };
  }

  if (!raw) return { value: null, status: MISSING };
  if (!isSecret(key)) return { value: raw, status: 'ok' };

  const plain = open(raw, aadFor(key));
  return plain === null ? { value: null, status: BROKEN } : { value: plain, status: 'ok' };
}

/** 只要值。给不需要区分「没配」与「解不开」的调用方用 */
async function getSetting(key, conn) {
  return (await readSetting(key, conn)).value;
}

/* ---------- 写 ---------- */

/**
 * 成批写设置：要么全部成功，要么全部回滚，每条各记一条历史。
 *
 * 【为什么是「一批」而不是「一条」】
 * 高德那两项必须成对，只写一半就等于制造了一个「只配了一半」的状态 ——
 * 那个状态在运行时是静默的（页面照常打开，只是用的还是静态那份 key）。
 * 所以写入的单位必须是「一次配置变更」，不是「一个键」。
 *
 * @param {Array<{key: string, value: string|null}>} entries  传进来的 value 是**明文**；
 *        value 为 null 表示删除该键
 * @param {number|null} changedBy  操作者 userId；命令行操作为 null（表示系统）
 * @returns {Promise<Array<{key, from, to, changed}>>}  from/to 是明文，供调用方回显；
 *          changed 为 false 表示空操作（写进去的值和原来一样），未记历史。
 */
async function setSettings(entries, changedBy) {
  assertPairsWhole(entries);

  const who = changedBy == null ? null : changedBy;

  /* 整批包在一个事务里。旧版这里写的是 BEGIN IMMEDIATE，理由（WAL 下 deferred
     事务会撞 SQLITE_BUSY_SNAPSHOT）随 SQLite 一起作废；MySQL 侧需要的只是
     「这批写入要么全成要么全不成」，withTransaction 给的就是这个。 */
  return withTransaction(async (conn) => {
    const now = Date.now();
    const changes = [];

    /* 这一次保存的批次号。同一次 setSettings 写下的所有历史行共用它，
       回滚时靠它找回「同一批」里的另一行 —— 用时间戳做不到，
       同一毫秒内的两次保存会配错（见迁移 003 的说明）。

       【为什么不是 MAX(batch)+1】
       SQLite 版的注释写着「写入都包在 BEGIN IMMEDIATE 里，所以这个读取-加一
       不会被并发穿插」。MySQL 的 REPEATABLE READ 下这句话不成立：普通 SELECT
       是快照读、不加锁，两个并发事务会读到同一个 MAX 值 —— 而 batch 的全部
       意义就是「同一次保存」的唯一标识，撞了就会配错行。

       也不改成 SELECT MAX(batch) ... FOR UPDATE：那是对空区间取间隙锁，
       空表时锁住整个范围，与并发插入叠在一起是标准的死锁配方。
       换成一行专用计数器：取值是一次**必然改动**的 UPDATE，行锁精确且只锁一行。

       顺序不能反 —— 先 +1 再读。先读后加的话两个事务会读到同一个值。 */
    await conn.execute("UPDATE sequences SET value = value + 1 WHERE name = 'settings_batch'");
    const [seqRows] = await conn.execute(
      "SELECT value AS n FROM sequences WHERE name = 'settings_batch'"
    );
    const batch = Number(seqRows[0].n);

    for (const { key, value } of entries) {
      const [rawRows] = await conn.execute('SELECT value FROM settings WHERE `key` = ?', [key]);
      const row = rawRows[0];
      const rawFrom = row && row.value != null ? String(row.value) : null;

      // 明文形态的旧值，只用于「变没变」的比较与回显 —— 密文每次封装都是新的
      // 随机 IV，拿密文比会得出「每次都变了」，空操作抑制就失效了。
      // 必须传 conn：读到事务外的快照会让「变没变」判断基于旧数据。
      const plainFrom = (await readSetting(key, conn)).value;

      const to = value == null ? null : String(value);

      /* 「变没变」的判断，清除与赋值走的是**不同的口径**。
         赋值看明文（密文每次封装都是新的随机 IV，比密文会永远得出「变了」）；
         清除看的是**库里到底有没有东西**。
         这里最初两种都用明文比较，于是有一个清不掉的死角：密文解不开时
         明文读出来是 null，清除就被当成了「本来就是空的」而静默跳过 ——
         而「APP_SECRET 换过、想把作废的密钥清掉」恰恰是最需要这个操作的时刻。 */
      const changed = to === null ? rawFrom !== null : plainFrom !== to;

      if (!changed) {
        changes.push({ key, from: plainFrom, to, changed: false });
        continue;
      }

      let rawTo = null;
      if (to !== null) {
        if (isSecret(key)) {
          try {
            rawTo = seal(to, aadFor(key));
          } catch (error) {
            throw new HttpError(409, `无法加密 ${key}：${error.message}`, { expose: true });
          }
        } else {
          rawTo = to;
        }
      }

      if (rawTo === null) {
        await conn.execute('DELETE FROM settings WHERE `key` = ?', [key]);
      } else {
        /* ON DUPLICATE KEY UPDATE 用 `AS incoming` 别名而不是 VALUES()：
           VALUES() 从 8.0.20 起被标记为废弃，在 8.0.42 上会往日志里打弃用警告。
           别名形式表达的是同一件事：下面这几个 incoming.x 就是「这次想插进去的值」。 */
        await conn.execute(
          `INSERT INTO settings (\`key\`, value, updated_at, updated_by) VALUES (?, ?, ?, ?) AS incoming
           ON DUPLICATE KEY UPDATE value      = incoming.value,
                                   updated_at = incoming.updated_at,
                                   updated_by = incoming.updated_by`,
          [key, rawTo, now, who]
        );
      }

      // 历史里存的是**落库形态**（密文项就是密文），所以回滚时原样搬回去即可，
      // 明文从不进入历史表。
      await conn.execute(
        'INSERT INTO settings_history (`key`, old_value, new_value, changed_at, changed_by, batch) VALUES (?, ?, ?, ?, ?, ?)',
        [key, rawFrom, rawTo, now, who, batch]
      );

      changes.push({ key, from: plainFrom, to, changed: true });
    }

    return changes;
  });
}

/** 删掉一批设置。写成收集键名，避免调用方各自拼 SQL */
async function clearSettings(keys, changedBy) {
  return setSettings(keys.map((key) => ({ key, value: null })), changedBy);
}

/* ---------- 历史与回滚 ---------- */

/**
 * 列某几项（或全部）的变更历史，新的在前。
 * 不回明文 —— 密文项的历史里本来就只有密文。
 */
async function listSettingHistory(keys, limit) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const list = Array.isArray(keys) && keys.length ? keys : null;

  // 排序要带 id 作并列时的次序。只按 changed_at 排的话，同一毫秒内的几次保存
  // 先后是未定义的 —— 界面按这个顺序显示「最新在前」，回滚也就可能点到错的那条。
  // （写入本身是快的，同一毫秒里连续保存两次完全正常。）
  const db = await getDb();
  const [rows] = list
    ? await db.execute(
        `SELECT * FROM settings_history WHERE \`key\` IN (${list.map(() => '?').join(',')})
          ORDER BY changed_at DESC, id DESC LIMIT ?`,
        [...list, cap]
      )
    : await db.execute(
        'SELECT * FROM settings_history ORDER BY changed_at DESC, id DESC LIMIT ?',
        [cap]
      );

  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    changedAt: row.changed_at,
    changedBy: row.changed_by,
    // 只告诉界面「原来有没有值、改成了有没有值」，不给值本身
    hadValue: row.old_value !== null,
    hasValue: row.new_value !== null,
    // 密文项的这两个值是不可读的，界面据此显示「（密文）」
    secret: isSecret(row.key)
  }));
}

/**
 * 把某一项回滚到某条历史记录的旧值。
 *
 * 走 setSettings 而不是直接写库：这样会重新封装（密文项拿到新的 IV）、
 * 会再记一条历史（「谁在什么时候回滚的」本身也是要留痕的）、
 * 也就不会在历史里留下一条看起来「凭空变回去」的记录。
 *
 * 密文项的旧值先拆封再重封：拆不开就报错，绝不静默跳过 ——
 * 那会让人以为回滚成功了，而实际上什么都没变。
 */
/** 把历史里的 old_value 解成明文。密文解不开就抛，绝不静默跳过 */
function decryptHistoryValue(entry) {
  if (entry.old_value === null) return null;
  if (!isSecret(entry.key)) return entry.old_value;

  const plain = open(entry.old_value, aadFor(entry.key));
  if (plain === null) {
    throw new HttpError(
      409,
      '这条历史里的值解不开（APP_SECRET 可能换过），无法回滚',
      { expose: true }
    );
  }
  return plain;
}

async function rollbackSetting(historyId, changedBy) {
  const db = await getDb();
  const [entryRows] = await db.execute('SELECT * FROM settings_history WHERE id = ?', [
    Number(historyId)
  ]);
  const entry = entryRows[0];
  if (!entry) throw new HttpError(404, '找不到这条历史记录', { expose: true });

  const targets = [entry];

  /* 成对的项要一起回滚。
     只回滚其中一条会造出「只配了一半」—— 而那个状态在运行时是静默失效
     （前端回落到 config.js 的静态值），正好是成对约束当初要挡的东西。
     界面上一行一个「回滚到此」按钮，很容易只点其中一个，所以这里补上。

     这两条 SELECT 刻意留在事务外（setSettings 自己会开事务），也就没有嵌套 ——
     MySQL 没有真正的嵌套事务，savepoint 是个易错替代品，不引入它。
     代价是「找到配对行」与「写回去」之间理论上能被并发写入插进一条历史，
     但回滚是管理员的低频操作，撞上的概率与后果都可接受；
     真要收紧，把这两条 SELECT 挪进 withTransaction 加 FOR UPDATE 即可。 */
  const partnerKey = partnerOf(entry.key);
  if (partnerKey && entry.batch != null) {
    const [partnerRows] = await db.execute(
      'SELECT * FROM settings_history WHERE `key` = ? AND batch = ? LIMIT 1',
      [partnerKey, entry.batch]
    );
    const partner = partnerRows[0];

    if (!partner) {
      throw new HttpError(
        409,
        `${entry.key} 与 ${partnerKey} 是一对，但另一项没有同一时刻的历史记录。` +
          '只回滚一个会造出「只配了一半」，所以这次操作没有执行',
        { expose: true }
      );
    }
    targets.push(partner);
  }

  const changes = await setSettings(
    targets.map((row) => ({ key: row.key, value: decryptHistoryValue(row) })),
    changedBy
  );

  return { keys: targets.map((row) => row.key), changes };
}

module.exports = {
  KEY_WEBJS,
  KEY_SECURITY,
  KEY_AMAP_SERVICE,
  KEY_DEEPSEEK,
  SECRET_KEYS,
  isSecret,
  readSetting,
  getSetting,
  partnerOf,
  PAIRS,
  setSettings,
  clearSettings,
  listSettingHistory,
  rollbackSetting
};
