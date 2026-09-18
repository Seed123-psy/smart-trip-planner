/**
 * Vercel serverless 函数：调用 DeepSeek 生成结构化旅行计划。
 * DeepSeek key 只从服务端环境变量 DEEPSEEK_API_KEY 读取。
 *
 * 两种返回形态，由客户端决定用哪种：
 *   · 带 Accept: text/event-stream → SSE，逐个阶段推事件，最后推完整结果
 *   · 不带 → 一次性 JSON（老调用不变）
 * 两者共用 tools/sse.js，与本地 serve.js 是同一条代码路径。
 */
'use strict';

const { plan } = require('../tools/planner');
const { wantsStream, streamPlan, sendJson } = require('../tools/sse');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '只支持 POST' });
    return;
  }

  try {
    if (wantsStream(req)) {
      // 流式路径全部用 writeHead + write + end：
      // res.json()/res.send() 会缓冲并补上 Content-Length，
      // 而带 Content-Length 的 text/event-stream 不合法，客户端可能整段收不到
      await streamPlan({ req, res, body: req.body || {}, plan });
      return;
    }

    const result = await plan(req.body || {});
    sendJson(res, 200, result);
  } catch (err) {
    console.error('[规划服务]', err && err.stack ? err.stack : err);
    // 响应头已经发出就改不了状态码了，只能把连接收掉
    if (res.headersSent) {
      try { res.end(); } catch { /* 已经断了 */ }
      return;
    }
    sendJson(res, 502, { error: err && err.message ? err.message : '规划服务失败' });
  }
};
