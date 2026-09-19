/**
 * 四把密钥的解析与描述。
 *
 * 后台的「密钥」区要显示四项，它们的来路各不相同：
 *
 *   浏览器侧（按设计就是公开的，会发到每个访客的浏览器）
 *     · 高德 WebJS Key      要和配套的安全密钥**成对**使用
 *     · 高德安全密钥
 *   服务端（永不发给浏览器）
 *     · 高德 Web 服务密钥    转发 /api/amap 与算路时用
 *     · DeepSeek 密钥        跑规划时用
 *
 * 解析顺序一律是：环境变量 > 数据库 > 本地文件（config.local.js / config.js）。
 *
 * 【为什么服务端那两把「解不开」时不继续往下回落】
 * 数据库里有值但拆不开，说明 APP_SECRET 换过。这时候若回落到 config.local.js，
 * 站点会**静默地**用回旧密钥 —— 而管理员刚刚做的正是一次密钥轮换，
 * 他会以为换成功了。宁可让取值为空、让接口明确报错，也不要这种成功假象。
 *
 * 【迁移到 MySQL 时是机械的 async 化，但传染面最广】
 * 这一层的 async 化源头是 settings.readSetting（它要读库），而它往上影响的
 * 调用点分布在 serve.js、api-router.js、admin-cli.js、quota.js ——
 * 这几处都要跟着加 await。注意 ignoredWarnings 保持**同步**：
 * 它只处理一个已经在手里的对象，不碰库。
 */

'use strict';

const path = require('path');
const {
  readSetting,
  KEY_WEBJS,
  KEY_SECURITY,
  KEY_AMAP_SERVICE,
  KEY_DEEPSEEK
} = require('./settings');

const ROOT = path.resolve(__dirname, '..');

/** config.local.js 的内容。不存在就是空对象 —— 它在 .gitignore 与 .vercelignore 里 */
let localCache = null;
function localConfig() {
  if (localCache) return localCache;
  try {
    localCache = require(path.join(ROOT, 'config.local.js')) || {};
  } catch {
    localCache = {};
  }
  return localCache;
}

/* ============ 一、浏览器侧那一对 ============ */

/**
 * 解析浏览器侧该用哪一对高德密钥。
 *
 * 返回 { amap, source, ignored }：
 *   amap    —— 解析出的 { WEB_JS_KEY, SECURITY_CODE }，或 null 表示没有覆盖值
 *   source  —— 'env' | 'settings' | 'static'，实际用的是哪一层
 *   ignored —— 被跳过的层（只配了一半的那些），供调用方告警
 *
 * 【为什么按「成对」判定，而不是逐字段回落】
 * WEB_JS_KEY 与 SECURITY_CODE 是一对，必须来自同一次配置。若逐字段合并，
 * 很容易出现「新 key 配旧 code」—— 高德会回 INVALID_USER_SCODE，
 * 这个错误比「key 缺失」难查得多，因为它看起来像密钥本身有问题。
 *
 * 【成对是「层内」的约束，不是跨层的】
 * 这一步最初写成「env 只要有一项就 return」，结果是：一个拼错的
 * AMAP_SECURITY_CODE 会让库里一对完全有效的配置被静默作废。
 * 跳过不完整的那一层、继续往下看，才是「成对」想表达的意思。
 */
async function resolveAmapWebConfig() {
  const envKey = (process.env.AMAP_WEB_JS_KEY || '').trim();
  const envCode = (process.env.AMAP_SECURITY_CODE || '').trim();

  if (envKey && envCode) {
    return { amap: { WEB_JS_KEY: envKey, SECURITY_CODE: envCode }, source: 'env', ignored: [] };
  }

  const ignored = envKey || envCode ? ['env'] : [];

  const dbKey = (await readSetting(KEY_WEBJS)).value;
  const dbCode = (await readSetting(KEY_SECURITY)).value;

  if (dbKey && dbCode) {
    return { amap: { WEB_JS_KEY: dbKey, SECURITY_CODE: dbCode }, source: 'settings', ignored };
  }
  if (dbKey || dbCode) ignored.push('settings');

  // 没有任何可用的覆盖值：浏览器用 config.js 里那份静态的
  return { amap: null, source: 'static', ignored };
}

/**
 * 被跳过的层各给一句能直接照着做的提示。返回空数组表示不需要提醒。
 * 文案必须说清「哪一层被跳过了、现在实际用的是哪一层」——
 * 只说「已忽略」的话，运维看不出库里其实还有一对可用的配置。
 */
function ignoredWarnings(result) {
  const parts = [];
  if (result.ignored.includes('env')) {
    parts.push('环境变量只配了 AMAP_WEB_JS_KEY 与 AMAP_SECURITY_CODE 中的一个，该层已跳过');
  }
  if (result.ignored.includes('settings')) {
    parts.push(`数据库里只配了 ${KEY_WEBJS} 与 ${KEY_SECURITY} 中的一个，该层已跳过`);
  }
  if (!parts.length) return [];

  const actual =
    result.source === 'env' ? '环境变量' :
    result.source === 'settings' ? '数据库' : 'config.js 静态值';

  return parts.map((p) => `${p}；当前实际使用${actual}`);
}

/* ============ 二、服务端那两把 ============ */

/**
 * 一把服务端密钥的解析。三层往下找，但**遇到「解不开」就停住**。
 *
 * @returns {Promise<{value: string|null, source: string, problem: string|null}>}
 *   source —— 'env' | 'settings' | 'local' | 'none'
 */
async function resolveServerKey(config) {
  const fromEnv = (process.env[config.envName] || '').trim();
  if (fromEnv) return { value: fromEnv, source: 'env', problem: null };

  const stored = await readSetting(config.settingKey);
  if (stored.status === 'ok') return { value: stored.value, source: 'settings', problem: null };
  if (stored.status === 'undecryptable') {
    return {
      value: null,
      source: 'settings',
      problem: `${config.label}存在数据库里，但解不开（APP_SECRET 换过？）`
    };
  }
  // 读库失败也**不往下回落**。对公开项来说回落到静态值是好事，
  // 但对服务端密钥不是：轮换完密钥之后来一次库故障，会让站点安静地用回
  // 本地文件里那把已经作废的 key，而换 key 的人以为已经生效了。
  if (stored.status === 'unreadable') {
    return {
      value: null,
      source: 'settings',
      problem: `${config.label}读不出来（数据库暂时不可用）。已停止回落，以免悄悄用回旧密钥`
    };
  }

  const local = (localConfig()[config.localName] || '').trim();
  if (local) return { value: local, source: 'local', problem: null };

  return { value: null, source: 'none', problem: null };
}

async function resolveAmapServiceKey() {
  return resolveServerKey({
    envName: 'AMAP_WEB_SERVICE_KEY',
    settingKey: KEY_AMAP_SERVICE,
    localName: 'amapWebServiceKey',
    label: '高德 Web 服务密钥'
  });
}

async function resolveDeepseekKey() {
  return resolveServerKey({
    envName: 'DEEPSEEK_API_KEY',
    settingKey: KEY_DEEPSEEK,
    localName: 'deepseekApiKey',
    label: 'DeepSeek 密钥'
  });
}

/* ============ 三、给后台看的描述 ============ */

const SOURCE_LABEL = {
  env: '环境变量',
  settings: '数据库',
  local: 'config.local.js',
  static: 'config.js 静态值',
  none: '未配置'
};

/** 只露头四位与末四位。够管理员核对自己填的是不是那一串，不足以拿去用 */
function mask(value) {
  if (!value) return null;
  if (value.length <= 10) return '•'.repeat(value.length);
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/**
 * 密钥区要的全部信息。
 *
 * 【为什么要掩码】服务端那两把绝不能出现在响应体里 —— 响应体会进浏览器内存、
 * 进开发者工具、进任何一次截图。浏览器侧那对按设计是公开的，但这里也一并掩码：
 * 管理员核对后四位就够了，而少一处明文出口就少一处需要解释的地方。
 * 要拿完整值，去 config.js 或环境变量那里取。
 */
async function describeKeys() {
  const web = await resolveAmapWebConfig();
  const service = await resolveAmapServiceKey();
  const deepseek = await resolveDeepseekKey();

  const envWebKey = Boolean((process.env.AMAP_WEB_JS_KEY || '').trim());
  const envWebCode = Boolean((process.env.AMAP_SECURITY_CODE || '').trim());
  const webEnvComplete = envWebKey && envWebCode;
  const webEnvPartial = (envWebKey || envWebCode) && !webEnvComplete;

  // 浏览器侧那一对是同一份解析结果，所以两项共享来源与告警
  const webSource = webEnvComplete ? 'env' : web.source;
  const webProblem = webEnvPartial
    ? '环境变量只配了一半，该层已被跳过；下面显示的不是环境变量里的值'
    : null;

  return {
    sourceLabel: SOURCE_LABEL,
    items: [
      {
        key: KEY_WEBJS,
        label: '高德 WebJS Key',
        scope: 'browser',
        hint: '渲染地图用。支持域名白名单，按设计就是公开的。',
        source: webSource,
        sourceLabel: SOURCE_LABEL[webSource] || webSource,
        value: mask(web.amap ? web.amap.WEB_JS_KEY : null),
        lockedByEnv: webEnvComplete,
        problem: webProblem
      },
      {
        key: KEY_SECURITY,
        label: '高德安全密钥',
        scope: 'browser',
        hint: '与 WebJS Key 配套。两项必须来自同一次配置，所以后台也是一起保存的。',
        source: webSource,
        sourceLabel: SOURCE_LABEL[webSource] || webSource,
        value: mask(web.amap ? web.amap.SECURITY_CODE : null),
        lockedByEnv: webEnvComplete,
        problem: webProblem
      },
      {
        key: KEY_AMAP_SERVICE,
        label: '高德 Web 服务密钥',
        scope: 'server',
        hint: '地理编码、算路、天气。它不支持域名白名单，内嵌就等于把每日配额公开，所以只在服务端用。',
        source: service.source,
        sourceLabel: SOURCE_LABEL[service.source] || service.source,
        value: mask(service.value),
        lockedByEnv: service.source === 'env',
        problem: service.problem
      },
      {
        key: KEY_DEEPSEEK,
        label: 'DeepSeek 密钥',
        scope: 'server',
        hint: '跑行程规划用。没配它时规划接口会直接失败。',
        source: deepseek.source,
        sourceLabel: SOURCE_LABEL[deepseek.source] || deepseek.source,
        value: mask(deepseek.value),
        lockedByEnv: deepseek.source === 'env',
        problem: deepseek.problem
      }
    ]
  };
}

module.exports = {
  localConfig,
  resolveAmapWebConfig,
  ignoredWarnings,
  resolveAmapServiceKey,
  resolveDeepseekKey,
  describeKeys
};
