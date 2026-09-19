#!/usr/bin/env node
/**
 * 本地静态服务：node serve.js [port]
 * 高德 JSAPI 的域名校验对 file:// 不友好，用 http 打开最稳。
 *
 * 除了发静态文件，它还提供 /api/amap —— 和线上 api/amap.js 同一套转发逻辑，
 * 目的是让本地开发也走「密钥不进浏览器」这条路。否则本地和线上会跑两套代码，
 * 部署后才发现问题。
 *
 * 新增的 /api/* 走 tools/api-router.js 的路由表。老的两个接口（/api/amap、
 * /api/plan）暂时留在本文件里，等阶段 7 和线上入口一起迁进去。
 *
 * 【发什么、绑哪里】
 * 静态资源走白名单（见下面「对外发什么」一节），只有列在名单上的目录与文件
 * 才发得出去 —— 这比列黑名单可靠，理由在那节里写了。
 * 监听地址默认是 127.0.0.1，手机连局域网调试要显式 HOST=0.0.0.0。
 *
 * 【为什么请求处理整个包在一个 async 函数里】
 * handleRequest 里那句 decodeURIComponent 的注释说的是同一件事：在请求回调里
 * 同步抛出的异常不属于「某个请求失败了」，而是未捕获异常，会直接干掉进程。
 * 以前只有 decodeURIComponent 一行需要防，现在整条链路（路由、数据库、
 * 鉴权）都可能抛，逐个 try 是漏一个算一个。
 * 包成 async 函数之后，任何同步抛出都自动变成 Promise 拒绝，由最外层
 * .catch 统一收口 —— 这是唯一不用把 try 撒得到处都是的写法。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { proxy } = require('./tools/amap-proxy');
const { plan } = require('./tools/planner');
const { wantsStream, streamPlan } = require('./tools/sse');
const { sendJson, sendError, readJson, redact, HttpError } = require('./tools/http');
const { handleApi } = require('./tools/api-router');
const { getDb, describeTarget } = require('./tools/db');
const { resolvePlanKey } = require('./tools/user-keys');
const quota = require('./tools/quota');
const trips = require('./tools/trips');
const { currentUser } = require('./tools/auth');
const {
  resolveAmapWebConfig,
  ignoredWarnings,
  resolveAmapServiceKey,
  resolveDeepseekKey
} = require('./tools/keys');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 5173;

/**
 * 监听地址。默认只绑本机回环。
 *
 * 以前这里是 .listen(PORT)，没写 host —— 那等于绑 0.0.0.0，同一网段的人都能访问。
 * 而这个服务上有两个会真花钱的接口（/api/plan 调 DeepSeek、/api/amap 走高德配额），
 * 目前又都还没有鉴权。默认收窄到回环，代价是手机连局域网调试要多写一句：
 *   HOST=0.0.0.0 node serve.js
 */
const HOST = process.env.HOST || '127.0.0.1';

/**
 * 取高德 Web 服务密钥：环境变量 > 数据库 > config.local.js。
 * 具体规则与「解不开时为什么不回落」见 tools/keys.js。
 * 每次调用现解析（会读一次库），这样后台改完 key 不用重启 ——
 * 与 /api/config 是同一个口径。
 */
async function amapKey() {
  return (await resolveAmapServiceKey()).value || '';
}

/* ---------- 对外发什么 ----------

   这里原先是一份黑名单（挡 config.local.js + 一批扩展名），它被实际打穿了。
   本地起服务逐条 curl 验过，四种写法都拿到了明文密钥：
     /config.local.js/          尾斜杠
     /CONFIG.LOCAL.JS           大小写（文件系统不敏感，而 Set 敏感）
     /config.local.js::$DATA    NTFS 备用数据流
     /GIT~1/config              NTFS 8.3 短名
   把这几条补上之后结论很清楚：黑名单要挡的是「文件系统认、字符串不认」的等价
   写法，那是个没有底的清单。换成白名单之后这一整类问题结构性消失 ——
   不在名单上的一律 404，不需要预知攻击者会怎么写。

   两件事共同决定一个文件能不能发：
     · 位置：根目录下的文件逐个列名；子目录只看顶层目录名
     · 类型：扩展名必须在这张 MIME 表里
   一张表同时决定「怎么发」与「发不发」，不会出现声明了却发不出去、
   或者发出去了却没有类型的错位。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const PUBLIC_EXT = new Set(Object.keys(MIME));

/**
 * 允许对外发的顶层目录。tools/ 与 api/ 不在其中 —— 服务端代码不该被下载。
 *
 * 粒度是「顶层目录 + 扩展名」，所以这几个目录下任意深度的同类型文件都会发出去。
 * 约束落在后来者身上：data/ 里只放可以公开的数据（poi.js、itinerary.js 这类），
 * 别往里放密钥或用户数据 —— 数据库文件是靠 .db 不在 MIME 表里才被挡住的，
 * 换个扩展名就挡不住了。
 *
 * 已知边界：硬链接。realpath 认不出它（返回的就是你用的那个名字），所以
 * scripts/ 下一个指向 config.local.js 的硬链接会被放行。利用它需要能在仓库里
 * 建链接，也就是已经有本地写权限了。但若日后有「上传 / 解压 / 构建产物落进
 * 这几个目录」的逻辑，这个前提就不成立了，那时要重新评估。
 */
const PUBLIC_DIRS = new Set(['scripts', 'styles', 'data']);

/**
 * 根目录下允许对外发的文件，必须逐个列名。
 * 根目录不能整个放开：serve.js 与 config.local.js 都在这儿。
 *
 * 【新增根目录页面时别忘了这里】加一个 login.html 却在浏览器里拿到 404、
 * 而文件明明就在磁盘上 —— 症状就是这样，因为白名单是默认拒绝的。
 */
const PUBLIC_ROOT_FILES = new Set([
  'index.html',
  'trip.html',
  'login.html',
  'account.html',
  'admin.html',
  'config.js'
]);

/**
 * 判断相对路径是否可以对外发。rel 来自 URL，分隔符一定是 '/'，不是 '\'。
 * 函数名与调用点的语义都是「可以发」—— 默认拒绝。
 */
function isPublic(rel) {
  // 冒号全挡。白名单本来已经覆盖了 ::$DATA 那类写法（扩展名不在 MIME 表里），
  // 这一条是给下面 realpath 那个系统调用兜底的：不把带备用数据流的路径递进去。
  if (rel.includes(':')) return false;

  // 滤掉空段：'/scripts/app.js/' 里的尾斜杠会 split 出一个空串
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length) return false;

  // 末段转小写再比：Windows 与 macOS 的文件系统大小写不敏感，
  // CONFIG.LOCAL.JS 打开的就是 config.local.js，而白名单是大小写敏感的。
  const base = parts[parts.length - 1].toLowerCase();

  if (parts.length === 1) return PUBLIC_ROOT_FILES.has(base);

  // 子目录只看顶层目录名，且扩展名必须在 MIME 表里。
  // data/app.db 会在这里落选（.db 不在表里），不必再单独维护一份黑名单扩展名。
  return PUBLIC_DIRS.has(parts[0].toLowerCase()) && PUBLIC_EXT.has(path.extname(base));
}

/**
 * 仓库根目录的真实路径。用于和 realpath 的结果做相对比较 ——
 * 根目录本身可能是符号链接或 junction，不解析的话下面每次比较都会误判为越界。
 */
const REAL_ROOT = (() => {
  try {
    return fs.realpathSync.native(ROOT);
  } catch {
    return ROOT;
  }
})();

/**
 * 处理一个请求，全程不抛。响应在这个函数里写出。
 */
async function handleRequest(req, res) {
  let urlPath;
  try {
    // decodeURIComponent 遇到 "%"、"%" 开头的不完整转义会抛 URIError
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }

  // 路由表先看。未命中返回 false，继续往下走既有的两个接口与静态服务 ——
  // 所以阶段 0 对现有行为是零改动。
  if (await handleApi(req, res)) return;

  // 与线上 api/amap.js 同源同行为
  if (urlPath === '/api/amap') {
    const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    try {
      const { status, body } = await proxy(query, await amapKey());
      sendJson(res, status, body);
    } catch (err) {
      // 走统一的错误出口：原文只进日志，回客户端的是固定文案
      console.error('[高德代理]', err && err.stack ? err.stack : err);
      sendError(res, err);
    }
    return;
  }

  // 与线上 api/plan.js 同源同行为：要流就给流，不要就还是一次性 JSON
  if (urlPath === '/api/plan') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: '只支持 POST' });
      return;
    }

    // 用谁的密钥在这里定，之后两条路（流式 / 一次性）共用同一个 options ——
    // 分开判的话，「流式用了全局 key、非流式用了用户 key」这种差异
    // 只会在对账时才发现。用户自己的密钥解不开时这里就抛，不会往下走。
    let resolved;
    let quotaSubject = null;

    try {
      resolved = await resolvePlanKey(req);

      // 用公共密钥的人占每日配额；配了自己密钥的人走自己的额度，不占这里的数。
      // 管理员不占 —— 站长的工具不该被自己的限额关在门外。
      if (resolved.owner === 'global' && !(resolved.user && resolved.user.role === 'admin')) {
        const subject = await quota.subjectFor(req);
        const gate = await quota.reserve(subject);

        if (!gate.allowed) {
          // 限额先取出来再拼文案：它现在是一次异步读库，
          // 直接写在模板字符串里会得到 "[object Promise] 次"
          const limit = await quota.dailyLimit();
          throw new HttpError(
            429,
            `今天的免费次数用完了（每天 ${limit} 次）。` +
              '在「账号」页配置自己的 DeepSeek 密钥可以不受这个限制。',
            { expose: true }
          );
        }

        // 连 day 一起带着 —— 结算时要打在**同一天**那一行上，
        // 否则跨零点跑完的那次规划会记不上账（见 tools/quota.js 的说明）
        quotaSubject = { subject, day: gate.day };
      }
    } catch (error) {
      sendError(res, error);
      return;
    }

    readPlanBody(req, res, resolved.options, quotaSubject);
    return;
  }

  serveStatic(req, res, urlPath);
}

/**
 * /api/plan 的请求体处理。
 *
 * 改用 tools/http.js 的 readJson（原先这里有一份自己的 readBody）：
 * 除了统一状态码，更重要的是那道 Content-Type 门禁。跨站表单发得出
 * text/plain / form-urlencoded / multipart，但发不出 application/json ——
 * 而这个接口会真金白银地调 DeepSeek。没有门禁时，一个 enctype="text/plain"
 * 的跨站表单就能驱动一次完整的七阶段规划。
 * 前端 scripts/plan-client.js 本来就发 application/json，切过来对正常调用零影响。
 */
function readPlanBody(req, res, options, quotaSubject) {
  /* 配额在这里结算，而且**必须在这两条路上都结**。
     流式那条尤其容易漏：它在 client 断开之后仍然继续跑完，所以结算
     不能挂在连接事件上，只能挂在这个 promise 上。

     「跑成了记用量、没跑起来就退回」：规划中途报错（密钥失效、上游全挂）
     时模型调用基本没发生，不该记用户的数。而用户中途关掉标签页**算跑成了** ——
     服务端那边并不会因此停下，模型调用是实实在在发生过的。 */
  /* 结算必须**恰好一次**，所以带个闸。

     这里踩过一个坑：结算原本只挂在下面 .then 的两条分支上，而 readJson 的
     失败（415 内容类型不对 / 413 体太大 / 400 不是 JSON）直接落到 .catch ——
     那里没有退回渲染，预留就永远留在库上。实测：连发两个 Content-Type
     不对的请求，当天额度就被吃光了，而规划根本没跑。

     这些请求是零成本的，而匿名访客的配额主体是 IP：办公室或学校共用一个
     出口地址时，一个人发几个畸形请求就能替所有人把当天的额度烧掉。 */
  let quotaSettled = false;
  const settleQuota = (ok) => {
    if (!quotaSubject || quotaSettled) return;
    quotaSettled = true;
    try {
      if (ok) quota.settle(quotaSubject.subject, quotaSubject.day);
      else quota.release(quotaSubject.subject, quotaSubject.day);
    } catch (error) {
      console.error('[配额] 结算失败：', error && error.message);
    }
  };

  /* 规划成功即落库，并把 id 挂回结果上。
     把它包在 plan 外面，而不是塞进 planner —— planner 的职责是
     「给定输入和密钥，产出行程」，让它去读会话与数据库就再也无法单独测试了。

     落库失败不影响把行程交回给用户：他等了 30 秒拿到的东西，
     不该因为一次写库失败而丢掉。 */
  const viewer = currentUser(req);
  const planAndSave = (body, onStage, opts) =>
    plan(body, onStage, opts).then((result) => {
      const saved = trips.save({ plan: result, userId: viewer ? viewer.id : null });
      // claimToken 只出现在这个响应里 —— 它是「认领」的凭证，与 id（读凭证，
      // 会进链接）刻意分开。它不会进 payload：上面 save 存的是 result 本身，
      // 而这里返回的是它的一个副本
      return saved
        ? Object.assign({}, result, { tripId: saved.id, claimToken: saved.claimToken })
        : result;
    });

  readJson(req)
    .then((body) => {
      if (wantsStream(req)) {
        return streamPlan({ req, res, body, plan: planAndSave, options }).then((outcome) => settleQuota(outcome.ok));
      }
      return planAndSave(body, undefined, options).then(
        (result) => {
          settleQuota(true);
          sendJson(res, 200, result);
        },
        (error) => {
          settleQuota(false);
          throw error;
        }
      );
    })
    .catch((err) => {
      // 走到这里说明规划没跑起来（读请求体就失败了、或者 plan 抛了错）。
      // 预留要退回去 —— 不退回的话，几个畸形请求就能把当天的额度占满
      settleQuota(false);

      // 流已经开了头就不能再改状态码了，只能把连接收掉
      if (res.headersSent) {
        console.error('[规划服务]', redact(err && err.stack ? err.stack : err));
        try { res.end(); } catch { /* 已经断了 */ }
        return;
      }
      // readJson 的错（400 / 413 / 415）自带状态码，直接用它。
      // 这类是客户端把请求写坏了，不是我们坏了 —— 所以**不打堆栈**：
      // 415 是最容易被探测脚本触发的形态，打堆栈等于把日志白送出去刷。
      if (err instanceof HttpError) {
        sendError(res, err);
        return;
      }
      // 规划本身失败仍是 502（上游问题，不是客户端请求畸形）。
      // 原文必须过 redact()：planner 会把上游错误原样抛出，而 DeepSeek 认证失败
      // 那条消息里带着密钥后四位（实测「Your api key: ****a765 is invalid」），
      // 不脱敏就等于把它送到公网，日志里也留一份。
      console.error('[规划服务]', redact(err && err.stack ? err.stack : err));
      sendJson(res, 502, { error: err && err.message ? redact(err.message) : '规划服务失败' });
    });
}

/**
 * 统一的 404。
 * rel 传了就回显请求路径（本地调试有用：「404 Not Found: api/foo」比光秃秃一个
 * 404 好查），但**被白名单挡下的一律不传** —— 那种情况连「这个文件存在」都不该被确认。
 */
function notFound(res, rel) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(rel ? '404 Not Found: ' + rel : '404 Not Found');
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');

  if (!isPublic(rel)) {
    notFound(res, null);
    return;
  }

  const file = path.join(ROOT, rel);

  // 目录穿越防护：用相对路径判断，避免 "武汉旅游攻略2" 这类同前缀目录绕过
  const relPath = path.relative(ROOT, file);
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
    notFound(res, null);
    return;
  }

  /* 真实路径复查。
     上面那两条仍是「拿字符串比字符串」，而这几种等价写法只有文件系统知道：
       · NTFS 8.3 短名：GIT~1 就是 .git
       · 大小写不敏感：CONFIG.LOCAL.JS 与 config.local.js 是同一个文件
       · 符号链接：scripts/x.js 链到 config.local.js，字符串看着完全正常
     realpath 把它们还原成真实名字再判一次。白名单本身已经挡住了前两种
     （GIT~1 与 .git 都不在名单上），这一步是为了符号链接，也为了让
     「字符串判定」与「文件系统判定」不会出现分歧。
     代价是每个请求多一次 stat 级别的系统调用，本地开发服务承受得起。 */
  let real;
  try {
    real = fs.realpathSync.native(file);
  } catch {
    // 文件不存在，或路径里的某一段不是目录 —— 都是 404
    notFound(res, rel);
    return;
  }

  const realRel = path.relative(REAL_ROOT, real).split(path.sep).join('/');
  if (realRel.startsWith('..') || path.isAbsolute(realRel) || !isPublic(realRel)) {
    notFound(res, null);
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

/* ---------- 启动自检 ---------- */

/**
 * 自检。**迁移到 MySQL 之后它整体变成了异步的** ——
 * 开库要先跑迁移、密钥解析要读库、清理要写库。
 * CommonJS 没有顶层 await，所以包成一个函数，由底部的 bootstrap() 调用。
 *
 * 「不 fail-fast」这条原则没有变：站点其余部分（静态页面）还不依赖数据库，
 * 为了一个还没被用上的功能让整个站起不来是过度设计。
 * 真正的判定权在 /api/health 手里。
 */
async function startupChecks() {
  // 提前开一次库，把「库连不上 / 迁移没过」暴露在启动日志里，
  // 而不是等第一个请求回 500。
  try {
    await getDb();
    console.log(`  数据库：${describeTarget()}`);
  } catch (error) {
    console.error(`  数据库连接失败（${describeTarget()}）：`, error && error.message);
    console.error('  /api/health 会持续报错，静态页面不受影响。');
  }

  // 过期会话与登录失败记录每天清一次。放启动时先跑一遍，之后按天重复。
  // 不清也不会出错（getSession 会判过期），但表会一直长。
  try {
    const { purgeExpired } = require('./tools/sessions');
    const { purgeStaleAttempts } = require('./tools/auth');

    // 启动时把所有预留清零。预留只在「一个规划正在跑」那 30—90 秒里有意义，
    // 而进程重启意味着那些规划已经不在了 —— 不清的话，用户的额度会被一个
    // 看不见的东西永久占着，且没有办法恢复。这件事只在启动做，
    // 放进下面的每日清理会把正在跑的规划也一起放掉。
    const orphans = await quota.releaseAllOrphans();
    if (orphans) console.log(`  已释放上次未结算的配额预留：${orphans} 条`);

    const sweep = async () => {
      const sessions = await purgeExpired();
      const attempts = await purgeStaleAttempts();
      const quotaRows = await quota.purgeOld(30);
      return { sessions, attempts, quotaRows };
    };

    const first = await sweep();
    if (first.sessions) console.log(`  已清理过期的登录会话：${first.sessions} 条`);
    if (first.attempts) console.log(`  已清理陈旧的登录失败记录：${first.attempts} 条`);
    if (first.quotaRows) console.log(`  已清理陈旧的配额记录：${first.quotaRows} 条`);

    setInterval(() => {
      // 定时清理失败不该影响服务，也不该产生一个未处理的 promise rejection
      sweep().catch(() => {});
    }, 24 * 60 * 60 * 1000).unref();
  } catch {
    /* 库有问题时上面已经报过了 */
  }

  // 没配 APP_SECRET 时，「用户自配 DeepSeek 密钥」整块功能是关闭的 ——
  // tools/crypto-box.js 的 masterKey() 会返回 null，而不是抛异常。
  // 这个降级是有意的（见那里的说明），但必须在启动日志里说出来：
  // 否则运维会以为功能开着、只是用户还没配，而去查一个根本不存在的问题。
  try {
    const { encryptionAvailable } = require('./tools/crypto-box');
    if (!encryptionAvailable()) {
      console.log('  未配置 APP_SECRET：用户自配密钥功能不可用（其余功能不受影响）。');
      console.log('        要用它请设置环境变量 APP_SECRET（一段足够长的随机串），然后重启。');
    }
  } catch {
    /* 自检本身不该影响启动 */
  }

  // 高德密钥只配了一半，是最容易踩的坑：看起来配了，实际被当成没配。
  // 这在运行时是静默的（页面照常打开，只是用的还是静态那份 key），
  // 所以要在启动日志里说清楚，别让人去猜为什么换的 key 不生效。
  try {
    for (const line of ignoredWarnings(await resolveAmapWebConfig())) {
      console.warn(`  注意：${line}`);
    }

    // 服务端两把密钥的 problem 也要在这里说出来。
    // 不说的话，取值为空会被 amap-proxy 描述成「未配置高德 Web 服务密钥」，
    // 而真实原因可能是「库里的值解不开（APP_SECRET 换过）」——
    // 照着那个提示去 config.local.js 里重配一遍是修不好的。
    for (const probe of [await resolveAmapServiceKey(), await resolveDeepseekKey()]) {
      if (probe.problem) console.warn(`  注意：${probe.problem}`);
    }
  } catch {
    /* 自检本身不该影响启动 */
  }
}

/**
 * 起服务。
 *
 * 自检先跑完再监听 —— 保持与旧版一致的日志顺序（先「数据库：…」，再「已启动」）。
 * 代价是数据库连不上时启动会多等一个 connectTimeout（2 秒），那是可接受的：
 * 那种情况下启动日志里那句报错，比早两秒开始监听重要得多。
 */
async function bootstrap() {
  await startupChecks();

  http
    .createServer((req, res) => {
      handleRequest(req, res).catch((error) => {
        // 兜底。走到这里说明异常逃出了 handleRequest 里所有分支，
        // 属于没预料到的错误 —— 原文只进日志，不回客户端。
        console.error('[服务] 请求处理失败：', error && error.stack ? error.stack : error);
        if (res.headersSent) {
          try { res.end(); } catch { /* 已经断了 */ }
          return;
        }
        sendJson(res, 500, { error: '服务器内部错误' });
      });
    })
    .listen(PORT, HOST, () => {
      const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
      console.log(`\n  武汉行程攻略已启动：  http://${shown}:${PORT}`);
      if (shown === 'localhost') {
        console.log(`  注意：已绑定 ${HOST}，同网段的人都能访问；/api/plan 与 /api/amap 会真花钱，且尚无鉴权`);
        // 会话 cookie 的 Secure 属性由 shouldSecureCookie 按 X-Forwarded-Proto 判定，
        // 而本服务自己只说 HTTP。少了前面那一层 TLS，现象是「登录成功，一刷新就登出」——
        // 因为带 Secure 的 cookie 在 http 页面上发不出去，而服务端日志一切正常，
        // 本地也复现不出来。这个坑值得在启动时就说清楚。
        console.log('        会话 cookie 需要 HTTPS 才发得出去。线上请用 nginx 终止 TLS 并设置');
        console.log('        proxy_set_header X-Forwarded-Proto $scheme。');
        console.log('        本机反代不需要额外配置 —— 对端是 127.0.0.1 时那些转发头本来就被信任；');
        console.log('        只有代理在别的机器上时，才要用 TRUST_PROXY=<代理地址> 把它列进可信名单。');
      }
      console.log('  按 Ctrl+C 停止\n');
    });
}

bootstrap().catch((error) => {
  // startupChecks 内部已经把每一段都 try 住了，走到这里说明是它之外的问题
  console.error('启动失败：', error && error.stack ? error.stack : error);
  process.exit(1);
});
