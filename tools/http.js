/**
 * HTTP 协议层：请求解析、响应发送、cookie 读写、错误映射。
 *
 * 单独成文件的理由和 tools/amap-proxy.js、tools/sse.js 一样：
 * 这些动作会被 api-router 与 serve.js 反复用到，各写一遍迟早漂移。
 *
 * 本模块不碰业务、不碰数据库，只做 HTTP 该做的事。
 */

'use strict';

/** 请求体上限。行程规划请求就这么大，100KB 是宽松的余量 */
const DEFAULT_LIMIT = 100 * 1024;

/**
 * 带 HTTP 状态码的错误。
 *
 * expose 决定这条 message 能不能回给客户端：
 * 自己主动抛的（参数不对、未登录）可以；数据库挂了、内部断言失败这类
 * 不能把原文透出去，那些一律回「服务器内部错误」，原文只进日志。
 */
class HttpError extends Error {
  constructor(status, message, options) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    // 默认按状态码决定能不能把原文回给客户端：4xx 是「你哪里没做对」，可以说；
    // 5xx 是「我们自己坏了」，原文里可能有 SQL、路径、密钥，不回，只进日志。
    // 之所以要有默认值而不是全靠调用方自觉：默认透出的话，一句
    // new HttpError(500, dbErr.message) 就会把数据库错误原样发给客户端，
    // 而 sendError 里那条只进日志的分支永远走不到。
    const explicit = options && typeof options.expose === 'boolean' ? options.expose : null;
    this.expose = explicit !== null ? explicit : status < 500;
  }
}

/** 400 / 401 / 403 一类的高频错误，省得每次写 new HttpError */
const badRequest = (msg) => new HttpError(400, msg);
const unauthorized = (msg) => new HttpError(401, msg || '未登录');
const forbidden = (msg) => new HttpError(403, msg || '没有权限');

/**
 * 拆出请求路径与查询串。**本函数不抛异常** —— 它跑在请求回调里，
 * 而回调里同步抛出会直接干掉整个进程（serve.js 文件头那条注释说的就是这件事）。
 *
 * pathname 解不开时返回 null，由调用方决定怎么回。百分号转义不完整
 * （比如 /%zz）会让 decodeURIComponent 抛 URIError，这是真实的攻击面。
 */
function parseUrl(req) {
  const raw = String((req && req.url) || '/');
  const cut = raw.indexOf('?');
  const rawPath = cut === -1 ? raw : raw.slice(0, cut);

  let pathname = null;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    pathname = null;
  }

  let query = {};
  try {
    query = Object.fromEntries(new URL(raw, 'http://localhost').searchParams);
  } catch {
    query = {};
  }

  return { pathname, query, raw };
}

/**
 * 请求是不是 application/json。
 *
 * 单独导出，是因为线上入口 api/plan.js 用不了 readJson —— Vercel 已经把 body
 * 解析好放在 req.body 里了 —— 但 Content-Type 门禁必须两边一致。
 * tools/http.js 存在的理由就是防漂移，所以这里共用一个谓词而不是各写一份。
 */
function isJsonRequest(req) {
  return (
    String((req.headers && req.headers['content-type']) || '')
      .split(';')[0]
      .trim()
      .toLowerCase() === 'application/json'
  );
}

/**
 * 读请求体并解析成 JSON。
 *
 * Content-Type 严格校验：只收 application/json，其余一律 415。
 * 这不只是规范问题 —— 它是一条真实的 CSRF 防线。跨站表单只能发出
 * form-urlencoded / multipart / text-plain 三种类型，发不出 application/json，
 * 所以「严格拒绝非 JSON」等价于「跨站表单打不进来」。
 * 但只有**严格**才成立：读进来再 try parse 的话，攻击者用 text/plain 发一段
 * JSON 文本照样能过。
 *
 * 校验不过时要把请求体排掉（req.resume），否则 keep-alive 连接里
 * 残留的字节会被当成下一个请求的开头。
 */
function readJson(req, options) {
  const limit = (options && options.limit) || DEFAULT_LIMIT;

  return new Promise((resolve, reject) => {
    if (!isJsonRequest(req)) {
      req.resume();
      reject(new HttpError(415, '请求体必须是 application/json'));
      return;
    }

    // 收 Buffer 而不是拼字符串。写成 raw += chunk 的话，每次 += 都会对
    // **当前这一个 chunk** 单独做一次 utf8 解码 —— 一个 3 字节的汉字被 TCP
    // 分片切开时，两半各自解成一个 U+FFFD，内容就损坏了。
    // 带中文的行程 JSON 几 KB 就超过一个 TCP 段，chunk 边界落在任意字节位置，
    // 所以这是必现的，不是偶发。
    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        // 不 destroy：那会让客户端在读到 413 之前先收到 ECONNRESET，
        // 现象是「服务端说请求太大，前端却报连接被重置」。排空即可。
        req.resume();
        reject(new HttpError(413, '请求体过大'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) {
        resolve({});
        return;
      }
      // 收完再一次性解码，跨 chunk 边界的多字节字符才不会被切断
      const raw = Buffer.concat(chunks).toString('utf8');

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        reject(badRequest('请求体不是有效 JSON'));
        return;
      }

      // 只接受 JSON 对象。JSON.parse('null') 是合法的 null，parse('123') 是数字，
      // parse('"x"') 是字符串 —— 这些会让调用方的 body.username 抛 TypeError，
      // 被 handleApi 的 catch 兜住之后变成一次**未鉴权的 500**，
      // 外加一整条堆栈写进日志。那是一个免费的错误日志灌入面。
      // 收口在这里而不是各个处理函数里：这是唯一的入口，漏不掉。
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(badRequest('请求体必须是一个 JSON 对象'));
        return;
      }

      resolve(parsed);
    });

    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/* ---------- Cookie ---------- */

/**
 * 解析 Cookie 头。
 * 单个值解不开百分号转义时保留原文，而不是整条丢弃 —— 一条坏 cookie
 * 不该让其余 cookie 一起失效。
 */
function parseCookies(header) {
  const out = {};
  if (!header) return out;

  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;

    const name = part.slice(0, eq).trim();
    if (!name) continue;

    let value = part.slice(eq + 1).trim();
    // RFC 6265 允许带引号的值
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** 取单个 cookie。等价于 parseCookies(req.headers.cookie)[name]，读起来短一些 */
function getCookie(req, name) {
  return parseCookies(req.headers && req.headers.cookie)[name];
}

const SAME_SITE = { lax: 'Lax', strict: 'Strict', none: 'None' };

/**
 * 拼 Set-Cookie。只实现用得到的字段，不做全量 RFC 覆盖。
 *
 * SameSite 值统一转成首字母大写：写 'lax' 的话浏览器认不认要看实现，
 * 而这个字段一旦被忽略，防护就静默消失了。
 */
function serializeCookie(name, value, options) {
  const opt = options || {};
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (opt.maxAge != null) parts.push(`Max-Age=${Math.floor(opt.maxAge)}`);
  if (opt.expires) parts.push(`Expires=${opt.expires.toUTCString()}`);
  if (opt.path) parts.push(`Path=${opt.path}`);
  if (opt.domain) parts.push(`Domain=${opt.domain}`);
  if (opt.httpOnly) parts.push('HttpOnly');
  if (opt.secure) parts.push('Secure');
  if (opt.sameSite) parts.push(`SameSite=${SAME_SITE[String(opt.sameSite).toLowerCase()] || opt.sameSite}`);

  return parts.join('; ');
}

/** 追加一条 Set-Cookie。用 append 而不是 setHeader —— 一次响应可能同时种多个 cookie */
function appendCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', cookie);
  else res.setHeader('Set-Cookie', [].concat(prev, cookie));
}

/** 让浏览器立刻丢弃某个 cookie。属性必须与种下时一致，否则删不掉 */
function clearCookie(res, name, options) {
  appendCookie(res, serializeCookie(name, '', Object.assign({}, options, { maxAge: 0 })));
}

/* ---------- 脱敏 ---------- */

/**
 * 抹掉文本里的密钥痕迹。
 *
 * 为什么需要它（实测，不是假想）：tools/planner.js 会把上游的原始错误抛出来，
 * DeepSeek 认证失败时那一句是
 *   Authentication Fails, Your api key: ****a765 is invalid
 * —— 它把 key 的后四位回显了。而 serve.js 与 api/plan.js 的错误分支都会把
 * err.message 原样回给客户端，等于把密钥片段送到公网，日志里也留一份。
 *
 * 放在这里而不是单开一个文件：两个调用点都是 HTTP 错误出口，
 * 脱敏的对象就是「即将离开本进程的文本」。
 *
 * 【它挡不住什么】裸的长十六进制串（高德那类 32 位 key）不会被匹配 ——
 * 那种形状与哈希、ID 无法区分，硬匹配会误伤正常诊断信息。当前之所以够用，
 * 是因为已证实的泄漏只有 DeepSeek 那一种回显形式；tools/amap-proxy.js 那边
 * 已经把上游错误收敛成固定文案，URL（含 key）不会外流。
 * 日后若新增会回显上游原始报文的接口，这里的规则要跟着补。
 */
function redact(text) {
  return String(text)
    // 完整的 sk- 开头的 key
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    // 各家回显密钥时的掩码形式，去掉掩码等于连后四位都不给
    .replace(/\*{2,}[A-Za-z0-9]{2,}/g, '****');
}

/* ---------- 响应 ---------- */

/**
 * 一次性 JSON 返回。
 * 原先住在 tools/sse.js 里，因为那时只有流式规划一个调用方。
 * 现在 api-router 与 serve.js 也要用，就搬到协议层来，sse.js 再导出一次
 * 保持既有 import 不断 —— 两份实现迟早会分叉。
 */
function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

/** 无正文的状态码返回，用于 404 / 405 这类不需要解释体、但需要正确状态的场合 */
function sendText(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/**
 * 把错误渲染成响应。已经发过头（流式响应开了口）就不能再改状态码，
 * 只能把连接收掉 —— 这是 tools/sse.js 里踩过的同一个坑。
 */
function sendError(res, error) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* 已经断了，无所谓 */
    }
    return;
  }

  const known = error instanceof HttpError;
  if (known && error.expose) {
    sendJson(res, error.status, { error: error.message });
    return;
  }

  // 非预期错误：原文只进日志，不回客户端 —— 里面可能有密钥、SQL、路径
  console.error('[服务] 未预期的错误：', error && error.stack ? error.stack : error);
  sendJson(res, known ? error.status : 500, { error: '服务器内部错误' });
}

module.exports = {
  HttpError,
  badRequest,
  unauthorized,
  forbidden,
  parseUrl,
  isJsonRequest,
  readJson,
  parseCookies,
  getCookie,
  serializeCookie,
  appendCookie,
  clearCookie,
  sendJson,
  sendText,
  sendError,
  redact
};
