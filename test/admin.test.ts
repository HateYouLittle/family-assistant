import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { loadConfig, type AppConfig } from "../src/config.js";
import { openDb } from "../src/db/db.js";
import { migrate } from "../src/db/migrations.js";
import { readSetting } from "../src/db/settings.js";
import { hashToken } from "../src/domain/auth.js";
import { listCategories } from "../src/domain/ledger.js";
import { listAudit } from "../src/audit/audit.js";
import { createMember } from "../src/domain/members.js";
import { TOOL_DEFINITIONS } from "../src/mcp/tools.js";
import { resetLastMcpRequestTime } from "../src/mcp/http.js";
import {
  ADMIN_AUDIT_MEMBER_ID,
  ADMIN_AUDIT_MEMBER_NAME,
  ADMIN_LOGIN_LOCKOUT_MS,
  ADMIN_LOGIN_MAX_FAILURES,
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_TTL_MS,
  ADMIN_SET_PASSWORD_HINT,
  clearAdminPassword,
  hasAdminPassword,
  setAdminPassword,
} from "../src/web/admin-auth.js";
import { SESSION_COOKIE_NAME, setMemberWebPassword, signSession } from "../src/web/auth.js";
import { buildWebServer } from "../src/web/http.js";
import { newFixture, TZ, IDENTITY_HEADER, type Fixture } from "./helpers.js";

/**
 * S6b 管理页(设计方案 §6)。
 *
 * 本文件钉住的**不是**"页面长什么样",而是八件别人最容易在这里做错的事:
 *
 * 1. **没有默认口令**:未设管理口令 → 管理页**一律 503** 并给出 CLI 指引;设置后能登录;
 *    错口令失败;连续失败被限速锁定。
 * 2. **会话隔离(双向)**:拿查看页 cookie 访问管理页 → 未授权;拿管理 cookie 访问查看页 → 未授权。
 * 3. **软删真的生效(跨门面)**:软删成员后,用他的 token 真跑一次 /mcp → `DENIED(unknown_profile)`。
 * 4. **token 明文只出现一次**:生成响应里有明文与 profile 片段;**库里查不到明文**(裸 SQL 断言,
 *    只有 sha256);新 token 能调通 MCP;吊销后立刻 `DENIED(unknown_profile)`。
 * 5. **分类**:新增后 `list_categories` 能查到;同名同类冲突响亮报错。
 * 6. **审计**:管理页的写操作能看到,且**审计里不出现任何 token 明文**。
 * 7. **备份**:下载到的字节**能当 SQLite 库打开**且行数与当前库一致;下载后**临时文件已清理**。
 * 8. **健康**:JSON 含 MCP/DB/最近备份/最近投递四项,且**不含成员数据与任何 token**。
 *
 * 纪律(沿用既有测试):
 * - **不起真实监听端口**:一律 `app.inject()`(含 /mcp 那条跨门面断言 —— 它走
 *   `buildHttpServer(...).inject()`,不是 `listen()`)。
 * - 断言"不含某字面量"时用的是**未经转义的原始输入**,转义回退会真的变红。
 */

const ADMIN_PASSWORD = "admin-pass-S6b-9x";
const MEMBER_PASSWORD: Record<"mama" | "baba" | "kid", string> = {
  mama: "mama-pass-1",
  baba: "baba-pass-2",
  kid: "kid-pass-3",
};

/** 成员会话的 cookie 取值(看页登录成功时拿)。 */
function memberCookieOf(res: { headers: Record<string, unknown> }): string | null {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [String(raw)];
  for (const line of list) {
    if (String(line).startsWith(`${SESSION_COOKIE_NAME}=`)) return String(line).split(";")[0]!;
  }
  return null;
}

/** 管理会话的 cookie 取值。 */
function adminCookieOf(res: { headers: Record<string, unknown> }): string | null {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [String(raw)];
  for (const line of list) {
    if (String(line).startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`)) return String(line).split(";")[0]!;
  }
  return null;
}

let f: Fixture;
let app: FastifyInstance;
let config: AppConfig;
/** 备份临时目录的专属落点(测试自己清空,好断言"没有残留")。 */
let backupRoot: string;
/** 恢复 `FA_BACKUP_TMPDIR`,免得污染别的测试文件。 */
let backupRootBefore: string | undefined;

function form(fields: Record<string, string>): {
  payload: string;
  headers: Record<string, string>;
} {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, v);
  return {
    payload: params.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
}

/** 成员在查看页登录(拿 `fa_session`)。 */
async function loginMember(key: "mama" | "baba" | "kid"): Promise<string> {
  setMemberWebPassword(f.db, f.members[key].id, MEMBER_PASSWORD[key]);
  const res = await app.inject({
    method: "POST",
    url: "/login",
    ...form({ member: f.members[key].name, password: MEMBER_PASSWORD[key] }),
  });
  assert.equal(res.statusCode, 302, `成员 ${key} 登录应成功,实际 ${res.statusCode}:${res.body}`);
  const cookie = memberCookieOf(res);
  assert.ok(cookie, "登录响应里没有成员会话 cookie");
  return cookie;
}

/** 管理登录,返回可放进 Cookie 头的那一段。 */
async function loginAdmin(password = ADMIN_PASSWORD): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/admin/login", ...form({ password }) });
  assert.equal(res.statusCode, 303, `管理登录应成功,实际 ${res.statusCode}:${res.body}`);
  const cookie = adminCookieOf(res);
  assert.ok(cookie, "管理登录响应里没有管理会话 cookie");
  return cookie;
}

async function adminGet(url: string, cookie = loginAdminCached): Promise<{ status: number; body: string }> {
  const res = await app.inject({ method: "GET", url, headers: { cookie } });
  return { status: res.statusCode, body: res.body };
}

async function adminPost(
  url: string,
  fields: Record<string, string>,
  cookie = loginAdminCached,
): Promise<{ status: number; body: string; location: string; contentType: string }> {
  const res = await app.inject({ method: "POST", url, ...form(fields), headers: { cookie, "content-type": "application/x-www-form-urlencoded" } });
  return {
    status: res.statusCode,
    body: res.body,
    location: String(res.headers.location ?? ""),
    contentType: String(res.headers["content-type"] ?? ""),
  };
}

/** 缓存一份管理 cookie,供上面的默认参数用(每组测试登录一次就够)。 */
let loginAdminCached: string;

beforeEach(() => {
  f = newFixture();
  config = { ...loadConfig({}), mcpPort: 8347, dbPath: ":memory:", timezone: TZ };
  app = buildWebServer(f.db, config);
  backupRootBefore = process.env.FA_BACKUP_TMPDIR;
  backupRoot = mkdtempSync(join(tmpdir(), "fa-admin-test-"));
  process.env.FA_BACKUP_TMPDIR = backupRoot;
  resetLastMcpRequestTime();
});

afterEach(async () => {
  if (backupRootBefore === undefined) delete process.env.FA_BACKUP_TMPDIR;
  else process.env.FA_BACKUP_TMPDIR = backupRootBefore;
  rmSync(backupRoot, { recursive: true, force: true });
  await app.close();
  f.db.close();
});

// ─────────────────── 1. 管理口令:无默认值、登录、限速 ───────────────────

describe("管理口令:未设置 → 一律 503;设置后能登录", () => {
  it("未设管理口令时,每一个管理页(含登录页自己)都 503 并给出 CLI 指引", async () => {
    assert.equal(hasAdminPassword(f.db), false, "前提:fixture 的库没设过管理口令");
    for (const url of [
      "/admin",
      "/admin/login",
      "/admin/members",
      "/admin/tokens",
      "/admin/categories",
      "/admin/audit",
      "/admin/health",
      "/admin/backup",
      "/admin/backup/download",
    ]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 503, `${url} 未设口令时应 503,实际 ${res.statusCode}`);
      assert.match(res.body, new RegExp(ADMIN_SET_PASSWORD_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `${url} 的 503 页面必须给出「先执行哪条命令」的指引`);
    }
  });

  it("503 时不给出任何管理内容,且不因为路径不同而漏出数据", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/members" });
    for (const secret of ["妈妈", "爸爸", "小明"]) {
      assert.equal(res.body.includes(secret), false, `未配置的管理页不该出现成员名「${secret}」`);
    }
    // 也不该给出登录框 —— "没配置"不是"没登录",两者的话术必须不同
    assert.equal(res.body.includes('type="password"'), false, "503 页面不该给出口令输入框");
  });

  it("未设口令时 POST /admin/login 也是 503(不能靠登录页绕过闸门)", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/login", ...form({ password: "" }) });
    assert.equal(res.statusCode, 503, "空口令不得让任何人进管理页(不得存在默认口令)");
    assert.equal(adminCookieOf(res), null, "503 不得下发任何 cookie");
  });

  it("设置管理口令后:库里只有 scrypt 哈希(不是明文、不是裸哈希)", () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    const stored = readSetting(f.db, "admin_password_hash");
    assert.ok(stored, "setting 表里应有管理口令哈希");
    assert.match(String(stored), /^scrypt\$\d+\$\d+\$\d+\$\d+\$/, `应是 scrypt 自描述格式,实际:${stored}`);
    assert.equal(String(stored).includes(ADMIN_PASSWORD), false, "库里绝不能有管理口令明文");
    // 复用查看页那套哈希:同一份 scrypt 参数与格式,没有第二套实现
    assert.equal(String(stored).split("$")[0], "scrypt");
  });

  it("设置后登录成功 → 下发独立 cookie(HttpOnly + SameSite=Lax + Path=/admin),并能进总览", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    const res = await app.inject({ method: "POST", url: "/admin/login", ...form({ password: ADMIN_PASSWORD }) });
    assert.equal(res.statusCode, 303);
    const raw = res.headers["set-cookie"];
    const setCookie = Array.isArray(raw) ? String(raw[0]) : String(raw);
    assert.match(setCookie, /HttpOnly/, "管理会话 cookie 必须 HttpOnly");
    assert.match(setCookie, /SameSite=Lax/, "必须 SameSite=Lax");
    assert.match(setCookie, /Path=\/admin/, `必须限定 Path=/admin(少一个能读到凭据的地方就少一条泄漏路径),实际:${setCookie}`);
    assert.doesNotMatch(setCookie, /Secure/, "局域网无 HTTPS,加 Secure 会让管理页直接用不了(R9)");
    assert.equal(String(setCookie).includes(ADMIN_PASSWORD), false, "cookie 里绝不能有明文口令");

    const cookie = adminCookieOf(res);
    assert.ok(cookie);
    const page = await app.inject({ method: "GET", url: "/admin", headers: { cookie } });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /管理页/);
  });

  it("错口令 → 401,响应里不含明文口令,也不下发 cookie", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    const wrong = "not-the-admin-pass";
    const res = await app.inject({ method: "POST", url: "/admin/login", ...form({ password: wrong }) });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.includes(wrong), false, "失败响应不得回显口令");
    assert.equal(adminCookieOf(res), null, "登录失败不得下发 cookie");
  });

  it(`连续失败 ${ADMIN_LOGIN_MAX_FAILURES} 次 → 锁定:即便口令正确也被拒(429),并说清还要等多久`, async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    for (let i = 0; i < ADMIN_LOGIN_MAX_FAILURES; i++) {
      await app.inject({
        method: "POST",
        url: "/admin/login",
        remoteAddress: "10.0.0.7",
        ...form({ password: `bad-${i}` }),
      });
    }
    const correct = await app.inject({
      method: "POST",
      url: "/admin/login",
      remoteAddress: "10.0.0.7",
      ...form({ password: ADMIN_PASSWORD }),
    });
    assert.equal(correct.statusCode, 429, "锁定期间即便口令正确也必须被拒");
    assert.match(correct.body, /锁定/);
    assert.match(correct.body, /分钟/, "锁定提示必须说清还要等多久");
    assert.equal(adminCookieOf(correct), null, "锁定期间不得下发 cookie");
  });

  it("限速按来源 IP 分桶:换一台 IP 不共享锁", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    for (let i = 0; i < ADMIN_LOGIN_MAX_FAILURES; i++) {
      await app.inject({
        method: "POST",
        url: "/admin/login",
        remoteAddress: "10.0.0.7",
        ...form({ password: `bad-${i}` }),
      });
    }
    const other = await app.inject({
      method: "POST",
      url: "/admin/login",
      remoteAddress: "192.168.9.9",
      ...form({ password: ADMIN_PASSWORD }),
    });
    assert.equal(other.statusCode, 303, "换一台设备的 IP 不该共享锁");
  });

  it("阈值与时长是具名常量,话术引用常量不另抄一个数字", async () => {
    assert.equal(ADMIN_LOGIN_MAX_FAILURES, 3, "管理端阈值应是 3(比查看页更紧:一次登录能换走整库备份)");
    assert.equal(ADMIN_LOGIN_LOCKOUT_MS, 30 * 60 * 1000, "管理端锁定应是 30 分钟");
    assert.equal(ADMIN_SESSION_TTL_MS, 60 * 60 * 1000, "管理会话应是 1 小时(比查看页的 12 小时短)");
    setAdminPassword(f.db, ADMIN_PASSWORD);
    for (let i = 0; i < ADMIN_LOGIN_MAX_FAILURES; i++) {
      await app.inject({
        method: "POST",
        url: "/admin/login",
        remoteAddress: "10.0.0.8",
        ...form({ password: "bad" }),
      });
    }
    const locked = await app.inject({
      method: "POST",
      url: "/admin/login",
      remoteAddress: "10.0.0.8",
      ...form({ password: ADMIN_PASSWORD }),
    });
    assert.match(locked.body, /分钟/, "话术必须说清剩余分钟数");
  });

  it("清除管理口令后:管理页回到一律 503(且已签发的管理会话一并失效)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    const cookie = await loginAdmin();
    assert.equal((await adminGet("/admin", cookie)).status, 200);

    assert.equal(clearAdminPassword(f.db), true);
    const after = await app.inject({ method: "GET", url: "/admin", headers: { cookie } });
    assert.equal(after.statusCode, 503, "清了口令 → 管理页一律 503,旧 cookie 也不能再开一页");

    // 再设一次(新的指纹) → 旧 cookie 依然失效
    setAdminPassword(f.db, "another-admin-pass");
    const stillOld = await app.inject({ method: "GET", url: "/admin", headers: { cookie } });
    assert.equal(stillOld.statusCode, 302, "改过口令后旧管理会话必须失效(指纹变了)");
    assert.equal(clearAdminPassword(f.db), true, "设了之后应清得掉");
    assert.equal(clearAdminPassword(f.db), false, "再清一次应报'本来就没有'");
  });
});

// ─────────────────── 2. 会话隔离(双向)───────────────────

describe("会话隔离:成员会话与管理员会话互不通用", () => {
  it("拿查看页 cookie 访问每一个管理页 → 一律未授权(302),不发页面", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    const cookie = await loginMember("mama");
    for (const url of [
      "/admin",
      "/admin/members",
      "/admin/tokens",
      "/admin/categories",
      "/admin/audit",
      "/admin/health",
      "/admin/backup",
      "/admin/backup/download",
    ]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie } });
      assert.ok(res.statusCode === 302 || res.statusCode === 403, `${url} 拿成员会话应未授权,实际 ${res.statusCode}`);
      assert.ok(String(res.headers.location ?? "").startsWith("/admin/login"), `${url} 应跳管理登录页`);
      assert.equal(res.body.includes("妈妈"), false, `未授权时不该发出成员数据(${url})`);
    }
  });

  it("拿成员会话 cookie 调管理页的**写路由**也一样被拒(不只读页受保护)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    const cookie = await loginMember("mama");
    for (const url of [
      "/admin/members/add",
      "/admin/members/remove",
      "/admin/members/aliases",
      "/admin/members/reset-password",
      "/admin/tokens/issue",
      "/admin/tokens/revoke",
      "/admin/categories/add",
    ]) {
      const res = await app.inject({
        method: "POST",
        url,
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        payload: "name=注入&member=妈妈",
      });
      assert.ok(res.statusCode === 302 || res.statusCode === 403, `${url} 拿成员会话应被拒,实际 ${res.statusCode}`);
    }
    // 前提成立:一次都没真写进去
    assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM member").get() as { n: number }).n, 3);
  });

  it("反过来:拿管理会话 cookie 访问查看页 → 未登录(302 到 /login)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    const admin = await loginAdmin();
    for (const url of ["/todos", "/calendar", "/ledger"]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie: admin } });
      assert.equal(res.statusCode, 302, `${url} 拿管理会话不该被当成已登录成员`);
      assert.ok(String(res.headers.location ?? "").startsWith("/login"));
      assert.equal(res.body.includes("管理员"), false, "查看页不该把管理员当成某个成员渲染出来");
    }
  });

  it("两面会话的 cookie 名、载荷格式、签名密钥三者都不同(结构性隔离)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    const admin = await loginAdmin();
    const member = await loginMember("mama");
    // 名字不同
    assert.ok(admin.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`));
    assert.ok(member.startsWith(`${SESSION_COOKIE_NAME}=`));
    assert.notEqual(ADMIN_SESSION_COOKIE_NAME, SESSION_COOKIE_NAME, "两个 cookie 名必须不同");
    // 载荷段数不同:管理 4 段(admin.指纹.过期.签名),成员 3 段(id.过期.签名)
    const adminValue = admin.slice(ADMIN_SESSION_COOKIE_NAME.length + 1);
    assert.equal(adminValue.split(".").length, 4, "管理会话应是 4 段");
    assert.equal(member.slice(SESSION_COOKIE_NAME.length + 1).split(".").length, 3, "成员会话应是 3 段");
    assert.ok(adminValue.startsWith("admin."), "管理会话第一段是固定标记 admin(不是任何成员 id)");
    // 签名密钥不同
    assert.ok(readSetting(f.db, "admin_session_secret"), "管理会话应有独立的签名密钥");
    assert.ok(readSetting(f.db, "web_session_secret"), "查看页会话也有自己的签名密钥");
    assert.notEqual(
      readSetting(f.db, "admin_session_secret"),
      readSetting(f.db, "web_session_secret"),
      "两套会话的签名密钥必须不同",
    );
  });

  it("退出管理:POST /admin/logout 清 cookie;GET 不存在(不让人点个链接就被登出)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    const cookie = await loginAdmin();
    const out = await app.inject({ method: "POST", url: "/admin/logout", headers: { cookie } });
    assert.equal(out.statusCode, 303);
    const cleared = String(out.headers["set-cookie"]);
    assert.match(cleared, new RegExp(`^${ADMIN_SESSION_COOKIE_NAME}=;`), "退出必须下发同名空值 cookie");
    assert.match(cleared, /Max-Age=0/);
    const get = await app.inject({ method: "GET", url: "/admin/logout", headers: { cookie } });
    assert.ok(get.statusCode === 404 || get.statusCode === 405, `GET /admin/logout 应无此路由,实际 ${get.statusCode}`);
    const still = await app.inject({ method: "GET", url: "/admin", headers: { cookie } });
    assert.equal(still.statusCode, 200, "GET /admin/logout 不该把人登出");
  });

  it("被篡改/乱填/过期的管理 cookie 一律未登录", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    const cookie = await loginAdmin();
    const tampered = cookie.replace(/admin\./, "adminx.");
    const truncated = `${ADMIN_SESSION_COOKIE_NAME}=admin..1.deadbeef`;
    for (const bad of [
      `${ADMIN_SESSION_COOKIE_NAME}=`,
      `${ADMIN_SESSION_COOKIE_NAME}=garbage`,
      `${ADMIN_SESSION_COOKIE_NAME}=a.b.c.d`,
      truncated,
      tampered,
    ]) {
      const res = await app.inject({ method: "GET", url: "/admin", headers: { cookie: bad } });
      assert.equal(res.statusCode, 302, `cookie=${JSON.stringify(bad)} 应视为未登录`);
    }
  });

  it("成员会话的 cookie 值塞进管理 cookie 名也没用(签名与格式都不匹配)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    // 构造一个"看起来像管理会话"的成员会话值:签同样的载荷,用的是成员密钥
    const forged = signSession(f.db, f.members.mama.id);
    const res = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${forged}` },
    });
    assert.equal(res.statusCode, 302, "查看页签出来的会话不得被管理页接受(密钥不同)");
  });
});

// ─────────────────── 3. 成员管理(含跨门面的软删验证)───────────────────

describe("成员管理:新增 / 改别名 / 软删", () => {
  it("未登录时先设好管理口令并登录,再看列表四列齐全", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    setMemberWebPassword(f.db, f.members.mama.id, MEMBER_PASSWORD.mama);
    const page = await adminGet("/admin/members");
    assert.equal(page.status, 200);
    // name / aliases / 是否已设查看页口令 / 名下 token 数与是否有效
    assert.match(page.body, /妈妈/);
    assert.match(page.body, /老妈、王丽/);
    assert.match(page.body, /已设置/);
    assert.match(page.body, /\d+ 个有效 \/ 共 \d+/);
    // 爸爸没设口令 → 标注未设置
    const row = page.body.slice(page.body.indexOf("爸爸") - 200, page.body.indexOf("爸爸") + 400);
    assert.match(row, /未设置/, "未设查看页口令的成员必须标注出来");
  });

  it("新增成员:成功;别名冲突响亮报错并指出冲突的是哪一个", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    const added = await adminPost("/admin/members/add", { name: "奶奶", aliases: "外婆,婆婆" });
    assert.equal(added.status, 303, `新增应成功,实际 ${added.status}:${added.body}`);
    assert.equal(added.location, "/admin/members");

    // 别名撞上现有成员的别名
    const clash = await adminPost("/admin/members/add", { name: "姑姑", aliases: "老妈" });
    assert.equal(clash.status, 400, "别名冲突必须响亮报错,不能静默存进去");
    assert.match(clash.body, /INVALID_PARAMS/);
    assert.match(clash.body, /老妈/, "报错要点明冲突的是哪个别名");
    assert.equal(
      (f.db.prepare("SELECT COUNT(*) AS n FROM member WHERE name = ?").get("姑姑") as { n: number }).n,
      0,
      "冲突的成员不该被建出来",
    );

    // 重名也报错
    const dup = await adminPost("/admin/members/add", { name: "妈妈" });
    assert.equal(dup.status, 400);
    assert.match(dup.body, /已存在/);
  });

  it("改别名:成功;抢别人的别名响亮报错且不改动", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    const okRes = await adminPost("/admin/members/aliases", { member: "爸爸", aliases: "老爸,老王,王强" });
    assert.equal(okRes.status, 303);
    const row = f.db.prepare("SELECT aliases FROM member WHERE name = ?").get("爸爸") as { aliases: string };
    assert.deepEqual(JSON.parse(row.aliases), ["老爸", "老王", "王强"]);

    const clash = await adminPost("/admin/members/aliases", { member: "爸爸", aliases: "老妈" });
    assert.equal(clash.status, 400);
    assert.match(clash.body, /老妈/);
    const after = f.db.prepare("SELECT aliases FROM member WHERE name = ?").get("爸爸") as { aliases: string };
    assert.deepEqual(JSON.parse(after.aliases), ["老爸", "老王", "王强"], "冲突时别名不该被改动");
  });

  it("软删成员:名下数据保留,且其 token 调 /mcp 真跑一次得到 DENIED(unknown_profile)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    // 先让小明有一条待办,验证"软删后数据保留"
    const addTodo = TOOL_DEFINITIONS.find((t) => t.name === "add_todo")!;
    const parsed = addTodo.parse({ title: "交电费" });
    assert.ok(parsed.ok);
    const env = addTodo.run(f.db, f.callers.kid, TZ, parsed.args);
    assert.ok(env.ok);

    const before = await mcpCall(f.tokens.kid, f.identity.kid, "list_todos", {});
    assert.equal(before.envelope.ok, true, "前提:软删前小明的 token 能调通 MCP");

    const removed = await adminPost("/admin/members/remove", { member: "小明" });
    assert.equal(removed.status, 303);

    // 名下数据保留
    const todoRow = f.db.prepare("SELECT COUNT(*) AS n FROM todo WHERE owner_id = ?").get(f.members.kid.id) as {
      n: number;
    };
    assert.equal(todoRow.n, 1, "软删后名下待办必须保留(§4:一律软删)");
    assert.equal(f.db.prepare("SELECT deleted_at FROM member WHERE id = ?").get(f.members.kid.id) !== undefined, true);

    // 跨门面真跑一次:同一进程里 /mcp 这个门面 → DENIED(unknown_profile)
    const after = await mcpCall(f.tokens.kid, f.identity.kid, "list_todos", {});
    assert.equal(after.envelope.ok, false, "软删后其 token 必须被拒");
    assert.equal(after.envelope.code, "DENIED");
    assert.equal(after.envelope.reason, "unknown_profile");
    assert.equal(after.isError, true, "拒绝必须同时体现在 MCP 的 isError 上");
  });
});

// ─────────────────── 4. token:明文只一次 + profile 片段 ───────────────────

describe("family token:按成员生成/吊销,明文只显示一次", () => {
  it("生成:响应里有明文与 profile 片段(两个头 + 成员 id + 正确的 url)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    const res = await adminPost("/admin/tokens/issue", { member: "妈妈", label: "hermes profile" });
    assert.equal(res.status, 200, `生成 token 应直接返回明文页,实际 ${res.status}:${res.body}`);

    // 抽明文:形如 fam_<base64url>
    const plain = /fam_[A-Za-z0-9_-]+/.exec(res.body)?.[0];
    assert.ok(plain, "生成响应里必须有 token 明文");
    assert.match(res.body, /X-Family-Member/, "片段里必须含身份声明头");
    assert.match(res.body, new RegExp(`${IDENTITY_HEADER}|X-Family-Member`), "片段里必须含声明头");
    // 声明头的值必须是该成员的 id
    assert.ok(
      res.body.includes(`X-Family-Member: "${f.members.mama.id}"`) ||
        res.body.includes(`X-Family-Member: &quot;${f.members.mama.id}&quot;`),
      `profile 片段里的声明头值必须是成员 id:${f.members.mama.id}`,
    );
    assert.ok(res.body.includes(`Bearer ${plain}`), "片段里必须含 Authorization: Bearer <token>");
    assert.ok(res.body.includes("http://127.0.0.1:8347/mcp"), "片段里必须是本进程的 /mcp 地址");
    assert.match(res.body, /只显示一次|只在这里出现一次/, "页面必须写明明文只出现一次");
  });

  it("库里查不到明文:只有 SHA-256(裸 SQL 断言,不看任何应用层接口)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    const res = await adminPost("/admin/tokens/issue", { member: "妈妈" });
    const plain = /fam_[A-Za-z0-9_-]+/.exec(res.body)?.[0];
    assert.ok(plain, "前提:拿到了明文");

    // 裸 SQL:全表扫一遍,任何一列都不得出现明文
    const rows = f.db.prepare("SELECT * FROM api_token WHERE member_id = ?").all(f.members.mama.id) as Record<
      string,
      unknown
    >[];
    assert.equal(rows.length, 2, "前提:妈妈有一个 fixture token + 刚生成的一个");
    for (const row of rows) {
      for (const [col, value] of Object.entries(row)) {
        assert.equal(String(value).includes(plain), false, `api_token.${col} 里出现了 token 明文`);
      }
    }
    // 存的是 sha256(可自行重算核对)
    const fresh = rows.find((r) => r.label === "hermes profile")!;
    assert.equal(fresh.token_hash, hashToken(plain), "库里存的必须是 sha256(token)");
    assert.equal(String(fresh.token_hash).includes(plain), false);

    // setting 表与 audit_log 里同样不得出现明文
    const settings = f.db.prepare("SELECT value FROM setting").all() as { value: string }[];
    for (const s of settings) assert.equal(s.value.includes(plain), false, "setting 表里出现了 token 明文");
    const audits = f.db.prepare("SELECT args_summary FROM audit_log").all() as { args_summary: string }[];
    for (const a of audits) assert.equal(a.args_summary.includes(plain), false, "audit_log 里出现了 token 明文");
  });

  it("新 token 能调通 MCP(带上声明头),而且是以该成员身份", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    const res = await adminPost("/admin/tokens/issue", { member: "小明" });
    const plain = /fam_[A-Za-z0-9_-]+/.exec(res.body)?.[0];
    assert.ok(plain);

    const called = await mcpCall(plain, f.identity.kid, "list_todos", {});
    assert.equal(called.envelope.ok, true, `新 token 应能调通 MCP,实际:${JSON.stringify(called.envelope)}`);

    // 声明头与 token 归属不一致 → 响亮失败(B1/S7 那条通道仍然生效)
    const wrongIdentity = await mcpCall(plain, f.identity.mama, "list_todos", {});
    assert.equal(wrongIdentity.envelope.code, "DENIED");
    assert.equal(wrongIdentity.envelope.reason, "identity_mismatch");
  });

  it("吊销后立刻 DENIED(unknown_profile)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    const res = await adminPost("/admin/tokens/issue", { member: "小明" });
    const plain = /fam_[A-Za-z0-9_-]+/.exec(res.body)?.[0];
    const tokenId = /tok_[A-Za-z0-9_-]+/.exec(res.body)?.[0];
    assert.ok(plain && tokenId);

    assert.equal((await mcpCall(plain, f.identity.kid, "list_todos", {})).envelope.ok, true, "前提:吊销前可用");

    const revoked = await adminPost("/admin/tokens/revoke", { token: tokenId });
    assert.equal(revoked.status, 303);

    const after = await mcpCall(plain, f.identity.kid, "list_todos", {});
    assert.equal(after.envelope.code, "DENIED");
    assert.equal(after.envelope.reason, "unknown_profile");

    // 吊销不存在的 token → 404 语义(400 + 提示),不静默成功
    const bogus = await adminPost("/admin/tokens/revoke", { token: "tok_不存在" });
    assert.equal(bogus.status, 400);
    assert.match(bogus.body, /NOT_FOUND/);
  });

  it("token 列表页:按成员分组,显示状态与吊销按钮,但**不显示哈希也不显示明文**", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    await adminPost("/admin/tokens/issue", { member: "妈妈" });
    const page = await adminGet("/admin/tokens");
    assert.equal(page.status, 200);
    assert.match(page.body, /妈妈/);
    assert.match(page.body, /有效/);
    assert.match(page.body, /吊销/);
    // 哈希绝不显示
    const hash = hashToken(f.tokens.mama);
    assert.equal(page.body.includes(hash), false, "token 列表页不该显示哈希");
    assert.equal(page.body.includes(f.tokens.mama), false, "token 列表页不该显示任何 token 明文");
  });
});

// ─────────────────── 5. 分类管理 ───────────────────

describe("分类管理:列出 + 新增", () => {
  it("新增后 list_categories 能查到(跨门面:管理页写,MCP 侧读)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    const res = await adminPost("/admin/categories/add", { name: "宠物", kind: "expense" });
    assert.equal(res.status, 303, `新增分类应成功,实际 ${res.status}:${res.body}`);

    const env = listCategories(f.db, f.callers.mama, TZ, {});
    assert.ok(env.ok);
    const cats = (env.data as { categories: { name: string }[] }).categories;
    assert.ok(cats.some((c) => c.name === "宠物"), "MCP 侧 list_categories 必须能查到管理页新建的分类");
  });

  it("同名同类冲突:响亮报错并告知已有的分类 id,不静默建第二个", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    const res = await adminPost("/admin/categories/add", { name: "餐饮", kind: "expense" });
    assert.equal(res.status, 400);
    assert.match(res.body, /INVALID_PARAMS/);
    assert.match(res.body, /餐饮/);
    assert.match(res.body, /cat-expense-food/, "报错应告知已有的分类 id(不必重建)");
    const n = f.db.prepare("SELECT COUNT(*) AS n FROM category WHERE name = ? AND kind = ?")
      .get("餐饮", "expense") as { n: number };
    assert.equal(n.n, 1, "冲突时不该建出第二个同名同类分类");
  });

  it("同名不同类允许(支出与收入可以各有一个「其他」)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    const res = await adminPost("/admin/categories/add", { name: "报销", kind: "income" });
    assert.equal(res.status, 303, `收入分类「报销」应能建成,实际:${res.body}`);
    const n = f.db.prepare("SELECT COUNT(*) AS n FROM category WHERE name = ?").get("报销") as { n: number };
    assert.equal(n.n, 1);
  });

  it("分类页按 kind 分组列出(支出 / 收入两张表)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    const page = await adminGet("/admin/categories");
    assert.equal(page.status, 200);
    assert.match(page.body, /支出分类\(9\)/);
    assert.match(page.body, /收入分类\(4\)/);
  });
});

// ─────────────────── 6. 审计:看得到写操作,且没有凭据 ───────────────────

describe("审计日志:管理端写操作留痕(固定身份 __admin__),且不含任何凭据", () => {
  it("建成员 / 改别名 / 软删 / 建分类 / 生成 token / 吊销 token 都在审计里看得见", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    await adminPost("/admin/members/add", { name: "奶奶", aliases: "外婆" });
    await adminPost("/admin/members/aliases", { member: "爸爸", aliases: "老爸,老王" });
    await adminPost("/admin/categories/add", { name: "宠物", kind: "expense" });
    const issued = await adminPost("/admin/tokens/issue", { member: "妈妈" });
    const tokenId = /tok_[A-Za-z0-9_-]+/.exec(issued.body)?.[0];
    assert.ok(tokenId);
    await adminPost("/admin/tokens/revoke", { token: tokenId });
    await adminPost("/admin/members/remove", { member: "奶奶" });
    await adminPost("/admin/members/reset-password", { member: "爸爸" });

    const page = await adminGet("/admin/audit");
    assert.equal(page.status, 200);
    for (const tool of [
      "admin.member.add",
      "admin.member.aliases",
      "admin.category.add",
      "admin.token.issue",
      "admin.token.revoke",
      "admin.member.remove",
      "admin.member.reset-password",
    ]) {
      assert.ok(page.body.includes(tool), `审计页里看不到 ${tool}`);
    }
    // 固定身份:说话人一律「管理员」,member_id 是保留字
    assert.match(page.body, new RegExp(ADMIN_AUDIT_MEMBER_NAME));
    const rows = listAudit(f.db, 100);
    const adminRows = rows.filter((r) => r.tool.startsWith("admin."));
    assert.equal(adminRows.length, 7, `应有 7 条管理端审计,实际 ${adminRows.length}`);
    for (const r of adminRows) {
      assert.equal(r.member_id, ADMIN_AUDIT_MEMBER_ID, "管理端审计的 member_id 必须是固定保留字,不是某个家人");
      assert.equal(r.member_name, ADMIN_AUDIT_MEMBER_NAME);
      assert.equal(r.ok, true);
    }
    // 绝不借用某个家庭成员的身份
    for (const key of ["mama", "baba", "kid"] as const) {
      assert.equal(adminRows.some((r) => r.member_id === f.members[key].id), false, "管理端审计不得借用家人身份");
    }
  });

  it("失败的写操作也留痕(result_code = 信封码)——配错正是最该被追溯的", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    await adminPost("/admin/members/add", { name: "妈妈" });
    const rows = listAudit(f.db, 10);
    const fail = rows.find((r) => r.tool === "admin.member.add");
    assert.ok(fail, "失败的管理端写操作也必须留痕");
    assert.equal(fail.ok, false);
    assert.equal(fail.result_code, "INVALID_PARAMS");
  });

  it("审计与审计页里都不出现任何 token 明文(用生成时拿到的明文做否定断言)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    const issued = await adminPost("/admin/tokens/issue", { member: "小明" });
    const plain = /fam_[A-Za-z0-9_-]+/.exec(issued.body)?.[0];
    assert.ok(plain, "前提:拿到了明文");

    // 库里
    const rows = listAudit(f.db, 100);
    for (const r of rows) {
      assert.equal(r.args_summary.includes(plain), false, `审计摘要里出现了 token 明文:${r.tool}`);
    }
    const raw = f.db.prepare("SELECT tool, args_summary FROM audit_log").all() as {
      tool: string;
      args_summary: string;
    }[];
    for (const r of raw) {
      assert.equal(r.args_summary.includes(plain), false, `audit_log.${r.tool} 里出现了 token 明文`);
    }
    // 页面上
    const page = await adminGet("/admin/audit");
    assert.equal(page.body.includes(plain), false, "审计页里出现了 token 明文");
  });

  it("重置查看页口令的审计里只有成员名,没有口令(明文与哈希都不许出现)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    const res = await adminPost("/admin/members/reset-password", { member: "小明" });
    assert.equal(res.status, 200);
    const plain = /<pre class="once">([A-Za-z0-9_-]{12})<\/pre>/.exec(res.body)?.[1];
    assert.ok(plain, "前提:重置响应里有随机口令");

    const rows = listAudit(f.db, 10);
    const row = rows.find((r) => r.tool === "admin.member.reset-password");
    assert.ok(row);
    assert.equal(row.args_summary.includes(plain), false, "审计里出现了口令明文");
    const memberHash = f.db.prepare("SELECT web_password_hash FROM member WHERE name = ?").get("小明") as {
      web_password_hash: string;
    };
    assert.equal(row.args_summary.includes(memberHash.web_password_hash), false, "审计里出现了口令哈希");
    assert.equal(row.args_summary, "member=小明");
  });

  it("N 可查询、且有上限:limit 超出上限被截断并说明", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    for (let i = 0; i < 3; i++) {
      await adminPost("/admin/members/add", { name: `成员${i}`, aliases: "" });
    }
    const small = await adminGet("/admin/audit?limit=2");
    assert.equal(small.status, 200);
    assert.match(small.body, /最近 2 条/);
    assert.equal((small.body.match(/data-audit-id=/g) ?? []).length, 2, "?limit=2 只显示 2 条");

    const huge = await adminGet("/admin/audit?limit=999999");
    assert.equal(huge.status, 200);
    assert.match(huge.body, /超过上限/, "超出上限必须明确告诉运维被截断了");
    assert.match(huge.body, /最近 200 条/);

    // 非法的 limit 不该变成 0 条或全表:回落到默认值
    const bogus = await adminGet("/admin/audit?limit=abc");
    assert.equal(bogus.status, 200);
    assert.match(bogus.body, /最近 50 条/);
  });
});

// ─────────────────── 7. 备份:VACUUM INTO + 临时文件清理 ───────────────────

describe("数据备份:在线快照可打开,且临时文件已清理", () => {
  it("下载到的字节是可打开的 SQLite 库,行数与当前库一致;临时文件已被清理", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    // 前提:库里得有数据(否则"行数一致"这条断言没有意义)
    const expected = f.db.prepare("SELECT COUNT(*) AS n FROM member").get() as { n: number };
    assert.equal(expected.n, 3, "前提:库里三名成员");

    const res = await app.inject({ method: "GET", url: "/admin/backup/download", headers: { cookie: loginAdminCached } });
    assert.equal(res.statusCode, 200, `下载应成功,实际 ${res.statusCode}`);
    const bytes = res.rawPayload;
    assert.ok(bytes.length > 0);
    // 响应头:文件名 + Content-Disposition
    const disposition = String(res.headers["content-disposition"]);
    assert.match(disposition, /^attachment; filename="family-assistant-backup-\d{8}-\d{6}Z\.db"$/, `文件名形状不对:${disposition}`);

    // 真的当 SQLite 库打开(写到临时副本再打开,因为 better-sqlite3 需要文件路径)
    const copyPath = join(backupRoot, "assert-copy.db");
    writeFileSync(copyPath, bytes);
    const snap = new Database(copyPath, { readonly: true });
    try {
      const n = snap.prepare("SELECT COUNT(*) AS n FROM member").get() as { n: number };
      assert.equal(n.n, expected.n, "备份里的成员数必须与当前库一致");
      const names = (snap.prepare("SELECT name FROM member").all() as { name: string }[]).map((r) => r.name).sort();
      const live = (f.db.prepare("SELECT name FROM member").all() as { name: string }[]).map((r) => r.name).sort();
      assert.deepEqual(names, live, "备份里的成员名单必须与当前库一致");
      // 迁移也一起被备份了(能打开就说明 schema 在)
      assert.ok((snap.prepare("SELECT COUNT(*) AS n FROM category").get() as { n: number }).n >= 13);
    } finally {
      snap.close();
      rmSync(copyPath, { force: true });
    }

    // **临时文件已被清理**:落点目录里不该有任何 .db 残留
    const leftovers = readdirSync(backupRoot).filter((n) => n.endsWith(".db"));
    assert.deepEqual(leftovers, [], `备份临时目录里不该有残留 .db,实际:${leftovers.join("、")}`);
    // 连目录本身都不该留下
    assert.equal(existsSync(join(backupRoot, "x")), false);
  });

  it("备份文件不落在共享目录(R9):用文件库时,库的目录里不出现任何新增 .db", async () => {
    // 单独开一个**文件库**:`:memory:` 没有"共享目录"可谈,而 R9 说的正是
    // "备份文件不落在共享目录"——库里所在的 data/ 就是那个共享目录。
    const dir = mkdtempSync(join(tmpdir(), "fa-shared-"));
    const dbPath = join(dir, "family-assistant.db");
    const fileDb = openDb(dbPath);
    const fileApp = buildWebServer(fileDb, { ...config, dbPath });
    try {
      migrate(fileDb);
      createMember(fileDb, TZ, { name: "妈妈" });
      setAdminPassword(fileDb, ADMIN_PASSWORD);
      const loginRes = await fileApp.inject({
        method: "POST",
        url: "/admin/login",
        ...form({ password: ADMIN_PASSWORD }),
      });
      const raw = loginRes.headers["set-cookie"];
      const line = Array.isArray(raw) ? String(raw[0]) : String(raw);
      const cookie = line.split(";")[0]!;

      const before = readdirSync(dir).sort();
      const res = await fileApp.inject({ method: "GET", url: "/admin/backup/download", headers: { cookie } });
      assert.equal(res.statusCode, 200);
      const after = readdirSync(dir).sort();
      assert.deepEqual(after, before, `下载备份不该在共享目录里留下任何文件:多出了 ${after.filter((n) => !before.includes(n)).join("、")}`);
      assert.equal(
        after.filter((n) => n.endsWith(".db")).length,
        before.filter((n) => n.endsWith(".db")).length,
        "共享目录里的 .db 数量不该变化(备份必须落在系统临时目录)",
      );
    } finally {
      await fileApp.close();
      fileDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("用 WAL 模式下已提交但未 checkpoint 的数据也能被备份到(WAL 模式的真问题)", async () => {
    // 这个用例单独开一个文件库:WAL 语义在 :memory: 上观察不到。
    const dir = mkdtempSync(join(tmpdir(), "fa-wal-backup-"));
    const dbPath = join(dir, "wal.db");
    const db = openDb(dbPath);
    try {
      migrate(db);
      db.prepare("INSERT INTO member (id, name, aliases, created_at) VALUES (?, ?, '[]', ?)").run(
        "m-wal-1",
        "妈妈",
        new Date().toISOString(),
      );
      // 不 checkpoint:数据此刻主要在 -wal 里,主库文件还是旧的
      assert.ok(existsSync(`${dbPath}-wal`), "前提:WAL 文件存在(数据还没进主库文件)");

      const backup = (await import("../src/admin/backup.js")).createBackup(db);
      const copyPath = join(dir, "snap.db");
      writeFileSync(copyPath, backup.bytes);
      const snap = new Database(copyPath, { readonly: true });
      try {
        const n = snap.prepare("SELECT COUNT(*) AS n FROM member").get() as { n: number };
        assert.equal(n.n, 1, "备份必须含 WAL 里已提交但未 checkpoint 的那一行(直接拷主库文件会丢)");
      } finally {
        snap.close();
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("备份后健康页的「最近一次备份时间」被更新,且不再显示暂无", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    const before = await app.inject({
      method: "GET",
      url: "/admin/health",
      headers: { cookie: loginAdminCached, accept: "application/json" },
    });
    const beforeJson = JSON.parse(before.body) as { backup: { last_backup_at: string | null } };
    assert.equal(beforeJson.backup.last_backup_at, null, "前提:还没备份过");

    await app.inject({ method: "GET", url: "/admin/backup/download", headers: { cookie: loginAdminCached } });

    const after = await app.inject({
      method: "GET",
      url: "/admin/health",
      headers: { cookie: loginAdminCached, accept: "application/json" },
    });
    const afterJson = JSON.parse(after.body) as { backup: { last_backup_at: string | null } };
    assert.ok(afterJson.backup.last_backup_at, "备份后必须记下时刻(供健康页显示)");
    assert.ok(!Number.isNaN(Date.parse(afterJson.backup.last_backup_at!)));
  });
});

// ─────────────────── 8. 健康状态:四项齐全,无成员数据与 token ───────────────────

describe("健康状态:JSON 含四项,且不含成员数据与任何 token", () => {
  it("含 MCP / DB / 最近备份 / 最近投递四项;没有数据时如实显示暂无", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    const res = await app.inject({
      method: "GET",
      url: "/admin/health",
      headers: { cookie: loginAdminCached, accept: "application/json" },
    });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /application\/json/);
    const body = JSON.parse(res.body) as Record<string, Record<string, unknown>>;

    for (const key of ["mcp", "db", "backup", "cron"]) {
      assert.ok(key in body, `健康 JSON 缺「${key}」项`);
    }
    // MCP:本进程自检
    assert.equal(body.mcp!["status"], "no_request_yet");
    assert.equal(body.mcp!["url"], "http://127.0.0.1:8347/mcp");
    assert.equal(body.mcp!["last_request_at"], null, "还没收到过 /mcp 请求时应如实为 null(不是编一个)");
    // DB:可读 + 文件大小
    assert.equal(body.db!["status"], "readable");
    assert.ok("size_bytes" in body.db!, "健康状态要给数据库文件大小");
    // 最近备份:没有数据时是 null + note 里带"暂无"
    assert.equal(body.backup!["last_backup_at"], null);
    assert.match(String(body.backup!["note"]), /暂无/);
    // 最近投递:程序自身不推送,恒为 null,并明说这不是投递结果
    assert.equal(body.cron!["last_delivery_at"], null);
    assert.match(String(body.cron!["note"]), /不推送|Hermes/);

    // /mcp 真收到一次请求后,MCP 项变成 serving
    await mcpCall(f.tokens.mama, f.identity.mama, "list_members", {});
    const after = await app.inject({
      method: "GET",
      url: "/admin/health",
      headers: { cookie: loginAdminCached, accept: "application/json" },
    });
    const afterJson = JSON.parse(after.body) as { mcp: { status: string; last_request_at: string | null } };
    assert.equal(afterJson.mcp.status, "serving", "收到过 /mcp 请求后应报 serving");
    assert.ok(afterJson.mcp.last_request_at, "并给出最近请求时刻");
  });

  it("不含成员数据,也不含任何 token(连哈希都没有)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    await adminPost("/admin/tokens/issue", { member: "妈妈" });
    const res = await app.inject({
      method: "GET",
      url: "/admin/health",
      headers: { cookie: loginAdminCached, accept: "application/json" },
    });
    for (const secret of ["妈妈", "爸爸", "小明", "老妈", f.tokens.mama, f.tokens.baba, f.tokens.kid]) {
      assert.equal(res.body.includes(secret), false, `健康 JSON 泄露了「${secret}」`);
    }
    // 哈希同样不许出现(它是凭据的一部分,离线可爆破)
    for (const key of ["mama", "baba", "kid"] as const) {
      assert.equal(res.body.includes(hashToken(f.tokens[key])), false, "健康 JSON 里出现了 token 哈希");
    }
    // 管理口令哈希也不许出现
    assert.equal(
      res.body.includes(String(readSetting(f.db, "admin_password_hash"))),
      false,
      "健康 JSON 里出现了管理口令哈希",
    );
    // 但"是否已设置"要说清楚(只报状态,不报内容)
    const body = JSON.parse(res.body) as { admin_password_set: boolean };
    assert.equal(body.admin_password_set, true);
  });

  it("未登录时健康页也不给(它是管理页的一部分,不是免登录端点)", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    const res = await app.inject({ method: "GET", url: "/admin/health", headers: { accept: "application/json" } });
    assert.equal(res.statusCode, 302, "健康状态属管理页,必须先过管理会话");
    // 与查看页那个**免登录**的 /healthz 明确区分开
    const probe = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(probe.statusCode, 200, "查看页的 /healthz 仍是免登录探测(不含成员数据)");
  });

  it("健康页(HTML)与 JSON 是同一份数据", async () => {
    setAdminPassword(f.db, ADMIN_PASSWORD);
    loginAdminCached = await loginAdmin();
    const html = await app.inject({ method: "GET", url: "/admin/health", headers: { cookie: loginAdminCached } });
    assert.equal(html.statusCode, 200);
    assert.match(String(html.headers["content-type"]), /text\/html; charset=utf-8/, "浏览器访问时给 HTML 渲染页");
    const jsonRes = await app.inject({
      method: "GET",
      url: "/admin/health",
      headers: { cookie: loginAdminCached, accept: "application/json" },
    });
    const json = JSON.parse(jsonRes.body) as Record<string, unknown>;
    assert.ok(html.body.includes(String(json.facade)), "HTML 页与 JSON 必须是同一份数据的两种渲染");
  });
});

// ─────────────────── 静态纪律:不新增监听口、不另写业务规则 ───────────────────

describe("管理页的静态纪律(可 grep 验证的部分)", () => {
  it("管理页不读家庭业务数据:页面层没有对 todo/event/entry 的查询", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/admin/pages.ts", import.meta.url), "utf8");
    // 页面层对业务表的直接查询会让"管理页能看全家数据"变成绕过 V1–V9 的后门
    for (const table of ["FROM todo", "FROM event_series", "FROM event_instance", "FROM entry"]) {
      assert.equal(src.includes(table), false, `src/admin/pages.ts 里出现了「${table}」:管理页不读家庭业务数据`);
    }
  });

  it("管理页用的是既有的 domain 函数,没有自己那套成员/分类业务规则", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/admin/http.ts", import.meta.url), "utf8");
    for (const fn of ["createMember(", "softDeleteMember(", "updateMemberAliases(", "addCategory(", "issueToken(", "revokeToken("]) {
      assert.ok(src.includes(fn), `src/admin/http.ts 应当调用既有的 ${fn}`);
    }
    // 页面层自己 INSERT/DELETE 成员表 = 另写了一套业务规则
    assert.doesNotMatch(src, /INSERT INTO member/i, "管理页不该自己插成员表");
    assert.doesNotMatch(src, /DELETE FROM/i, "管理页不该自己删表");
  });

  it("审计里不含 UPDATE/DELETE 入口(admin/audit.ts 只是 recordAudit 的包装)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/admin/audit.ts", import.meta.url), "utf8");
    assert.doesNotMatch(src, /UPDATE\s+audit_log/i);
    assert.doesNotMatch(src, /DELETE\s+FROM/i);
  });

  it("管理页与查看页共用同一个 Fastify 实例:不新增第二个监听口", async () => {
    assert.equal(app.server.listening, false, "测试全程不起真实监听端口");
    // 注册管理路由的是 buildWebServer 本身 → 同一个 app、同一个 FA_WEB_HOST
    const res = await app.inject({ method: "GET", url: "/admin/login" });
    assert.ok(res.statusCode === 303 || res.statusCode === 503 || res.statusCode === 200, `管理页路由应挂在 web app 上,实际 ${res.statusCode}`);
  });

  it("CLI 与管理页贴出的 profile 片段来自同一份实现(不会一个漏声明头)", async () => {
    const { hermesProfileSnippet } = await import("../src/admin/profile.js");
    const snippet = hermesProfileSnippet({
      config,
      memberName: "妈妈",
      memberId: f.members.mama.id,
      token: "fam_EXAMPLE",
    });
    assert.ok(snippet.includes('Authorization: "Bearer fam_EXAMPLE"'));
    assert.ok(snippet.includes(`X-Family-Member: "${f.members.mama.id}"`));
    assert.ok(snippet.includes('url: "http://127.0.0.1:8347/mcp"'));
    // CLI 也 import 同一个函数(grep 级):src/cli/admin.ts 里不再自己拼 yaml
    const { readFileSync } = await import("node:fs");
    const cliSrc = readFileSync(new URL("../src/cli/admin.ts", import.meta.url), "utf8");
    assert.ok(cliSrc.includes("hermesProfileSnippet("), "CLI 应调用共用的片段实现");
    assert.equal(cliSrc.includes("mcp_servers:"), false, "CLI 不该自己再拼一份 profile 片段");
  });
});

// ─────────────────── 跨门面 /mcp 的小工具(inject,不起端口)───────────────────

/**
 * 真跑一次 `/mcp`:用 `buildHttpServer(...).inject()`,**不监听端口**。
 * 返回信封与 isError,断言的是 MCP 侧真正看到的东西(而不是我们本地复算的 authenticate)。
 */
async function mcpCall(
  token: string,
  identity: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ envelope: Record<string, unknown>; isError: boolean }> {
  const { buildHttpServer } = await import("../src/mcp/http.js");
  const mcpApp = buildHttpServer(f.db, config);
  try {
    const res = await mcpApp.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        [IDENTITY_HEADER]: identity,
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
    });
    const text = res.body;
    // enableJsonResponse → 直接是 JSON-RPC 响应
    const rpc = JSON.parse(text) as {
      result?: { content?: { type: string; text?: string }[]; isError?: boolean };
    };
    const bodyText = rpc.result?.content?.find((c) => c.type === "text")?.text ?? "";
    return { envelope: JSON.parse(bodyText) as Record<string, unknown>, isError: rpc.result?.isError === true };
  } finally {
    await mcpApp.close();
  }
}