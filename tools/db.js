/**
 * 数据层：MySQL（mysql2 连接池）。
 *
 * 【与上一版的关系】
 * 上一版是 node:sqlite 的单文件库，同步 API，零 npm 依赖。换成 MySQL 之后
 * 有四件事与旧版**不通用**，读这个文件的人需要先知道：
 *
 *   1. **API 变成异步**。node:sqlite 的 DatabaseSync 是同步的，MySQL 驱动不是。
 *      所以 getDb() 返回的是 Promise，所有调用点都要 await —— 这个改动向上
 *      传染到了整个数据层与请求处理链。
 *
 *   2. **单连接变成连接池**，于是「事务里的每条语句都在同一个事务里」不再是
 *      白给的性质。见 withTransaction 的说明：谁在事务里，谁的签名上就有一个 conn。
 *
 *   3. **迁移的保证变了**。SQLite 的 DDL 是事务性的，旧版能说「中途失败整体回滚」。
 *      MySQL 的 DDL 隐式提交，那个保证做不到 —— 换成「每条语句自己幂等 +
 *      一整条迁移跑完才记账」。理由写在 migrate() 上面。
 *
 *   4. **零依赖的口子开了**。旧版文件头有整整一段论证「为什么不用 better-sqlite3」，
 *      核心理由是原生模块要编译、整套构建链跟着走。这条理由对 MySQL 驱动同样成立，
 *      所以选 mysql2 —— 它是纯 JS，安装时不需要编译器。
 *
 * 【不变的口径】
 * 库里一律存 epoch 毫秒（BIGINT），不存日期字符串，也不用 MySQL 的时间类型。
 * 唯一的例外仍然是 quota_usage.day —— 那是「哪一天」的账期标签，形如 2026-09-18，
 * 按 Asia/Shanghai 切分而不是 UTC，理由是拿 UTC 切会让用户在北京时间早上 8 点
 * 看到额度重置，看起来像 bug。它在 JS 侧算好，库里就是定长字符串。
 * 这个口径带来一个实际好处：**全项目没有任何 SQL 时间函数**，
 * 所以从 SQLite 迁过来时没有一处 strftime / NOW() 需要翻译。
 */

'use strict';

const mysql = require('mysql2/promise');

const { dbConfig, isConfigured, describeTarget } = require('./db-config');
const { MIGRATIONS, META_TABLE } = require('./schema-mysql');

/**
 * 迁移用的咨询锁名。
 *
 * 库级的命名空间（MySQL 的 GET_LOCK 是**实例级**的，所有库共用一张锁表），
 * 所以名字里带上项目前缀，免得与同一个 MySQL 实例上别的应用撞名 ——
 * 那会让两边互相等锁，而且报出来的错毫无线索。
 */
const MIGRATE_LOCK = 'wuhan-trip:migrate';

/** 连接池。惰性创建 —— 见 getPool() */
let pool = null;

/** 迁移完成的 promise。失败时会清空，好让下次调用重试 */
let ready = null;

/**
 * 取连接池（惰性单例）。
 *
 * 【没配数据库时**同步抛**，而不是尝试连接】
 * 线上（Vercel）就没有配数据库。如果这里去尝试连一个不存在的地址，
 * 要等到 connectTimeout 才失败 —— 而配额预留（quota.reserve）在
 * /api/plan 的关键路径上，那会把「配额记不上账」从瞬时的变成每次规划都慢 2 秒。
 * 同步抛的话，调用方的 try/catch 立刻接住，路径与「数据库正常但这条语句失败」
 * 完全一样。
 *
 * 【为什么是池而不是单连接】
 * 规划要跑 30–90 秒，期间还要写会话、写配额、写审计。单连接会让这些互相排队。
 * 池还能顺带解决 mysql2 的连接复用问题（它自己管心跳与重连）。
 */
function getPool() {
  if (pool) return pool;

  if (!isConfigured()) {
    throw new Error(
      '未配置数据库：设置环境变量 DB_HOST，或在 config.local.js 里填 mysql 段'
    );
  }

  const cfg = dbConfig();

  pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,

    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,

    /* 2 秒。本机 MySQL 用不到这么久，而线上那条「没配库」的路径现在由
       isConfigured() 提前挡掉了，所以这个值只在真正连不上时起作用 ——
       那时早点报错比吊着强。 */
    connectTimeout: 2000,

    /* 必须显式指定 utf8mb4。mysql2 的默认连接字符集是 utf8mb3，
       那样四位字节的字符（emoji、部分生僻字）会在写入时被截断或报错，
       而行程标题与审计里的中文姓名都用得到。 */
    charset: 'utf8mb4',

    /* 【为什么打开 CLIENT_FOUND_ROWS】
       SQLite 的 changes() 数的是**被 WHERE 匹配到**的行，MySQL 默认数的是
       **真的被改动**的行。两者只在一种语句上分叉：幂等的 UPDATE。
       全仓 11 个「按 changes 判定结果」的调用点里，10 个的 WHERE 里都带着
       让值必然改变的谓词（AND revoked = 0、AND used_count < max_uses、
       AND reserved > 0、AND user_id IS NULL），只有 invites.revoke 的
       「UPDATE invite_codes SET revoked = 1 WHERE code = ?」会碰上
       「已经是 1 了」那种情况 —— 而那里打开开关后的行为正是原意：
       重复撤销仍回 true，404 只留给「找不到这个码」。

       逐个改写判定条件也能做，但那要动 11 个地方，且改完的语义与注释里写的
       「靠 changes 判定」不再是同一件事。一个连接级开关能做到的事，
       不要散成 11 处约定。

       【唯一要记住的副作用】INSERT ... ON DUPLICATE KEY UPDATE 在「命中但
       没改动」时也会报 1（默认报 0）。所以 quota.reserve 刻意不用 ODKU 的
       结果判成败，改用一条必然改动的 UPDATE —— 那条语句的 affectedRows
       与这个开关无关。 */
    flags: ['FOUND_ROWS']
  });

  return pool;
}

/**
 * 事务。同一事务里的所有语句必须走同一条连接 ——
 * 这是从单连接换到池之后**唯一新增的、必须显式保证的不变量**。
 *
 * 【为什么显式传 conn，而不是用 AsyncLocalStorage 之类隐式传递】
 * 全仓只有 settings.setSettings 一个函数需要在事务里跑多条语句。
 * 为它一个引入一层看不见的上下文，读代码的人就得同时在脑子里维护两套
 * 「这条语句到底走哪条连接」的判断 —— 而「同一件事不要有两套判断」
 * 是这个项目已经吃过两次亏的教训（见 api-router.js 的 segments 守卫）。
 * 所以显式传：谁在事务里，谁的签名上就有一个 conn。
 *
 * @param {(conn: import('mysql2/promise').PoolConnection) => Promise<any>} fn
 */
async function withTransaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    try {
      await conn.rollback();
    } catch {
      /* 回滚失败不该盖住真正的错 —— 往上抛的是 original error，
         而回滚失败通常意味着连接已经断了，那时也回滚不了什么 */
    }
    throw error;
  } finally {
    // release 而不是 end：end 会把连接真正关掉，池子会慢慢枯死。
    // 这个方法在 promise 包装下是同步的，不需要 await。
    conn.release();
  }
}

/**
 * 应用未执行的迁移。
 *
 * 【保证与旧版不同，这是有意的】
 * SQLite 的 DDL 是事务性的，旧版能保证「中途失败整体回滚，不会留下做了一半的库」。
 * MySQL 的 DDL 是**隐式提交**的，那个保证在这里做不到。换来的是一条更朴素的：
 *
 *   · 每条语句自己幂等（CREATE TABLE IF NOT EXISTS；加列加索引这类没有
 *     IF NOT EXISTS 的，用 schema-mysql.js 里的 guard 现查 information_schema）
 *   · 一整条迁移跑完才记账
 *   · 于是失败时那条迁移没记上，下次启动从它的第一条重跑，不会留下半张表
 *
 * 【为什么需要 GET_LOCK】
 * SQLite 下这一步靠 BEGIN IMMEDIATE 天然串行化。MySQL 没有等价物：
 * serve.js 与一个一次性脚本同时首次开库时，两边会各自读到「没有已记账的迁移」，
 * 然后各跑一遍。语句幂等所以不会坏，但会白跑、且可能在 ALTER 上互相等锁到超时。
 *
 * 注意 GET_LOCK 是**连接级**的：取锁、跑迁移、放锁必须在同一条连接上，
 * 从池里随手拿另一条连接去放锁是不生效的（而且会一直锁到那条连接断开）。
 * 所以下面全程用同一个 conn。
 */
async function migrate() {
  const conn = await getPool().getConnection();

  try {
    // 记账表本身由引导流程建，不放在迁移里 —— 否则「记录已执行的迁移」这件事没有落脚点。
    // 它是幂等的，所以放锁外面也安全。
    await conn.query(META_TABLE);

    const [[lock]] = await conn.query('SELECT GET_LOCK(?, 30) AS ok', [MIGRATE_LOCK]);
    if (Number(lock.ok) !== 1) {
      throw new Error('另一个进程正在跑迁移，等待 30 秒后仍未拿到锁');
    }

    try {
      const [rows] = await conn.execute(
        'SELECT `key` FROM schema_meta WHERE `key` LIKE ?',
        ['migration.%']
      );
      const applied = new Set(rows.map((row) => row.key));
      const pending = MIGRATIONS.filter((m) => !applied.has(`migration.${m.id}`));

      for (const migration of pending) {
        for (const statement of migration.statements) {
          if (typeof statement === 'string') {
            await conn.query(statement);
            continue;
          }

          // 带 guard 的语句：guard 返回 true 才执行。
          // DDL 一律走 query 而不是 execute —— MySQL 的 prepared statement
          // 不支持相当一部分 DDL，用 execute 会得到一个与语句本身无关的语法错。
          if (await statement.guard(conn)) {
            await conn.query(statement.sql);
          }
        }

        await conn.execute('INSERT INTO schema_meta (`key`, value) VALUES (?, ?)', [
          `migration.${migration.id}`,
          String(Date.now())
        ]);
      }

      return pending.map((m) => m.id);
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [MIGRATE_LOCK]);
    }
  } finally {
    conn.release();
  }
}

/** 确保迁移已跑过。失败时清空缓存，好让下次调用重试而不是永远拿到同一个 rejected promise */
function ensureReady() {
  if (!ready) {
    ready = migrate().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

/**
 * 取库句柄。返回的是**连接池**，不是单条连接 ——
 * 用完不需要还，池自己管。需要事务时用 withTransaction。
 *
 * 首次调用会建池并跑迁移，所以它是 async 的：
 *
 *   const db = await getDb();
 *   const [rows] = await db.execute('SELECT ... WHERE id = ?', [id]);
 *
 * 旧版的注释说这里「惰性而不是模块加载时就开，因为 tools/ 下有些脚本只是
 * require 一下取个常量，不该因此凭空造出一个库文件」—— 这条理由现在升级成了
 * 更强的一条：**线上（Vercel）根本没配数据库**，如果模块加载时就建池，
 * api/plan.js 那条链路会直接加载失败，而它本来只是可选地记个配额。
 */
async function getDb() {
  await ensureReady();
  return getPool();
}

/**
 * 关池。主要用于一次性脚本与测试，长驻服务不需要调。
 *
 * 旧版的实现里有一句「关掉库会做一次 WAL checkpoint，别把 -wal 文件留在那里」——
 * 那是 SQLite 特有的，MySQL 没有对应物。这里保留它只是为了把连接还干净，
 * 免得脚本退出时 mysql 那边留一堆 sleeping 连接要等超时。
 */
async function closeDb() {
  const current = pool;
  pool = null;
  ready = null;
  if (current) await current.end();
}

module.exports = {
  getDb,
  closeDb,
  getPool,
  withTransaction,
  ensureReady,
  // 从 db-config 透出来，调用方（serve.js / admin-cli.js）不用再 require 一次
  isConfigured,
  describeTarget,
  MIGRATIONS
};
