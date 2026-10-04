import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { registerAdminRoutes } from "../admin/http.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { todayInTz } from "../db/id.js";
import { listActiveMembers } from "../domain/members.js";
import type { Viewer } from "../domain/viewer.js";
import {
  attemptLogin,
  clearSessionCookieHeader,
  hasWebPassword,
  LoginThrottle,
  LOGIN_MAX_FAILURES,
  readSessionCookie,
  sessionCookieHeader,
  signSession,
  viewerFromSession,
} from "./auth.js";
import { h, HTML_CONTENT_TYPE, layout, query } from "./html.js";
import { renderCalendar, renderLedger, renderTodos, resolveWindow } from "./pages.js";

/**
 * 查看页的 HTTP 门面(设计方案 §2「同一进程两个 HTTP 门面」、§6)。
 *
 * ## 绑定地址由配置决定,缺省只绑回环
 * `FA_WEB_HOST` 缺省 `127.0.0.1` —— **缺省即不对外**:同机部署时查看页没有任何对外的理由,
 * "忘了配"的后果必须是"家人手机打不开",而不是"家庭数据挂到整个局域网"。
 * 需要局域网访问时显式设成网卡地址(`FA_WEB_HOST=192.168.x.x`)。
 * `/mcp` 那个门面**不受影响**:它继续只绑 127.0.0.1(D2)。
 *
 * ## 加固清单(§6「查看页与管理页的加固」)
 * 1. 口令哈希存储、**无默认口令** —— 见 ./auth.ts(没设口令的成员无法登录,并得到明确提示)。
 * 2. 登录失败限速与锁定 —— `LoginThrottle`;阈值/时长都是具名常量,话术直接引用常量不另抄一份。
 * 3. 会话 cookie:`HttpOnly` + `SameSite=Lax` + `Path=/`,签名密钥**存库**(迁移 v4)。
 * 4. **所有输出做 HTML 转义** —— 动态值一律经 ./html.ts 的 `h()`。
 * 5. 页面只读:除 `POST /logout` 清 cookie 外**没有任何写路由**,数据一律经 domain 的读函数。
 *    (S6b 起这个"只读"只约束**查看页自己的那几条路由**;管理页的写路由挂在 `/admin/*` 前缀下,
 *    见文件末的 `registerAdminRoutes`。)
 * 6. 未登录访问受保护页面 → **302 到 /login 并带原路径**,登录后回跳。
 *
 * ## 为什么导出 `buildWebServer`(而不是只导 listen)
 * 测试用 `app.inject()` 发请求,**不起真实端口**(与 src/mcp/http.ts 同一做法)。
 *
 * ## S6b:管理页挂在这同一个 app 上
 * `registerAdminRoutes` 把 `/admin/*` 注册到**同一个实例** —— 于是管理页与查看页
 * 共用 `FA_WEB_HOST` 这一个绑定地址,没有第二个监听口(红线:不得把管理页暴露到回环之外)。
 */
export function buildWebServer(db: Db, config: AppConfig): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.FA_LOG_LEVEL ?? "info",
      // 会话 cookie 是凭据、请求体里是口令:两者都不许进日志(§6「不要把口令写进日志」)。
      redact: ["req.headers.cookie", "res.headers['set-cookie']", "req.body.password"],
    },
  });
  const throttle = new LoginThrottle();

  // 表单解析:登录与退出都是普通表单。body 上限 16 KB,登录页只有三个字段。
  app.addContentTypeParser<string>(
    ["application/x-www-form-urlencoded", "multipart/form-data"],
    { parseAs: "string", bodyLimit: 16 * 1024 },
    (_req, body, done) => {
      const out: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(body)) out[k] = v;
      done(null, out);
    },
  );

  /** 回一个 HTML 页面(统一 Content-Type 与首尾换行)。 */
  function sendHtml(reply: FastifyReply, html: string): FastifyReply {
    return reply.type(HTML_CONTENT_TYPE).send(`\n${html}\n`);
  }

  /** 当前登录者;没有有效会话 → null。**不带 cookie 一律视为未登录**(§6)。 */
  function currentViewer(req: FastifyRequest): Viewer | null {
    const value = readSessionCookie(req.headers.cookie);
    return value === null ? null : viewerFromSession(db, value);
  }

  /**
   * 受保护页面的入口闸门。未登录 → **302 到 /login 并带上原路径**,登录后回跳。
   *
   * 为什么是 302 而不是 401:这是**给浏览器用的页面**,家人点开链接时要的是
   * "被送去登录页";401 会让浏览器显示一段无用的错误正文。401 留给 API 语境。
   */
  async function requireViewer(req: FastifyRequest, reply: FastifyReply): Promise<Viewer | null> {
    const viewer = currentViewer(req);
    if (viewer !== null) return viewer;
    const next = req.url.startsWith("/") ? req.url : `/${req.url}`;
    // 先 await 完再返回 null:直接把 send() 的返回值(一个 reply 对象)透出去会被
    // 调用方当成"viewer 非空"而继续渲染 —— 那等于把未登录请求送进 domain 层。
    await reply.code(302).header("location", `/login${query({ next })}`).send();
    return null;
  }

  // ─────────────────────────── 健康探测(免登录) ───────────────────────────

  /**
   * `GET /healthz`:进程存活 + DB 可读 + 服务端时间。**不需要登录**。
   *
   * 因此**绝不含任何成员数据**(家人名单、代记情况、待办条数都不许出现):
   * 免登录的端点一旦带上成员信息,就成了绕过登录读数据的通道。
   * DB 可读性只用 `SELECT 1`(能查即活着)—— 刻意不去 COUNT member 表,
   * 那是"读成员数据",哪怕只是个计数。
   */
  app.get("/healthz", async (_req, reply) => {
    let dbReadable = false;
    try {
      db.prepare("SELECT 1 AS ok").get();
      dbReadable = true;
    } catch {
      dbReadable = false;
    }
    return reply.code(dbReadable ? 200 : 503).send({
      ok: dbReadable,
      service: "family-assistant",
      facade: "web",
      db: dbReadable ? "readable" : "unreadable",
      now: new Date().toISOString(),
      timezone: config.timezone,
    });
  });

  // ─────────────────────────── 登录 / 退出 ───────────────────────────

  /**
   * `GET /login`:成员下拉 + 口令框。
   *
   * 未设口令的成员**照样列出来但标注"(未设置密码)"** —— 藏起来等于"成员不存在",
   * 家人会以为系统坏了;列出来并让他选,登录时才给明确指引(§6:不得有默认口令,
   * 未设过密码的成员**无法登录**)。
   */
  app.get("/login", async (req, reply) => {
    const q = req.query as { next?: string; denied?: string };
    // 已登录还来登录页 → 直接回原页面,不给人"再登一次"的机会。
    const viewer = currentViewer(req);
    if (viewer !== null) return reply.code(302).header("location", safeNext(q.next)).send();

    const options = listActiveMembers(db)
      .map((m) => `<option value="${h(m.name)}">${h(m.name)}${hasWebPassword(db, m.id) ? "" : "(未设置密码)"}</option>`)
      .join("");
    const content = `<h1>家庭助手 · 登录</h1>
${q.denied === "1" ? `<div class="denied">登录失败:成员名或密码不对。</div>` : ""}
<form method="post" action="/login">
  <p><label>成员 <select name="member">${options}</select></label></p>
  <p><label>密码 <input type="password" name="password" autocomplete="current-password" required></label></p>
  <input type="hidden" name="next" value="${h(q.next ?? "")}">
  <p><button type="submit">登录</button></p>
</form>
<p class="meta">还没设查看页密码?让管理员执行 <code>npm run admin -- member set-password &lt;成员&gt;</code>(不给 --password 时会随机生成并只显示一次)。本页只读:增删改一律走对话。</p>`;
    return sendHtml(reply, layout({ title: "登录", viewer: null, content }));
  });

  /**
   * `POST /login`:口令校验在 domain 的成员解析之上,成功后下发签名 cookie。
   *
   * **失败一律不回显口令**,也不区分"成员不存在 / 口令错 / 未设口令"之外的信息给攻击者:
   * 前两种都说"成员名或密码不对"。唯一例外是 `no_password` —— 那不是凭据线索而是
   * 操作指引(§6 明确要求提示"请让管理员先设置你的查看页密码"),且成员名单本来就在下拉里。
   * 锁定(429)是第三种:必须说清还要等多久,那是给人的操作指引。
   */
  app.post("/login", async (req, reply) => {
    const body = (req.body ?? {}) as { member?: string; password?: string; next?: string };
    const result = attemptLogin(db, throttle, {
      ip: req.ip ?? "unknown",
      memberRef: (body.member ?? "").trim(),
      password: body.password ?? "",
    });

    if (!result.ok) {
      if (result.kind === "locked") {
        const mins = Math.max(1, Math.ceil((result.retryAfterMs ?? 0) / 60_000));
        const content = `<h1>家庭助手 · 登录</h1>
<div class="denied">登录失败次数过多,已临时锁定。请在 <strong>${h(String(mins))} 分钟</strong>后再试(连续输错 ${h(String(LOGIN_MAX_FAILURES))} 次即锁定)。</div>
<p class="tabs"><a href="/login">返回登录页</a></p>`;
        return reply.code(429).type(HTML_CONTENT_TYPE).send(`\n${layout({ title: "已锁定", viewer: null, content })}\n`);
      }
      const hint =
        result.kind === "no_password"
          ? "请让管理员先设置你的查看页密码。"
          : // 成员不存在与口令错**话术逐字相同**:登录页本来就把成员名列在下拉里,
            // 再用不同措辞区分"没有这个成员 / 口令不对"只是白送一个成员名枚举器。
            "成员名或密码不对。";
      const content = `<h1>家庭助手 · 登录</h1>
<div class="denied">${h(hint)}</div>
<p class="tabs"><a href="/login">再试一次</a></p>`;
      return reply.code(401).type(HTML_CONTENT_TYPE).send(`\n${layout({ title: "登录失败", viewer: null, content })}\n`);
    }

    reply.header("set-cookie", sessionCookieHeader(signSession(db, result.viewer.memberId)));
    return reply.code(302).header("location", safeNext(body.next)).send();
  });

  /**
   * `POST /logout`:清 cookie。
   * **用 POST 而不是 GET** —— GET 改状态意味着"点一个链接 / 一次预加载"就能把家人登出(§6)。
   */
  app.post("/logout", async (_req, reply) => {
    reply.header("set-cookie", clearSessionCookieHeader());
    return reply.code(302).header("location", "/login").send();
  });

  // ─────────────────────────── 三个只读页面 ───────────────────────────

  app.get("/todos", async (req, reply) => {
    const viewer = await requireViewer(req, reply);
    if (viewer === null) return reply;
    return sendHtml(reply, renderTodos(db, viewer, config.timezone));
  });

  app.get("/calendar", async (req, reply) => {
    const viewer = await requireViewer(req, reply);
    if (viewer === null) return reply;
    const q = req.query as { start?: string; end?: string };
    const window = resolveWindow(q.start, q.end, todayInTz(config.timezone));
    return sendHtml(reply, renderCalendar(db, viewer, config.timezone, window));
  });

  /**
   * `/ledger`:缺省共享账本;`?ledger=personal` 只给本人。
   * **显式要他人私账**(`?ledger=personal&member=他人`)由 domain 判成 `DENIED(not_visible)`,
   * 页面渲染成明确的未授权提示(403 语义),**绝不静默显示空表** —— 见 renderLedger。
   */
  app.get("/ledger", async (req, reply) => {
    const viewer = await requireViewer(req, reply);
    if (viewer === null) return reply;
    const q = req.query as { ledger?: string; member?: string };
    const kind: "shared" | "personal" = q.ledger === "personal" ? "personal" : "shared";
    const member = q.member === undefined || q.member === "" ? null : q.member;
    return sendHtml(reply, renderLedger(db, viewer, config.timezone, kind, member));
  });

  /** 根路径:已登录去 /todos,未登录去 /login。 */
  app.get("/", async (req, reply) => {
    const viewer = currentViewer(req);
    return reply.code(302).header("location", viewer === null ? "/login" : "/todos").send();
  });

  // ─────────────────────────── 管理页(S6b)───────────────────────────
  //
  // **注册在同一个 app 上**,所以管理页与查看页共用同一个绑定地址(`FA_WEB_HOST`)——
  // 没有"管理页独立监听 0.0.0.0"这样的口子(红线)。缺省仍是回环。
  //
  // 路由顺序上管理页排在最后:两套门面路径前缀不重叠(`/admin/*` vs `/todos` 等),
  // 所以顺序不影响路由匹配;但把一个更宽的面板放在后面,读代码时不容易把它
  // 误当成"查看页也能进的路径"。
  registerAdminRoutes(app, db, config);

  return app;
}

/**
 * 回跳地址的白名单化:`?next=` 是**用户可控输入**,直接拿去当 Location 就是开放重定向
 * (别人发一条 `/login?next=http://evil.example`,家人登录后就被带走)。
 * 只接受**站内绝对路径**;其余一律落到 /todos。
 */
function safeNext(next: string | undefined): string {
  if (next === undefined || next === "") return "/todos";
  if (!next.startsWith("/")) return "/todos";
  if (next.startsWith("//")) return "/todos"; // `//evil.example` 是协议相对 URL
  if (next.includes("\\")) return "/todos";
  return next;
}

export async function startWebServer(db: Db, config: AppConfig): Promise<FastifyInstance> {
  const app = buildWebServer(db, config);
  await app.listen({ port: config.webPort, host: config.webHost });
  return app;
}
