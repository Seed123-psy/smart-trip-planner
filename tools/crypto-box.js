/**
 * 口令散列与密钥信封。
 *
 * 两块内容放一个文件，是因为它们回答的是同一个问题：**什么东西可以明文落库**。
 * 答案是什么都不可以 —— 口令只存散列，用户密钥只存密文。
 *
 * 只用 node:crypto，不引 bcrypt / argon2 / jsonwebtoken。这个项目至今零 npm 依赖，
 * 而 scrypt 是 Node 内置里唯一被公认适合存口令的 KDF（PBKDF2 抗 GPU 弱得多，
 * 内置的 SHA 系列更是完全不能用）。
 */

'use strict';

const crypto = require('crypto');

/* ============ 一、口令散列 ============ */

/**
 * scrypt 参数。N 是 CPU/内存开销的主旋钮。
 *
 * 16384 是 2026 年还能接受的**下限**，不是理想值。选它是因为这个站点跑在
 * 一台老机器上：单次约 42ms，登录接口能扛住，而 N 再翻倍就会让登录明显变慢。
 * 将来机器换好了，把 N 调大即可 —— 参数写在每条散列串里，老用户用各自记录
 * 里的参数校验，登录成功后由 needsRehash() 提示顺带升级，不会把人锁在门外。
 */
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;
const SALT_LEN = 16;

/**
 * 必须显式给 maxmem。Node 默认 32MB，而 scrypt 需要约 128*N*r = 16MB，
 * 看着够用，但只要有人把 N 调到 32768 就会撞上默认上限并抛错 ——
 * 那时错误信息是「memory limit exceeded」，和「密码不对」长得完全不一样，
 * 排查时容易往错的方向找。给足余量，让调参只受机器性能限制。
 */
const MAXMEM = 128 * 1024 * 1024;

const PREFIX = 'scrypt';

function scryptAsync(password, salt, keylen, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM },
      (error, derived) => (error ? reject(error) : resolve(derived))
    );
  });
}

/**
 * 生成口令散列，格式：scrypt$N$r$p$salt$hash
 *
 * 参数写进串里而不是只存在代码里，是为了让「以后调高 N」不需要一次性重算
 * 全库 —— 老用户下次登录时按记录里的参数校验，校验通过再顺手升级。
 *
 * 【为什么是异步】scryptSync 一次约 42ms，期间事件循环完全停住。
 * 100 个并发登录就是全站卡死 4.2 秒，而它同时还会打断 /api/plan 的 SSE 心跳。
 * 这既是可用性问题，本身也是一个拒绝服务面。异步版走线程池，不占事件循环。
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const derived = await scryptAsync(password, salt, KEYLEN, SCRYPT);
  return [
    PREFIX,
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    derived.toString('base64')
  ].join('$');
}

/** 拆散列串。形状不对返回 null —— 库里被手改坏了不该让服务抛异常 */
function parseHash(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;

  const [, n, r, p, salt, hash] = parts;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return null;
  if (params.N <= 1 || params.r <= 0 || params.p <= 0) return null;

  let saltBuf;
  let hashBuf;
  try {
    saltBuf = Buffer.from(salt, 'base64');
    hashBuf = Buffer.from(hash, 'base64');
  } catch {
    return null;
  }
  if (!saltBuf.length || !hashBuf.length) return null;

  return { params, salt: saltBuf, hash: hashBuf };
}

/**
 * 校验口令。
 *
 * 用 timingSafeEqual 而不是 === ：字符串比较会在第一个不同的字节停下，
 * 那个时间差足以让人逐字节猜出散列。timingSafeEqual 要求两边等长，
 * 所以先比长度 —— 长度不是秘密，泄露它没有意义。
 */
async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;

  const derived = await scryptAsync(password, parsed.salt, parsed.hash.length, parsed.params);
  if (derived.length !== parsed.hash.length) return false;
  return crypto.timingSafeEqual(derived, parsed.hash);
}

/** 散列是不是用当前参数算的。不是的话，登录成功后应该顺手重算一遍 */
function needsRehash(stored) {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return parsed.params.N !== SCRYPT.N || parsed.params.r !== SCRYPT.r || parsed.params.p !== SCRYPT.p;
}

/* ---------- 防时序枚举 ---------- */

let dummyHash = null;

/**
 * 用户名不存在时也要花掉一次 scrypt 的时间。
 *
 * 不这么做的话，「查无此人」会立刻返回，而「密码错误」要等 42ms ——
 * 攻击者据此就能把「哪些用户名存在」扫出来，之后再针对性地爆破。
 * 这里对一个固定口令跑一次真实校验，把两条路径的耗时拉平。
 *
 * 懒算并缓存：模块加载时算会平白拖慢启动，而第一次需要它的时候
 * 本来就在处理一个登录请求，多这 42ms 无感。
 */
async function burnPasswordTime() {
  if (!dummyHash) dummyHash = await hashPassword('timing-equalizer');
  await verifyPassword('timing-equalizer', dummyHash);
}

/* ============ 二、密钥信封（AES-256-GCM） ============ */

const AAD_SALT = 'wuhan-trip/key-envelope/v1';
const IV_LEN = 12; // GCM 的标准长度，96 位
const ENVELOPE_VERSION = 'v1';

let cachedKey = null;

/**
 * 取主密钥，由 APP_SECRET 派生。
 *
 * 没配 APP_SECRET 时返回 null —— **不抛异常**。用户自配密钥是整个站点的一项
 * 功能，不该因为没配它就让站点起不来：没有它的时候，自配密钥功能停用，
 * 其余部分（包括用全局 key 规划）照常工作。这个取舍是有意的，见 serve.js 的启动自检。
 *
 * 用 HKDF 派生而不是直接哈希 APP_SECRET：HKDF 是标准的「从一段密钥材料
 * 导出用途明确的子密钥」的做法，将来需要第二把密钥（比如签 token）时，
 * 换个 info 就能得到互不相关的另一把，不用把 APP_SECRET 换掉。
 */
function masterKey() {
  if (cachedKey) return cachedKey;
  const secret = (process.env.APP_SECRET || '').trim();
  if (!secret) return null;
  cachedKey = Buffer.from(crypto.hkdfSync('sha256', secret, AAD_SALT, 'deepseek-key', 32));
  return cachedKey;
}

/** 自配密钥功能是否可用 */
function encryptionAvailable() {
  return masterKey() !== null;
}

/**
 * 封装一段明文，返回 v1.<iv>.<tag>.<ct>（三段都是 base64url）。
 *
 * aad 会被绑进认证标签，调用方各自给一串**能唯一标识「这段密文属于哪个位置」**
 * 的值。目前有两种形态，前缀刻意不重叠：
 *   · `u:<userId>`        —— 用户自己的 DeepSeek 密钥（tools/user-keys.js）
 *   · `setting:<键名>`    —— settings 表里的服务端密钥（tools/settings.js）
 *
 * 于是把 A 的密文粘到 B 的位置上也解不开 —— 包括跨这两类搬（把设置项的密文
 * 塞进某个用户的行里）。少了这一条，一个能写库的人（或者一次误操作）就能把
 * 别人的密钥搬到自己名下，然后「用别人的 key 规划」，而密文本身完好，
 * 系统完全看不出异常。
 */
function seal(plaintext, aad) {
  const key = masterKey();
  if (!key) throw new Error('未配置 APP_SECRET，无法加密');

  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(aad || ''), 'utf8'));

  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ct.toString('base64url')
  ].join('.');
}

/**
 * 解开信封。任何一步失败都返回 null，**绝不返回半截明文**。
 *
 * 调用方必须把 null 当成「解不开」来处理，而不是「没有配」——
 * 静默回落到全局 key 是明令禁止的：那会烧站长的额度，还让用户以为
 * 自己用的是自己的 key。
 */
function open(envelope, aad) {
  const key = masterKey();
  if (!key) return null;

  const parts = String(envelope || '').split('.');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) return null;

  let iv;
  let tag;
  let ct;
  try {
    iv = Buffer.from(parts[1], 'base64url');
    tag = Buffer.from(parts[2], 'base64url');
    ct = Buffer.from(parts[3], 'base64url');
  } catch {
    return null;
  }
  if (iv.length !== IV_LEN || tag.length !== 16) return null;

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(String(aad || ''), 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // 认证失败（密文被改、AAD 不匹配、密钥换过）都走这里
    return null;
  }
}

module.exports = {
  SCRYPT,
  hashPassword,
  verifyPassword,
  needsRehash,
  burnPasswordTime,
  encryptionAvailable,
  seal,
  open
};
