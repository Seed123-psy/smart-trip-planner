/**
 * AI 行程规划服务。
 *
 * 服务端先从高德实时搜索城市 POI，再让模型筛选、排程和审校，
 * 最后按高德算路接口补齐每段的真实距离与耗时。
 * 模型输出只允许引用本次搜索结果，服务端负责校验引用并补齐路线数据。
 */
'use strict';

const path = require('path');
const { resolveDeepseekKey, resolveAmapServiceKey } = require('./keys');
const { redact } = require('./http');

const ROOT = path.resolve(__dirname, '..');
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const AMAP_BASE = 'https://restapi.amap.com';
const REQUEST_TIMEOUT_MS = 45000;
const AMAP_TIMEOUT_MS = 12000;
/** 算路比 POI 检索慢一档，但也不该拖住整次规划 */
const ROUTE_TIMEOUT_MS = 8000;
/** 算路全部失败时的兜底均速（km/h），结果会标记 estimated 供前端提示 */
const FALLBACK_SPEED = { driving: 25, transit: 22, walking: 4.5 };

/**
 * 带脱敏的告警出口。
 *
 * planner 会把上游（DeepSeek / 高德）的原始错误带进来，而 DeepSeek 认证失败
 * 那一句是「Authentication Fails, Your api key: ****a765 is invalid」——
 * 末尾带着密钥后四位。HTTP 出口早就在过 redact()，但这些内部告警没有，
 * 于是同一份密钥片段从日志这边漏了出去。
 *
 * 与其在每个 console.warn 上记得加一次，不如让这个文件里只有这一个出口。
 */
function logWarn(...args) {
  // 这里必须是 console.warn。用脚本批量替换 console.warn 时，
  // 这一行也被换成了 logWarn，于是它自己调自己 —— 一栈到底。
  console.warn(...args.map((a) => (typeof a === 'string' ? redact(a) : a)));
}

/**
 * 表单可选项。key 由前端提交，label 直接进提示词 ——
 * 与其把 key 丢给模型猜含义，不如把中文写进去，省得它在心里做一次翻译。
 * 这里也是白名单：不在表里的值一律丢弃，不让前端任意字符串进模型上下文。
 */
const OPTIONS = {
  party: {
    solo: '独自出行',
    family: '家庭出行',
    couple: '情侣出行',
    friends: '朋友出行',
    seniors: '老人出行'
  },
  styles: {
    culture: '文化体验',
    classic: '经典必去',
    nature: '自然风光',
    cityscape: '城市景观',
    history: '历史古迹'
  },
  timing: {
    early: '偏早出',
    late: '偏晚归'
  }
};

/**
 * 风格偏好 -> 高德检索词。
 * 这一层映射是必须的：模型只能从检索回来的目录里挑地点，
 * 目录里没有的东西它变不出来。偏好若只写在提示词里而不落到检索上，
 * 选「自然风光」也照样只会拿到一堆博物馆。
 */
const STYLE_KEYWORDS = {
  culture: ['博物馆', '美术馆'],
  classic: ['景点', '名胜'],
  nature: ['公园', '风景区'],
  cityscape: ['观景台', '步行街'],
  history: ['古迹', '历史文化街区']
};

/**
 * 取表单选项：只保留白名单内的 key，不在表里的一律丢弃。
 *
 * 必须用 Object.hasOwn，不能写成 `allowed[key]` ——
 * "constructor"、"__proto__"、"toString" 这些会顺着原型链取到真值，
 * 白名单就形同虚设（实测能混进检索关键词，变成 [object Object] 发给高德）。
 */
function pickKeys(group, value) {
  const allowed = OPTIONS[group] || {};
  const list = Array.isArray(value) ? value : [value];
  return list.filter((key) => typeof key === 'string' && Object.hasOwn(allowed, key));
}

/**
 * 交给模型的请求视图：把选项 key 翻成中文。
 * request 本身存的是 key（检索关键词要按 key 映射，不能用中文反查），
 * 到了提示词边上才翻译 —— 两边各司其职，谁也不用猜对方。
 */
function describeRequest(request) {
  const labels = (group, value) => {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return list.map((key) => OPTIONS[group][key]).filter(Boolean);
  };
  return {
    city: request.city,
    days: request.days,
    startDate: request.startDate,
    endDate: request.endDate,
    party: labels('party', request.party),
    styles: labels('styles', request.styles),
    timing: labels('timing', request.timing),
    pace: request.pace,
    budget: request.budget,
    interests: request.interests,
    notes: request.notes
  };
}

function loadLocalConfig() {
  try {
    return require(path.join(ROOT, 'config.local.js')) || {};
  } catch {
    return {};
  }
}

/**
 * 本次规划要用的配置。
 *
 * overrides 是路由层决定的、与「谁在用」有关的覆盖项 —— 目前只有 deepseekKey：
 * 用户配了自己的就用他的，没配才用全局的。
 *
 * 【为什么「该不该回落」不在这里判断】
 * 那需要知道账号体系（谁登录了、他的密钥解不解得开），而 planner 的职责是
 * 「给定输入和密钥，产出行程」。让它去读会话，就再也无法单独测试或复用。
 * 所以这里只负责用给它的值，一切判断留在路由层。
 */
function plannerConfig(overrides) {
  const local = loadLocalConfig();
  const opt = overrides || {};

  return {
    // 两把密钥走统一的解析层：环境变量 > 数据库 > config.local.js。
    // 这样管理员在后台换 key 不用重启，也不用去动服务器上的文件。
    // 每次调用现解析（会读一次库）—— 这个函数每次规划才调几次，不是每个请求都调。
    key: String(opt.deepseekKey || '').trim() || resolveDeepseekKey().value || '',
    amapKey: resolveAmapServiceKey().value || '',

    // 下面两个是模型名，不是密钥，没必要进数据库
    model: process.env.DEEPSEEK_MODEL || local.deepseekModel || 'deepseek-flash',
    fallbackModel: process.env.DEEPSEEK_FALLBACK_MODEL || local.deepseekChatModel || 'deepseek-chat'
  };
}

/**
 * 整个规划的硬预算。
 *
 * 三跳模型调用（每跳上限 45s）加上算路，最坏情况会超出 serverless 的时限；
 * 超预算就跳过审校、算路直接走估算，保证函数一定在可预期时间内返回。
 * 流式响应**不会**延长函数超时，所以这条线必须自己守。
 */
const PLAN_BUDGET_MS = 90000;
/** 审校跑一次最多要 45s，剩余时间不够就别起了 —— 起了也是被掐断 */
const REVIEW_MIN_REMAINING_MS = 30000;
/** 行前准备同样是一跳模型调用，留够时间再起 */
const PREP_MIN_REMAINING_MS = 25000;

/**
 * 阶段上报的包装器。
 *
 * onStage 一律作为参数逐层透传，**绝不能用模块级变量** ——
 * serve.js 是长驻进程，两个并发规划会互相串台。
 */
async function stage(name, emit, fn, detailOf) {
  emit({ stage: name, status: 'start' });
  const t0 = Date.now();
  try {
    const out = await fn();
    emit({
      stage: name,
      status: 'done',
      ms: Date.now() - t0,
      ...(detailOf ? { detail: detailOf(out) } : {})
    });
    return out;
  } catch (error) {
    emit({ stage: name, status: 'error', ms: Date.now() - t0, message: error.message });
    throw error;
  }
}

function cleanText(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeRequest(input) {
  const body = input && typeof input === 'object' ? input : {};
  const today = new Date().toISOString().slice(0, 10);
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(body.startDate) ? body.startDate : today;
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(body.endDate) ? body.endDate : startDate;
  const days = Math.max(1, Math.min(14, Number(body.days) || dateDiff(startDate, endDate) + 1));
  return {
    city: cleanText(body.city, 40) || '武汉',
    startDate,
    endDate,
    days,
    interests: cleanText(body.interests, 300),
    pace: ['slow', 'balanced', 'fast'].includes(body.pace) ? body.pace : 'balanced',
    budget: ['low', 'medium', 'high'].includes(body.budget) ? body.budget : 'medium',
    // 表单选项一律过白名单，只留 key；交给模型前由 describeRequest 翻成中文
    party: pickKeys('party', body.party)[0] || '',
    styles: pickKeys('styles', body.styles),
    timing: pickKeys('timing', body.timing),
    /** 「更多偏好」自由文本：只进提示词，不参与检索关键词抽取 */
    notes: cleanText(body.notes, 300),
    startPoint: cleanText(body.startPoint, 120),
    endPoint: cleanText(body.endPoint, 120)
  };
}

function dateDiff(a, b) {
  const start = Date.parse(`${a}T00:00:00Z`);
  const end = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 86400000));
}

/**
 * 检索词：用户写的兴趣 + 风格偏好映射 + 兜底分类。
 *
 * 兜底那三个是保底 —— 用户的兴趣词可能都搜不到东西（错别字、生僻叫法），
 * 全靠它保证目录不至于空。总数封顶 10 个：每词一次高德请求，
 * 再多就只是拿配额换重复结果了。
 */
const MAX_KEYWORDS = 10;
const BASE_KEYWORDS = ['景点', '博物馆', '公园'];

function searchKeywords(request) {
  const userTerms = cleanText(request.interests, 160)
    .split(/[，,、；;\s]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && term.length <= 14)
    .slice(0, 3);

  const styleTerms = (request.styles || []).flatMap((key) => STYLE_KEYWORDS[key] || []);

  return [...new Set([...userTerms, ...styleTerms, ...BASE_KEYWORDS])].slice(0, MAX_KEYWORDS);
}

/**
 * 统一的 Web 服务请求：补上 key，并校验高德特有的 status 字段。
 * 高德即使参数错误也返回 HTTP 200，只看 response.ok 会把失败当成功。
 */
async function amapGet(endpoint, params, key, timeout = AMAP_TIMEOUT_MS) {
  if (!key) throw new Error('服务端未配置高德 Web 服务密钥');

  const url = new URL(AMAP_BASE + endpoint);
  url.searchParams.set('key', key);
  url.searchParams.set('output', 'JSON');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status !== '1') {
    throw new Error(body.info || `高德接口返回 ${response.status}`);
  }
  return body;
}

async function searchAmap(keyword, city, key) {
  const body = await amapGet('/v3/place/text', {
    keywords: keyword,
    city,
    citylimit: 'true',
    extensions: 'all',
    offset: '25',
    page: '1'
  }, key);
  return Array.isArray(body.pois) ? body.pois : [];
}

/**
 * 取目标城市的 adcode 与 citycode。
 * 前端用 adcode 查天气、用 citycode 算公交 —— 规划到别的城市时，
 * 这两个都不能继续沿用武汉的 420100 / 027。
 *
 * 解析不到就返回空串：前端会据此隐藏天气，而不是继续显示上一座城市的天气。
 */
async function resolveCityMeta(city, key) {
  try {
    const body = await amapGet('/v3/geocode/geo', { address: city, city }, key);
    const geo = (body.geocodes && body.geocodes[0]) || {};
    // coords 是给首页用的：规划一开始要把地图飞到这座城市
    const point = String(geo.location || '').split(',').map(Number);
    return {
      adcode: cleanText(geo.adcode, 20),
      citycode: cleanText(geo.citycode, 20),
      coords: point.length === 2 && point.every(Number.isFinite) ? point : null
    };
  } catch (error) {
    logWarn('[规划服务] 城市编码解析失败，前端将隐藏天气、公交按城市名算路：', error.message);
    return { adcode: '', citycode: '', coords: null };
  }
}

function poiKind(type) {
  const value = String(type || '');
  if (value.includes('博物馆')) return 'museum';
  if (value.includes('公园') || value.includes('风景')) return 'park';
  if (value.includes('餐饮') || value.includes('美食')) return 'food';
  return 'landmark';
}

/**
 * 目录上限按天数放大。
 * 候选池必须比最终行程宽裕得多：筛选 Agent 要留下「每天 6—8 个」的备选，
 * 排程才有挑的余地。以前固定 80，7 天就只剩每天 11 个，
 * 一挤就出现「某天只剩一个景点」。同时给个上限，避免 14 天把提示词撑爆。
 */
const catalogLimit = (days) => Math.min(140, Math.max(60, days * 12));

async function discoverCatalog(request, config) {
  if (!config.amapKey) throw new Error('服务端未配置高德 Web 服务密钥，无法搜索景点');
  // 逐个过限速闸门：以前并发发出，必有一个关键词撞 CUQPS_HAS_EXCEEDED_THE_LIMIT，
  // 被 catch 成空数组后无人察觉，候选池就这么悄悄少了一批
  const jobs = searchKeywords(request).map((keyword) =>
    runWithRateRetry(searchLimiter, () => searchAmap(keyword, request.city, config.amapKey), `检索「${keyword}」`)
      .catch((error) => {
        logWarn(`[规划服务] 高德搜索「${keyword}」失败：`, error.message);
        return [];
      })
  );
  const batches = await Promise.all(jobs);
  const seen = new Set();
  const items = [];
  batches.flat().forEach((item) => {
    const [lng, lat] = String(item.location || '').split(',').map(Number);
    if (!item.name || !Number.isFinite(lng) || !Number.isFinite(lat)) return;
    const dedupe = `${item.name}|${lng.toFixed(5)}|${lat.toFixed(5)}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    items.push({
      id: `amap-${String(items.length + 1).padStart(3, '0')}`,
      name: cleanText(item.name, 100),
      address: cleanText(item.address || item.business_area, 180),
      city: request.city,
      kind: poiKind(item.type),
      role: 'spot',
      note: cleanText(item.type || '', 100),
      ticket: '',
      coords: [lng, lat],
      source: 'amap',
      amapId: cleanText(item.id, 80)
    });
  });
  if (items.length < 3) {
    throw new Error(`高德没有找到足够的「${request.city}」景点，请检查城市名称后重试`);
  }
  const limit = catalogLimit(request.days);
  console.log(`[规划服务] 候选目录 ${items.length} 个，取前 ${Math.min(items.length, limit)} 个（${request.days} 天）`);
  return items.slice(0, limit);
}

function systemPrompt() {
  return [
    '你是旅行路线规划器。只能从本次高德实时搜索返回的 POI 目录中选择地点，不得创造新的 poiId。',
    '请根据日期、兴趣、预算和节奏安排可执行的多日行程，避免同一天跨城来回。',
    // 密度必须写死。以前这里只字未提「每天几个点」，模型就在 1—5 个之间飘，
    // 出现「某天只有一个景点」的行程；审校环节又只查「太挤」不查「太空」，补不回来。
    '每个整天安排 4 到 6 个点。确实排不满（抵离日只有半天、候选里没有合适的）可以少，但必须在当天的 summary 里写明原因。',
    '候选目录是备选池，宁可让每天多排一个顺路的点，也不要出现某天只有 1—2 个点。',
    '输出必须是 JSON，不要 Markdown，不要解释 JSON 之外的内容。',
    '每天 visits 按时间递增；每个 visit 必须有 poiId、time、title、desc、stay、mode。',
    'mode 只能是 driving、transit、walking。walking 只用于相邻且合理的近距离地点。',
    '优先保留开放时间和预约等信息；不确定的内容放入 warnings，不要编造价格或营业时间。',
    'JSON 结构：{"days":[{"id":"day1","label":"Day 1","date":"YYYY-MM-DD","dateText":"","title":"","summary":"","visits":[{"poiId":"","time":"HH:mm","title":"","desc":"","stay":"","mode":"driving","advice":"","hot":false}]}],"warnings":[]}'
  ].join('\n');
}

function selectionPrompt() {
  return [
    '你是景点筛选 Agent。目录来自高德对目标城市的实时搜索，只能从目录中选择 poiId，不得创造地点。',
    // 以前的「每天 3 到 6 个」是候选池口径，但措辞含糊，实际卡在下限：
    // 7 天只留 22 个候选，排程再怎么分也必然有某天只剩 1 个。
    '为每天挑选 6 到 8 个候选（总量约为天数 × 7），宁多勿少：排程会从候选里再筛一遍，候选不够就会导致某天无点可排。',
    '尽量保持区域集中，同一天相邻的点在地理上要顺路。',
    '按用户填的出行人群、风格偏好、时间安排和「更多偏好」来取舍。',
    '只输出 JSON：{"selectedPoiIds":["id"],"notes":["需要预约或存在不确定性的说明"]}'
  ].join('\n');
}

function schedulePrompt() {
  return [
    systemPrompt(),
    '你是行程排程 Agent。只使用候选 poiId，安排每天合理的开放时段与交通节奏。',
    '只输出上述约定的完整行程 JSON。'
  ].join('\n');
}

function reviewPrompt() {
  return [
    '你是行程审校 Agent。逐天检查并修正：',
    '· 引用的 poiId 是否都在候选目录内；日期是否连续；时间是否递增；交通方式是否合理。',
    '· 太挤：每天超过 6 个点要删到 6 个以内，优先删同类型里最次要的。',
    // 只有上限没有下限，是之前「某天只剩一个景点」能一路通过审校的原因
    '· 太空：某天不足 4 个点要从候选目录里补足到 4 个，补的点要与当天其它点顺路、且时间能塞得进递增序列。',
    '抵离日等确实只能半天的，可以不足 4 个，但当天 summary 必须写明原因。',
    '不得新增候选目录之外的地点。保留可执行的描述和 warnings。',
    '只输出完整的行程 JSON：{"days":[...],"warnings":[]}'
  ].join('\n');
}

/** 交给模型的请求视图：选项已翻成中文，见 describeRequest */
function userPrompt(request, items) {
  return JSON.stringify({ request: describeRequest(request), poiCatalog: items }, null, 2);
}

/**
 * 行前准备 Agent。
 *
 * 它的产出会直接拿去用 —— 照着抢票、照着打电话。所以这里的约束比排程那步更硬：
 * 编错一个放票时间，人按它去抢就白等一场；编一个电话号码，打过去是别人的号。
 * 提示词写不下这种保证，真正兜底的是 sanitizePrep 里的服务端校验。
 */
function prepPrompt() {
  return [
    '你是行前准备 Agent。产物直接给旅行者用，所以**只写这次行程里能确定的东西**。',
    '',
    '硬性要求：',
    '1. bookings 只能引用给定行程里出现过的 poiId，不得新增地点。',
    '   不确定要不要预约的宁可不写 —— 一份短而准的清单比一份长而可疑的清单有用。',
    '2. 放票时间、提前天数这类**具体事实**，只有你确实知道时才写数字；',
    '   不确定就把数字留空，在 note 里写清楚「去哪个官方渠道查」。',
    '   写一个看起来合理但实际错误的放票时间，比留空糟得多。',
    '3. transport 的结论必须从给出的实测数据里得出（每段的出行方式、距离、耗时，',
    '   以及标了 alt 的段还有另一种方式的对比）。不要凭城市印象下结论，数据里没有的不要说。',
    '4. emergency 只允许这些号码：全国通用的 110 / 120 / 119 / 122，',
    '   以及全国旅游服务热线 12301。**城市与景区的电话一律不要写具体数字**，',
    '   写成「出发前查 XX 官方公众号」。',
    '5. packing 要针对这一趟：季节与天气、同行的人、每天怎么走、去哪些类型的点。',
    '   不要用「身份证、手机、充电器」这类放之四海皆准的条目占位置 ——',
    '   每一条都要能说出「为什么是这一趟需要它」。',
    '6. tickets 逐个给出这次行程里去到的每个景点：免费还是收费、大概多少。',
    '   **价格只能给「大约」的整数**（「约 60 元」），并带上「以官方为准」；',
    '   拿不准的写「以官方公布为准」，宁可不给数字也不要给一个错的。',
    '   免费的就写「免费」，有条件的（如免费但需预约）一并说明。',
    '',
    '只输出 JSON，不要解释：',
    '{"bookings":[{"poiId":"","day":"YYYY-MM-DD","advance":0,"release":"HH:mm","level":"must|optional","channel":"","note":""}],' +
      '"tickets":[{"poiId":"","text":""}],' +
      '"packing":[{"group":"","items":[""]}],' +
      '"transport":{"summary":"","points":[""]},' +
      '"emergency":[{"label":"","value":"","note":""}]}'
  ].join('\n');
}

/**
 * 当地美食 Agent。
 *
 * 关键在「按动线推荐」而不是给一份「XX 必吃」：用户要的是
 * 「我 Day 2 下午在文庙一带，那里能吃什么」，不是一张和行程无关的榜单。
 * 所以 near 必须落在这次行程走过的地方上。
 */
function foodPrompt() {
  return [
    '你是当地美食 Agent。用户会照着这份清单去找吃的，所以只写你确实知道的。',
    '',
    '硬性要求：',
    '1. near 只能填这次行程里走过的地方（景点名或所在街区），',
    '   这样用户才知道自己什么时候顺路去 —— 与其给一份和行程无关的榜单，不如按动线来。',
    '2. 只写你确实知道的店与菜。店名不确定就只写「XX 一带的 XX」这类位置描述，',
    '   **不要编一个具体的店名** —— 不存在的店名会让人白跑一趟。',
    '3. 价格只给区间且标明「大约」，不要精确到个位的数字。',
    '4. 不要写「当地特色小吃」这种放之四海皆准的话，',
    '   每条都要能说出「为什么是这一带、这个时间吃它」。',
    '5. 覆盖行程里的主要区域，4—8 条即可，宁可少而准。',
    '',
    '只输出 JSON：{"summary":"","items":[{"near":"","place":"","dish":"","note":""}]}'
  ].join('\n');
}

/** 可以做应急电话的唯一白名单；其余号码一律视为编造 */
const ALLOWED_PHONES = new Set(['110', '120', '119', '122', '12301', '12308']);

/**
 * 抹掉编造的电话号码。
 *
 * 提示词里说了「不要编城市电话」，但模型仍可能给出一串像模像样的号码 ——
 * 那种错误最危险：用户真的会去打。所以这里做硬校验：
 * 一旦发现非白名单的长号码，整条 value 换成「去官方渠道查」，
 * 宁可少给信息，也不给一个打不通或打错的号。
 */
function stripFabricatedPhone(text) {
  const value = String(text || '');
  const candidates = value.match(/\d[\d\s-]{6,}\d/g) || [];
  const bad = candidates.filter((raw) => !ALLOWED_PHONES.has(raw.replace(/[\s-]/g, '')));
  if (bad.length) {
    logWarn('[规划服务] 行前准备里出现了疑似编造的电话号码，已替换：', bad[0]);
    return '出发前查官方渠道';
  }
  return value;
}

/** 行前准备的清洗：把不可信的内容挡在产物之外 */
function sanitizePrep(raw, plan, request) {
  const poiIds = new Set(Object.keys(plan.poi || {}));
  const dayByPoi = new Map();
  (plan.days || []).forEach((day) => {
    (day.visits || []).forEach((visit) => {
      if (visit.poiId && !dayByPoi.has(visit.poiId)) dayByPoi.set(visit.poiId, day.date);
    });
  });

  const bookings = (Array.isArray(raw?.bookings) ? raw.bookings : [])
    // 只留行程里真的有的地点 —— 模型编一个不存在的 poiId，前端的预约倒计时会找不到那天的行程
    .filter((item) => item && poiIds.has(cleanText(item.poiId, 80)))
    .slice(0, 8)
    .map((item) => {
      const poiId = cleanText(item.poiId, 80);
      const advance = Number(item.advance);
      const release = /^\d{1,2}:\d{2}$/.test(item.release || '') ? item.release : '';
      return {
        poiId,
        day: /^\d{4}-\d{2}-\d{2}$/.test(item.day || '') ? item.day : dayByPoi.get(poiId) || request.startDate,
        // advance 与 release 要么都给、要么都不给：只给一半算不出放票时刻
        ...(Number.isFinite(advance) && advance > 0 && release ? { advance: Math.min(90, Math.round(advance)), release } : {}),
        level: item.level === 'optional' ? 'optional' : 'must',
        channel: cleanText(item.channel, 120) || '官方渠道',
        note: cleanText(item.note, 300)
      };
    });

  // 门票：只保留这次行程里去到的点。
  // 价格是硬事实，编错了没人兜得住，所以除了提示词里的「只能给大约」，
  // 这里再补一道：出现了具体数字却没有限定词，程序化加上「以官方为准」。
  const tickets = (Array.isArray(raw?.tickets) ? raw.tickets : [])
    .filter((item) => item && poiIds.has(cleanText(item.poiId, 80)))
    .slice(0, 40)
    .map((item) => ({
      poiId: cleanText(item.poiId, 80),
      text: hedgePrice(cleanText(item.text, 80))
    }))
    .filter((item) => item.text);

  const packing = (Array.isArray(raw?.packing) ? raw.packing : [])
    .slice(0, 5)
    .map((group) => ({
      group: cleanText(group?.group, 30) || '其它',
      items: (Array.isArray(group?.items) ? group.items : [])
        .map((x) => cleanText(x, 120))
        .filter(Boolean)
        .slice(0, 6)
    }))
    .filter((group) => group.items.length);

  const transport = {
    summary: cleanText(raw?.transport?.summary, 300),
    points: (Array.isArray(raw?.transport?.points) ? raw.transport.points : [])
      .map((x) => cleanText(x, 240))
      .filter(Boolean)
      .slice(0, 6)
  };

  const emergency = (Array.isArray(raw?.emergency) ? raw.emergency : [])
    .slice(0, 8)
    .map((item) => ({
      label: cleanText(item?.label, 40),
      value: stripFabricatedPhone(cleanText(item?.value, 120)),
      note: cleanText(item?.note, 200)
    }))
    .filter((item) => item.label && item.value);

  return {
    bookings,
    tickets,
    packing,
    transport: transport.summary || transport.points.length ? transport : { summary: '', points: [] },
    emergency
  };
}

/**
 * 给没带限定词的价格补上「以官方为准」。
 *
 * 门票价格是会被用户当真的数字。模型给了「60 元」却没说是大约的，
 * 界面读起来就像挂牌价 —— 补一句限定，成本极低，但避免了「到了现场发现不是这个数」。
 */
function hedgePrice(text) {
  const value = String(text || '');
  // 免费 / 无需门票这类不含价格的说法不用管
  if (!/\d/.test(value)) return value;
  if (/约|大约|左右|起|以官方|以现场|为准|不确定|待定/.test(value)) return value;
  return `${value}（以官方为准）`;
}

/** 美食推荐：near 是自由文本，只做长度与条数约束；店名是否真实由提示词与用户判断 */
function sanitizeFood(raw) {
  const items = (Array.isArray(raw?.items) ? raw.items : [])
    .slice(0, 10)
    .map((item) => ({
      near: cleanText(item?.near, 40),
      place: cleanText(item?.place, 60),
      dish: cleanText(item?.dish, 60),
      note: cleanText(item?.note, 160)
    }))
    // 地点和吃食至少要有一样，否则这一条读起来是空的
    .filter((item) => item.dish && (item.place || item.near));

  return { summary: cleanText(raw?.summary, 300), items };
}

/** 喂给行前准备 Agent 的行程事实。交通那段必须来自实测，不能让它猜 */
function prepPayload(plan, request) {
  const poiName = (id) => (plan.poi[id] && plan.poi[id].name) || id;

  const days = (plan.days || []).map((day) => ({
    label: day.label,
    date: day.date,
    title: day.title,
    summary: day.summary,
    visits: (day.visits || []).map((visit) => {
      const poi = plan.poi[visit.poiId] || {};
      return {
        // poiId 必须给：bookings 与 tickets 都要按它引用，服务端也会拿它校验。
        // 不给的话模型只能编一个 id 或用名字，产物会被校验整批丢掉。
        poiId: visit.poiId,
        name: poi.name || visit.title,
        kind: poi.kind,
        address: poi.address,
        time: visit.time,
        stay: visit.stay,
        mode: visit.mode
      };
    })
  }));

  const legs = (plan.routes?.legs || []).map((leg) => {
    const main = leg.modes[leg.primary] || {};
    const altMode = Object.keys(leg.modes).find((m) => m !== leg.primary);
    const alt = altMode ? leg.modes[altMode] : null;
    return {
      day: leg.dayId,
      from: poiName(leg.from),
      to: poiName(leg.to),
      mode: leg.primary,
      distance: Math.round(main.distance || 0),
      duration: Math.round(main.duration || 0),
      ...(alt ? { alt: { mode: altMode, distance: Math.round(alt.distance || 0), duration: Math.round(alt.duration || 0) } } : {})
    };
  });

  const sum = plan.routes?.summary || {};
  return {
    request: describeRequest(request),
    days,
    legs,
    totals: { days: days.length, legs: legs.length, estimatedLegs: sum.estimatedLegs || 0 }
  };
}

async function callModel(messages, model, key) {
  const response = await fetch(DEEPSEEK_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      max_tokens: 12000,
      thinking: { type: 'disabled' }
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message || `DeepSeek 返回 ${response.status}`);
    error.status = response.status || 422;
    throw error;
  }
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    const detail = body.error?.message || body.choices?.[0]?.finish_reason || '响应内容为空';
    const error = new Error(`DeepSeek 没有返回规划内容：${detail}`);
    error.status = response.status;
    throw error;
  }
  return content;
}

async function callAgent(prompt, payload, config) {
  const messages = [
    { role: 'system', content: prompt },
    { role: 'user', content: JSON.stringify(payload, null, 2) }
  ];
  try {
    return parseJson(await callModel(messages, config.model, config.key));
  } catch (error) {
    if (config.model === config.fallbackModel || ![400, 404, 422].includes(error.status)) throw error;
    return parseJson(await callModel(messages, config.fallbackModel, config.key));
  }
}

function parseJson(content) {
  const text = String(content).trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型返回的不是有效 JSON');
  return JSON.parse(text.slice(start, end + 1));
}

function haversineMeters(a, b) {
  const R = 6371000;
  const rad = (n) => (n * Math.PI) / 180;
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function normalizeMode(mode) {
  return ['driving', 'transit', 'walking'].includes(mode) ? mode : 'driving';
}

/* ------------------------------------------------------------------ */
/* 高德请求限速                                                        */
/* ------------------------------------------------------------------ */

/**
 * 并发 + 速率双闸门。
 *
 * 只限并发是不够的：高德接口常在两三百毫秒内返回，几个在途实际能跑到 6~10 QPS，
 * 超过个人 key 约 3 QPS 的限制就会被限流。而被限流的后果在两条链路上都很隐蔽：
 *   · 检索 —— 失败的关键词被 catch 成空数组，候选池悄悄变小，
 *     最终表现成「后面几天没景点可排」，完全看不出是限流引起的；
 *   · 算路 —— 本该有真实路径的段降级成直线。
 * 所以并发之外再补一层最小间隔，把发起速率压回限流线以内。
 *
 * scripts/route.js 里那份是浏览器 IIFE、这里是 Node，没有构建步骤可以共用模块，
 * 所以各自保留一份小实现。
 */
function createLimiter({ concurrency, minInterval }) {
  let inFlight = 0;
  const waiting = [];
  let lastStart = 0;
  // 节流串成一条链：同时进来的几个若各自算等待时间，会算出同样的值一起发出去
  let pace = Promise.resolve();

  function acquire() {
    if (inFlight < concurrency) {
      inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next) next(); // 名额直接转交，inFlight 不变
    else inFlight--;
  }

  function waitTurn() {
    pace = pace.then(async () => {
      const wait = lastStart + minInterval - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastStart = Date.now();
    });
    return pace;
  }

  /**
   * 跑一次受闸门保护的请求。
   * @param {Function} task
   * @param {Function} [skipIf] 拿到名额后、等待节流前再判一次；返回 true 则直接
   *        返回 undefined，既不执行 task 也不占用一个节流名额。
   *        算路用它来「超预算就别再排队了」，否则后面几十段会白等一轮节流。
   */
  async function run(task, skipIf) {
    await acquire();
    try {
      if (skipIf && skipIf()) return undefined;
      await waitTurn();
      return await task();
    } finally {
      release();
    }
  }

  return { run };
}

/**
 * CUQPS_HAS_EXCEEDED_THE_LIMIT 里的 CU 是 concurrent —— 它是**并发**限制，
 * 不是纯速率限制。实测并发 2 就会撞上（个人 key 的并发额度比文档写的 QPS 紧），
 * 所以这里一律串行，只用最小间隔控速。
 *
 * 两处都串行的代价是算路阶段变慢，但换来的是不再静默丢数据：
 * 检索丢一个关键词就少一批候选，算路丢一段就得多画一条直线。
 */
/** 检索：十个关键词，串行 + 400ms */
const searchLimiter = createLimiter({ concurrency: 1, minInterval: 400 });
/** 算路：路段数最多，间隔可以小一些，但仍串行 */
const routeLimiter = createLimiter({ concurrency: 1, minInterval: 250 });

/**
 * 限流是瞬时故障，退避重试通常就过了。
 * 不重试的代价很实在：检索少一批候选、算路多一条假直线，用户都看不出来源。
 * 只重试两次 —— 真挂了重试多少次都一样，不能把接口无限拖下去。
 */
const RETRY_DELAYS_MS = [600, 1600];

async function runWithRateRetry(limiter, task, label, skipIf) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await limiter.run(task, skipIf);
    } catch (error) {
      const retriable = /CUQPS|LIMIT|QUOTA|ENGINE_RESPONSE_DATA_ERROR/i.test(error.message);
      if (attempt >= RETRY_DELAYS_MS.length || !retriable) throw error;
      logWarn(`[规划服务] ${label} 被限流（${error.message}），${RETRY_DELAYS_MS[attempt]}ms 后第 ${attempt + 2} 次尝试`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

/* ------------------------------------------------------------------ */
/* 路段算路：距离与耗时以高德返回的真实路径为准                            */
/* ------------------------------------------------------------------ */

/**
 * 算路阶段的总预算。路段数随天数增长，14 天最多能有数十条，
 * 只靠单条超时兜不住总时长；超预算的段直接估算，保证接口在可预期时间内返回
 * （最坏情况 = 预算 + 在途那几条自己的超时）。
 */
const ROUTE_BUDGET_MS = 20000;

/**
 * 取距离与耗时并校验。
 * 高德字段缺失时给的是空串或 undefined，Number() 会变成 0 / NaN ——
 * 那样会被当成真实路径存下来，前端就会显示「NaN 小时」且不带任何估算提示。
 */
function routeMetrics(source) {
  const distance = Number(source && source.distance);
  const duration = Number(source && source.duration);
  if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('高德返回的距离或耗时不可用');
  }
  return { distance, duration };
}

/** 调高德算路接口取真实距离（米）与耗时（秒）。没有方案时抛错，由调用方决定降级 */
async function fetchRoute(from, to, mode, city, key) {
  const origin = from.join(',');
  const destination = to.join(',');

  if (mode === 'walking') {
    const body = await amapGet('/v3/direction/walking', { origin, destination }, key, ROUTE_TIMEOUT_MS);
    const path = body.route && body.route.paths && body.route.paths[0];
    if (!path) throw new Error('无步行路径');
    return routeMetrics(path);
  }

  if (mode === 'transit') {
    // 公交算路必须带城市，否则高德会按全国路网给结果
    const target = city || '武汉';
    const body = await amapGet(
      '/v3/direction/transit/integrated',
      { origin, destination, city: target, cityd: target, strategy: 0 },
      key,
      ROUTE_TIMEOUT_MS
    );
    const transit = body.route && body.route.transits && body.route.transits[0];
    if (!transit) throw new Error('无公交方案');
    return routeMetrics(transit);
  }

  // 与 tools/generate-routes.js 用同一个 strategy，保证 AI 规划与静态数据的口径一致
  const body = await amapGet(
    '/v3/direction/driving',
    { origin, destination, strategy: 10, extensions: 'base' },
    key,
    ROUTE_TIMEOUT_MS
  );
  const path = body.route && body.route.paths && body.route.paths[0];
  if (!path) throw new Error('无驾车路径');
  return routeMetrics(path);
}

/**
 * 「打车还是地铁」只对一部分段才有讨论价值：
 * 主方式是打车、且距离足够长，才谈得上选哪种。
 * 太近的段本来就走过去，单独补算一次公交只是白烧配额。
 */
const COMPARE_MIN_METERS = 1500;

/**
 * 取一段路的数据：优先真实算路，失败才退回估算。
function estimateLeg(from, to, mode) {
  const distance = Math.round(haversineMeters(from, to));
  const kmh = FALLBACK_SPEED[mode] || FALLBACK_SPEED.driving;
  return {
    distance,
    duration: Math.max(60, Math.round((distance / 1000 / kmh) * 3600)),
    estimated: true
  };
}

/**
 * 取一段路的数据：优先真实算路，失败才退回估算。
 *
 * 缓存挂在 ctx 上、随一次 plan() 一起结束 —— 算路耗时含实时路况，
 * 留在模块级就会跨请求复用，隔几小时再规划时拿到的可能是早高峰的数字。
 * 只有成功结果进缓存：把降级出来的估算也存下去，同一次规划里就再没机会取回真实路径。
 */
async function legMetrics(from, to, mode, ctx) {
  const cacheKey = `${mode}|${from.join(',')}|${to.join(',')}`;
  const cached = ctx.cache.get(cacheKey);
  if (cached) return cached;

  try {
    // 排队等名额期间可能已超预算，这时候不该再发请求、也不该再占节流名额
    const metrics = await runWithRateRetry(
      routeLimiter,
      () => fetchRoute(from, to, mode, ctx.city, ctx.key),
      `${mode} 算路`,
      () => Date.now() >= ctx.deadline
    );
    if (!metrics) return estimateLeg(from, to, mode);

    ctx.cache.set(cacheKey, metrics);
    return metrics;
  } catch (error) {
    logWarn(`[规划服务] ${mode} 算路失败，该段退回直线估算：`, error.message);
    return estimateLeg(from, to, mode);
  }
}

/**
 * 为每天相邻的两点补齐路段数据。
 *
 * 只算 primary 那一种方式：时间轴、地图、总路程统计读的都只有 primary，
 * 把三种方式都算一遍要多发两倍请求，撞上 QPS 限制反而更容易降级成直线。
 */
async function makeRoutes(days, poiById, city, hardDeadline = Infinity) {
  const locations = {};
  const pairs = [];

  Object.values(poiById).forEach((item) => {
    if (Array.isArray(item.coords)) locations[item.id] = { coords: item.coords, formattedAddress: item.address || item.name };
  });

  days.forEach((day) => {
    const visits = Array.isArray(day.visits) ? day.visits : [];
    const located = visits.map((visit, visitIndex) => ({ visit, visitIndex, poi: poiById[visit.poiId] })).filter((x) => x.poi && Array.isArray(x.poi.coords));
    for (let i = 0; i < located.length - 1; i++) {
      const from = located[i];
      const to = located[i + 1];
      pairs.push({
        dayId: day.id,
        fromIndex: from.visitIndex,
        from: from.poi,
        to: to.poi,
        // 出行方式记在「到达」那个点上：从 A 到 B 用哪种方式由 B 决定
        primary: normalizeMode(to.visit.mode)
      });
    }
  });

  // 一起发出去、由闸门与节流统一压速率；Promise.all 保序，路段顺序仍与行程一致
  const ctx = {
    city,
    key: plannerConfig().amapKey,
    cache: new Map(),
    // 算路自己的预算和整个规划的预算取更紧的那个：规划快超时了就别再逐段算了
    deadline: Math.min(Date.now() + ROUTE_BUDGET_MS, hardDeadline)
  };
  const legs = await Promise.all(
    pairs.map(async (pair) => {
      const primary = await legMetrics(pair.from.coords, pair.to.coords, pair.primary, ctx);
      const modes = { [pair.primary]: primary };

      // 「打车还是地铁」只有够长的打车段才谈得上是个选择。
      // 这里补算一次公交，给行前准备 Agent 一份真实对比 ——
      // 否则它只能凭城市印象下结论，那正是这个功能最该避免的。
      // 公交算不出来（短途、景区周边很常见）就只留主方式，不编。
      if (pair.primary === 'driving' && (primary.distance || 0) >= COMPARE_MIN_METERS) {
        const transit = await legMetrics(pair.from.coords, pair.to.coords, 'transit', ctx).catch(() => null);
        if (transit && !transit.estimated) modes.transit = transit;
      }

      return {
        dayId: pair.dayId,
        fromIndex: pair.fromIndex,
        from: pair.from.id,
        to: pair.to.id,
        primary: pair.primary,
        modes
      };
    })
  );

  const estimatedLegs = legs.filter((leg) => Object.values(leg.modes).some((m) => m.estimated)).length;
  return {
    generatedAt: new Date().toISOString(),
    summary: { days: days.length, legs: legs.length, estimatedLegs, pendingLocations: [] },
    locations,
    legs
  };
}

async function sanitizePlan(raw, request, allPoi, ctx = {}) {
  const emit = ctx.emit || (() => {});
  const pickedIds = ctx.pickedIds || new Set();

  const poiById = Object.fromEntries(allPoi.map((item) => [item.id, item]));
  const days = Array.isArray(raw?.days) ? raw.days.slice(0, request.days) : [];
  if (!days.length) throw new Error('模型没有生成任何行程日');

  const safeDays = days.map((day, index) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(day.date) ? day.date : addDays(request.startDate, index);
    const visits = Array.isArray(day.visits) ? day.visits : [];
    return {
      // id 一律由下标生成，不采用模型给的值：id 是路线段的关联键、也是每日主题色的
      // 取值依据，模型返回 "Day1" / "d1" / 中文 这类变体时，以前会静默失配
      // （所有天塌成同一个颜色、路线段对不上），既难查也没有报错。
      // label 早就是这个口径，这里跟它对齐。
      id: `day${index + 1}`,
      index: index + 1,
      label: cleanText(day.label, 20) || `Day ${index + 1}`,
      date,
      dateText: cleanText(day.dateText, 30) || date,
      title: cleanText(day.title, 80) || `${request.city} 第 ${index + 1} 天`,
      summary: cleanText(day.summary, 300),
      visits: visits.map((visit) => {
        const poiId = cleanText(visit.poiId, 80);
        if (!poiById[poiId]) return null;
        return {
          poiId,
          time: /^\d{1,2}:\d{2}/.test(visit.time) ? visit.time : '10:00',
          title: cleanText(visit.title, 100) || poiById[poiId].name,
          desc: cleanText(visit.desc, 500),
          stay: cleanText(visit.stay, 40),
          mode: normalizeMode(visit.mode),
          advice: cleanText(visit.advice, 180),
          hot: Boolean(visit.hot)
        };
      }).filter(Boolean)
    };
  });

  const selectedIds = new Set(safeDays.flatMap((day) => day.visits.map((visit) => visit.poiId)));

  // 备选池：**全部**检索到的点都要留着，不能只留排进行程的那些。
  // 编辑模式靠它回答「这一天还能加什么」，只留用过的就等于没有备选。
  // picked 标出哪些进过筛选 Agent 的候选 —— 那些是过了质量关的，
  // 候选面板会把它们排在前面，其余算是「检索到了但没被看中」。
  const poi = {};
  allPoi.forEach((item) => {
    poi[item.id] = ctx.pickedIds.has(item.id) ? { ...item, picked: true } : item;
  });

  // 算路是这里最重的一步（每段一次高德请求），所以单独成一阶段。
  // 它的耗时上限还要受整个规划的预算约束，不能自己跑满 20 秒。
  // 传全量 poi：makeRoutes 顺带建出 locations，而编辑模式要按它定位新加的点
  const routes = await stage(
    'routes',
    ctx.emit,
    () => makeRoutes(safeDays, poi, request.city, ctx.deadline),
    (out) => ({ legs: out.legs.length, estimatedLegs: out.summary.estimatedLegs })
  );

  // 估算出来的路段在时间轴上是逐段标了的，但整次规划是否大面积降级只有服务端知道，
  // 不汇总一条出来，用户看到的就是「和平时一样成功」
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.map((x) => cleanText(x, 240)).filter(Boolean).slice(0, 12) : [];
  if (routes.summary.estimatedLegs) {
    warnings.push(`有 ${routes.summary.estimatedLegs} 段路线没取到高德实时路径，按直线距离估算，出发前请再核对一次。`);
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    city: request.city,
    // 城市编码随产物回传，前端据此换天气与公交的城市参数
    citycode: request.citycode || '',
    adcode: request.adcode || '',
    startDate: request.startDate,
    endDate: request.endDate,
    days: safeDays,
    poi,
    routes,
    warnings: warnings.slice(0, 12),
    model: plannerConfig().model
  };
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * @param {object} input 表单请求
 * @param {Function} [onStage] 阶段回调，收 { stage, status, ms, detail? }。
 *        上报失败绝不能影响规划本身，所以这里整条包了 try。
 */
async function plan(input, onStage, options) {
  const emit = (event) => {
    if (typeof onStage !== 'function') return;
    try {
      onStage(event);
    } catch (error) {
      logWarn('[规划服务] 阶段上报失败（不影响规划）：', error && error.message);
    }
  };

  const request = normalizeRequest(input);
  const config = plannerConfig(options);
  // 走到这里还取不到 key，只可能是全局那份也没配 ——
  // 「用户自己的 key 解不开」那种情况由路由层提前拦住，不会进到这个函数
  if (!config.key) throw new Error('服务端未配置 DeepSeek API Key');

  const deadline = Date.now() + PLAN_BUDGET_MS;

  // 目录与城市编码互不依赖，并行取，对外算同一个阶段
  const [items, cityMeta] = await stage(
    'discover',
    emit,
    () => Promise.all([discoverCatalog(request, config), resolveCityMeta(request.city, config.amapKey)]),
    ([list, meta]) => ({
      count: list.length,
      // 城市中心与全部候选点的坐标：首页要先把地图飞到这座城市，
      // 再把这些点撒上去 —— 这一步的「可视化」就是真实的检索结果。
      // citycode 一并给出：首页后面要用它去算公交段（默认值会是武汉的 027）
      city: meta.coords,
      citycode: meta.citycode,
      pois: list.map((item) => ({
        id: item.id,
        name: item.name,
        lng: item.coords[0],
        lat: item.coords[1]
      }))
    })
  );
  const base = { request, poiCatalog: items };

  const selection = await stage(
    'select',
    emit,
    () => callAgent(selectionPrompt(), base, config),
    // 把留下的 id 也给出去：首页那一拍要「大多数退场、少数留亮」
    (out) => {
      const ids = Array.isArray(out.selectedPoiIds) ? out.selectedPoiIds : [];
      return { count: ids.length, ids };
    }
  );
  const selectedIds = Array.isArray(selection.selectedPoiIds)
    ? selection.selectedPoiIds.filter((id) => items.some((item) => item.id === id))
    : [];
  const selected = selectedIds.length ? items.filter((item) => selectedIds.includes(item.id)) : items;

  const draft = await stage(
    'schedule',
    emit,
    () => callAgent(schedulePrompt(), {
      request,
      candidatePoiCatalog: selected,
      selectionNotes: selection.notes || []
    }, config),
    // 每天按时间顺序的点与出行方式：首页拿它把点连成当日路线（用当天主题色），
    // 后面还能按 mode 去高德换成真实道路几何
    (out) => ({
      days: Array.isArray(out.days) ? out.days.length : 0,
      order: Array.isArray(out.days)
        ? out.days.map((day) =>
            Array.isArray(day.visits)
              ? day.visits
                  .filter((v) => v.poiId)
                  .map((v) => ({ id: v.poiId, mode: normalizeMode(v.mode) }))
              : []
          )
        : []
    })
  );

  // 审校 Agent 只接收草案和候选目录，避免它绕开第一阶段重新发散。
  let reviewed = draft;
  // 剩余时间还够跑一次审校才跑（别把 > 和 < 写反：写反了会永远跳过审校）
  if (deadline - Date.now() >= REVIEW_MIN_REMAINING_MS) {
    try {
      reviewed = await stage('review', emit, () => callAgent(reviewPrompt(), {
        request,
        candidatePoiIds: selected.map((item) => item.id),
        draft
      }, config));
    } catch (error) {
      // 审校失败不该让整单失败：草案本身是可用的
      logWarn('[规划服务] 审校 Agent 失败，使用排程结果：', error.message);
    }
  } else {
    // 报 skipped 而不是假装没这个阶段：前端要能区分「审校过了」和「时间不够跳过了」
    emit({ stage: 'review', status: 'skipped', message: '时间预算不足，跳过审校' });
  }

  // cityMeta 只给产物用，不进模型上下文：模型不需要城市编码，多给只是白烧 token
  const result = await sanitizePlan(reviewed, { ...request, ...cityMeta }, items, {
    emit,
    deadline,
    // 筛选 Agent 挑过的候选：进入产物时会标成 picked，供备选面板排序
    pickedIds: new Set(selected.map((item) => item.id))
  });

  // 美食与行前准备都只依赖最终行程与实测路况，**彼此之间没有先后**，
  // 所以并行跑：省下较短那个的时间（实测 33.2s → 28s）。
  // 两个 Agent 打的是同一个 DeepSeek key，但那是两条独立的请求，不互相排队。
  //
  // 时间不够就跳过 —— 行程本身已经可用了，不该为了附加内容把整单拖过时限。
  // 两个 Agent 的输入完全相同，只算一次
  const agentInput = prepPayload(result, request);
  const hasBudget = deadline - Date.now() >= PREP_MIN_REMAINING_MS;

  const runFood = async () => {
    if (!hasBudget) {
      emit({ stage: 'food', status: 'skipped', message: '时间预算不足，跳过美食推荐' });
      return;
    }
    try {
      const raw = await stage(
        'food',
        emit,
        () => callAgent(foodPrompt(), agentInput, config),
        (out) => ({ items: Array.isArray(out.items) ? out.items.length : 0 })
      );
      result.food = sanitizeFood(raw);
    } catch (error) {
      logWarn('[规划服务] 美食 Agent 失败，这次不带当地美食推荐：', error.message);
      emit({ stage: 'food', status: 'skipped', message: `美食推荐失败：${error.message}` });
    }
  };

  const runPrep = async () => {
    if (!hasBudget) {
      emit({ stage: 'prep', status: 'skipped', message: '时间预算不足，跳过行前准备' });
      return;
    }
    try {
      const raw = await stage(
        'prep',
        emit,
        () => callAgent(prepPrompt(), agentInput, config),
        (out) => ({
          bookings: Array.isArray(out.bookings) ? out.bookings.length : 0,
          packing: Array.isArray(out.packing) ? out.packing.length : 0
        })
      );
      result.prep = sanitizePrep(raw, result, request);
    } catch (error) {
      logWarn('[规划服务] 行前准备 Agent 失败，这次不带定制清单：', error.message);
      emit({ stage: 'prep', status: 'skipped', message: `行前准备失败：${error.message}` });
    }
  };

  await Promise.all([runFood(), runPrep()]);

  return result;
}

module.exports = { plan, plannerConfig };
