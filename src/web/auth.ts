import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/db.js";
import { ensureSetting } from "../db/settings.js";
import { resolveMemberRef, type MemberRow } from "../domain/members.js";
import type { Viewer } from "../domain/viewer.js";

/**
 * 查看页的成员登录与会话(设计方案 §6「查看页的加固」①②③)。
 *
 * ## 为什么口令与 token 是两套东西
 * MCP 侧的 family token 是**高熵随机串**(见 domain/auth.ts:只存 SHA-256 即可),
 * 查看页的口令是**家人自己挑的短口令** —— 低熵、可被字典猜到,所以:
 * - 口令一律 **scrypt**(node:crypto 自带,带盐)哈希后存 `member.web_password_hash`;
 * - **没有任何默认口令**:没设过口令的成员无法登录,页面提示"请让管理员先设置你的查看页密码";
 * - 连续失败**限速锁定**(见 LoginThrottle),防止对着一个弱口令穷举。
 *
 * ## 会话
 * 登录成功后下发**签名 cookie**(HttpOnly + SameSite=Lax + Path=/),内容是
 * `成员id.过期时刻.HMAC-SHA256(密钥, 前两段)`。密钥存库(setting 表,迁移 v4),
 * **首次启动随机生成**——不写死默认值,理由见迁移 v4 的注释。
 * 会话里**不放口令、不放成员名**,只放成员 id;服务端每次请求重新查库确认
 * 该成员未被软删、且口令仍存在(清口令 = 让既有会话一并失效)。
 *
 * ## 这一层不碰可见性
 * 登录只回答"你是谁"(→ Viewer),**能不能看哪些数据由 domain 层的同一个过滤层判定**
 * (src/domain/viewer.ts)。web 层不得、也没有任何一处重写 V1–V9。
 */

// ─────────────────────────── 口令哈希(scrypt) ───────────────────────────

/**
 * scrypt 参数。格式 `scrypt$N$r$p$keylen$salt_b64$hash_b64`,**参数随哈希一起存**:
 * 以后调参数(N/r/p 往上加)时旧口令仍能验,不必强制全员重设。
 *
 * - `SCRYPT_N = 16384 = 2^14`:CPU/内存成本。它乘以 r 决定内存占用(约 16 MB),
 *   也就是"猜一次口令要付出的代价"。家用机单次约几十毫秒,登录这种低频操作完全够用,
 *   而离线爆破整库时每次都要付这个代价。
 * - `r = 8`、`p = 1`:Node 默认值,保持不动;要调成本只调 N(内存与时间一起涨)。
 * - `keylen = 32` 字节(256 位):与 scrypt 的输出等长,没有截断。
 * - `salt = 16` 字节随机:**每个口令一份自己的盐**(同一口令两次哈希必然不同,
 *   彩虹表失效,库里一眼也看不出"这两个成员用了同一个口令")。
 * - `maxmem` 显式给到 64 MB:Node 的默认 32 MB 恰好卡在边缘,N 稍大就会以
 *   "内存不够"报错,宁可显式放宽。
 */
export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 32;
export const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** 校验从库里读出的参数,防止被篡改成"成本为 1 的 scrypt"这种自我设障的值。 */
const SCRYPT_N_LIMIT = 1 << 20;

function scryptKey(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Buffer {
  return scryptSync(password, salt, keylen, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
}

/** 口令 → 存库串。永不含明文。 */
export function hashWebPassword(password: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = scryptKey(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEYLEN);
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    SCRYPT_KEYLEN,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

/**
 * 校验口令。**任何形状不对一律按"不匹配"返回 false**,不抛异常:
 * 登录路径上抛异常会把内部格式变成 500 与错误信息,那是给攻击者的免费探针。
 */
export function verifyWebPassword(password: string, stored: string | null | undefined): boolean {
  if (stored === null || stored === undefined || stored === "") return false;
  const parts = stored.split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const keylen = Number(parts[4]);
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    !Number.isInteger(keylen) ||
    n < 2 ||
    n > SCRYPT_N_LIMIT ||
    (n & (n - 1)) !== 0 || // N 必须是 2 的幂(scrypt 的要求)
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16 ||
    keylen < 16 ||
    keylen > 64
  ) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[5]!, "base64");
    expected = Buffer.from(parts[6]!, "base64");
  } catch {
    return false;
  }
  if (expected.length !== keylen || salt.length === 0) return false;
  const actual = scryptKey(password, salt, n, r, p, keylen);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 管理入口:给成员设查看页口令(库中只留哈希)。明文只在调用方打印一次。 */
export function setMemberWebPassword(db: Db, memberId: string, password: string): void {
  db.prepare("UPDATE member SET web_password_hash = ? WHERE id = ?").run(hashWebPassword(password), memberId);
}

/** 管理入口:清掉查看页口令 —— 该成员**无法登录**,已有的会话也一并作废(见 viewerFromSession)。 */
export function clearMemberWebPassword(db: Db, memberId: string): void {
  db.prepare("UPDATE member SET web_password_hash = NULL WHERE id = ?").run(memberId);
}

/**
 * 随机生成一个查看页口令(CLI 不给 `--password` 时用)。
 * 12 个 base64url 字符 ≈ 72 bit,家人抄得下来、旁人猜不到;
 * **只显示一次**,不打印进日志、不落库(落库的只有哈希)。
 */
export function generateWebPassword(): string {
  return randomBytes(9).toString("base64url");
}

// ─────────────────────────── 会话 cookie(签名 + 有效期) ───────────────────────────

/** 会话 cookie 名。带 `fa_` 前缀,避免与将来管理页/静态资源的 cookie 撞名。 */
export const SESSION_COOKIE_NAME = "fa_session";

/**
 * 会话有效期 = 12 小时(具名常量,便于可测)。
 * 为什么是 12 小时:家里的使用模式是"晚上看一眼明天的事",手机放一晚上;
 * 太短(1 小时)会让人在餐桌前反复登录,太长(一周)则意味着一次忘退出的手机
 * 在别人手里还能看一周的家务 —— 12 小时大致等于"睡一觉",过了就该重新证明身份。
 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** 签名密钥在 setting 表里的键名。删掉这一行即可让全部旧会话失效(轮换)。 */
export const SESSION_SECRET_KEY = "web_session_secret";
const SESSION_SECRET_BYTES = 32;

/**
 * 取会话签名密钥,不存在就随机生成一个写进库(迁移 v4 的 setting 表)。
 * 「没有就生成」这一步交给 `ensureSetting`:它用 INSERT OR IGNORE,
 * 两个进程同时首次启动时后写的那个**不覆盖**先写的 —— 覆盖会让先启动进程
 * 手里的会话签名密钥失效(那些 cookie 全部作废),而"启动顺序影响会话"
 * 是一种极难排查的故障。
 */
export function sessionSecret(db: Db): string {
  return ensureSetting(db, SESSION_SECRET_KEY, () => randomBytes(SESSION_SECRET_BYTES).toString("base64url"));
}

function signWith(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

/** 常量时间比较两个字符串(长度不同直接 false —— 长度本身不是秘密)。 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 造会话 cookie 的**值**(不含 Set-Cookie 属性):`成员id.过期毫秒.签名`。
 * 只放成员 id:成员名可能改,口令绝不该出现在 cookie 里(浏览器会把 cookie 存到磁盘)。
 */
export function signSession(db: Db, memberId: string, now: number = Date.now()): string {
  const payload = `${memberId}.${now + SESSION_TTL_MS}`;
  return `${payload}.${signWith(sessionSecret(db), payload)}`;
}

/**
 * 校验 cookie 值 → Viewer(source="web");任何一环不满足一律 null(未登录)。
 *
 * 逐项拒绝:签名不符/被篡改、已过期、成员被软删(`deleted_at`)、口令已被清掉。
 * 最后两项是关键:软删成员/被清口令的成员不该靠一个还没过期的 cookie 继续看页面。
 */
export function viewerFromSession(db: Db, cookieValue: string, now: number = Date.now()): Viewer | null {
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return null;
  const [memberId, expRaw, sig] = parts as [string, string, string];
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || !Number.isInteger(exp)) return null;
  const expected = signWith(sessionSecret(db), `${memberId}.${expRaw}`);
  if (!safeEqual(sig, expected)) return null;
  if (exp <= now) return null;
  const row = db
    .prepare("SELECT id, name, deleted_at, web_password_hash FROM member WHERE id = ?")
    .get(memberId) as
    | { id: string; name: string; deleted_at: string | null; web_password_hash: string | null }
    | undefined;
  if (!row || row.deleted_at !== null || row.web_password_hash === null) return null;
  return { memberId: row.id, memberName: row.name, source: "web" };
}

/** 从 `Cookie:` 头里取出会话 cookie 的值(没有则 null)。 */
export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * 下发会话 cookie 的 `Set-Cookie` 值。
 *
 * 属性与理由:
 * - `HttpOnly`:**JS 读不到**。页面上不跑任何脚本,但这一条让"日后有人加一行脚本"
 *   也不可能把会话 cookie 读出来发走。
 * - `SameSite=Lax`:**跨站请求不带这个 cookie**,顺带挡掉跨站表单 POST(退出、登录)。
 * - `Path=/`:三个页面共用一份会话。
 * - `Max-Age`:与服务话有效期一致(12 小时),浏览器重启后不必再登录一次。
 * - **没有 `Secure`**:局域网是 HTTP(R9),加了 `Secure` 浏览器直接不发 cookie —— 页面直接用不了。
 *   这是"明文口令经过 Wi-Fi"的代价,README 与注释里写明,别假装不存在。
 */
export function sessionCookieHeader(value: string): string {
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Lax`;
}

/** 清 cookie 的 `Set-Cookie` 值(退出登录):同一套属性 + Max-Age=0。 */
export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

// ─────────────────────────── 登录失败限速(阈值与锁定时长) ───────────────────────────

/**
 * 允许的连续失败次数(具名常量):第 5 次失败即锁定。
 * 为什么不是 3:家人手输密码常错一两次(手机输入法、中英文),3 次锁死会把正常人也关在门外;
 * 5 次给足手误余量,又让弱口令的穷举代价高到不值得试(锁定 15 分钟,一天最多试 ~96 次)。
 */
export const LOGIN_MAX_FAILURES = 5;

/** 锁定时长 = 15 分钟(具名常量)。15 分钟够"想起密码去问管理员",又不至于让暴力试变成慢速撞库。 */
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

interface ThrottleEntry {
  /** 锁定前已累计的连续失败次数。 */
  failures: number;
  /** 锁定的到期时刻;0 = 未锁定。 */
  lockedUntil: number;
}

/**
 * 登录失败计数器(按「来源 IP + 成员」分桶)。
 *
 * **为什么按 IP + 成员两个维度**:只按 IP 会让"爸爸输错 5 次"把妈妈也锁在门外;
 * 只按成员则换台设备就能重来。两个一起用才是"针对某个成员口令的猜测"这个真实威胁。
 *
 * **状态只在内存里**:它是**抗猜测**的闸门,不是权限凭据 —— 丢了它最坏结果是重启后又可以试 5 次;
 * 而写进库就得处理多进程共享与清理,收益不成比例。刻意不做的事:成功登录只清**这一桶**,
 * 别的成员/别的 IP 的计数不受影响。
 */
export class LoginThrottle {
  readonly #entries = new Map<string, ThrottleEntry>();

  /** 当前还剩多少毫秒才解锁(0 = 未锁定)。过期的锁定顺手清零,让计数重新开始。 */
  remainingMs(key: string, now: number = Date.now()): number {
    const e = this.#entries.get(key);
    if (e === undefined) return 0;
    if (e.lockedUntil > now) return e.lockedUntil - now;
    if (e.lockedUntil !== 0) {
      // 锁定已过 → 计数清零:再给一次完整的 LOGIN_MAX_FAILURES 次机会。
      this.#entries.set(key, { failures: 0, lockedUntil: 0 });
    }
    return 0;
  }

  /** 记一次失败;达到阈值就锁定。返回锁定剩余毫秒(0 = 尚未锁定)。 */
  recordFailure(key: string, now: number = Date.now()): number {
    const prev = this.#entries.get(key) ?? { failures: 0, lockedUntil: 0 };
    const failures = prev.failures + 1;
    const lockedUntil = failures >= LOGIN_MAX_FAILURES ? now + LOGIN_LOCKOUT_MS : 0;
    this.#entries.set(key, { failures, lockedUntil });
    return lockedUntil > now ? lockedUntil - now : 0;
  }

  /** 成功登录清零(任务书要求:连续计数不得跨成功累积)。 */
  clear(key: string): void {
    this.#entries.delete(key);
  }

  /** 已记的桶数(测试用:确认成功登录确实清掉了桶)。 */
  get size(): number {
    return this.#entries.size;
  }
}

// ─────────────────────────── 登录判定 ───────────────────────────

export type WebLoginResult =
  | { ok: true; viewer: Viewer }
  | { ok: false; kind: "unknown_member" | "no_password" | "bad_password" | "locked"; retryAfterMs?: number };

/** 限速桶的键:来源 IP + 成员 id(解析不出成员时用原始输入,那一类本来也不计数)。 */
export function throttleKey(ip: string, ref: string): string {
  return `${ip}|${ref.trim().toLowerCase()}`;
}

/**
 * 一次登录尝试的完整判定(顺序是纪律的一部分)。
 *
 * 1. 解析成员(`resolveMemberRef`,与 MCP 侧同一套归属解析:名字/别名/id 都收);
 *    解析不出 → `unknown_member`,**不计数**(没口令可猜,计数只会变成"按名字锁人"的骚扰)。
 * 2. **先看锁定**:`remainingMs > 0` → `locked` 并给出剩余时间。
 *    这一步必须在验口令之前 —— 否则锁定期间拿正确密码仍能进,锁定就形同虚设。
 * 3. 没设过口令 → `no_password`,回执话术是"请让管理员先设置你的查看页密码"。
 * 4. 验口令失败 → 记一次失败,达到 `LOGIN_MAX_FAILURES` 就锁定并把剩余时间带出去。
 * 5. 成功 → 清零该桶 + 返回 Viewer(source="web")。
 *
 * **全程不回显口令**,失败话术里也不含它(页面与日志都拿不到明文)。
 */
export function attemptLogin(
  db: Db,
  throttle: LoginThrottle,
  args: { ip: string; memberRef: string; password: string; now?: number },
): WebLoginResult {
  const now = args.now ?? Date.now();
  const resolved = resolveMemberRef(db, args.memberRef);
  if (!resolved.ok) return { ok: false, kind: "unknown_member" };
  const member: MemberRow = resolved.member;

  const key = throttleKey(args.ip, member.id);
  const lockedFor = throttle.remainingMs(key, now);
  if (lockedFor > 0) return { ok: false, kind: "locked", retryAfterMs: lockedFor };

  const stored = readWebPasswordHash(db, member.id);
  if (stored === null) return { ok: false, kind: "no_password" };

  if (!verifyWebPassword(args.password, stored)) {
    const retryAfterMs = throttle.recordFailure(key, now);
    return { ok: false, kind: "bad_password", ...(retryAfterMs > 0 ? { retryAfterMs } : {}) };
  }

  throttle.clear(key);
  return { ok: true, viewer: { memberId: member.id, memberName: member.name, source: "web" } };
}

/** 读某成员的查看页口令哈希(未设过则为 null)。 */
export function readWebPasswordHash(db: Db, memberId: string): string | null {
  const row = db.prepare("SELECT web_password_hash FROM member WHERE id = ?").get(memberId) as
    | { web_password_hash: string | null }
    | undefined;
  return row?.web_password_hash ?? null;
}

/** 该成员是否已设查看页口令(登录页用来标注"还没设口令")。 */
export function hasWebPassword(db: Db, memberId: string): boolean {
  return readWebPasswordHash(db, memberId) !== null;
}
