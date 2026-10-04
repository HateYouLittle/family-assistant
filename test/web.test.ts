import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { Db } from "../src/db/db.js";
import { openDb } from "../src/db/db.js";
import { todayInTz } from "../src/db/id.js";
import { migrate } from "../src/db/migrations.js";
import { readSetting } from "../src/db/settings.js";
import { addEvent, listEvents, type EventView } from "../src/domain/events.js";
import type { Envelope, OkEnvelope } from "../src/domain/envelope.js";
import { addEntry, listEntries, type EntryView } from "../src/domain/ledger.js";
import { createMember, type MemberRow } from "../src/domain/members.js";
import { addTodo, listTodos, type TodoView } from "../src/domain/todos.js";
import type { Viewer } from "../src/domain/viewer.js";
import {
  clearMemberWebPassword,
  LoginThrottle,
  LOGIN_LOCKOUT_MS,
  LOGIN_MAX_FAILURES,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  setMemberWebPassword,
  signSession,
  verifyWebPassword,
  viewerFromSession,
} from "../src/web/auth.js";
import { h } from "../src/web/html.js";
import { buildWebServer } from "../src/web/http.js";
import { newFixture, TZ, type Fixture } from "./helpers.js";

/**
 * S6 查看页(设计方案 §6)。
 *
 * 本文件钉住的**不是**"页面长什么样",而是四件别人最容易在这里做错的事:
 *
 * 1. **登录/会话/限速**:口令哈希存储且无默认口令、签名 HttpOnly cookie、
 *    失败限速锁定、成功清零、篡改/缺失 cookie 一律未登录、退出后立即失效。
 * 2. **可见性同源**:三页渲染出的条目集合 == **直接调 domain 函数**的结果集合
 *    (同一 viewer 下)。这是"web 层没有重写 V1–V9"的可执行证据 —— 断言的是
 *    **集合相等**,不是"页面上大致对"。另有逐条反例:他人待办/个人日程/私账一律不出现。
 * 3. **HTML 转义**:标题里的 `<script>` 在页面上只能是实体化文本。
 * 4. **只读与免登录边界**:页面不写库;`/healthz` 免登录且不含成员数据。
 *
 * 纪律(沿用既有测试):
 * - **不起真实端口**:一律 `app.inject()`(与 test/mcp-http.test.ts 同一条路)。
 * - 期望值里的日期按 TZ 动态构造,不复用实现的日期函数。
 * - 断言"HTML 里**不含**某个字面量"时,用的是**未经转义的原始输入**
 *   (所以转义一旦回退,这些断言会真的变红)。
 */

const PASSWORD: Record<"mama" | "baba" | "kid", string> = {
  mama: "mama-pass-1",
  baba: "baba-pass-2",
  kid: "kid-pass-3",
};

let f: Fixture;
let app: FastifyInstance;
let config: AppConfig;

/**
 * 从 Set-Cookie 里取出可以**原样放进 Cookie 请求头**的那一段(`name=value`,不含属性)。
 * 后续所有请求都靠它,所以这里返回完整的一对而不是光取值 —— 光取值会被当成
 * 一个没有名字的 cookie,服务端读不到,页面一律 302,那种失败很难一眼看懂。
 */
function cookiePairOf(res: { headers: Record<string, unknown> }): string | null {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [String(raw)];
  for (const line of list) {
    if (String(line).startsWith(`${SESSION_COOKIE_NAME}=`)) return String(line).split(";")[0]!;
  }
  return null;
}

/** 登录并返回可复用的 cookie 对 + 完整的 Set-Cookie 头(属性断言要用)。 */
async function login(key: "mama" | "baba" | "kid", password = PASSWORD[key]): Promise<{ cookie: string; setCookie: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/login",
    payload: `member=${encodeURIComponent(f.members[key].name)}&password=${encodeURIComponent(password)}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(res.statusCode, 302, `登录 ${key} 应成功,实际 ${res.statusCode}:${res.body}`);
  const cookie = cookiePairOf(res);
  assert.ok(cookie, `登录响应里没有 ${SESSION_COOKIE_NAME} cookie`);
  const raw = res.headers["set-cookie"];
  const setCookie = Array.isArray(raw) ? String(raw[0]) : String(raw);
  return { cookie, setCookie };
}

/** 带会话 cookie 的 GET。 */
async function getAs(key: "mama" | "baba" | "kid", url: string, cookieOverride?: string): Promise<{ status: number; body: string }> {
  const { cookie } = await login(key);
  const res = await app.inject({ method: "GET", url, headers: { cookie: cookieOverride ?? cookie } });
  return { status: res.statusCode, body: res.body };
}

/**
 * 取页面上某一类条目的 id 集合(读 `data-*-id` 锚点,不去猜标题)。
 * 排序后比集合,所以顺序不同不算失败 —— 页面排序由展示需要决定,可见性才是纪律。
 */
function idsIn(html: string, kind: "todo" | "event" | "entry"): string[] {
  return [...html.matchAll(new RegExp(`data-${kind}-id="([^"]*)"`, "g"))].map((m) => m[1]!).sort();
}

function ok(env: Envelope, why: string): asserts env is OkEnvelope {
  assert.equal(env.ok, true, `${why}:期望成功信封,实际:${JSON.stringify(env)}`);
}

function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const p2 = (v: number) => String(v).padStart(2, "0");
  return `${String(dt.getUTCFullYear()).padStart(4, "0")}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
}

function today(): string {
  return todayInTz(TZ);
}

beforeEach(() => {
  f = newFixture();
  config = {
    ...loadConfig({}), // 默认值本身也是被测对象之一(FA_WEB_HOST 缺省回环)
    mcpPort: 0,
    dbPath: ":memory:",
    timezone: TZ,
  };
  app = buildWebServer(f.db, config);
});

afterEach(async () => {
  await app.close();
  f.db.close();
});

// ───────────────────────────── 会话与登录的构造 ─────────────────────────────

/** 给三名成员都设上口令(默认不设,便于测"未设口令"那条)。 */
function setPasswords(): void {
  for (const key of ["mama", "baba", "kid"] as const) {
    setMemberWebPassword(f.db, f.members[key].id, PASSWORD[key]);
  }
}

// ────────────────────────────────── 登录 ──────────────────────────────────

describe("查看页登录(成员名 + 个人口令,无默认口令)", () => {
  it("口令正确 → 下发签名 cookie,HttpOnly + SameSite=Lax + Path=/", async () => {
    setPasswords();
    const { setCookie } = await login("mama");
    // 属性逐条断言:少一条就有一类攻击面敞开
    assert.match(setCookie, /HttpOnly/, "会话 cookie 必须 HttpOnly(JS 读不到)");
    assert.match(setCookie, /SameSite=Lax/, "必须 SameSite=Lax(跨站请求不带它)");
    assert.match(setCookie, /Path=\//, "必须 Path=/(三个页面共用一份会话)");
    // 没有 Secure:局域网是 HTTP,加了 Secure 浏览器直接不发 cookie(README 已写明 R9 的代价)
    assert.doesNotMatch(setCookie, /Secure/, "局域网无 HTTPS,加 Secure 会让页面直接用不了(R9 的已知代价)");
  });

  it("cookie 值不含明文口令,也不含成员名(只有 id + 过期 + 签名)", async () => {
    setPasswords();
    const { cookie } = await login("mama");
    assert.equal(cookie.includes(PASSWORD.mama), false, "cookie 里绝不能有明文口令");
    assert.equal(cookie.includes("妈妈"), false, "cookie 里不该有成员名(成员名可改,id 稳定)");
    assert.ok(cookie.includes(f.members.mama.id), "cookie 里应有成员 id");
  });

  it("签名密钥存库(setting 表),首次启动随机生成且不是硬编码值", async () => {
    setPasswords();
    await login("mama");
    const secret = readSetting(f.db, "web_session_secret");
    assert.ok(secret && secret.length >= 32, `setting 表里应有会话密钥,实际:${secret}`);
    // 换一个库(模拟另一套部署)必须得到不同密钥:写死的话这里会相等
    const other: Db = openDb(":memory:");
    migrate(other);
    const res = await buildWebServer(other, config).inject({
      method: "POST",
      url: "/login",
      payload: "member=%E5%A6%88%E5%A6%88&password=x",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(res.statusCode, 401, "另一个库没有这名成员,登录应失败(顺带证明两库独立)");
    const otherSecret = readSetting(other, "web_session_secret");
    assert.notEqual(otherSecret, secret, "会话密钥不得是硬编码常量:两套部署必须是两个密钥");
    other.close();
  });

  it("口令错误 → 401,且响应里不含明文口令", async () => {
    setPasswords();
    const secret = "wrong-pass-9999";
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: `member=${encodeURIComponent(f.members.mama.name)}&password=${encodeURIComponent(secret)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.includes(secret), false, "失败响应不得回显口令");
    assert.equal(cookiePairOf(res), null, "登录失败不得下发 cookie");
  });

  it("成员名不存在 → 401,话术与「口令错」一致(不区分哪个错了)", async () => {
    setPasswords();
    const post = (payload: string) =>
      app.inject({
        method: "POST",
        url: "/login",
        payload,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
    const wrongMember = await post(`member=${encodeURIComponent("查无此人")}&password=${encodeURIComponent("whatever")}`);
    const wrongPassword = await post(`member=${encodeURIComponent(f.members.mama.name)}&password=zzz-wrong`);
    assert.equal(wrongMember.statusCode, 401);
    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(wrongMember.body, wrongPassword.body, "两种失败的话术必须完全一致(否则成了成员名枚举器)");
  });

  it("未设口令的成员无法登录,并得到「请让管理员先设置」的提示", async () => {
    // 刻意**只**给妈妈设口令:爸爸与小明都没设过
    setMemberWebPassword(f.db, f.members.mama.id, PASSWORD.mama);
    const res = await app.inject({
      method: "POST",
      url: "/login",
      // 就算猜对了"口令"也进不去:库里没有哈希就没有可校验的东西
      payload: `member=${encodeURIComponent(f.members.baba.name)}&password=${encodeURIComponent("")}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.body, /请让管理员先设置你的查看页密码/);
    assert.equal(cookiePairOf(res), null);

    // 登录页本身仍列出他,但标注未设置(藏起来会让人以为系统坏了)
    const page = await app.inject({ method: "GET", url: "/login" });
    assert.match(page.body, /爸爸\(未设置密码\)/);
    assert.doesNotMatch(page.body, /妈妈\(未设置密码\)/, "已设口令的成员不应带「未设置」标注");
  });

  it("口令库里只存 scrypt 哈希(不是明文、不是裸哈希)", () => {
    setPasswords();
    const row = f.db.prepare("SELECT web_password_hash FROM member WHERE id = ?").get(f.members.mama.id) as {
      web_password_hash: string;
    };
    const stored = row.web_password_hash;
    assert.ok(stored.startsWith("scrypt$"), `应为 scrypt 自描述格式,实际:${stored}`);
    assert.equal(stored.includes(PASSWORD.mama), false, "库里绝不能有明文口令");
    assert.equal(verifyWebPassword(PASSWORD.mama, stored), true, "正确口令应验过");
    assert.equal(verifyWebPassword(PASSWORD.mama + "x", stored), false, "错误口令必须验不过");
    // 同一个口令哈希两次必须不同(自带随机 salt):用爸爸也设成妈妈的口令来对照
    setMemberWebPassword(f.db, f.members.baba.id, PASSWORD.mama);
    const babaRow = f.db.prepare("SELECT web_password_hash FROM member WHERE id = ?").get(f.members.baba.id) as {
      web_password_hash: string;
    };
    assert.notEqual(babaRow.web_password_hash, stored, "两个成员用同一个口令时哈希也必须不同(每个口令一份盐)");
  });

  it("clear-password 之后该成员无法登录;已有会话也失效", async () => {
    setPasswords();
    const { cookie } = await login("mama");
    // 登录后能看页面
    const before = await app.inject({ method: "GET", url: "/todos", headers: { cookie } });
    assert.equal(before.statusCode, 200);

    clearMemberWebPassword(f.db, f.members.mama.id);

    const after = await app.inject({ method: "GET", url: "/todos", headers: { cookie } });
    assert.equal(after.statusCode, 302, "清口令后旧会话必须失效,不该继续发页面");
    const again = await app.inject({
      method: "POST",
      url: "/login",
      payload: `member=${encodeURIComponent(f.members.mama.name)}&password=${encodeURIComponent(PASSWORD.mama)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(again.statusCode, 401, "清口令后即使口令正确也不能登录");
  });
});

// ───────────────────────────── 限速与锁定 ─────────────────────────────

describe("登录失败限速与锁定(按 来源IP + 成员)", () => {
  /** 连续失败 n 次,返回最后一次响应。 */
  async function failTimes(key: "mama" | "baba", times: number, ip = "10.0.0.9"): Promise<{ status: number; body: string }> {
    let last = { status: 0, body: "" };
    for (let i = 0; i < times; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/login",
        remoteAddress: ip,
        payload: `member=${encodeURIComponent(f.members[key].name)}&password=bad-${i}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      last = { status: res.statusCode, body: res.body };
    }
    return last;
  }

  it(`连续失败 ${LOGIN_MAX_FAILURES} 次 → 锁定,即使口令正确也被拒,并说清还要等多久`, async () => {
    setPasswords();
    const last = await failTimes("mama", LOGIN_MAX_FAILURES);
    assert.equal(last.status, 401, "第 N 次失败本身仍是 401(尚未锁定)或 429(已锁定)");

    const correct = await app.inject({
      method: "POST",
      url: "/login",
      remoteAddress: "10.0.0.9",
      payload: `member=${encodeURIComponent(f.members.mama.name)}&password=${encodeURIComponent(PASSWORD.mama)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(correct.statusCode, 429, "锁定期间即便口令正确也必须被拒");
    assert.match(correct.body, /锁定/, "锁定提示要说清状态");
    assert.match(correct.body, /分钟/, "锁定提示必须说清还要等多久(分钟数)");
    assert.equal(cookiePairOf(correct), null, "锁定期间不得下发 cookie");
  });

  it("锁定只影响那一个 (IP, 成员) 桶:别的成员 / 别的 IP 不受影响", async () => {
    setPasswords();
    await failTimes("mama", LOGIN_MAX_FAILURES, "10.0.0.9");
    // 同一 IP 换成员 → 另一桶,正常
    const baba = await app.inject({
      method: "POST",
      url: "/login",
      remoteAddress: "10.0.0.9",
      payload: `member=${encodeURIComponent(f.members.baba.name)}&password=${encodeURIComponent(PASSWORD.baba)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(baba.statusCode, 302, "妈妈被锁不该把爸爸也锁在门外");
    // 另一 IP 换回来 → 另一桶,正常
    const otherIp = await app.inject({
      method: "POST",
      url: "/login",
      remoteAddress: "192.168.9.9",
      payload: `member=${encodeURIComponent(f.members.mama.name)}&password=${encodeURIComponent(PASSWORD.mama)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(otherIp.statusCode, 302, "换一台设备的 IP 不该共享锁(否则一人输错全家被锁)");
  });

  it("成功登录清零计数:失败 3 次 → 成功 → 再失败 3 次都不会锁定", async () => {
    setPasswords();
    await failTimes("mama", LOGIN_MAX_FAILURES - 2); // 3 次
    const good = await app.inject({
      method: "POST",
      url: "/login",
      remoteAddress: "10.0.0.9",
      payload: `member=${encodeURIComponent(f.members.mama.name)}&password=${encodeURIComponent(PASSWORD.mama)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(good.statusCode, 302, "还差 2 次才到阈值,此时正确口令应当能进");
    // 成功清零:再来 3 次(不到阈值)应该仍然只是 401
    const after = await failTimes("mama", LOGIN_MAX_FAILURES - 2, "10.0.0.9");
    assert.equal(after.status, 401, "计数被成功登录清零了,3 次失败不该锁定");
    const final = await app.inject({
      method: "POST",
      url: "/login",
      remoteAddress: "10.0.0.9",
      payload: `member=${encodeURIComponent(f.members.mama.name)}&password=${encodeURIComponent(PASSWORD.mama)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(final.statusCode, 302);
  });

  it("锁定时长与阈值是具名常量,话术里不写死另一个数字", async () => {
    assert.equal(LOGIN_MAX_FAILURES, 5, "阈值常量应是 5(给手误留余量,又让穷举代价高)");
    assert.equal(LOGIN_LOCKOUT_MS, 15 * 60 * 1000, "锁定时长应是 15 分钟");
    assert.equal(SESSION_TTL_MS, 12 * 60 * 60 * 1000, "会话时长应是 12 小时");
    setPasswords();
    await failTimes("mama", LOGIN_MAX_FAILURES);
    const res = await app.inject({
      method: "POST",
      url: "/login",
      remoteAddress: "10.0.0.9",
      payload: `member=${encodeURIComponent(f.members.mama.name)}&password=${encodeURIComponent(PASSWORD.mama)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.match(res.body, new RegExp(`连续输错 ${LOGIN_MAX_FAILURES} 次`), "话术里的阈值必须引用同一个常量");
  });

  it("LoginThrottle 单测:锁定到期后计数归零、可再试(不必等进程重启)", () => {
    const t = new LoginThrottle();
    const t0 = 1_000_000;
    for (let i = 1; i < LOGIN_MAX_FAILURES; i++) {
      assert.equal(t.recordFailure("ip|key", t0), 0, `第 ${i} 次失败还不该锁定`);
    }
    const locked = t.recordFailure("ip|key", t0);
    assert.ok(locked > 0 && locked <= LOGIN_LOCKOUT_MS, "第 5 次失败应锁定");
    // 锁定期内:即使手上有正确口令也报"还要等"
    const during = t.remainingMs("ip|key", t0 + 1000);
    assert.equal(during, locked - 1000, "锁定期内剩余时间随时间递减");
    // 到期后归零
    assert.equal(t.remainingMs("ip|key", t0 + LOGIN_LOCKOUT_MS), 0, "锁定到期即解锁");
    assert.equal(t.recordFailure("ip|key", t0 + LOGIN_LOCKOUT_MS), 0, "到期后计数应重新从 0 开始");
    // 成功清零
    t.clear("ip|key");
    assert.equal(t.size, 0, "成功登录应清掉该桶");
  });
});

// ─────────────────────────── 会话 cookie 的边界 ───────────────────────────

describe("会话边界:cookie 缺失 / 篡改 / 过期 / 退出", () => {
  it("未带 cookie 访问三个受保护页 → 302 到 /login 并带原路径", async () => {
    setPasswords();
    for (const [path, next] of [
      ["/todos", "/todos"],
      ["/calendar", "/calendar"],
      ["/ledger", "/ledger"],
    ] as const) {
      const res = await app.inject({ method: "GET", url: path });
      assert.equal(res.statusCode, 302, `${path} 未登录应 302 而不是把页面发出去`);
      const loc = String(res.headers.location);
      assert.ok(loc.startsWith("/login"), `${path} 应跳 /login,实际 ${loc}`);
      assert.match(loc, new RegExp(`next=${encodeURIComponent(next)}`), `${path} 应带回跳路径`);
    }
  });

  it("cookie 被篡改(改了成员 id)→ 一律未登录", async () => {
    setPasswords();
    const { cookie } = await login("mama");
    const tampered = cookie.replace(f.members.mama.id, f.members.baba.id);
    assert.notEqual(tampered, cookie, "构造前提:替换后确实变了");
    const res = await app.inject({ method: "GET", url: "/todos", headers: { cookie: tampered } });
    assert.equal(res.statusCode, 302, "篡改签名必须验不过");
    assert.equal(res.body.includes("妈妈"), false, "不该发出任何页面内容");
  });

  it("cookie 被截断 / 乱填 / 空值 → 一律未登录", async () => {
    setPasswords();
    for (const bad of ["", "garbage", "a.b.c", "x".repeat(500), "m-1.99999999999999.deadbeef"]) {
      const res = await app.inject({ method: "GET", url: "/todos", headers: { cookie: `${SESSION_COOKIE_NAME}=${bad}` } });
      assert.equal(res.statusCode, 302, `cookie=${JSON.stringify(bad)} 应视为未登录`);
    }
  });

  /**
   * 过期会话 → 未登录。
   *
   * 用 `viewerFromSession` 直接断言"过期"这条分支(签名正确但时间已过),
   * 免得只测到"篡改签名被拒"而把过期判定漏掉 —— 签名依赖过期时刻,
   * 所以在 HTTP 层改过期时刻必然先被签名挡下,那条路证明不了过期判定本身。
   */
  it("过期的会话(签名正确但已过期)→ 未登录", () => {
    setPasswords();
    const memberId = f.members.mama.id;
    // 签一个"出生即过期"的会话:now 取 12 小时之前,签出来的那一刻就已过期
    const value = signSession(f.db, memberId, Date.now() - SESSION_TTL_MS - 60_000);
    assert.equal(viewerFromSession(f.db, value), null, "已过期的会话必须判为无效");
  });

  it("过期的会话走 HTTP 也发不出页面", async () => {
    setPasswords();
    const value = signSession(f.db, f.members.mama.id, Date.now() - SESSION_TTL_MS - 60_000);
    const res = await app.inject({ method: "GET", url: "/todos", headers: { cookie: `${SESSION_COOKIE_NAME}=${value}` } });
    assert.equal(res.statusCode, 302, "过期会话等同未登录");
    assert.equal(res.body.includes("妈妈"), false, "不该发出任何页面内容");
  });

  it("登录后回跳原路径(/login?next=…),并且 next 只接受站内路径", async () => {
    setPasswords();
    const back = await app.inject({
      method: "POST",
      url: "/login",
      payload: `member=${encodeURIComponent(f.members.mama.name)}&password=${encodeURIComponent(PASSWORD.mama)}&next=%2Fcalendar`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(back.statusCode, 302);
    assert.equal(String(back.headers.location), "/calendar", "登录后应回跳原路径");

    // 开放重定向:`next` 指向站外必须被丢掉
    for (const evil of ["https://evil.example/", "//evil.example/", "\\\\evil.example", "http://evil.example"]) {
      const res = await app.inject({
        method: "POST",
        url: "/login",
        payload: `member=${encodeURIComponent(f.members.mama.name)}&password=${encodeURIComponent(PASSWORD.mama)}&next=${encodeURIComponent(evil)}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      assert.equal(String(res.headers.location), "/todos", `next=${evil} 必须被拒绝(开放重定向)`);
    }
  });

  it("POST /logout 清 cookie:同名空值 + Max-Age=0,随后必须重新登录", async () => {
    setPasswords();
    const { cookie } = await login("mama");
    const out = await app.inject({ method: "POST", url: "/logout", headers: { cookie } });
    assert.equal(out.statusCode, 302);
    assert.equal(String(out.headers.location), "/login");
    const cleared = String(out.headers["set-cookie"]);
    assert.match(cleared, new RegExp(`^${SESSION_COOKIE_NAME}=;`), "退出必须下发一个同名的空值 cookie");
    assert.match(cleared, /Max-Age=0/, "退出必须把 cookie 置为过期");
    assert.match(cleared, /HttpOnly/, "清 cookie 用同一套属性");

    // 浏览器按响应把 cookie 清掉 → 之后的请求不带它 → 未登录。
    // 这里显式模拟"浏览器已清"(不带 cookie),因为会话是**无服务端状态**的签名 cookie,
    // 服务端无法撤销一个已经发出去的副本 —— 声称"退出即刻作废"是假的,所以不这么断言。
    const after = await app.inject({ method: "GET", url: "/todos" });
    assert.equal(after.statusCode, 302, "退出后(浏览器已清 cookie)必须重新登录");
  });

  it("GET /logout 不改状态:它连路由都没有(404/405),会话继续可用", async () => {
    setPasswords();
    const { cookie } = await login("mama");
    const res = await app.inject({ method: "GET", url: "/logout", headers: { cookie } });
    // 返回 404 / 405 都算"没有这个 GET 路由"。若哪天有人加了 GET /logout 的实现,
    // 这条会红 —— 预加载、图片探测、爬链接都会顺手把人登出。
    assert.ok(res.statusCode === 404 || res.statusCode === 405, `GET /logout 应无此路由,实际 ${res.statusCode}`);
    const still = await app.inject({ method: "GET", url: "/todos", headers: { cookie } });
    assert.equal(still.statusCode, 200, "GET /logout 不该把人登出");
  });
});

// ──────────────────────────── /healthz(免登录) ────────────────────────────

describe("/healthz:免登录、不含成员数据", () => {
  it("无 cookie 也返回 JSON(ok + DB 可读 + 时间)", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.db, "readable");
    assert.ok(typeof body.now === "string" && !Number.isNaN(Date.parse(String(body.now))), "应带服务端时间");
    assert.ok(!("members" in body), "免登录端点绝不能带成员数据");
  });

  it("即使库里有数据与成员,healthz 里也不出现任何成员名字/条数", async () => {
    setPasswords();
    addTodo(f.db, f.callers.mama, TZ, { title: "买酱油" });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    for (const secret of ["妈妈", "爸爸", "小明", "买酱油"]) {
      assert.equal(res.body.includes(secret), false, `/healthz 泄露了「${secret}」:免登录端点不含成员数据`);
    }
  });
});

// ──────────────────────── /todos:仅本人(V1) ────────────────────────

describe("/todos:仅本人待办,分组 + 截止说法", () => {
  it("妈妈登录:只有妈妈的待办,爸爸的待办一个字都不出现", async () => {
    setPasswords();
    const m = addTodo(f.db, f.callers.mama, TZ, { title: "交物业费", due_date: today() });
    ok(m, "妈妈记待办");
    addTodo(f.db, f.callers.baba, TZ, { title: "修自行车", due_date: today() });

    const { status, body } = await getAs("mama", "/todos");
    assert.equal(status, 200);
    assert.match(body, /交物业费/);
    assert.equal(body.includes("修自行车"), false, "V1:他人的待办绝不能出现在页面上");
    assert.match(body, /今天截止/, "截止说法要复用域里的 describeDue");
  });

  it("已完成的待办在已完成分组里,且不与未完成混在一起", async () => {
    setPasswords();
    const t = addTodo(f.db, f.callers.mama, TZ, { title: "交物业费" });
    ok(t, "建待办");
    const { completeTodo } = await import("../src/domain/todos.js");
    ok(completeTodo(f.db, f.callers.mama, TZ, (t.data as TodoView).id), "完成待办");

    const { body } = await getAs("mama", "/todos");
    assert.match(body, /未完成\(0\)/);
    assert.match(body, /已完成\(1\)/);
  });

  it("HTML 转义:标题里的 <script> 在页面上只能是实体化文本", async () => {
    setPasswords();
    const payload = `<script>alert(1)</script>`;
    addTodo(f.db, f.callers.mama, TZ, { title: payload });
    const { body } = await getAs("mama", "/todos");
    assert.equal(body.includes(payload), false, "原始 <script> 序列绝不能出现在 HTML 里(那是可执行标签)");
    assert.ok(body.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "应当出现实体化文本");
  });

  it("同源断言:页面渲染的待办 id 集合(含今天块)== 直接调 domain 的结果集合", async () => {
    setPasswords();
    const due = addTodo(f.db, f.callers.mama, TZ, { title: "交物业费", due_date: today() });
    ok(due, "建今日到期待办");
    const open = addTodo(f.db, f.callers.mama, TZ, { title: "买酱油", notes: "无截止" });
    ok(open, "建无截止待办");
    addTodo(f.db, f.callers.baba, TZ, { title: "修自行车" }); // 爸爸的:妈妈不可见
    const delegated = addTodo(f.db, f.callers.baba, TZ, { title: "爸爸代记的", owner: f.members.mama.name });
    ok(delegated, "建代记待办(owner=妈妈)");

    // 期望值 = 直调 domain 的结果(而不是把标题写死):同一个 viewer,差别只有 source
    const viewer: Viewer = { ...f.callers.mama, source: "web" };
    const envOpen = listTodos(f.db, viewer, TZ, { done: false });
    const envDone = listTodos(f.db, viewer, TZ, { done: true });
    ok(envOpen, "直调 listTodos done=false");
    ok(envDone, "直调 listTodos done=true");
    const expectedOpen = (envOpen.data as { todos: TodoView[] }).todos.map((t) => t.id).sort();
    const expectedDone = (envDone.data as { todos: TodoView[] }).todos.map((t) => t.id).sort();
    assert.deepEqual(expectedOpen.length, 3, "前提:妈妈名下 3 条未完成(含代记的那条,owner 是妈妈)");

    const { body } = await getAs("mama", "/todos");
    const rendered = idsIn(body, "todo");
    // 集合相等 = 页面**不多不少**地渲染了 domain 给的那几条(今天块里的条目也算同一批)
    assert.deepEqual(
      [...new Set(rendered)].sort(),
      [...new Set([...expectedOpen, ...expectedDone])].sort(),
      "页面渲染的待办集合必须与 domain 返回的集合相等(不多不少)",
    );
    assert.equal(rendered.includes("修自行车"), false, "集合相等意味着爸爸的待办一条都不在页面上");
  });

  it("代记语义(V8):别人代我记的待办对我可见并标注,页面读的是同一份 domain 结果", async () => {
    setPasswords();
    // 爸爸代妈妈记(V4);对妈妈来说这是她自己的待办(owner=妈妈),但由爸爸创建
    addTodo(f.db, f.callers.baba, TZ, { title: "帮妈妈记的", owner: f.members.mama.name });
    const { body } = await getAs("mama", "/todos");
    assert.match(body, /帮妈妈记的/);
    assert.match(body, /由 爸爸 代记/, "代记事实要写出来(它是 V4 的服务端判定,页面不该自己推断)");
  });
});

// ──────────────────── /calendar:全家 + 本人(他人不可见) ────────────────────

describe("/calendar:全家日程 + 本人个人日程,他人个人日程不可见", () => {
  /** 在本周内落一条日程(默认 owner 缺省 = 全家)。 */
  function newEvent(viewer: Viewer, input: Parameters<typeof addEvent>[3]): string {
    const env = addEvent(f.db, viewer, TZ, input);
    ok(env, "建日程");
    return (env.data as EventView).id;
  }

  it("全家日程 + 本人个人日程都出现,他人个人日程的标题不出现在 HTML 里", async () => {
    setPasswords();
    const { start, end } = { start: shiftDay(today(), -3), end: shiftDay(today(), 3) };
    newEvent(f.callers.mama, { title: "全家晚饭", start: `${shiftDay(today(), 1)} 18:00`, end: `${shiftDay(today(), 1)} 19:00` });
    newEvent(f.callers.mama, { title: "妈妈的私人安排", start: `${shiftDay(today(), 2)} 09:00` , owner: f.members.mama.name });
    newEvent(f.callers.baba, { title: "爸爸的秘密日程", start: `${shiftDay(today(), 2)} 10:00`, owner: f.members.baba.name });

    const { body } = await getAs("mama", `/calendar?start=${start}&end=${end}`);
    assert.match(body, /全家晚饭/, "全家日程人人可见(V2)");
    assert.match(body, /妈妈的私人安排/, "本人个人日程本人可见(V1)");
    assert.equal(body.includes("爸爸的秘密日程"), false, "V1:他人的个人日程连标题都不能出现在 HTML 里");
    void start;
    void end;
  });

  it("带时间说法:同一天的起止合成 `起–止`,全天日程说「全天」", async () => {
    setPasswords();
    const day = shiftDay(today(), 1);
    newEvent(f.callers.mama, { title: "家长会", start: `${day} 15:00`, end: `${day} 16:00` });
    newEvent(f.callers.mama, { title: "国庆回家", start: shiftDay(today(), 3), all_day: true });

    const { body } = await getAs("mama", `/calendar?start=${day}&end=${day}`);
    assert.match(body, /家长会/, "当天日程应出现");
    assert.match(body, /15:00–16:00/, "同一天起止应合成一个时间说法(复用 describeTime)");
    const allDay = await getAs("mama", `/calendar?start=${shiftDay(today(), 3)}&end=${shiftDay(today(), 3)}`);
    assert.match(allDay.body, /全天/, "全天日程要说「全天」");
  });

  it("HTML 转义:日程标题里的 <script> 只以实体化文本出现", async () => {
    setPasswords();
    const day = shiftDay(today(), 1);
    newEvent(f.callers.mama, { title: `<img src=x onerror=alert(1)>`, start: `${day} 08:00` });
    const { body } = await getAs("mama", `/calendar?start=${day}&end=${day}`);
    assert.equal(body.includes("<img src=x"), false, "可执行标签绝不能进 HTML");
    assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  it("同源断言:页面渲染的日程 id 集合 == domain 的 family + mine 结果集合", async () => {
    setPasswords();
    const start = shiftDay(today(), -3);
    const end = shiftDay(today(), 3);
    newEvent(f.callers.mama, { title: "全家晚饭", start: `${shiftDay(today(), 1)} 18:00` });
    newEvent(f.callers.mama, { title: "我自己的事", start: `${shiftDay(today(), 1)} 20:00`, owner: f.members.mama.name });
    newEvent(f.callers.baba, { title: "别人的事", start: `${shiftDay(today(), 1)} 21:00`, owner: f.members.baba.name });

    const viewer: Viewer = { ...f.callers.mama, source: "web" };
    const family = listEvents(f.db, viewer, TZ, { start, end, scope: "family" });
    const mine = listEvents(f.db, viewer, TZ, { start, end, scope: "mine" });
    ok(family, "listEvents family");
    ok(mine, "listEvents mine");
    const expectedIds = [
      ...((family.data as { family: EventView[] }).family),
      ...((mine.data as { mine: EventView[] }).mine),
    ].map((e) => e.id);

    const { body } = await getAs("mama", `/calendar?start=${start}&end=${end}`);
    assert.deepEqual(
      idsIn(body, "event"),
      expectedIds.sort(),
      "页面渲染的日程 id 集合必须与 domain 的 family+mine 结果集合相等",
    );
    assert.equal(body.includes("别人的事"), false, "集合相等:不在 domain 结果里的日程一条都不该出现");
  });

  it("缺省窗口是本周(周一至周日,含今天)", async () => {
    setPasswords();
    const res = await app.inject({ method: "GET", url: "/calendar" });
    assert.equal(res.statusCode, 302, "未登录仍走 302");
    const { body } = await getAs("mama", "/calendar");
    // 页面把窗口写在标题下:YYYY-MM-DD 至 YYYY-MM-DD
    const m = /(\d{4}-\d{2}-\d{2}) 至 (\d{4}-\d{2}-\d{2})/.exec(body);
    assert.ok(m, "页面应显示窗口起止");
    const wd = new Date(`${today()}T00:00:00Z`).getUTCDay();
    const expectStart = shiftDay(today(), wd === 0 ? -6 : wd - 1);
    assert.equal(m![1], expectStart, "缺省窗口起点应是本周周一");
    assert.equal(m![2], shiftDay(expectStart, 6), "缺省窗口终点应是本周周日");
  });
});

// ────────────────────────── /ledger:双账本 + 归属人筛选 ──────────────────────────

describe("/ledger:共享账本 + 我的个人账本,他人私账不可见不可切换", () => {
  function newEntry(viewer: Viewer, input: Parameters<typeof addEntry>[3]): void {
    const env = addEntry(f.db, viewer, TZ, input);
    ok(env, "记一笔");
  }

  it("缺省是共享账本:全家可见,本人个人账本不混进来", async () => {
    setPasswords();
    newEntry(f.callers.mama, { member_id: f.members.mama.name, type: "expense", amount_fen: 3500, note: "买菜" });
    newEntry(f.callers.mama, { member_id: f.members.mama.name, ledger: "personal", type: "expense", amount_fen: 9900, note: "偷偷存的私房钱" });

    const { body } = await getAs("mama", "/ledger");
    assert.match(body, /¥35\.00/, "共享账本流水应出现");
    assert.equal(body.includes("偷偷存的私房钱"), false, "个人账本不该混进缺省视图");
    assert.equal(body.includes("¥99.00"), false);
  });

  it("?ledger=personal 只给本人那份,且标明仅本人可见", async () => {
    setPasswords();
    newEntry(f.callers.mama, { member_id: f.members.mama.name, ledger: "personal", type: "expense", amount_fen: 9900, note: "我的私房钱" });
    newEntry(f.callers.mama, { member_id: f.members.mama.name, type: "expense", amount_fen: 3500, note: "买菜" });

    const { body } = await getAs("mama", "/ledger?ledger=personal");
    assert.match(body, /我的私房钱/, "本人个人账本可见");
    assert.equal(body.includes("买菜"), false, "个人账本视图里不该混共享账本");
    assert.match(body, /仅我可见/);
  });

  it("显式要他人私账 → 未授权提示;页面里不含他的金额与备注(不得静默空表)", async () => {
    setPasswords();
    newEntry(f.callers.baba, { member_id: f.members.baba.name, ledger: "personal", type: "expense", amount_fen: 888800, note: "老公的秘密开支" });

    const { body } = await getAs("mama", `/ledger?ledger=personal&member=${encodeURIComponent(f.members.baba.name)}`);
    assert.match(body, /没有权限/, "必须明确说没有权限,不能给一张空表(V5)");
    assert.match(body, /仅归属人本人可见/);
    assert.equal(body.includes("8888"), false, "金额不得出现在未授权页面里(任何形式)");
    assert.equal(body.includes("老公的秘密开支"), false, "备注不得出现在未授权页面里");
    assert.equal(body.includes("¥8,888.00"), false);
  });

  it("页面上不存在任何「切换到他人账本」的入口", async () => {
    setPasswords();
    const { body } = await getAs("mama", "/ledger");
    // 共享账本下的归属人筛选可以有;但 personal + 他人 的组合一个都不该出现
    const links = [...body.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    for (const link of links) {
      const hasOtherPersonal = link.includes("ledger=personal") && (link.includes("member=%E7%88%B7%E7%88%B8") || link.includes("member=%E5%B0%8F%E6%98%8E"));
      assert.equal(hasOtherPersonal, false, `页面渲染了指向他人私账的入口:${link}`);
    }
    // 个人账本视图里干脆连"按归属人筛选"都不渲染
    const personal = await getAs("mama", "/ledger?ledger=personal");
    assert.equal(personal.body.includes("按归属人筛选"), false, "个人账本下渲染归属人筛选 = 提供看别人私账的入口");
  });

  it("HTML 转义:备注里的 <script> 只以实体化文本出现", async () => {
    setPasswords();
    newEntry(f.callers.mama, {
      member_id: f.members.mama.name,
      type: "expense",
      amount_fen: 100,
      note: `<script>alert('xss')</script>`,
    });
    const { body } = await getAs("mama", "/ledger");
    assert.equal(body.includes("<script>alert"), false, "可执行标签绝不能进 HTML");
    // 单引号也必须转义(转义表覆盖 5 个字符):期望的是**逐字符**实体化后的文本。
    assert.match(body, /&lt;script&gt;alert\(&#39;xss&#39;\)&lt;\/script&gt;/);
  });

  it("同源断言:页面流水 id/金额集合 == 直接调 listEntries 的结果集合", async () => {
    setPasswords();
    newEntry(f.callers.mama, { member_id: f.members.mama.name, type: "expense", amount_fen: 3500, note: "买菜" });
    newEntry(f.callers.baba, { member_id: f.members.baba.name, type: "expense", amount_fen: 1200, note: "公交" });
    newEntry(f.callers.mama, { member_id: f.members.mama.name, type: "income", amount_fen: 500000, note: "工资" });

    const viewer: Viewer = { ...f.callers.mama, source: "web" };
    const env = listEntries(f.db, viewer, TZ, { ledger: "shared" });
    ok(env, "直调 listEntries");
    const expected = (env.data as { entries: EntryView[] }).entries;
    assert.equal(expected.length, 3, "前提:共享账本 3 笔全家可见(V2)");

    const { body } = await getAs("mama", "/ledger");
    assert.deepEqual(
      idsIn(body, "entry"),
      expected.map((e) => e.id).sort(),
      "页面渲染的流水 id 集合必须与 domain 返回的集合相等(不多不少)",
    );
    // 逐笔的备注与金额也在页面上(页面不做任何加总,金额只是格式化 domain 的结果)
    for (const e of expected) {
      assert.ok(body.includes(e.note ?? ""), `页面缺 domain 给出的流水备注:${e.id}`);
    }
    assert.match(body, /¥5,000\.00/, "合计与金额都由 domain 的 SQL SUM 给出,页面只格式化");
    assert.match(body, /本月流水\(3\)/, "页面列出的条数应与 domain 一致");
  });

  it("?member= 是归属人筛选(共享账本内),不是「看谁的私账」", async () => {
    setPasswords();
    newEntry(f.callers.mama, { member_id: f.members.mama.name, type: "expense", amount_fen: 3500, note: "妈妈买菜" });
    newEntry(f.callers.baba, { member_id: f.members.baba.name, type: "expense", amount_fen: 1200, note: "爸爸公交" });

    const { body } = await getAs("mama", `/ledger?member=${encodeURIComponent(f.members.mama.name)}`);
    assert.match(body, /妈妈买菜/);
    assert.equal(body.includes("爸爸公交"), false, "筛了妈妈就该只剩妈妈的流水");
  });
});

// ───────────────────────── 只读性与页面纪律 ─────────────────────────

describe("查看页只读:页面不写库(审计与业务表都不变)", () => {
  it("把三个页面各读一遍(含日程惰性续期之外)不产生任何审计行", async () => {
    setPasswords();
    addTodo(f.db, f.callers.mama, TZ, { title: "交物业费" });
    const auditCount = () => (f.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
    const before = auditCount();
    await getAs("mama", "/todos");
    await getAs("mama", "/calendar");
    await getAs("mama", "/ledger");
    await getAs("mama", "/ledger?ledger=personal");
    assert.equal(auditCount(), before, "查看页是读:不记审计(§6「只记写操作」)");
  });

  it("只读:页面上没有任何 POST 到写路径的表单(除退出登录)", async () => {
    setPasswords();
    for (const [key, path] of [
      ["mama", "/todos"],
      ["mama", "/calendar"],
      ["mama", "/ledger"],
    ] as const) {
      const { cookie } = await login(key);
      const res = await app.inject({ method: "GET", url: path, headers: { cookie } });
      const forms = [...res.body.matchAll(/<form[^>]*method="post"[^>]*action="([^"]*)"/g)].map((m) => m[1]!);
      for (const action of forms) {
        assert.ok(
          action === "/logout",
          `${path} 上出现了写操作表单(POST ${action}):页面必须只读,写走对话(§6)`,
        );
      }
    }
  });

  it("查看页自己没有意外的写路由:除 POST /login 与 POST /logout 外,不存在可用的写端点", async () => {
    setPasswords();
    const { cookie } = await login("mama");
    // **不含 `/admin`**:S6b 起管理页在同一 app 上注册了 `/admin/*` 的写路由,
    // "查看页只读"这条纪律约束的是**查看页自己的那几条路由**。
    // 管理页的写路由由另一套闸门把守(管理口令 + 独立会话,见 test/admin.test.ts:
    // 拿成员会话 cookie 调 /admin/* 一律被拒),那才是它们该被断言的地方。
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      for (const path of ["/todos", "/calendar", "/ledger", "/entries", "/events", "/healthz"]) {
        const res = await app.inject({
          method,
          url: path,
          headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
          payload: "title=注入",
        });
        assert.ok(
          res.statusCode === 404 || res.statusCode === 405,
          `${method} ${path} 返回 ${res.statusCode}:查看页不该有任何写端点`,
        );
      }
    }
  });

  it("所有页面都是 text/html; charset=utf-8", async () => {
    setPasswords();
    for (const path of ["/login", "/todos", "/calendar", "/ledger"]) {
      const { cookie } = await login("mama");
      const res = await app.inject({ method: "GET", url: path, headers: path === "/login" ? {} : { cookie } });
      assert.match(String(res.headers["content-type"]), /text\/html; charset=utf-8/, `${path} 的 Content-Type 不对`);
    }
  });
});

// ─────────────────────── 绑定地址与配置(静态面) ───────────────────────

describe("双门面的绑定地址与配置", () => {
  it("FA_WEB_HOST 缺省 127.0.0.1(缺省即不对外),端口缺省 8348", () => {
    const c = loadConfig({});
    assert.equal(c.webHost, "127.0.0.1", "查看页缺省必须绑回环:忘了配的后果是打不开,而不是数据对外");
    assert.equal(c.webPort, 8348);
    // /mcp 那一侧不受影响:仍是回环(D2)
    assert.equal(c.mcpHost, "127.0.0.1");
    assert.equal(c.mcpPort, 8347);
  });

  it("FA_WEB_HOST 可显式设成局域网网卡地址(此时 webHost 随之改变,mcpHost 不变)", () => {
    const c = loadConfig({ FA_WEB_HOST: "192.168.1.23" });
    assert.equal(c.webHost, "192.168.1.23", "需要局域网访问时必须显式配置");
    assert.equal(c.mcpHost, "127.0.0.1", "配了查看页也不许把 /mcp 改成对外");
  });

  it("查看页门面与 /mcp 门面是同一个进程的两个 build 函数(测试不监听端口)", () => {
    assert.equal(typeof buildWebServer, "function");
    // 断言本文件全程没 listen 过:app.inject 能跑通即是证据
    assert.equal(app.server.listening, false, "测试不得起真实监听端口");
  });
});

// ─────────────────────────── 转义函数的单元断言 ───────────────────────────

describe("HTML 转义原语", () => {
  it("五个字符全转义,且不改可读中文", () => {
    assert.equal(h("<"), "&lt;");
    assert.equal(h(">"), "&gt;");
    assert.equal(h("&"), "&amp;");
    assert.equal(h('"'), "&quot;");
    assert.equal(h("'"), "&#39;");
    assert.equal(h("交物业费 & 买菜"), "交物业费 &amp; 买菜");
    // 幂等性不是要求(双重转义会显示 &amp;amp;),但不能把中文改掉
    assert.equal(h("妈妈"), "妈妈");
  });
});
