/**
 * 高德 Web 服务转发逻辑，本地开发服务器与线上 serverless 函数共用一份。
 *
 * 存在的唯一理由：Web 服务密钥不能出现在浏览器里。
 * 页面上的 JS 谁都能读，密钥一旦内嵌就等于公开 —— 而高德的 Web 服务 key
 * 不支持域名白名单（只有 Web端 JS key 支持），拿到就能从任何地方刷你的配额。
 *
 * 接口白名单是必须的：不加就是一个人人可用的公开代理，
 * 别人能拿你的服务器当免费中转。
 *
 * 本地：serve.js 读 config.local.js 里的密钥
 * 线上：api/amap.js 读环境变量 AMAP_WEB_SERVICE_KEY
 */

'use strict';

/** 只放行前端真正会调的四个接口 */
const ALLOWED = new Set([
  '/v3/direction/driving',
  '/v3/direction/walking',
  '/v3/direction/transit/integrated',
  '/v3/weather/weatherInfo'
]);

const UPSTREAM = 'https://restapi.amap.com';
const TIMEOUT_MS = 10000;

/**
 * @param {Record<string, string>} query 请求参数。p 是高德接口路径，其余原样透传
 * @param {string} key 高德 Web 服务密钥
 * @returns {Promise<{status: number, body: object}>}
 */
async function proxy(query, key) {
  const endpoint = query.p;

  if (!ALLOWED.has(endpoint)) {
    return { status: 400, body: { error: '不支持的接口', path: endpoint || null } };
  }

  if (!key) {
    return {
      status: 500,
      body: {
        error: '服务端未配置高德 Web 服务密钥',
        hint: '本地：写入 config.local.js；线上：配置环境变量 AMAP_WEB_SERVICE_KEY'
      }
    };
  }

  const url = new URL(UPSTREAM + endpoint);
  for (const [k, v] of Object.entries(query)) {
    // 查询串里同一个 key 出现多次时高德会给数组，直接塞进去会变成 "a,b"
    if (k === 'p' || typeof v !== 'string') continue;
    url.searchParams.set(k, v);
  }
  url.searchParams.set('key', key);
  url.searchParams.set('output', 'JSON');

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: 200, body: await res.json() };
  } catch (err) {
    return { status: 502, body: { error: '上游请求失败', detail: String(err && err.message) } };
  }
}

module.exports = { proxy, ALLOWED };
