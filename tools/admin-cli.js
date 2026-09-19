#!/usr/bin/env node
/**
 * 管理员命令行。
 *
 *   node tools/admin-cli.js show
 *   node tools/admin-cli.js set-amap --key <WEB_JS_KEY> --code <SECURITY_CODE>
 *   node tools/admin-cli.js clear-amap
 *
 *   node tools/admin-cli.js create-admin [--username <名字>] [--weak]
      --weak 跳过口令的最低长度要求，只给本机初始引导用。
      不加它时口令至少 8 位 —— 注册页与后台重置口令始终是这个口径。
 *   node tools/admin-cli.js invite [--note <备注>] [--uses N] [--days N]
 *   node tools/admin-cli.js invites
 *   node tools/admin-cli.js revoke-invite <code>
 *
 * 为什么要有它：阶段 1 让浏览器侧高德密钥可以被服务端覆盖，但写入界面在阶段 3。
 * 没有这个命令行，那两项就只能靠手写 SQL，而手写 SQL 最容易犯的错恰好是
 * 「只写了一行」—— 那会造出一个只配了一半的状态，运行时静默回落到静态值，
 * 看起来像「改了没生效」。这个命令行的主要价值就是让「成对」变成唯一入口。
 *
 * 【口令一律交互式输入，绝不走命令行参数】命令行参数会进 shell 历史，也会
 * 出现在同一台机器上任何人的 `ps` 输出里。高德那两项按设计是公开的所以无所谓，
 * 但 create-admin 的口令、以及放进设置表的 DeepSeek key，都必须
 * 走这里的 promptHidden()。
 *
 * 【迁移到 MySQL 时的两处改动】
 *   · 每个命令都变成 async（数据层是异步的），入口处 await 开库
 *   · 原来打印的是「库文件 <路径>」，现在打印 <user>@<host>:<port>/<库名>。
 *     **绝不打印口令** —— 这串会进终端输出、进 issue 截图、进别人复制的报错里
 */

'use strict';

const readline = require('readline');
const { getDb, closeDb, describeTarget } = require('./db');
const {
  getSetting,
  setSettings,
  clearSettings,
  KEY_WEBJS,
  KEY_SECURITY
} = require('./settings');
const { resolveAmapWebConfig, ignoredWarnings } = require('./keys');
const {
  validateUsername,
  validatePassword,
  createUser,
  findByUsername,
  MIN_PASSWORD_LENGTH
} = require('./auth');
const { createInvite, listInvites, revoke: revokeInvite, countUsable, normalizeCode } = require('./invites');
const audit = require('./audit');

const USAGE = `
管理员命令行

  node tools/admin-cli.js show
      显示浏览器侧高德密钥当前生效的来源与取值。

  node tools/admin-cli.js set-amap --key <WEB_JS_KEY> --code <SECURITY_CODE>
      写入一对高德密钥。两项必须同时给出 —— 只给一个会被拒绝，
      因为「只配一半」在运行时是静默失效的，比报错难查得多。

  node tools/admin-cli.js clear-amap
      删掉覆盖值，回落 config.js 里的静态配置。

  node tools/admin-cli.js create-admin [--username <名字>] [--weak] [--promote]
  node tools/admin-cli.js invite [--note <备注>] [--uses N] [--days N]
  node tools/admin-cli.js invites
  node tools/admin-cli.js revoke-invite <code>

改完不需要重启服务：/api/config 每次请求都重新读库。
但浏览器已经打开的页面要刷新一次才会拿到新值。
`;

/** 高德这两个值都是 32 位十六进制。只提醒不拦截 —— 格式变了不该被这个挡住 */
function looksLikeAmapValue(value) {
  return /^[0-9a-f]{32}$/i.test(value);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq > -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    // --flag 后面没跟值，或者跟的是另一个 --flag，就当它是布尔开关
    if (next === undefined || next.startsWith('--')) {
      out[name] = true;
      continue;
    }
    out[name] = next;
    i++;
  }
  return out;
}

/* ---------- 命令 ---------- */

async function cmdShow() {
  const resolved = await resolveAmapWebConfig();
  const { amap, source } = resolved;

  const envKey = (process.env.AMAP_WEB_JS_KEY || '').trim();
  const envCode = (process.env.AMAP_SECURITY_CODE || '').trim();
  const dbKey = await getSetting(KEY_WEBJS);
  const dbCode = await getSetting(KEY_SECURITY);

  const yes = (v) => (v ? '已设置' : '未设置');
  const label = { static: 'config.js 静态值', settings: '数据库覆盖', env: '环境变量覆盖' };

  console.log('\n── 浏览器侧高德密钥 ──────────────────────────');
  console.log(`  数据库    ${describeTarget()}`);
  console.log(`  生效来源  ${label[source] || source}`);

  if (amap) {
    console.log(`  WEB_JS_KEY      ${amap.WEB_JS_KEY}`);
    console.log(`  SECURITY_CODE   ${amap.SECURITY_CODE}`);
  } else {
    console.log('  （没有完整覆盖值，浏览器会用 config.js 里的静态那一对）');
  }

  console.log('\n  各来源状态');
  console.log(`    环境变量  AMAP_WEB_JS_KEY ${yes(envKey)} / AMAP_SECURITY_CODE ${yes(envCode)}`);
  console.log(`    数据库    ${KEY_WEBJS} ${yes(dbKey)} / ${KEY_SECURITY} ${yes(dbCode)}`);

  for (const line of ignoredWarnings(resolved)) {
    console.log(`\n  ⚠ ${line}`);
  }

  console.log('\n  注意：换 key 之后要确认高德控制台里的域名白名单覆盖了当前访问域名，');
  console.log('        否则地图会加载不出来 —— 这一条只有浏览器能验。\n');
  return 0;
}

async function cmdSetAmap(args) {
  const key = typeof args.key === 'string' ? args.key.trim() : '';
  const code = typeof args.code === 'string' ? args.code.trim() : '';

  if (!key || !code) {
    const missing = [!key && '--key', !code && '--code'].filter(Boolean).join(' 与 ');
    console.error(`\n✗ 缺少 ${missing}`);
    console.error('  WEB_JS_KEY 与 SECURITY_CODE 必须成对提供。只写一个的话，运行时');
    console.error('  会当成没配、静默回落到 config.js 的静态值 —— 看起来像「改了没生效」。');
    console.error('  若确实想只改一个，请把另一个的现值也一起填上。\n');
    return 1;
  }

  const changes = await setSettings([
    { key: KEY_WEBJS, value: key },
    { key: KEY_SECURITY, value: code }
  ]);

  // 命令行改设置也要进审计 —— 这是当前唯一的成对写入入口，
  // 不记的话后台的「操作记录」里会缺掉最要紧的那条「谁换了 key」
  await audit.record({
    actor: null,
    action: 'settings.set',
    target: changes.map((c) => c.key).join(', '),
    detail: '命令行'
  });

  console.log('\n── 已写入 ────────────────────────────────────');
  for (const c of changes) {
    const short = (v) => (v ? `${v.slice(0, 8)}…${v.slice(-4)}` : '（无）');
    console.log(`  ${c.key}${c.changed ? '' : '  （与原值相同，未记历史）'}`);
    console.log(`    ${short(c.from)}  →  ${short(c.to)}`);
  }

  if (!looksLikeAmapValue(key) || !looksLikeAmapValue(code)) {
    console.log('\n  ⚠ 有一个值不是 32 位十六进制的形状。高德的两个值历来都是这个格式，');
    console.log('    写错了不会有任何报错，只会表现为地图加载不出来。已写入，请自行核对。');
  }

  console.log('\n  已记入 settings_history，可在后台回滚。');
  console.log('  浏览器需刷新才会拿到新值；服务本身不用重启。');
  console.log('  别忘了确认高德控制台的域名白名单。\n');
  return 0;
}

async function cmdClearAmap() {
  const changes = await clearSettings([KEY_WEBJS, KEY_SECURITY]);
  const existed = changes.some((c) => c.changed);

  // 空操作不记 —— 与 setSettings 的口径一致，否则审计里会堆满「无 → 无」
  if (existed) {
    await audit.record({
      actor: null,
      action: 'settings.clear',
      target: changes.map((c) => c.key).join(', '),
      detail: '命令行'
    });
  }

  console.log('\n── 已清除 ────────────────────────────────────');
  for (const c of changes) {
    console.log(`  ${c.key}  ${c.from === null ? '（本来就没设）' : '已删除'}`);
  }
  console.log(existed ? '\n  浏览器将回落到 config.js 里的静态密钥。\n' : '\n  数据库里本来就没有覆盖值。\n');
  return 0;
}

/* ---------- 交互式输入 ---------- */

/* ---- 非交互环境（管道、CI）用的共享读取器 ----

   这里踩过一个坑，值得写下来：最初每个问题都新建一个 readline 接口，
   结果在 `printf 'a\nb\n' | node tools/admin-cli.js create-admin` 这种用法下，
   第一个接口把管道里的输入一次性抽干，第二个问题永远等不到输入 ——
   而事件循环此时已经空了，Node 就以**退出码 0** 静默结束。
   表面上「命令成功了」，实际上一个用户都没建出来。

   所以整个进程共用一个接口：行先入队，问的时候再取。 */
const lineQueue = [];
const lineWaiters = [];
let readerStarted = false;
let stdinClosed = false;

function initReader() {
  if (readerStarted) return;
  readerStarted = true;

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const waiter = lineWaiters.shift();
    if (waiter) waiter(line);
    else lineQueue.push(line);
  });
  rl.on('close', () => {
    stdinClosed = true;
    // 唤醒所有还在等的人。不唤醒的话它们永远挂着，进程又会静默退出。
    while (lineWaiters.length) lineWaiters.shift()('');
  });
}

function readPipedLine(prompt) {
  initReader();
  process.stdout.write(prompt);
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (stdinClosed) return Promise.resolve(''); // 输入已耗尽
  return new Promise((resolve) => lineWaiters.push(resolve));
}

/**
 * 问一个问题并读一行答案。
 * hidden 为真时关闭回显 —— 口令不该出现在屏幕上，也不该留在终端的回滚缓冲里。
 * 输入耗尽时返回空串，由调用方决定怎么报错。
 */
function ask(question, options) {
  const hidden = Boolean(options && options.hidden);
  const stdin = process.stdin;

  // 非交互环境没有 TTY，setRawMode 不存在，只能退化成明文读取
  if (!stdin.isTTY || !hidden) return readPipedLine(question);

  return new Promise((resolve) => {
    const stdout = process.stdout;
    stdout.write(question);

    // 用数组存字符而不是字符串拼接：退格时按码点弹出，
    // 否则一个多字节字符会被 slice 劈成半个代理对
    const chars = [];

    const finish = (result) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      resolve(result);
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(chars.join(''));
        if (ch === '\u0003') {
          stdout.write('\n');
          process.exit(130); // Ctrl+C
        }
        if (ch === '\u007f' || ch === '\b') {
          chars.pop();
          continue;
        }
        chars.push(ch);
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  return 1;
}

/* ---------- 账号 ---------- */

async function cmdCreateAdmin(args) {
  const db = await getDb();
  const [adminRows] = await db.execute("SELECT count(*) AS n FROM users WHERE role = 'admin'");
  const admins = adminRows[0].n;

  let username = typeof args.username === 'string' ? args.username : '';
  if (!username) username = await ask('管理员用户名：');

  try {
    username = validateUsername(username);
  } catch (error) {
    return fail(error.message);
  }

  const existing = await findByUsername(username);

  if (existing) {
    if (!args.promote) {
      console.error(`\n✗ 用户名「${username}」已存在（id ${existing.id}，当前角色 ${existing.role}）`);
      console.error('  若本意是把这个已有账号提成管理员，加上 --promote 再执行一次。');
      return 1;
    }
    await db.execute("UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?", [
      Date.now(),
      existing.id
    ]);

    // 提权比建号更该留痕：前者改的是既有账号的权限
    await audit.record({
      actor: null,
      action: 'user.role',
      target: `u:${username}`,
      detail: `${existing.role} → admin · 命令行`
    });

    console.log(`\n✓ 已把「${username}」提升为管理员`);
    return 0;
  }

  // --weak 跳过最低长度要求，只给初始引导用（本机试用常设成 admin/admin）。
  // 注册页与后台的「重置口令」不受它影响 —— 见 tools/auth.js 的说明
  const weak = args.weak === true;
  const prompt = weak
    ? '口令（--weak：不限长度，输入时不显示）：'
    : `口令（至少 ${MIN_PASSWORD_LENGTH} 位，输入时不显示）：`;

  const password = await ask(prompt, { hidden: true });
  if (!password) return fail('没有读到口令。用管道输入时，两行口令都要喂进来');

  try {
    validatePassword(password, { allowShort: weak });
  } catch (error) {
    return fail(error.message);
  }

  const again = await ask('再输一次：', { hidden: true });
  if (!again) return fail('没有读到第二次口令');
  if (again !== password) return fail('两次输入不一致');

  const user = await createUser({ username, password, role: 'admin' }, { allowShort: weak });

  // 命令行操作也要进审计。actor 传 null —— record() 会把操作者记成「命令行」。
  // 有 shell 权限的人当然能直接改库，审计挡不住他；但如果命令行不留痕，
  // 「这个管理员是谁建的」就永远查不出来，而那是审计最该回答的问题之一。
  await audit.record({
    actor: null,
    action: 'user.create',
    target: `u:${user.username}`,
    detail: '管理员 · 命令行'
  });

  console.log(`\n✓ 管理员已创建：${user.username}（id ${user.id}）`);
  if (admins === 0) {
    console.log('  这是第一个管理员 —— 在此之前没有任何人能进管理后台。');
  }
  console.log('  现在启动服务，用这个账号登录 /login.html。\n');
  return 0;
}

/* ---------- 邀请码 ---------- */

async function cmdInvite(args) {
  const uses = args.uses === undefined ? 1 : Number(args.uses);
  if (!Number.isFinite(uses) || uses < 1) return fail('--uses 需要是大于 0 的整数');

  const days = args.days === undefined ? null : Number(args.days);
  if (days !== null && (!Number.isFinite(days) || days <= 0)) return fail('--days 需要是大于 0 的整数');

  const invite = await createInvite({
    note: typeof args.note === 'string' ? args.note : null,
    maxUses: uses,
    expiresAt: days === null ? null : Date.now() + days * 24 * 60 * 60 * 1000
  });

  await audit.record({
    actor: null,
    action: 'invite.create',
    target: `invite:${invite.code}`,
    detail: `上限 ${invite.max_uses} 次 · 命令行`
  });

  console.log('\n── 邀请码 ────────────────────────────────────');
  console.log(`  ${invite.code}`);
  console.log(`\n  使用上限  ${invite.max_uses} 次（已用 ${invite.used_count} 次）`);
  console.log(`  有效期    ${days === null ? '不过期' : `${days} 天`}`);
  if (invite.note) console.log(`  备注      ${invite.note}`);
  console.log('\n  把它发给要注册的人，在 /login.html 的注册表单里填。\n');
  return 0;
}

async function cmdInvites() {
  const rows = await listInvites(100);

  console.log('\n── 邀请码 ────────────────────────────────────');
  if (!rows.length) {
    console.log('  （还没有邀请码。用 node tools/admin-cli.js invite 生成一个）\n');
    return 0;
  }

  const now = Date.now();
  for (const row of rows) {
    const state =
      row.revoked ? '已撤销' :
      row.used_count >= row.max_uses ? '已用尽' :
      row.expires_at !== null && row.expires_at <= now ? '已过期' : '可用';
    const expiry = row.expires_at === null ? '不过期' : new Date(row.expires_at).toLocaleDateString('zh-CN');
    console.log(`  ${row.code}  ${state.padEnd(4)}  ${row.used_count}/${row.max_uses}  ${expiry}${row.note ? '  ' + row.note : ''}`);
  }

  const usable = await countUsable();
  console.log(`\n  可用 ${usable} 个 / 共 ${rows.length} 个\n`);
  return 0;
}

async function cmdRevokeInvite(args) {
  const code = args._[1] || args.code;
  if (!code) return fail('用法：node tools/admin-cli.js revoke-invite <code>');

  if (!(await revokeInvite(code))) return fail(`找不到邀请码 ${normalizeCode(code)}`);

  await audit.record({
    actor: null,
    action: 'invite.revoke',
    target: `invite:${normalizeCode(code)}`,
    detail: '命令行'
  });

  console.log(`\n✓ 已撤销 ${normalizeCode(code)}`);
  console.log('  已经用它注册出来的账号不受影响。\n');
  return 0;
}

/* ---------- 入口 ---------- */

async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0] || (args.help || args.h ? 'help' : 'show');

  switch (command) {
    case 'show':
      return cmdShow();
    case 'set-amap':
      return cmdSetAmap(args);
    case 'clear-amap':
      return cmdClearAmap();
    case 'create-admin':
      return cmdCreateAdmin(args);
    case 'invite':
      return cmdInvite(args);
    case 'invites':
      return cmdInvites();
    case 'revoke-invite':
      return cmdRevokeInvite(args);
    case 'help':
      console.log(USAGE);
      return 0;
    default:
      console.error(`\n✗ 未知命令：${command}`);
      console.log(USAGE);
      return 1;
  }
}

(async () => {
  let code;
  try {
    // 先把库打开，好让「连不上库 / 迁移没过」这类错误在命令执行前就报出来，
    // 而不是等某一条 SQL 抛在半个事务里。
    // getDb() 在 MySQL 版里是 async —— 它要先跑迁移。
    await getDb();
    code = await main(process.argv.slice(2));
  } catch (error) {
    console.error('\n✗ 执行失败：', error && error.message);
    code = 1;
  } finally {
    // 必须显式关池：连接池会保持 socket 打开，不关的话 Node 进程不退出，
    // 脚本会挂在那里看起来像卡死了（旧版这里是「做一次 WAL checkpoint」，
    // 那个理由随 SQLite 一起没了，但「必须关」这件事没变）
    try {
      await closeDb();
    } catch {
      /* 已经关了 */
    }
  }
  process.exit(code);
})();
