#!/usr/bin/env node
/**
 * 本地静态服务：node serve.js [port]
 * 高德 JSAPI 的域名校验对 file:// 不友好，用 http 打开最稳。
 *
 * 除了发静态文件，它还提供 /api/amap —— 和线上 api/amap.js 同一套转发逻辑，
 * 目的是让本地开发也走「密钥不进浏览器」这条路。否则本地和线上会跑两套代码，
 * 部署后才发现问题。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { proxy } = require('./tools/amap-proxy');
const { plan } = require('./tools/planner');
const { wantsStream, streamPlan, sendJson } = require('./tools/sse');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 5173;

/**
 * 取高德 Web 服务密钥。优先环境变量（和线上一致），其次 config.local.js。
 * 这个文件不会被部署，见 .vercelignore。
 */
function amapKey() {
  if (process.env.AMAP_WEB_SERVICE_KEY) return process.env.AMAP_WEB_SERVICE_KEY;
  try {
    return require('./config.local.js').amapWebServiceKey || '';
  } catch {
    return '';
  }
}

/**
 * 绝不对外发的文件。config.local.js 里是明文密钥，
 * 静态服务默认会把它当普通文件返回 —— 那样「密钥不进浏览器」就白做了，
 * 凡是能访问到这个端口的人 GET 一下就能拿到。
 */
const BLOCKED = new Set(['config.local.js']);

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 100000) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('请求体不是有效 JSON'));
      }
    });
    req.on('error', reject);
  });
}

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

http
  .createServer((req, res) => {
    let urlPath;
    try {
      // decodeURIComponent 遇到 "%"、"%" 开头的不完整转义会抛 URIError，
      // 在请求回调里同步抛出会直接干掉整个进程
      urlPath = decodeURIComponent(req.url.split('?')[0]);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('400 Bad Request');
      return;
    }

    // 与线上 api/amap.js 同源同行为
    if (urlPath === '/api/amap') {
      const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
      proxy(query, amapKey())
        .then(({ status, body }) => {
          res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
          });
          res.end(JSON.stringify(body));
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: String(err && err.message) }));
        });
      return;
    }

    // 与线上 api/plan.js 同源同行为：要流就给流，不要就还是一次性 JSON
    if (urlPath === '/api/plan') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: '只支持 POST' });
        return;
      }
      readJson(req)
        .then((body) =>
          wantsStream(req)
            ? streamPlan({ req, res, body, plan })
            : plan(body).then((result) => sendJson(res, 200, result))
        )
        .catch((err) => {
          console.error('[规划服务]', err && err.stack ? err.stack : err);
          // 流已经开了头就不能再改状态码了，只能把连接收掉
          if (res.headersSent) {
            try { res.end(); } catch { /* 已经断了 */ }
            return;
          }
          sendJson(res, err.message === '请求体过大' ? 413 : 502, {
            error: err && err.message ? err.message : '规划服务失败'
          });
        });
      return;
    }

    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');

    if (BLOCKED.has(path.basename(rel))) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const file = path.join(ROOT, rel);

    // 目录穿越防护：用相对路径判断，避免 "武汉旅游攻略2" 这类同前缀目录绕过
    const relPath = path.relative(ROOT, file);
    if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
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
  })
  .listen(PORT, () => {
    console.log(`\n  武汉行程攻略已启动：  http://localhost:${PORT}\n  按 Ctrl+C 停止\n`);
  });
