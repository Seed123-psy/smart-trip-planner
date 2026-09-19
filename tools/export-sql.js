#!/usr/bin/env node
/**
 * 把 SQLite 里的数据导出成一份 MySQL 可以直接吃的 database.sql。
 *
 *   node tools/export-sql.js [输出路径]
 *
 * 生成的文件同时含**建表语句**与**数据**，所以 `mysql < database.sql`
 * 之后就直接得到一个和现在一模一样的库，不需要再跑迁移。
 *
 * 【为什么直接读 SQLite 文件，而不是走 tools/db.js】
 * 因为 db.js 已经改成 MySQL 版了 —— 它会去连 MySQL。而这份脚本要读的恰恰是
 * 那个**旧的** SQLite 文件。所以这里直接 require('node:sqlite')，
 * 与运行时的数据层完全解耦。
 *
 * 【源库只读打开】
 * 这是硬约束，不是顺手写的。导完之后 data/app.db 要能原封不动地留着当回退物，
 * 一旦这里写了一次，回退路径就不成立了。
 *
 * 【刻意不导出的数据】
 * 四类数据被排除在外，因为一份 .sql 文件会进 git、会被拷来拷去，
 * 而它们要么拿到就能直接用，要么本来就没有价值：
 *   · sessions 整表      —— 虽然存的是 token 的 sha256 反不出原 token，
 *                           但整表导出去没有意义：会话本来就该在换库后重新登录
 *   · trip_shares 整表   —— token 是**明文**的分享凭证，拿到即可访问那条行程
 *   · trips.claim_token  —— 认领凭证，拿到即可把别人的匿名行程认领走
 *   · settings_history 的值字段 —— 只导「谁在什么时候改了什么」，不导值本身。
 *       那些值可能是密文（解不开的旧密钥）**也可能是明文**（浏览器侧那对本来就
 *       不加密），两种都不该出现在一份要入库的文件里。
 *       代价是历史回滚失去数据 —— 但回滚本来就依赖能解开的值，
 *       而解不开的那部分历史搬回去也只会造出「解不开」的状态。
 * 其余（账号、口令散列、行程、邀请码、审计、配额账）原样保留 ——
 * 没有它们就不叫「恢复到同一个库」了。
 *
 * 【口令散列仍在文件里，这个文件应当私有】
 * users.password_hash 是 scrypt 散列，够强但**弱口令可离线爆破**。
 * 这个文件按用户的决定入库，所以请确保仓库是私有的。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// 只借用 mysql2 的转义器，不建连接。
// payload 是 30KB 的 JSON，里面必然有单引号、反斜杠与换行，
// 手写转义一定会错 —— 而错了之后的表现是「导入时报语法错」或者更糟的
// 「静默存进了截断的 JSON」。
const mysql = require('mysql2');

const schema = require('./schema-mysql');
const { dbConfig } = require('./db-config');

const ROOT = path.resolve(__dirname, '..');
const SQLITE_PATH = path.join(ROOT, 'data', 'app.db');
const OUT_PATH = path.resolve(process.argv[2] || path.join(ROOT, 'database.sql'));

/**
 * 导出的表与顺序。顺序按**外键依赖**排：users 必须排在所有引用它的表前面，
 * trips 必须排在 trip_shares 前面（后者不导，但保留这个顺序便于日后加回来）。
 *
 * overrides 用来把某一列强制写成 NULL —— 目前只有 trips.claim_token。
 */
const TABLES = [
  { name: 'users' },
  { name: 'invite_codes' },
  // sessions 不导（活凭证），见文件头
  { name: 'login_attempts' },
  { name: 'settings' },
  // 只导时间线与键名，值一律置 NULL —— 见文件头「刻意不导出的数据」
  { name: 'settings_history', overrides: { old_value: null, new_value: null } },
  { name: 'quota_usage' },
  { name: 'trips', overrides: { claim_token: null } },
  // trip_shares 不导（活凭证），见文件头
  { name: 'audit_log' }
];

/** 有 AUTO_INCREMENT 主键的表，导出后要把自增起点推到 MAX(id)+1，否则导入后第一批新行会撞主键 */
const AUTO_INCREMENT_TABLES = ['users', 'settings_history', 'audit_log'];

/** 转义一个值。null / undefined 一律成 NULL 字面量，其余交给 mysql2 */
function lit(value) {
  if (value === null || value === undefined) return 'NULL';
  // BIGINT 的毫秒时间戳是 13 位，远在 Number.MAX_SAFE_INTEGER 之内，
  // 所以这里不会碰上精度问题；一旦碰上说明数据本身已经坏了，让它原样输出成科学计数法反而能暴露
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return String(value);
  return mysql.escape(value);
}

/** SQLite 里某张表的列名（按定义顺序） */
function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

function build() {
  if (!fs.existsSync(SQLITE_PATH)) {
    throw new Error(`找不到源库：${SQLITE_PATH}`);
  }

  // readOnly 不是可选项，见文件头
  const db = new DatabaseSync(SQLITE_PATH, { readOnly: true });

  const target = dbConfig();
  const out = [];
  const push = (line) => out.push(line);

  /* ---------- 文件头 ---------- */

  push('-- 武汉行程攻略 · MySQL 数据库导出');
  push('--');
  push('-- 由 tools/export-sql.js 生成，源库是 data/app.db（SQLite）。');
  push('-- 建表语句取自 tools/schema-mysql.js —— 与运行时建表用的是同一份，');
  push('-- 所以这份文件建出来的表和跑一遍迁移建出来的表逐列相同。');
  push('--');
  push('-- 导入方式：');
  push(`--   mysql -u ${target.user} -p < database.sql`);
  push('-- 或者在 mysql 客户端里：');
  push('--   source /path/to/database.sql');
  push('--');
  push('-- 【这份文件含口令散列，应当私有】');
  push('-- users.password_hash 是 scrypt 散列，弱口令可离线爆破。');
  push('--');
  push('-- 【刻意未导出的三类活凭证】');
  push('--   sessions 整表      —— 换库后本就该重新登录');
  push('--   trip_shares 整表   —— token 是明文分享凭证，拿到即可访问该行程');
  push('--   trips.claim_token  —— 认领凭证，拿到即可认领他人的匿名行程');
  push('-- 其余数据原样保留。');
  push('');

  push('SET NAMES utf8mb4;');
  push('SET FOREIGN_KEY_CHECKS = 0;');
  push('');

  /* ---------- 建库 ---------- */

  push('-- ---------- 建库 ----------');
  for (const sql of schema.databaseDdl(target.database)) push(`${sql};`);
  push('');

  /* ---------- 建表 ---------- */

  push('-- ---------- 建表 ----------');
  push('-- 与 tools/db.js 的迁移链等价。导入完成后 schema_meta 里会有 4 条记录，');
  push('-- 所以应用启动时迁移器会空转，不会对着已有的表再跑一次 CREATE。');
  push('');
  push(`${schema.META_TABLE};`);
  push('');

  for (const migration of schema.MIGRATIONS) {
    push(`-- ${migration.id}`);
    for (const statement of migration.statements) {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      // 导出到空库，guard 全部按「需要执行」处理 —— 这里不做 information_schema 检查，
      // 因为此刻库刚建出来，那些列和索引必然都不存在
      push(`${sql};`);
    }
    push('');
  }

  push('START TRANSACTION;');
  push('');

  /* ---------- 迁移记账 ---------- */

  push('-- ---------- 迁移记账（让应用启动时不再重跑迁移） ----------');
  for (const migration of schema.MIGRATIONS) {
    push(
      `INSERT INTO schema_meta (\`key\`, value) VALUES (` +
        `${lit(`migration.${migration.id}`)}, ${lit(String(Date.now()))});`
    );
  }
  push('');

  /* ---------- 批次计数器种子 ---------- */

  // SQLite 版用 MAX(batch)+1 取批次号，MySQL 版换成这张计数器表。
  // 它必须从**源库已用到的最大 batch** 接着往下走，从 0 开始的话
  // 下一次保存的 batch 会与历史里的撞上，而 batch 撞了就会在回滚时配错行。
  const maxBatch = db.prepare('SELECT COALESCE(MAX(batch), 0) AS n FROM settings_history').get().n;
  push('-- ---------- 批次计数器 ----------');
  push(
    `UPDATE sequences SET value = ${lit(Number(maxBatch))} WHERE name = 'settings_batch';`
  );
  push('');

  /* ---------- 数据 ---------- */

  push('-- ---------- 数据 ----------');
  const counts = [];

  for (const table of TABLES) {
    const columns = columnsOf(db, table.name);
    const rows = db.prepare(`SELECT * FROM ${table.name}`).all();

    push('');
    push(`-- ${table.name}：${rows.length} 行`);
    counts.push(`${table.name}=${rows.length}`);

    if (!rows.length) continue;

    const columnList = columns.map((c) => `\`${c}\``).join(', ');
    // 每批多行一条 INSERT，但不追求极致压缩：一行一条更好读，
    // 出错时 mysql 报的行号也直接对应得上
    for (const row of rows) {
      const values = columns.map((column) => {
        if (table.overrides && column in table.overrides) return lit(table.overrides[column]);
        return lit(row[column]);
      });
      push(`INSERT INTO \`${table.name}\` (${columnList}) VALUES (${values.join(', ')});`);
    }
  }

  push('');

  /* ---------- 自增起点 ---------- */

  push('-- ---------- 自增起点 ----------');
  push('-- 不回填的话，导入后第一条新记录会从 1 开始，撞上已经存在的主键');
  for (const table of AUTO_INCREMENT_TABLES) {
    const max = db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM ${table}`).get().n;
    push(`ALTER TABLE \`${table}\` AUTO_INCREMENT = ${Number(max) + 1};`);
  }

  push('');
  push('COMMIT;');
  push('');
  push('SET FOREIGN_KEY_CHECKS = 1;');
  push('');

  db.close();
  return { sql: out.join('\n'), counts: counts.join(' ') };
}

/* ---------- 跑 ---------- */

try {
  const { sql, counts } = build();
  fs.writeFileSync(OUT_PATH, sql, 'utf8');

  const bytes = Buffer.byteLength(sql, 'utf8');
  const lines = sql.split('\n').length;

  console.log(`已导出：${OUT_PATH}`);
  console.log(`  ${lines} 行，${(bytes / 1024).toFixed(1)} KB`);
  console.log(`  目标库：${dbConfig().user}@${dbConfig().host}:${dbConfig().port}/${dbConfig().database}`);
  console.log(`  表行数：${counts}`);
  console.log('  已排除：sessions（整表）、trip_shares（整表）、trips.claim_token、settings_history 的值');
} catch (error) {
  console.error('导出失败：', error && error.message);
  process.exitCode = 1;
}
