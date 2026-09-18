/* ============================================================
   规划接口客户端：调 /api/plan，边收边报进度

   EventSource 用不了 —— 它只能发 GET，而规划要 POST 一个表单。
   所以这里用 fetch + ReadableStream 手写 SSE 分帧。

   ── 为什么按「响应」的 content-type 分支，而不是按请求信号 ──
   服务端支持流式，不代表这一路真能流回浏览器：Vercel 某些配置下会把
   响应缓冲起来并补上 Content-Length，而带 Content-Length 的
   text/event-stream 本身就不合法，客户端可能整段攒到最后一次收到。
   但那种情况下的响应头仍然是 text/event-stream，解析器天然能吃
   「所有帧挤在最后一坨里到齐」—— 所以降级不需要特殊分支，
   只需要如实告诉调用方「这次没有真的流起来」，别去伪造逐节点耗时。
   ============================================================ */

(function () {
  'use strict';

  /**
   * 七个阶段的 id，与 tools/sse.js 的 STAGES 同序。
   * 浏览器与 Node 之间没有构建步骤可以共用模块，只能各留一份，改一处要一起改。
   */
  const STAGES = ['discover', 'select', 'schedule', 'review', 'routes', 'food', 'prep'];

  /** 单跳模型调用的上限是 45s，空闲判定要比它长，否则会把正常的长调用误杀 */
  const IDLE_TIMEOUT_MS = 60000;
  /** 最外层兜底，防整条链路挂死 */
  const TOTAL_TIMEOUT_MS = 180000;

  /** 从缓冲区切出完整帧（SSE 以空行分帧） */
  function takeFrames(buffer) {
    const frames = [];
    let rest = buffer;
    let idx;
    while ((idx = rest.indexOf('\n\n')) >= 0) {
      frames.push(rest.slice(0, idx));
      rest = rest.slice(idx + 2);
    }
    return { frames, rest };
  }

  /** 解析一帧；心跳、注释、坏帧都返回 null */
  function parseFrame(raw) {
    let event = 'message';
    const dataLines = [];

    for (const line of raw.split('\n')) {
      if (!line || line.charAt(0) === ':') continue; // `: ping` 之类
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.charAt(0) === ' ') value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }

    if (!dataLines.length) return null;
    try {
      // data 可能跨多行，必须整段拼起来再解析
      return { event, data: JSON.parse(dataLines.join('\n')) };
    } catch {
      // 一个坏帧不该毁掉整条流，跳过继续
      return null;
    }
  }

  /** 每次读取都套一层空闲超时：卡住要能自己报错，而不是永远转圈 */
  function readWithIdleLimit(reader) {
    let timer = 0;
    return Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reader.cancel().catch(() => {});
          reject(new Error(`超过 ${Math.round(IDLE_TIMEOUT_MS / 1000)} 秒没有收到任何进度，连接可能已断`));
        }, IDLE_TIMEOUT_MS);
      })
    ]).finally(() => clearTimeout(timer));
  }

  async function readStream(res, onStage) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let chunks = 0;
    let plan = null;
    let failure = null;

    while (!plan && !failure) {
      const { value, done } = await readWithIdleLimit(reader);
      if (done) break;
      chunks++;

      buffer += decoder.decode(value, { stream: true });
      // 必须在拼接之后统一规范化：\r\n 可能正好被切在两个 chunk 的边界上
      buffer = buffer.replace(/\r\n/g, '\n');

      const { frames, rest } = takeFrames(buffer);
      buffer = rest;

      for (const raw of frames) {
        const msg = parseFrame(raw);
        if (!msg) continue;
        if (msg.event === 'stage') {
          if (onStage) onStage(msg.data);
        } else if (msg.event === 'result') {
          plan = msg.data;
        } else if (msg.event === 'error') {
          failure = msg.data && msg.data.message ? msg.data.message : '规划失败';
        }
      }
    }

    if (failure) throw new Error(failure);
    if (!plan) throw new Error('连接中断，没有拿到完整行程');
    // 分块数 > 1 才说明真的是边跑边发；只有一块就是被整段缓冲了
    return { plan, streamed: chunks > 1 };
  }

  function signalWithTimeout(external) {
    const timeout = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(TOTAL_TIMEOUT_MS)
      : null;
    if (!timeout) return external;
    if (!external) return timeout;
    // AbortSignal.any 比较新，没有就退回只用外部信号
    return typeof AbortSignal.any === 'function' ? AbortSignal.any([external, timeout]) : external;
  }

  /**
   * @param {object} body 表单请求体
   * @param {{onStage?:Function, onOpen?:Function, signal?:AbortSignal}} handlers
   *        onOpen 在响应头到达时触发，带上 { streaming } ——
   *        调用方据此决定是显示逐阶段进度，还是只显示「已等待 N 秒」
   * @returns {Promise<{plan: object, streamed: boolean}>}
   */
  async function generate(body, handlers) {
    const { onStage, onOpen, signal } = handlers || {};

    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: signalWithTimeout(signal)
    });

    if (!res.ok) {
      // 错误响应未必是 JSON（网关拦截之类），先当文本读再试着解析
      const text = await res.text().catch(() => '');
      let message = `规划服务返回 ${res.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.error) message = parsed.error;
      } catch {
        if (text) message = text.slice(0, 200);
      }
      throw new Error(message);
    }

    const type = String(res.headers.get('content-type') || '');
    const canStream = Boolean(res.body) && typeof res.body.getReader === 'function' && typeof TextDecoder === 'function';
    const streaming = type.includes('text/event-stream') && canStream;

    if (onOpen) onOpen({ streaming });

    if (streaming) return await readStream(res, onStage);

    // 服务端（或中间层）把它降级成了一次性 JSON：结果照样能拿到，只是没有逐阶段进度
    return { plan: await res.json(), streamed: false };
  }

  window.TripPlanClient = { STAGES, generate };
})();
