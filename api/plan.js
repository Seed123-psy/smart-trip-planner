/**
 * Vercel serverless 函数：调用 DeepSeek 生成结构化旅行计划。
 * DeepSeek key 只从服务端环境变量 DEEPSEEK_API_KEY 读取。
 *
 * 两种返回形态，由客户端决定用哪种：
 *   · 带 Accept: text/event-stream → SSE，逐个阶段推事件，最后推完整结果
 *   · 不带 → 一次性 JSON（老调用不变）
 * 两者共用 tools/sse.js，与本地 serve.js 是同一条代码路径。
 *
 * 【迁移到 MySQL 之后，这个文件的行为**没有变**，但注释里的理由必须换掉】
 * 它继续吞掉所有配额与落库的异常。改变的不是决定，是决定背后的原因 ——
 * 原来写的是「Vercel 上没有那个 SQLite 文件」，现在 SQLite 已经不存在了。
 * 留着旧理由的注释在说谎，比没有注释更坏。
 */
'use strict';

const { plan } = require('../tools/planner');
const { wantsStream, streamPlan, sendJson } = require('../tools/sse');
const { isJsonRequest, redact } = require('../tools/http');
const { resolvePlanKey } = require('../tools/user-keys');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '只支持 POST' });
    return;
  }

  /* Content-Type 门禁，与本地 serve.js 同一条防线。
     跨站表单发得出 text/plain / form-urlencoded / multipart，但发不出
     application/json —— 只有严格拒绝才成立（读进来再 try parse 的话，
     用 text/plain 发一段 JSON 文本照样能过）。
     这个接口会真金白银地调 DeepSeek，没有这层时一个 enctype="text/plain"
     的跨站表单就能驱动一次完整的七阶段规划。
     注意 req.body 是 Vercel 代为解析的，平台对这几种类型都会照收，
     所以必须在业务之前自己再判一次。前端 scripts/plan-client.js 本来就发
     application/json，对正常调用零影响。 */
  if (!isJsonRequest(req)) {
    sendJson(res, 415, { error: '请求体必须是 application/json' });
    return;
  }

  // 与本地 serve.js 同一份判断：谁登录了、他有没有配自己的密钥、解不解得开
  let resolved;
  try {
    resolved = await resolvePlanKey(req);
  } catch (err) {
    sendJson(res, err && err.status ? err.status : 409, {
      error: err && err.expose ? err.message : '无法确定使用哪把密钥'
    });
    return;
  }

  /* 配额在本地 serve.js 上是强制的（见那里的 /api/plan 分支）。
     这里只能尽力而为：**线上没有配数据库** —— Vercel 项目里没有 DB_HOST
     环境变量，config.local.js 又被 .vercelignore 排除，于是
     tools/db-config.js 的 isConfigured() 返回 false，tools/db.js 的 getPool()
     会**同步抛**「未配置数据库」。

     用同步抛而不是去尝试连接，是有意的：尝试连一个不存在的地址要等
     connectTimeout（2 秒），而 reserve 在规划的关键路径上 ——
     那会把「配额记不上账」从瞬时的变成每次规划都慢 2 秒。

     **故意吞掉**并继续：让线上因为「记不上账」而彻底不能规划，
     比暂时没有配额更糟。真按计划迁到自托管之后，这条路径会被删掉（阶段 7 删 api/）。 */
  let quotaTicket = null;
  if (resolved.owner === 'global' && !(resolved.user && resolved.user.role === 'admin')) {
    try {
      const quota = require('../tools/quota');
      // subjectFor 会读一次会话，只算一次 —— 原来调了两遍，白跑一遍查询
      const subject = await quota.subjectFor(req);
      const gate = await quota.reserve(subject);

      if (!gate.allowed) {
        const limit = await quota.dailyLimit();
        sendJson(res, 429, { error: `今天的免费次数用完了（每天 ${limit} 次）` });
        return;
      }
      quotaTicket = { subject, day: gate.day };
    } catch (error) {
      /* 这里只能吞 —— 线上没配数据库，getPool() 会直接抛（见上面那段）。
         但**要留一条日志**：无条件静默的话，哪天在自托管形态下走到这条入口
         （或者配额表因为迁移没跑而缺表），配额会无声消失且事后无从查起。 */
      console.warn('[配额] 这个环境用不了配额：', error && error.message);
    }
  }

  const settleQuota = async (ok) => {
    if (!quotaTicket) return;
    try {
      const quota = require('../tools/quota');
      if (ok) await quota.settle(quotaTicket.subject, quotaTicket.day);
      else await quota.release(quotaTicket.subject, quotaTicket.day);
    } catch {
      /* 同上 */
    }
  };

  const options = resolved.options;

  /* 与本地 serve.js 完全一样的包装：规划成功即落库，把 id 与认领凭证挂回结果。
     包在 plan 外面而不是塞进 planner —— 那会让 planner 去读会话与数据库。

     **两条路都要包**。之前只有一次性那条包了，而浏览器发的永远是流式
     （scripts/plan-client.js 带 Accept: text/event-stream），于是线上
     返回的 tripId 一直是 undefined，saveId 空转、分享与认领全链路静默失效。 */
  const planAndSave = async (body, onStage, opts) => {
    const result = await plan(body, onStage, opts);
    try {
      const trips = require('../tools/trips');
      const saved = await trips.save({
        plan: result,
        userId: resolved.user ? resolved.user.id : null
      });
      return saved
        ? Object.assign({}, result, { tripId: saved.id, claimToken: saved.claimToken })
        : result;
    } catch {
      // 线上没配数据库。落库失败不影响把行程交回给用户 —— 他等了 30 秒
      // 拿到的东西，不该因为写不进库而丢掉
      return result;
    }
  };

  try {
    if (wantsStream(req)) {
      // 流式路径全部用 writeHead + write + end：
      // res.json()/res.send() 会缓冲并补上 Content-Length，
      // 而带 Content-Length 的 text/event-stream 不合法，客户端可能整段收不到
      const outcome = await streamPlan({ req, res, body: req.body || {}, plan: planAndSave, options });
      await settleQuota(outcome.ok);
      return;
    }

    const result = await planAndSave(req.body || {}, undefined, options);
    await settleQuota(true);
    sendJson(res, 200, result);
  } catch (err) {
    await settleQuota(false);
    // 与本地 serve.js 同样的脱敏：planner 抛出的上游错误里可能带密钥片段
    console.error('[规划服务]', redact(err && err.stack ? err.stack : err));
    // 响应头已经发出就改不了状态码了，只能把连接收掉
    if (res.headersSent) {
      try { res.end(); } catch { /* 已经断了 */ }
      return;
    }
    sendJson(res, 502, { error: err && err.message ? redact(err.message) : '规划服务失败' });
  }
};
