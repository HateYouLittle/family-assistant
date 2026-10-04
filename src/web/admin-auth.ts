import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/db.js";
import { readSetting, writeSetting } from "../db/settings.js";
import {
  generateWebPassword,
  hashWebPassword,
  LoginThrottle,
  verifyWebPassword,
} from "./auth.js";

/**
 * 管理页的身份与口令(设计方案 §6「管理页(`ADMIN_PASSWORD` 保护,日常不碰)」+ §6 加固①)。
 *
 * ## 口令:scrypt 哈希存 `setting` 表,**没有默认口令**
 * 哈希**直接复用 `./auth.ts` 的 `hashWebPassword` / `verifyWebPassword`**(同一套 scrypt 参数、
 * 同一份自描述格式 `scrypt$N$r$p$keylen$salt$hash`)。**没有另写一套哈希**:
 * 第二套实现意味着第二个参数组、第二次"调参数忘了兼容旧值"的坑,以及
 * "成员口令升级到 argon2 时忘了升级管理口令"的分裂。这里连常量都不复制。
 * 存 `setting` 表(迁移 v4)而不是 `member` 表:管理口令**不对应任何家庭成员**。
 *
 * **未设置时管理页一律 503**(见 ADMIN_SET_PASSWORD_HINT),绝不回落到任何默认口令或
 * "空口令可进" —— 设计 §6 加固①的原文是"不得存在默认口令,首次启动强制设置"。
 * 谁能设置它?只有 CLI(`npm run admin -- admin set-password`):**管理页自己不能是设置入口**,
 * 否则"先打开管理页给自己开门"就绕过了口令。
 *
 * ## 会话:与查看页会话**彻底分开**(cookie 名 + 载荷格式 + 有效期 + 签名密钥)
 * 这是本文件最要紧的一条纪律:两套会话若共用 cookie 名或载荷格式,就必然出现
 * "成员会话被当成管理员"或反之 —— 那不是理论风险,而是两套 TTL、两套受众的凭据
 * 装在同一个字段里,任何一个解析疏漏都是越权。
 *
 * - **cookie 名不同**:`fa_admin_session` vs 查看页的 `fa_session`(浏览器会两个都带上,
 *   所以服务端必须按名字取,不能"扫一遍看哪个能用")。
 * - **载荷格式不同**:管理会话是 4 段 `admin.<指纹>.<过期>.<签名>`,查看页是 3 段
 *   `<成员id>.<过期>.<签名>`。段数不同 ⇒ 两边的解析器互相不认对方的 cookie 值。
 * - **签名密钥不同**:`admin_session_secret` vs `web_session_secret`,各自随机生成存库。
 *   密钥共用的话,一个值在另一侧被构造出来也不是不可能;分开是白纸黑字的分界。
 * - **有效期更短**:管理会话 1 小时 vs 查看页 12 小时(见 ADMIN_SESSION_TTL_MS 注释)。
 * - **口令指纹在签名载荷里**:改管理口令 ⇒ 指纹变 ⇒ 旧会话全部验不过(见 adminSessionFingerprint)。
 *
 * ## 限速
 * 登录失败按**来源 IP** 计数(管理端只有一个身份,再按"成员"分桶没有意义),
 * 阈值/时长是本文件自己的具名常量(不复用查看页的:管理口令的爆炸半径是一整库备份,
 * 值得更紧一点),桶本身复用 `./auth.ts` 的 `LoginThrottle`(同一份计数/锁定逻辑)。
 */

/** 管理口令哈希在 `setting` 表里的键名。 */
export const ADMIN_PASSWORD_KEY = "admin_password_hash";

/** 管理会话签名密钥在 `setting` 表里的键名(与查看页的 `web_session_secret` 分开)。 */
export const ADMIN_SESSION_SECRET_KEY = "admin_session_secret";

/** 管理会话 cookie 名。**必须与 `SESSION_COOKIE_NAME` 不同** —— 这是两套会话的分界。 */
export const ADMIN_SESSION_COOKIE_NAME = "fa_admin_session";

/**
 * 管理会话有效期 = **1 小时**(具名常量,便于可测)。
 *
 * 为什么比查看页(12 小时)短得多:管理端能下载**整库备份**、能吊销任何人的 token、
 * 能软删成员 —— 一次会话被偷走的后果不是一个下午的日程,而是全家的家庭数据。
 * 运维动作本来就低频(日常不碰,设计 §6 原话),1 小时要求"改完就重新登一次"完全够用,
 * 却把"忘了退出"的暴露窗口从半天压到一小时。管理页还有退出按钮,不用靠 TTL 兜底。
 */
export const ADMIN_SESSION_TTL_MS = 60 * 60 * 1000;

/** 管理端登录失败阈值(具名常量):**3 次**即锁定 —— 比查看页(5 次)更紧。 */
export const ADMIN_LOGIN_MAX_FAILURES = 3;

/** 管理端锁定时长 = **30 分钟**(具名常量):锁定期间即便口令正确也一律被拒。 */
export const ADMIN_LOGIN_LOCKOUT_MS = 30 * 60 * 1000;

/**
 * 未设置管理口令时管理页给出的指引。
 * 写成具名常量是为了**页面、CLI 帮助、测试三处引用同一句话**,不各抄一份。
 */
export const ADMIN_SET_PASSWORD_HINT = "npm run admin -- admin set-password";

// ─────────────────────────── 口令(哈希复用查看页那套) ───────────────────────────

/** 管理口令是否已设置(管理页的 503 闸门读它)。 */
export function adminPasswordStatus(db: Db): { set: boolean } {
  return { set: readSetting(db, ADMIN_PASSWORD_KEY) !== null };
}

/** 是否已设置管理口令(供路由/页面直接用,少一层解包)。 */
export function hasAdminPassword(db: Db): boolean {
  return adminPasswordStatus(db).set;
}

/** 设置/覆盖管理口令。库里只有 scrypt 哈希;明文由调用方负责只打印一次。 */
export function setAdminPassword(db: Db, plain: string): void {
  writeSetting(db, ADMIN_PASSWORD_KEY, hashWebPassword(plain));
}

/**
 * 清除管理口令。返回是否真的清掉了(本来就没设时返回 false,CLI 据此说"无需清除")。
 * 语义后果:管理页立即一律 503,直到重新设置 —— 这是"收回管理入口",不是"降级到匿名"。
 */
export function clearAdminPassword(db: Db): boolean {
  if (!hasAdminPassword(db)) return false;
  db.prepare("DELETE FROM setting WHERE key = ?").run(ADMIN_PASSWORD_KEY);
  return true;
}

/**
 * 随机生成一个管理口令(CLI 不给 `--password` 时用)。
 *
 * 与成员查看页口令同规格(12 个 base64url 字符 ≈ 72 bit),**复用** `generateWebPassword`
 * 而不是再写一个随机串生成器:两处对"多长才算够"的判断没有理由不同。
 */
export function generateAdminPassword(): string {
  return generateWebPassword();
}

/** 校验管理口令。库里没有口令 ⇒ 恒 false(**空口令进不去**,与 §6 加固①一致)。 */
export function verifyAdminPassword(db: Db, plain: string): boolean {
  return verifyWebPassword(plain, readSetting(db, ADMIN_PASSWORD_KEY));
}

// ─────────────────────────── 会话(独立 cookie / 密钥 / 载荷) ───────────────────────────

/**
 * 管理会话签名密钥(不存在就随机生成一个写进 `setting`)。
 *
 * 与 `sessionSecret` 同样的理由("没有就生成"而不是写死):写死 = 所有部署共用一个密钥。
 * 但**刻意不复用查看页那个密钥** —— 见文件头"签名密钥不同"。
 */
export function adminSessionSecret(db: Db): string {
  const existing = readSetting(db, ADMIN_SESSION_SECRET_KEY);
  if (existing !== null) return existing;
  const fresh = randomBytes(32).toString("base64url");
  writeSetting(db, ADMIN_SESSION_SECRET_KEY, fresh);
  return readSetting(db, ADMIN_SESSION_SECRET_KEY) ?? fresh;
}

/**
 * 口令指纹:当前管理口令哈希的 SHA-256 前 16 位十六进制。
 *
 * **为什么指纹要进签名载荷**:这样"改了管理口令 ⇒ 旧管理会话全部失效"是**结构事实**
 * 而不是"运维记得手工清 cookie"。管理口令泄露后的标准处置就是换口令;
 * 如果换口令不影响已签发的会话,那处置只做了一半 —— 拿到 cookie 的人还能继续用一小时。
 * 指纹取哈希的摘要而不是哈希本身:载荷里放的是摘要,明文与完整哈希都不进 cookie。
 * 没设置口令时指纹为空串,此时 `adminFromSession` 直接拒绝(没有口令就没有会话)。
 */
export function adminSessionFingerprint(db: Db): string {
  const stored = readSetting(db, ADMIN_PASSWORD_KEY);
  if (stored === null) return "";
  return createHmac("sha256", "family-assistant/admin-session-fingerprint")
    .update(stored, "utf8")
    .digest("hex")
    .slice(0, 16);
}

function adminSign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 造管理会话 cookie 的值(不含 Set-Cookie 属性):`admin.<指纹>.<过期毫秒>.<签名>`。
 * **固定 4 段**,第一段是字面量 `admin`(不是任何成员 id)—— 与查看页的 3 段格式互不通用。
 */
export function signAdminSession(db: Db, now: number = Date.now()): string {
  const payload = `admin.${adminSessionFingerprint(db)}.${now + ADMIN_SESSION_TTL_MS}`;
  return `${payload}.${adminSign(adminSessionSecret(db), payload)}`;
}

/**
 * 校验管理会话 cookie 值 → 管理员身份成立?true/false(管理端**只有一个身份**,没有"是谁"的问题)。
 *
 * 逐项拒绝:段数不对(顺带把成员会话的 3 段值挡在这里)、指纹为空或与当前口令不符
 * (换了口令/清了口令 → 旧 cookie 失效)、签名不符(篡改)、已过期。
 */
export function adminFromSession(db: Db, cookieValue: string, now: number = Date.now()): boolean {
  const parts = cookieValue.split(".");
  if (parts.length !== 4) return false;
  const [marker, fingerprint, expRaw, sig] = parts as [string, string, string, string];
  if (marker !== "admin") return false;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp)) return false;
  const payload = `admin.${fingerprint}.${expRaw}`;
  if (!safeEqual(sig, adminSign(adminSessionSecret(db), payload))) return false;
  if (exp <= now) return false;
  // 指纹对不上 = 口令已被改过或已被清掉 ⇒ 旧会话不再算数。
  return fingerprint !== "" && safeEqual(fingerprint, adminSessionFingerprint(db));
}

/** 从 `Cookie:` 头里取管理会话 cookie 的值(没有则 null)。按名字取,绝不"扫一遍"。 */
export function readAdminSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === ADMIN_SESSION_COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * 下发管理会话 cookie 的 `Set-Cookie` 值。
 *
 * 属性:`HttpOnly` + `SameSite=Lax` + `Path=/admin`。
 *
 * **`Path=/admin` 是本文件的核心加固之一**:管理端的 cookie **不会**被发往 `/todos`、`/ledger`
 * 这些查看页路径,查看页的 `fa_session`(`Path=/`)也不会流到 `/admin` 之外的语义上。
 * 少一个能读到凭据的地方,就少一条"日志/代理/中间件把 cookie 记下来"的泄漏路径。
 *
 * **没有 `Secure`**:局域网是 HTTP(R9),加了 `Secure` 浏览器直接不发 cookie,管理页当场用不了。
 * 与查看页同一个已知代价,README 与页脚都写着。
 */
export function adminSessionCookieHeader(value: string): string {
  return `${ADMIN_SESSION_COOKIE_NAME}=${value}; Path=/admin; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Lax`;
}

/** 清管理会话 cookie(退出):同一套属性 + Max-Age=0。 */
export function clearAdminSessionCookieHeader(): string {
  return `${ADMIN_SESSION_COOKIE_NAME}=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Lax`;
}

// ─────────────────────────── 登录判定(限速按来源 IP) ───────────────────────────

export type AdminLoginResult =
  | { ok: true }
  | { ok: false; kind: "no_password_set" | "bad_password" | "locked"; retryAfterMs?: number };

/**
 * 限速桶的键:**只有来源 IP**。
 *
 * 管理端只有一个身份(管理口令),再按"成员"分桶没有意义;而按 IP 是必需的 ——
 * 攻击者换成员名并不能换桶,但换来源 IP 才算换了机器。
 */
export function adminThrottleKey(ip: string): string {
  return `admin|${ip}`;
}

/**
 * 一次管理端登录尝试的完整判定(顺序是纪律的一部分)。
 *
 * 1. **没设管理口令 → `no_password_set` 且不计数**:此时根本没有可校验的东西,
 *    正确处置是 503 + 让人去跑 CLI(见 ADMIN_SET_PASSWORD_HINT),不是"当成口令错"——
 *    后者会让运维反复试口令却永远不知道为什么进不去。
 * 2. **先看锁定**:`remainingMs > 0` → `locked` 并给出剩余时间。必须在验口令之前,
 *    否则锁定期间拿正确口令仍能进,锁定形同虚设。
 * 3. 验口令失败 → 记一次失败,达 ADMIN_LOGIN_MAX_FAILURES 就锁定。
 * 4. 成功 → 清零该桶。
 *
 * **全程不回显口令**,失败话术里也不含它。
 */
export function attemptAdminLogin(
  db: Db,
  throttle: LoginThrottle,
  args: { ip: string; password: string; now?: number },
): AdminLoginResult {
  const now = args.now ?? Date.now();
  if (!hasAdminPassword(db)) return { ok: false, kind: "no_password_set" };

  const key = adminThrottleKey(args.ip);
  const lockedFor = throttle.remainingMs(key, now);
  if (lockedFor > 0) return { ok: false, kind: "locked", retryAfterMs: lockedFor };

  if (!verifyAdminPassword(db, args.password)) {
    const retryAfterMs = throttle.recordFailure(key, now);
    return { ok: false, kind: "bad_password", ...(retryAfterMs > 0 ? { retryAfterMs } : {}) };
  }

  throttle.clear(key);
  return { ok: true };
}

/**
 * 管理端的固定审计身份(S6b 裁决)。
 *
 * 审计表 `audit_log.member_id` 是 `TEXT NOT NULL` **且刻意不建外键**(迁移 v2 的注释:
 * 审计必须活得比成员/数据更久)。管理端**没有家庭成员身份** —— 用一个**保留字**当 id
 * 而不是挑一个成员来背锅。
 *
 * 为什么不能借用某个家人的身份:那会让审计说"妈妈在凌晨软删了爸爸",而实际上是运维在管理页
 * 点的按钮。R1(配置写错)的追溯依赖审计里身份属实;伪造身份等于把唯一的兜底机制变成谎话。
 * 为什么用 `__admin__` 这种一眼可辨的形式:事后看审计时不需要猜"这是谁"。
 *
 * 成员名取 `管理员` 而非某个家庭成员的名字,同理。
 */
export const ADMIN_AUDIT_MEMBER_ID = "__admin__";
export const ADMIN_AUDIT_MEMBER_NAME = "管理员";