/**
 * Vercel serverless 函数：把浏览器发来的高德请求转发出去，并补上密钥。
 *
 * 前端调用形如：
 *   /api/amap?p=/v3/direction/walking&origin=114.29,30.55&destination=114.30,30.56
 *
 * 密钥来自 Vercel 项目的环境变量 AMAP_WEB_SERVICE_KEY，
 * 绝不写进任何会被浏览器加载的文件。转发规则见 tools/amap-proxy.js。
 */

'use strict';

const { proxy } = require('../tools/amap-proxy');

module.exports = async (req, res) => {
  const { status, body } = await proxy(
    req.query || {},
    process.env.AMAP_WEB_SERVICE_KEY
  );

  // 算路与当天天气短时间内不会变，让边缘缓存挡掉重复请求，省配额。
  // 失败的不缓存，免得一次抖动被固化住。
  res.setHeader(
    'Cache-Control',
    status === 200 ? 's-maxage=300, stale-while-revalidate=600' : 'no-store'
  );
  res.status(status).json(body);
};
