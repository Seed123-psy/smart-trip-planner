/**
 * MySQL 版的 schema：建库语句 + 迁移数组。
 *
 * 【这个文件是 DDL 的唯一真相源】
 * 它同时被两处引用：
 *   · tools/db.js          —— 运行时首次开库时按它建表
 *   · tools/export-sql.js  —— 生成 database.sql 时按它出建表语句
 * 共用一份，是为了让「导出的 SQL 文件」与「运行时实际建出来的表」不可能漂移。
 * 分成两份 DDL 各自演进的话，它们的分歧要到「拿旧文件建了一个新库、
 * 结果应用起不来」时才会暴露 —— 那时已经晚了。
 *
 * 【与 SQLite 版（tools/db.js 的历史形态）的对应关系】
 * 迁移的**语义**逐条对应：001 建表、002 审计日志、003 batch 列、004 claim_token
 * 与分享唯一性。但写法几乎每条都要改：
 *   · AUTOINCREMENT → AUTO_INCREMENT，且 id 必须是 BIGINT（见下）
 *   · 所有时间列 INTEGER → BIGINT —— epoch 毫秒是 13 位，而 MySQL 的 INT
 *     上限是 21 亿（10 位），用 INT 会直接溢出，而且是静默的
 *   · TEXT PRIMARY KEY → VARCHAR/CHAR，MySQL 的主键必须显式给长度
 *   · WITHOUT ROWID 删除 —— InnoDB 的聚簇索引本来就是按主键组织的
 *   · 部分唯一索引 → 生成列（见 004）
 *   · 索引写进 CREATE TABLE —— MySQL 没有 CREATE INDEX IF NOT EXISTS，
 *     分开写就丢掉了可重入性，而可重入是这套迁移机制唯一的保证
 *
 * 【可重入是核心约束，不是锦上添花】
 * MySQL 的 DDL 是隐式提交的，SQLite 那套「包在 BEGIN IMMEDIATE 里、失败整体
 * 回滚」在这里做不到。换来的保证是：**每条语句自己幂等 + 一整条迁移跑完才记账**。
 * 于是任何一条迁移失败后可以整条重跑，而不会留下做了一半的表。
 * CREATE TABLE 有 IF NOT EXISTS，加列却没有 —— 那种语句用 guard 现查
 * information_schema 兜住。见下面 columnMissing / indexMissing。
 *
 * 【字符集】
 * 库级默认 utf8mb4（见 DATABASE_DDL）。三类列单独指定：
 *   · username  —— ascii_general_ci。它对应 SQLite 版的 COLLATE NOCASE：
 *       validateUsername 的正则已经只允许小写 [a-z0-9_-]，所以这条排序规则
 *       是第二道防线（防手改库、防日后放松校验时忘了这里）。
 *       用 ascii 而不是 utf8mb4 是因为那个正则保证了这个列不可能出现非 ASCII ——
 *       注释里写明了放开中文会带来同形字问题，那道判断在应用层，这里只是不
 *       给它留后路。
 *   · 机器生成的标识符（trips.id / trip_shares.token / invite_codes.code /
 *       sessions.token_hash / 各种 key）—— ascii_bin。字符集由代码里的
 *       ALPHABET 常量或 hex 编码保证是 ASCII，排序规则用 bin 是为了**精确匹配**：
 *       这些值是按字节比较的令牌，任何大小写折叠语义都是多余且危险的。
 *   · 其余文本列 —— 继承库级 utf8mb4，因为用户名之外的展示字段（行程标题、
 *       审计里的 actor_name）确实会出现中文。
 */

'use strict';

/** 建库语句。导出脚本会把它放在 database.sql 最前面 */
const DATABASE_NAME_DEFAULT = 'itinerary';

/**
 * 库级语句。**不含 CREATE DATABASE** —— 库名由 db-config 决定，
 * 由调用方拼进去（见 databaseDdl()）。
 */
function databaseDdl(databaseName) {
  const name = String(databaseName || DATABASE_NAME_DEFAULT);
  // 库名是标识符，不能绑参。只允许字母数字下划线，杜绝拼接带来的注入面
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`库名不合法：${name}`);
  }
  return [
    `CREATE DATABASE IF NOT EXISTS \`${name}\`` +
      ' DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
    `USE \`${name}\``
  ];
}

/* ---------- 幂等护栏 ---------- */

/**
 * 某个列在不在。
 *
 * 给「没有 IF NOT EXISTS 的 ALTER TABLE ADD COLUMN」当护栏。
 * MySQL 直到 8.0 都没有 ADD COLUMN IF NOT EXISTS（那是 MariaDB 的扩展），
 * 而这条迁移要能重跑，所以只能现查。
 */
async function columnMissing(conn, table, column) {
  const [rows] = await conn.execute(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return Number(rows[0].n) === 0;
}

/** 某个索引在不在。同上，ADD INDEX 也没有 IF NOT EXISTS */
async function indexMissing(conn, table, index) {
  const [rows] = await conn.execute(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, index]
  );
  return Number(rows[0].n) === 0;
}

/* ---------- 迁移 ---------- */

/**
 * 顺序迁移。只增不改：已经发出去过的迁移一旦改动，
 * 老库和新库就会长得不一样，而 schema_meta 里记的版本号还是同一个。
 *
 * 每个 id 一经使用就不要再动它上面的 SQL。
 *
 * statements 的元素有两种形态：
 *   · 字符串           —— 直接执行，必须自身幂等（CREATE TABLE IF NOT EXISTS）
 *   · {sql, guard}     —— guard(conn) 返回 true 才执行。给加列/加索引这类
 *                         没有 IF NOT EXISTS 的语句用
 */
const MIGRATIONS = [
  {
    id: '001-init',
    statements: [
      /* ---------- 账号 ---------- */

      `CREATE TABLE IF NOT EXISTS users (
        id            BIGINT       NOT NULL AUTO_INCREMENT,
        /* ascii_general_ci 对应 SQLite 版的 COLLATE NOCASE ——
           让 Alice 与 alice 撞唯一键。不加的话大小写变体可以并存，
           就成了冒充面：注册 alice 去骗 admin 是同一类问题。
           长度 32 与 tools/auth.js 的 MAX_USERNAME_LENGTH 一致。 */
        username      VARCHAR(32)  CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
        /* 格式 scrypt$N$r$p$salt$hash，参数写进串里。
           实测当前散列串长 86 字符，255 留了充分余量。 */
        password_hash VARCHAR(255) NOT NULL,
        role          VARCHAR(16)  NOT NULL DEFAULT 'user',
        disabled      TINYINT(1)   NOT NULL DEFAULT 0,
        /* 用户自己的 DeepSeek key，格式 v1.<iv>.<tag>.<ct>（AES-256-GCM，AAD 绑定 userId）。
           明文绝不落库；解不开时报错，绝不静默回落到全局 key。 */
        deepseek_key  TEXT         NULL,
        created_at    BIGINT       NOT NULL,
        updated_at    BIGINT       NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_users_username (username),
        CONSTRAINT chk_users_role     CHECK (role IN ('user', 'admin')),
        CONSTRAINT chk_users_disabled CHECK (disabled IN (0, 1))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      `CREATE TABLE IF NOT EXISTS invite_codes (
        /* CODE_LENGTH = 12，且 ALPHABET 是纯大写字母数字 */
        code       CHAR(12)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        note       TEXT         NULL,
        created_by BIGINT       NULL,
        created_at BIGINT       NOT NULL,
        /* NULL 表示永不过期 */
        expires_at BIGINT       NULL,
        max_uses   INT          NOT NULL DEFAULT 1,
        used_count INT          NOT NULL DEFAULT 0,
        revoked    TINYINT(1)   NOT NULL DEFAULT 0,
        PRIMARY KEY (code),
        KEY idx_invite_created_by (created_by),
        CONSTRAINT fk_invite_created_by FOREIGN KEY (created_by)
          REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT chk_invite_revoked CHECK (revoked IN (0, 1))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      `CREATE TABLE IF NOT EXISTS sessions (
        /* 只存 sha256(token) 的 hex，固定 64 字符。
           明文 token 只在 Set-Cookie 那一刻存在于内存里 ——
           库被读走也没法拿去冒充（前提是 token 本身够随机，它是 32 字节随机数）。 */
        token_hash   CHAR(64)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        user_id      BIGINT       NOT NULL,
        created_at   BIGINT       NOT NULL,
        expires_at   BIGINT       NOT NULL,
        last_seen_at BIGINT       NOT NULL,
        /* 代码里是 .slice(0, 300) —— 截断发生在 JS 侧、按 UTF-16 码元，
           所以最多 300 个码元，字符数只会更少。300 够。 */
        user_agent   VARCHAR(300) NULL,
        /* IPv6 最长 45 字符，64 有余量 */
        ip           VARCHAR(64)  NULL,
        PRIMARY KEY (token_hash),
        KEY idx_sessions_user (user_id),
        KEY idx_sessions_expires (expires_at),
        CONSTRAINT fk_sessions_user FOREIGN KEY (user_id)
          REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      /* 登录失败计数放表里而不是内存 Map：进程重启会清空内存计数，
         而重启恰恰是攻击者乐见的时机。
         subject 形如 u:alice（按账号）或 ip:1.2.3.4（按来源），全是 ASCII。 */
      `CREATE TABLE IF NOT EXISTS login_attempts (
        subject       VARCHAR(64)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        fails         INT          NOT NULL DEFAULT 0,
        first_fail_at BIGINT       NOT NULL,
        /* NULL 表示未锁定；有值且大于当前时间即为锁定中 */
        locked_until  BIGINT       NULL,
        PRIMARY KEY (subject)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      /* ---------- 全局设置与审计 ---------- */

      `CREATE TABLE IF NOT EXISTS settings (
        \`key\`      VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        /* 可能是明文（可公开项），也可能与用户 key 一样是 v1.<iv>.<tag>.<ct> 信封 */
        value      TEXT        NULL,
        updated_at BIGINT      NOT NULL,
        updated_by BIGINT      NULL,
        PRIMARY KEY (\`key\`),
        KEY idx_settings_updated_by (updated_by),
        CONSTRAINT fk_settings_updated_by FOREIGN KEY (updated_by)
          REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      /* 换全局密钥是不可灰度的高风险操作，必须能回溯与回滚 */
      `CREATE TABLE IF NOT EXISTS settings_history (
        id         BIGINT      NOT NULL AUTO_INCREMENT,
        \`key\`      VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        old_value  TEXT        NULL,
        new_value  TEXT        NULL,
        changed_at BIGINT      NOT NULL,
        changed_by BIGINT      NULL,
        PRIMARY KEY (id),
        KEY idx_settings_history_key (\`key\`, changed_at DESC),
        CONSTRAINT fk_settings_history_by FOREIGN KEY (changed_by)
          REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      /* ---------- 配额 ---------- */

      /* 计数器表。reserved 是「已预留未结算」：
         一次规划要跑 30–90 秒，只在开始时检查、结束时才记数，
         并发下这条检查形同虚设 —— 5 个请求会一起看到 used=0 然后全部放行。
         主键 (subject, day) 就是 SQLite 版那句 WITHOUT ROWID 想表达的东西，
         InnoDB 的聚簇索引天然按主键组织，不需要额外写。 */
      `CREATE TABLE IF NOT EXISTS quota_usage (
        subject  VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        /* YYYY-MM-DD，按 Asia/Shanghai 切分而不是 UTC ——
           拿 UTC 切会让用户在北京时间早上 8 点看到额度重置，看起来像 bug。
           用 CHAR(10) 而不是 DATE：这个值参与 < 比较与排序，
           定长 ASCII 字符串的字典序就是日期序，且不需要任何时区转换。 */
        day      CHAR(10)    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        used     INT         NOT NULL DEFAULT 0,
        reserved INT         NOT NULL DEFAULT 0,
        PRIMARY KEY (subject, day)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      /* ---------- 行程与分享 ---------- */

      `CREATE TABLE IF NOT EXISTS trips (
        /* randomId(16)，ALPHABET 是纯大写字母数字 */
        id          CHAR(16)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        /* NULL 表示未登录时的匿名行程，仍然入库（分享链接要能引用） */
        user_id     BIGINT       NULL,
        title       VARCHAR(255) NULL,
        city        VARCHAR(64)  NULL,
        /* 代码允许 2MB（tools/trips.js 的 MAX_PAYLOAD_BYTES），
           而 MySQL 的 TEXT 上限是 64KB —— 用 TEXT 会抛 1406 Data too long。
           MEDIUMTEXT 上限 16MB，够。 */
        payload     MEDIUMTEXT   NOT NULL,
        created_at  BIGINT       NOT NULL,
        updated_at  BIGINT       NOT NULL,
        PRIMARY KEY (id),
        KEY idx_trips_user (user_id, created_at DESC),
        CONSTRAINT fk_trips_user FOREIGN KEY (user_id)
          REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      `CREATE TABLE IF NOT EXISTS trip_shares (
        /* randomId(20) */
        token      CHAR(20)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        trip_id    CHAR(16)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        created_by BIGINT     NULL,
        created_at BIGINT     NOT NULL,
        revoked    TINYINT(1) NOT NULL DEFAULT 0,
        PRIMARY KEY (token),
        KEY idx_trip_shares_trip (trip_id),
        CONSTRAINT fk_trip_shares_trip FOREIGN KEY (trip_id)
          REFERENCES trips(id) ON DELETE CASCADE,
        CONSTRAINT fk_trip_shares_by FOREIGN KEY (created_by)
          REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT chk_trip_shares_revoked CHECK (revoked IN (0, 1))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
    ]
  },

  {
    id: '002-audit-log',
    statements: [
      /* 管理员做过什么，要能回溯。
         settings_history 只覆盖「设置被改成了什么」，回答不了「谁把谁禁用了」
         这类问题，所以单开一张表。

         actor_name 是**冗余**存的，不是多余的：actor_id 用了 ON DELETE SET NULL，
         用户被删之后那一列会变成 NULL。审计的全部价值就在于事后追问，
         而事后往往正是人已经不在了的时候 —— 只留一个会被清空的 id 等于没记。
         actor_name 会出现中文（命令行、真实姓名），所以是 utf8mb4。 */
      `CREATE TABLE IF NOT EXISTS audit_log (
        id         BIGINT       NOT NULL AUTO_INCREMENT,
        at         BIGINT       NOT NULL,
        actor_id   BIGINT       NULL,
        actor_name VARCHAR(128) NOT NULL,
        action     VARCHAR(64)  NOT NULL,
        target     VARCHAR(128) NULL,
        detail     TEXT         NULL,
        PRIMARY KEY (id),
        KEY idx_audit_log_at (at DESC),
        KEY idx_audit_log_action (action, at DESC),
        CONSTRAINT fk_audit_log_actor FOREIGN KEY (actor_id)
          REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
    ]
  },

  {
    id: '003-settings-history-batch',
    statements: [
      /* 记录「这一行属于哪一次保存」。
         需要它是因为成对的项（高德 WebJS Key 与安全密钥）要一起回滚，
         而回滚时必须找回**同一次写入**里的另一行。原先靠 changed_at 相等来找，
         但那不够：同一毫秒内的两次保存无法区分，会配错行 ——
         实测结果是回滚把两个键改成了一次写入之前的值、另一次写入之后的值，
         造出「只配了一半」的状态，正是成对约束要挡的东西。 */
      {
        guard: (conn) => columnMissing(conn, 'settings_history', 'batch'),
        sql: 'ALTER TABLE settings_history ADD COLUMN batch BIGINT NULL'
      },

      {
        guard: (conn) => indexMissing(conn, 'settings_history', 'idx_settings_history_batch'),
        sql: 'ALTER TABLE settings_history ADD KEY idx_settings_history_batch (batch, `key`)'
      },

      /* 【为什么单开一张计数器表，而不是沿用 SQLite 版的 MAX(batch)+1】
         SQLite 版的注释写着「写入都包在 BEGIN IMMEDIATE 里，所以这个读取-加一
         不会被并发穿插」。MySQL 的 REPEATABLE READ 下这句话不成立：
         普通 SELECT 是快照读、不加锁，两个并发事务会读到同一个 MAX 值 ——
         而 batch 的全部意义就是「同一次保存」的唯一标识，撞了就会配错行。

         也不能改成 SELECT MAX(batch) ... FOR UPDATE：那是对一个空区间取间隙锁，
         空表时锁住整个范围，与并发插入叠在一起是标准的死锁配方。
         换成一行专门的计数器：它的取值是一次**必然改动**的 UPDATE，
         行锁精确且只锁一行。 */
      `CREATE TABLE IF NOT EXISTS sequences (
        name  VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        value BIGINT      NOT NULL,
        PRIMARY KEY (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

      /* 种子行。INSERT IGNORE 保证可重入 —— 重跑这条迁移不会把计数清零 */
      "INSERT IGNORE INTO sequences (name, value) VALUES ('settings_batch', 0)"
    ]
  },

  {
    id: '004-trip-claim-token',
    statements: [
      /* 「认领匿名行程」需要一把与「读」分开的凭证。
         行程 id 按设计是**读**能力（capability URL，谁拿到谁能看：手工发出去的
         trip.html?trip=<id> 链接、浏览器历史、截图）。而认领原本只凭这个 id
         就把 user_id 改成自己 —— 于是一个只被授予「看」的人登录一次，
         就能把行程从原主人手里夺走：原主人（通常没账号）再打开就是 404。
         所以另发一把 claim_token，只在规划那一次的响应里回给客户端，
         不进 URL、不进 payload、不进分享链接。实测长度 20。 */
      {
        guard: (conn) => columnMissing(conn, 'trips', 'claim_token'),
        sql: 'ALTER TABLE trips ADD COLUMN claim_token CHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL'
      },

      /* 建唯一约束之前先把可能存在的重复撤销掉，否则这一步会因为唯一冲突失败。
         SQLite 版用 rowid NOT IN (SELECT MIN(rowid) ...) —— MySQL 没有隐式 rowid，
         而这张表的主键 token 是随机生成的，不携带先后信息。
         换一个等价的确定口径：**每条 trip_id 保留 token 字典序最小的那一条**，
         其余全部撤销。不变量的内容（每条行程最多一条生效分享）与老版本一致，
         只是「留哪一条」从「最早插入的」变成「token 最小的」——
         对任何正常数据这本来就是个空操作。

         为什么要多套一层派生表：MySQL 的 1093 错误不允许在 UPDATE 的目标表上
         直接开子查询。多嵌一层强制物化来绕开它；而 8.0.14 起派生表会被合并，
         单层嵌套在部分形态下会重新触发 1093，所以这里是两层。 */
      `UPDATE trip_shares AS s
         JOIN (
           SELECT trip_id, MIN(token) AS keep_token
             FROM (SELECT token, trip_id FROM trip_shares WHERE revoked = 0) AS t
            GROUP BY trip_id
         ) AS keep ON keep.trip_id = s.trip_id
          SET s.revoked = 1
        WHERE s.revoked = 0 AND s.token <> keep.keep_token`,

      /* 「同一条行程同时只有一条生效的分享链接」这个不变量交给库来保证。
         原先靠 createShare 里「先查后插」+「Node 是单线程」这个隐含前提，
         单进程成立，多进程会各查各的再各插一条。

         【MySQL 没有部分索引（partial index），用生成列代替】
         撤销的行在生成列里是 NULL，而唯一索引**不约束 NULL**（SQL 的唯一约束
         本来就把多个 NULL 视为互不相等），于是只有 revoked = 0 的行参与唯一性
         判定 —— 与 SQLite 那条 `WHERE revoked = 0` 的部分索引逐字等价。

         【为什么不能改成应用层互斥】那等于把上面说的多进程 bug 请回来，
         而且它是静默的：两个进程各查各的，都认为没有生效分享，然后各插一条。

         【为什么必须保留「抛可捕获的唯一键错误」这一行为】
         tools/trips.js 的 createShare 依赖它作为「另一个进程刚建过」的信号，
         catch 之后把对方那条取回来复用。所以不能改成 INSERT IGNORE ——
         那会把信号吞掉，调用方拿到一个自己编的 token，而库里存的是另一条。
         用 VIRTUAL 而不是 STORED：VIRTUAL 不占行内空间，且唯一索引照样能建。 */
      {
        guard: (conn) => columnMissing(conn, 'trip_shares', 'active_trip_id'),
        sql: `ALTER TABLE trip_shares
                ADD COLUMN active_trip_id CHAR(16) CHARACTER SET ascii COLLATE ascii_bin
                  GENERATED ALWAYS AS (IF(revoked = 0, trip_id, NULL)) VIRTUAL`
      },

      {
        guard: (conn) => indexMissing(conn, 'trip_shares', 'uniq_trip_shares_active'),
        sql: 'ALTER TABLE trip_shares ADD UNIQUE KEY uniq_trip_shares_active (active_trip_id)'
      }
    ]
  }
];

/** 迁移记账表。不放在迁移里 —— 否则「记录已执行的迁移」这件事没有落脚点 */
const META_TABLE = `CREATE TABLE IF NOT EXISTS schema_meta (
  \`key\` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (\`key\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

module.exports = {
  MIGRATIONS,
  META_TABLE,
  DATABASE_NAME_DEFAULT,
  databaseDdl,
  columnMissing,
  indexMissing
};
