import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { issueToken, revokeToken } from "../domain/auth.js";
import { failEnvelope, okEnvelope, type Envelope } from "../domain/envelope.js";
import { addCategory, type CategoryKind } from "../domain/ledger.js";
import { createMember, resolveMemberRef, softDeleteMember, updateMemberAliases } from "../domain/members.js";
import { generateWebPassword, LoginThrottle, setMemberWebPassword } from "../web/auth.js";
import {
  ADMIN_LOGIN_LOCKOUT_MS,
  ADMIN_LOGIN_MAX_FAILURES,
  ADMIN_SET_PASSWORD_HINT,
  adminFromSession,
  adminSessionCookieHeader,
  attemptAdminLogin,
  clearAdminSessionCookieHeader,
  hasAdminPassword,
  readAdminSessionCookie,
  signAdminSession,
} from "../web/admin-auth.js";
import { auditValue, recordAdminAudit } from "./audit.js";
import { createBackup } from "./backup.js";
import { adminHealth, recordBackupAt } from "./health.js";
import {
  AUDIT_PAGE_DEFAULT,
  AUDIT_PAGE_MAX,
  renderAdminAudit,
  renderAdminBackup,
  renderAdminCategories,
  renderAdminHealth,
  renderAdminLogin,
  renderAdminMembers,
  renderAdminNotConfigured,
  renderAdminOneTime,
  renderAdminOverview,
  renderAdminTokens,
} from "./pages.js";
import { hermesProfileSnippet } from "./profile.js";
import { HTML_CONTENT_TYPE } from "../web/html.js";

/**
 * 管理页的 HTTP 门面(S6b)。
 *
 * ## 绑定:与查看页**同一个 Fastify 实例**,因此同一个 `FA_WEB_HOST`
 * 没有"管理页独立监听 0.0.0.0"这样的口子(红线)。要在局域网用管理页,必须显式配
 * `FA_WEB_HOST`;缺省仍是回环,也就是"忘了配"的后果是打不开,而不是把运维入口挂到局域网。
 *
 * ## 三道闸,顺序固定
 * 1. **未设管理口令 → 503**(`onRequest` 钩子,覆盖每一个 `/admin` 路由,含登录页自己)。
 *    设计 §6 加固①"不得存在默认口令";503 的语义是"这个服务暂时不可用,因为还缺一次配置" ——
 *    返回登录页会让人以为口令错了,403 会让人以为没权限,都把"还缺配置"说歪了。
 *    **这道闸同时意味着管理页自己不是设置入口**:"打开管理页给自己开门"等于绕过口令。
 * 2. **会话校验**:管理会话 cookie(`fa_admin_session`,独立名字/密钥/载荷格式,见 ../web/admin-auth.ts)。
 *    没带或验不过 → 302 到 `/admin/login`。**查看页的 `fa_session` 一律不被认**(三重隔离)。
 * 3. **登录限速**:按来源 IP,连续失败 `ADMIN_LOGIN_MAX_FAILURES` 次锁定 `ADMIN_LOGIN_LOCKOUT_MS`。
 *    与查看页**分开的限速器实例**:否则"家人输错 5 次"会和管理端的桶混在一起,阈值也就没有意义了。
 *
 * ## 写操作:一律调用**已有的 domain 函数**
 * 建成员 `createMember`、改别名 `updateMemberAliases`、软删 `softDeleteMember`、
 * 建分类 `addCategory`(与 MCP 工具 `add_category` 同一个实现)、发/吊 token `issueToken`/`revokeToken`、
 * 设查看页口令 `setMemberWebPassword`。**管理页没有自己的业务规则,也不新增任何工具面。**
 * 每个写操作记一条审计,身份固定为 `__admin__` / 管理员。
 *
 * ## 表单一律 POST
 * 写操作不接受 GET:点个链接、一次预加载、一个爬虫都不能建成员或吊销 token。退出也是 POST。
 * 成功后的**普通写操作**回 **303 跳回列表**(PRG:刷新不会重复提交);
 * **只有"要显示一次性明文"的两条**(重置查看页口令、生成 token)直接返回 200 渲染明文 ——
 * 那正是"明文只显示一次"的落点:它只在这一次响应里,刷新(GET)就再也拿不到。
 */
export function registerAdminRoutes(app: FastifyInstance, db: Db, config: AppConfig): void {
  // 管理端限速器:阈值比查看页更紧(3 次 / 30 分钟),且**独立实例** ——
  // 共用实例的话,"家人输错 5 次"会与管理端的桶混在一起,两边的阈值就都没了意义。
  const throttle = new LoginThrottle({
    maxFailures: ADMIN_LOGIN_MAX_FAILURES,
    lockoutMs: ADMIN_LOGIN_LOCKOUT_MS,
  });

  /** POST 表单字段(一律是字符串)。 */
  function form(req: FastifyRequest): Record<string, string> {
    return (req.body ?? {}) as Record<string, string>;
  }

  function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  /** 逗号分隔的别名输入 → 数组(空段丢弃;中文逗号也收,免得输入法打错就静默失效)。 */
  function aliasList(raw: string): string[] {
    return raw
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }

  function sendHtml(reply: FastifyReply, html: string): FastifyReply {
    return reply.type(HTML_CONTENT_TYPE).send(`\n${html}\n`);
  }

  /**
   * 域函数的 `{ok, member}` / `{ok, envelope}` 结果 → 信封(审计与页面提示都用信封)。
   * 成功时 data 放最小信息(成员 id/name),**不放任何凭据**。
   */
  function toEnvelope(
    r: { ok: true; member: { id: string; name: string } } | { ok: false; envelope: Envelope },
    okMessage: (m: { id: string; name: string }) => string,
  ): Envelope {
    return r.ok ? okEnvelope({ id: r.member.id, name: r.member.name }, okMessage(r.member)) : r.envelope;
  }

  // ───────────────────── 第 1 道闸:未设管理口令一律 503 ─────────────────────

  /**
   * 覆盖每一个 `/admin` 路由(含 `/admin/login` 自己)。
   *
   * 不注册这个前缀下的路由时,Fastify 仍会先跑 `onRequest`,所以连"忘了登录"这种状态
   * 都拿不到页面 —— 未配置的管理页**不存在**,不是"存在但进不去"。
   */
  app.addHook("onRequest", async (req, reply) => {
    // 只拦 `/admin` 与 `/admin/...`。**不是 `startsWith("/admin")`**:那会把将来某个
    // 恰好叫 `/adminXYZ` 的路由也拖进这道闸(现在没有,但"将来的"正是这类钩子的风险)。
    if (req.url !== "/admin" && !req.url.startsWith("/admin/")) return;
    if (hasAdminPassword(db)) return;
    await reply
      .code(503)
      .type(HTML_CONTENT_TYPE)
      .header("cache-control", "no-store")
      .send(`\n${renderAdminNotConfigured(ADMIN_SET_PASSWORD_HINT)}\n`);
  });

  // ───────────────────── 登录 / 退出 ─────────────────────

  app.get("/admin/login", async (_req, reply) => sendHtml(reply, renderAdminLogin({})));

  app.post("/admin/login", async (req, reply) => {
    const result = attemptAdminLogin(db, throttle, {
      ip: req.ip ?? "unknown",
      password: form(req).password ?? "",
    });

    if (!result.ok) {
      // 这一分支**不依赖 onRequest 钩子的顺序**:即便将来有人挪动/删掉那道闸,
      // 最坏结果也只是 401,而不是"空口令可进"。纵深防御,不是冗余。
      if (result.kind === "no_password_set") {
        return reply
          .code(503)
          .type(HTML_CONTENT_TYPE)
          .header("cache-control", "no-store")
          .send(`\n${renderAdminNotConfigured(ADMIN_SET_PASSWORD_HINT)}\n`);
      }
      if (result.kind === "locked") {
        const mins = Math.max(1, Math.ceil((result.retryAfterMs ?? 0) / 60_000));
        return reply.code(429).type(HTML_CONTENT_TYPE).send(`\n${renderAdminLogin({ lockedMinutes: mins })}\n`);
      }
      // 口令错就是"口令不对",不区分任何其它细节(这里没有可枚举的用户名,
      // 也不存在"口令正确但账户停用"这类可区分状态)。
      return reply.code(401).type(HTML_CONTENT_TYPE).send(`\n${renderAdminLogin({ denied: true })}\n`);
    }

    reply.header("set-cookie", adminSessionCookieHeader(signAdminSession(db)));
    return reply.code(303).header("location", "/admin").send();
  });

  app.post("/admin/logout", async (_req, reply) => {
    reply.header("set-cookie", clearAdminSessionCookieHeader());
    return reply.code(303).header("location", "/admin/login").send();
  });

  // ───────────────────── 第 2 道闸:会话 ─────────────────────

  /**
   * 受保护页面的入口闸门。没带管理会话(或会话验不过)→ **302 到 /admin/login**。
   *
   * **查看页 cookie 一律不被认**:本函数只读 `fa_admin_session`,连 `fa_session` 的值都不看;
   * 反向也成立(查看页只读 `fa_session`)。cookie 名 + 载荷段数 + 签名密钥三重隔离,
   * 所以"成员会话被当成管理员"在结构上不可表达。
   */
  async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const value = readAdminSessionCookie(req.headers.cookie);
    if (value !== null && adminFromSession(db, value)) return true;
    // **不带回跳参数**:管理端只有一个落点(`/admin` 总览),登录页也不提供"下一跳"输入框 ——
    // 一个没人消费的 `?next=` 只会让人以为登录后能回到原来那一页。
    await reply.code(302).header("location", "/admin/login").send();
    return false;
  }

  /** 写操作成功后的 PRG 跳转(303:改用 GET 重新请求,刷新不会重复提交)。 */
  function seeOther(reply: FastifyReply, location: string): FastifyReply {
    return reply.code(303).header("location", location).send();
  }

  /** 域函数失败 → 把提示画回列表页,并给出 400(调用方是浏览器,所以仍给可读页面而不是纯 JSON)。 */
  function failWith(reply: FastifyReply, env: Envelope, render: (env: Envelope) => string): FastifyReply {
    return reply.code(400).type(HTML_CONTENT_TYPE).send(`\n${render(env)}\n`);
  }

  // ───────────────────── 总览 ─────────────────────

  app.get("/admin", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    return sendHtml(reply, renderAdminOverview(db));
  });

  // ───────────────────── 成员管理 ─────────────────────

  app.get("/admin/members", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    return sendHtml(reply, renderAdminMembers(db, null));
  });

  app.post("/admin/members/add", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const body = form(req);
    const name = text(body.name);
    const aliases = aliasList(body.aliases ?? "");
    // 审计摘要记 name 与 aliases(逐个截断)。
    //
    // **为什么记别名而不是只记个数**:别名是**归属解析的一级**(resolveMemberRef),
    // 正是 X10「归属目标重名」这类配错事故的现场。事后能看出"妈妈在 10-05 多了个别名「二叔」,
    // 而二叔也是爸爸的别名"才算追溯到了根因;只记 `aliases=2` 谁都还原不出这件事。
    // 这与 `add_category` 记 `name=` 是同一条纪律:标识类字段进审计,备注类自由文本不进。
    const summary = `name=${auditValue(name)} aliases=${aliases.map(auditValue).join(",")}`;
    if (name === "") {
      const env = failEnvelope("MISSING_PARAMS", { message: "成员名不能为空。", missing: ["name"] });
      recordAdminAudit(db, "member.add", summary, env);
      return failWith(reply, env, (e) => renderAdminMembers(db, e));
    }
    const created = createMember(db, config.timezone, { name, aliases });
    const env = toEnvelope(created, (m) => `已创建成员「${m.name}」。`);
    recordAdminAudit(db, "member.add", summary, env);
    if (!env.ok) return failWith(reply, env, (e) => renderAdminMembers(db, e));
    return seeOther(reply, "/admin/members");
  });

  app.post("/admin/members/aliases", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const body = form(req);
    const ref = text(body.member);
    const aliases = aliasList(body.aliases ?? "");
    const summary = `member=${auditValue(ref)} aliases=${aliases.map(auditValue).join(",")}`;
    const updated = updateMemberAliases(db, ref, aliases);
    const env = toEnvelope(updated, (m) => `已更新「${m.name}」的别名。`);
    recordAdminAudit(db, "member.aliases", summary, env);
    if (!env.ok) return failWith(reply, env, (e) => renderAdminMembers(db, e));
    return seeOther(reply, "/admin/members");
  });

  app.post("/admin/members/remove", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const ref = text(form(req).member);
    const removed = softDeleteMember(db, ref);
    const env = toEnvelope(removed, (m) => `已软删成员「${m.name}」:名下数据保留,其 token 一并失效。`);
    recordAdminAudit(db, "member.remove", `member=${auditValue(ref)}`, env);
    if (!env.ok) return failWith(reply, env, (e) => renderAdminMembers(db, e));
    return seeOther(reply, "/admin/members");
  });

  /**
   * 重置查看页口令:**直接返回 200 渲染明文**(不跳转)。
   *
   * 明文只在这一次响应里 —— 不写 session、不落库、不进审计。它由 POST 的返回值直接渲染,
   * 刷新(GET)拿不到第二次。
   *
   * 审计只记 `member=<名字>`:**口令(明文或哈希)绝不进审计**。
   */
  app.post("/admin/members/reset-password", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const ref = text(form(req).member);
    const resolved = resolveMemberRef(db, ref);
    if (!resolved.ok) {
      const env =
        resolved.kind === "not_found"
          ? failEnvelope("NOT_FOUND", { message: `没有找到成员「${ref}」。`, id: ref })
          : failEnvelope("AMBIGUOUS", {
              message: `「${ref}」匹配到多位成员,请指明具体是谁。`,
              candidates: resolved.members.map((m) => ({ name: m.name, aliases: m.aliases })),
            });
      recordAdminAudit(db, "member.reset-password", `member=${auditValue(ref)}`, env);
      return failWith(reply, env, (e) => renderAdminMembers(db, e));
    }
    const plain = generateWebPassword();
    setMemberWebPassword(db, resolved.member.id, plain);
    const env = okEnvelope(null, `已重置 ${resolved.member.name} 的查看页口令。`);
    recordAdminAudit(db, "member.reset-password", `member=${auditValue(resolved.member.name)}`, env);
    return reply
      .header("cache-control", "no-store")
      .type(HTML_CONTENT_TYPE)
      .send(
        `\n${renderAdminOneTime({
          title: "查看页口令已重置",
          lead: `${resolved.member.name} 的新查看页口令(随机生成)。明文只在这里出现一次,之后无法从库里取回 —— 请立刻抄下来交给本人。`,
          plain,
          snippet: null,
          footnote:
            "该成员已有的查看页会话已一并失效(会话校验要求口令仍存在)。" +
            "库里只存 scrypt 哈希。局域网内没有 HTTPS,口令以明文经过 Wi-Fi(设计 §10 R9)。",
        })}\n`,
      );
  });

  // ───────────────────── token(按成员)─────────────────────

  app.get("/admin/tokens", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    return sendHtml(reply, renderAdminTokens(db, null));
  });

  /**
   * 为成员生成新 token:**明文 + profile 配置片段只在这一个响应里**(200,不跳转)。
   *
   * 审计记的是 **token id**,不是明文、更不是哈希:`token_id` 足够追溯"谁在什么时候给谁签发了什么",
   * 而明文进审计表就等于把凭据抄进了一份 append-only 的、任何人都能读的文件。
   */
  app.post("/admin/tokens/issue", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const body = form(req);
    const ref = text(body.member);
    const label = text(body.label) || "hermes profile";
    const resolved = resolveMemberRef(db, ref);
    if (!resolved.ok) {
      const env =
        resolved.kind === "not_found"
          ? failEnvelope("NOT_FOUND", { message: `没有找到成员「${ref}」。`, id: ref })
          : failEnvelope("AMBIGUOUS", {
              message: `「${ref}」匹配到多位成员,请指明具体是谁。`,
              candidates: resolved.members.map((m) => ({ name: m.name, aliases: m.aliases })),
            });
      recordAdminAudit(db, "token.issue", `member=${auditValue(ref)}`, env);
      return failWith(reply, env, (e) => renderAdminTokens(db, e));
    }
    const issued = issueToken(db, resolved.member.id, label);
    const env = okEnvelope(null, `已为 ${resolved.member.name} 生成 token(${issued.id})。`);
    recordAdminAudit(db, "token.issue", `member=${auditValue(resolved.member.name)} label=${auditValue(label)} token_id=${auditValue(issued.id)}`, env);
    // `cache-control: no-store`:一次性的 token 明文绝不能被浏览器/中间代理缓存下来
    // (那等于把凭据留在磁盘缓存里,与"只显示一次"的承诺直接矛盾)。
    return reply
      .header("cache-control", "no-store")
      .type(HTML_CONTENT_TYPE)
      .send(
        `\n${renderAdminOneTime({
          title: "token 已生成",
          lead: `${resolved.member.name} 的 family token(id: ${issued.id};明文只在这里出现一次;库里只存 SHA-256)。请立刻复制下面两段:token 本体,以及可直接粘贴的 Hermes profile 配置片段。`,
          plain: issued.token,
          snippet: hermesProfileSnippet({
            config,
            memberName: resolved.member.name,
            memberId: resolved.member.id,
            token: issued.token,
          }),
          footnote:
            "两个头(Authorization 与身份声明头)都必须填,少填声明头会静默串号(BUG B1)," +
            "配错则下一次调用响亮失败 DENIED(identity_mismatch)。刷新本页拿不到第二次明文。",
        })}\n`,
      );
  });

  app.post("/admin/tokens/revoke", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const tokenId = text(form(req).token);
    if (tokenId === "") {
      const env = failEnvelope("MISSING_PARAMS", { message: "缺少 token id。", missing: ["token"] });
      recordAdminAudit(db, "token.revoke", "token_id=", env);
      return failWith(reply, env, (e) => renderAdminTokens(db, e));
    }
    const done = revokeToken(db, tokenId);
    // token id 不是秘密(它是吊销要用的标识,页面上也显示着),所以可以进审计。
    const env = done
      ? okEnvelope(null, `已吊销 token ${tokenId}。`)
      : failEnvelope("NOT_FOUND", { message: `没有找到可吊销的 token:${tokenId}。`, id: tokenId });
    recordAdminAudit(db, "token.revoke", `token_id=${auditValue(tokenId)}`, env);
    if (!done) return failWith(reply, env, (e) => renderAdminTokens(db, e));
    return seeOther(reply, "/admin/tokens");
  });

  // ───────────────────── 分类 ─────────────────────

  app.get("/admin/categories", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    return sendHtml(reply, renderAdminCategories(db, null));
  });

  app.post("/admin/categories/add", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const body = form(req);
    const name = text(body.name);
    const kindRaw = text(body.kind);
    const kind: CategoryKind = kindRaw === "income" ? "income" : "expense";
    // 与 MCP 的 add_category 同一个域函数:同名同类冲突的话术、已有的分类 id 提示
    // 全部来自那里,页面上显示的与 CLI/Agent 看到的是逐字同一句。
    const env = addCategory(db, ADMIN_PAGE_VIEWER, config.timezone, { name, kind });
    recordAdminAudit(db, "category.add", `name=${auditValue(name)} kind=${kind}`, env);
    if (!env.ok) return failWith(reply, env, (e) => renderAdminCategories(db, e));
    return seeOther(reply, "/admin/categories");
  });

  // ───────────────────── 审计日志 ─────────────────────

  app.get("/admin/audit", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const q = req.query as { limit?: string };
    const raw = Number(q.limit);
    const hasLimit = q.limit !== undefined && Number.isInteger(raw) && raw > 0;
    const capped = hasLimit && raw > AUDIT_PAGE_MAX;
    // **上限是硬的**:N 可查询、但必须有上限(任务书)。给上限不是"省流量",
    // 是不让"limit=999999999"把一整张审计表拉进一个 HTML 页面。
    const effective = hasLimit ? Math.min(raw, AUDIT_PAGE_MAX) : AUDIT_PAGE_DEFAULT;
    return sendHtml(reply, renderAdminAudit(db, effective, capped));
  });

  // ───────────────────── 健康 ─────────────────────

  app.get("/admin/health", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const health = adminHealth(db, config);
    // 同一份数据两种消费:浏览器看渲染页,curl(`Accept: application/json`)拿 JSON。
    const wantsJson = (req.headers.accept ?? "").includes("application/json");
    if (wantsJson) return reply.type("application/json").send(health);
    return sendHtml(reply, renderAdminHealth(JSON.stringify(health, null, 2)));
  });

  // ───────────────────── 备份 ─────────────────────

  app.get("/admin/backup", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const health = adminHealth(db, config);
    const note =
      health.backup.last_backup_at === null
        ? "暂无:还没有下载过备份。R5 的定期备份靠 Hermes cron 或系统 cron,程序内没有定时器。"
        : `上一次下载备份:${health.backup.last_backup_at}(程序不保留备份文件本身)。`;
    return sendHtml(reply, renderAdminBackup(note));
  });

  /**
   * 下载在线备份:`VACUUM INTO` → 临时文件 → 读出字节下发 → **临时文件已在前一步删掉**。
   *
   * **不记审计**:下载整库是**只读**动作,不改变任何业务数据(§6:审计只记写操作)。
   * 唯一留下的痕迹是 `last_backup_at` 这个服务端键值,供健康页显示"最近一次备份时间"。
   *
   * 用 GET 而不是 POST:它是**下载**(幂等的读),URL 不含任何参数,挂在 `<a>` 上才像下载。
   * 所有会改变数据的动作仍然是 POST。
   */
  app.get("/admin/backup/download", async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return reply;
    const backup = createBackup(db);
    recordBackupAt(db);
    return reply
      .type("application/vnd.sqlite3")
      .header("content-disposition", `attachment; filename="${backup.fileName}"`)
      .header("cache-control", "no-store")
      .send(backup.bytes);
  });
}

/**
 * 管理端读分类时用的固定 Viewer。
 *
 * 为什么需要它:`listCategories` 的签名里有 viewer(统一上下文,见 src/domain/viewer.ts 约定 1),
 * 但它**不读 viewer 的任何字段**。传固定身份而不是伪造某个成员,是为了让"这里没有任何家庭成员身份"
 * 在类型上就是真的。
 */
const ADMIN_PAGE_VIEWER = { memberId: "__admin__", memberName: "管理员", source: "web" as const };