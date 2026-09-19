/**
 * MySQL 连接参数。
 *
 * 解析顺序与 tools/keys.js 那几把服务端密钥同一套口径：
 * **环境变量 > config.local.js > 内置默认值**。之所以刻意保持一致，
 * 是因为用这个项目的人只需要记住一种「本地怎么覆盖默认」的心智模型 ——
 * 密钥、数据库、以后别的东西，都从同一个地方按同一个顺序取。
 *
 * 【为什么单独一个文件，而不是塞进 tools/db.js】
 * 导出脚本（tools/export-sql.js）与并发验证脚本都要读同一份参数，
 * 而它们不该顺带把连接池、迁移机制一起 require 进来 ——
 * 那会让「我只想读一下参数」变成「顺带建一次池、跑一遍迁移」。
 * 建这个文件的直接原因是迁移到 MySQL 时导出脚本要独立于运行时跑。
 */

'use strict';

/** 单项解析：环境变量非空即胜出，否则看本地文件，最后才是内置默认 */
function pick(envName, localValue, fallback) {
  const fromEnv = (process.env[envName] || '').trim();
  if (fromEnv) return fromEnv;

  const fromLocal = localValue == null ? '' : String(localValue).trim();
  if (fromLocal) return fromLocal;

  return fallback;
}

function localConfig() {
  try {
    return require('../config.local');
  } catch {
    // 没这个文件是正常状态（线上、或者刚 clone 下来还没配），不是错误。
    // 这里不能抛：抛了的话线上每次 require 都要走一遍异常构造。
    return {};
  }
}

/**
 * 是不是**真的配过**数据库。
 *
 * 与 dbConfig() 必须分开：后者总会给出 127.0.0.1 这样的默认值，
 * 于是「没配」这件事在返回值里看不出来。而线上（Vercel）正是「没配」——
 * 那里没有 DB_HOST 环境变量、也没有 config.local.js（被 .vercelignore 排除）。
 * 拿默认值去连一个不存在的地址，要等到 connectTimeout 才失败，
 * 那会把「配额记不上账」从瞬时的变成每次规划都慢 2 秒（见 tools/db.js 的 getPool）。
 */
function isConfigured() {
  if ((process.env.DB_HOST || '').trim()) return true;

  const local = localConfig().mysql;
  return Boolean(local && (local.host || local.database));
}

function dbConfig() {
  const local = localConfig().mysql || {};

  return {
    host: pick('DB_HOST', local.host, '127.0.0.1'),
    port: Number(pick('DB_PORT', local.port, 3306)),
    user: pick('DB_USER', local.user, 'root'),

    /* 口令这一项不能用 pick。pick 的口径是「非空才胜出」，而空口令在本机是合法的
       （MySQL 允许免密），用 pick 会让显式写下的空口令被本地文件里的口令盖掉。
       所以改成「设过就听设过的」—— 存在与否比内容重要。 */
    password:
      process.env.DB_PASSWORD != null
        ? String(process.env.DB_PASSWORD)
        : local.password != null
          ? String(local.password)
          : '',

    database: pick('DB_NAME', local.database, 'itinerary')
  };
}

/**
 * 给日志与命令行用的一行描述。**绝不带口令** ——
 * 这串会进终端输出、进 issue 截图、进别人复制的报错信息里。
 */
function describeTarget() {
  const c = dbConfig();
  return `${c.user}@${c.host}:${c.port}/${c.database}`;
}

module.exports = { dbConfig, isConfigured, describeTarget, localConfig };
