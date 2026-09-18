/**
 * 规划接口的流式响应：把「现在做到哪一步了」实时推给前端。
 *
 * 为什么单独成文件：serve.js（本地长驻）与 api/plan.js（线上 serverless）
 * 要做的是同一串有顺序、有错误分支的动作 —— 开 header、冲缓冲、起心跳、
 * 跑规划、推结果、关流、清心跳。两边各写一遍必然漂移，
 * 和 tools/amap-proxy.js 拆出来的理由一样。
 *
 * 帧格式是最朴素的 SSE：
 *   event: stage   data: {"stage":"select","status":"done","ms":4210}
 *   event: result  data: {完整行程 JSON}       ← 终结帧
 *   event: error   data: {"message":"..."}     ← 终结帧
 *   : ping                                     ← 心跳，15 秒一次
 */

'use strict';

/**
 * 五个阶段的 id，顺序即执行顺序。
 * 前端 scripts/landing-flow.js 里有一份同序的副本（带中文标签）——
 * 浏览器与 Node 之间没有构建步骤可以共用模块，只能各留一份，改一处要一起改。
 */
const STAGES = ['discover', 'select', 'schedule', 'review', 'routes', 'food', 'prep'];

/**
 * 客户端是否要流式。
 * `Accept` 是主信号（语义正确、是 CORS 安全头、不触发预检）；
 * `?stream=1` 兜底，防某些代理把 Accept 改写掉。
 * 两个都没有就走原来的一次性 JSON —— 老调用不受影响。
 */
function wantsStream(req) {
  const accept = String((req.headers && req.headers.accept) || '');
  if (accept.includes('text/event-stream')) return true;
  return /[?&]stream=1(&|$)/.test(String(req.url || ''));
}

const HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  // no-transform 是关键：压缩器正是把 SSE 攒成一坨再发的常见原因
  'Cache-Control': 'no-store, no-transform',
  Connection: 'keep-alive',
  // 挡掉 nginx 一类反代的缓冲
  'X-Accel-Buffering': 'no'
};

function frame(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * 跑一次流式规划，全程不抛异常 —— 异常都变成 error 帧。
 *
 * 绝不设 Content-Length：带 Content-Length 的 text/event-stream 本身就不合法，
 * 而 Vercel 某些配置下会自动补上它。补上之后客户端可能整段攒到最后才收到。
 */
async function streamPlan({ req, res, body, plan }) {
  try {
    res.writeHead(200, HEADERS);
    // 立刻冲一次：既让客户端确知连接已建立，也顺手冲掉代理的缓冲
    res.write(': ok\n\n');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    frame(res, 'open', { stages: STAGES });

    // 规划可能跑一两分钟，中间任何一端断开都要停止写，否则是 EPIPE 噪声
    let closed = false;
    if (typeof req.on === 'function') req.on('close', () => { closed = true; });
    const beat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15000);

    try {
      const result = await plan(body, (event) => {
        if (!closed) frame(res, 'stage', event);
      });
      if (!closed) {
        frame(res, 'result', result);
        res.end();
      }
    } catch (error) {
      if (!closed) {
        frame(res, 'error', { message: (error && error.message) || '规划失败' });
        res.end();
      }
    } finally {
      clearInterval(beat);
    }
  } catch (error) {
    // 写头之前就炸了（比如 socket 已断）：只能记日志，没法再告诉客户端什么
    console.error('[规划服务] 流式响应失败：', error && error.message);
    try { res.end(); } catch { /* 已经断了，无所谓 */ }
  }
}

/** 一次性 JSON 返回，两个入口共用同一份错误文案与头 */
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

module.exports = { STAGES, wantsStream, streamPlan, sendJson };
