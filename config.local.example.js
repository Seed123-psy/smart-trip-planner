/**
 * 本地开发配置模板。复制为 config.local.js 后填写真实值。
 * config.local.js 已被 .gitignore 排除，禁止提交或部署。
 * APP_SECRET 不写在此文件；请在启动服务的终端环境变量中设置，并长期保持不变。
 */
'use strict';

module.exports = {
  amapWebServiceKey: '',
  deepseekApiKey: '',
  deepseekModel: 'deepseek-flash',
  mysql: {
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: 'itinerary'
  }
};
