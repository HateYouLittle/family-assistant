import type { Db } from "../db/db.js";
import { listAudit } from "../audit/audit.js";
import { listTokens, type TokenRow } from "../domain/auth.js";
import type { Envelope } from "../domain/envelope.js";
import { listCategories, type CategoryKind, type CategoryView } from "../domain/ledger.js";
import { listActiveMembers, type MemberRow } from "../domain/members.js";
import { hasWebPassword } from "../web/auth.js";
import { h, STYLE } from "../web/html.js";

/**
 * 管理页的渲染层(S6b)。
 *
 * ## 纪律:**本文件只做"把已有的东西显示出来 / 把表单变成 domain 调用"**
 * - **不重写任何业务规则**:成员增删改别名走 `src/domain/members.ts`,建分类走
 *   `addCategory`(同一个 MCP 工具 `add_category` 的实现),审计走 `listAudit`。
 *   页面里没有一条自己的校验规则 —— 页面上"响亮报错"的文案全部来自 domain 的信封,
 *   所以 CLI 与页面对同一次操作的提示逐字相同。
 * - **不重写可见性**:管理页是运维入口,看到的是全量数据(成员名单、全部 token、审计)。
 *   它**不读任何家庭业务数据**(不列待办、不列日程、不列流水)—— 想看那些请走查看页,
 *   那里才有 V1–V9 的过滤。两处混在一起会让"管理页能看到全家数据"变成绕过 V1–V9 的后门。
 * - **所有动态值过 `h()`**:成员名、别名、token label、审计摘要都是自由文本,
 *   转义必须是不可绕过的单出口(与查看页同一条纪律)。
 *
 * 明文类输出(token、重置出来的口令)统一用 `.once` 块,并且**只在生成的那一次响应里出现**:
 * 这里不缓存、不落库、不从库里读回。
 */

// ─────────────────────────────────── 外壳 ───────────────────────────────────

/** 管理页的导航(只有已登录的会话才渲染)。与查看页的导航刻意不同,避免混淆。 */
function adminNav(current: string): string {
  const tab = (path: string, label: string) =>
    `<a class="${current === path ? "on" : ""}" href="${path}">${h(label)}</a>`;
  return `<nav>
      ${tab("/admin", "总览")}
      ${tab("/admin/members", "成员")}
      ${tab("/admin/tokens", "token")}
      ${tab("/admin/categories", "分类")}
      ${tab("/admin/audit", "审计")}
      ${tab("/admin/health", "健康")}
      ${tab("/admin/backup", "备份")}
      <form method="post" action="/admin/logout" style="display:inline">
        <button type="submit">退出管理</button>
      </form>
    </nav>`;
}

/**
 * 管理页骨架。
 *
 * 页脚与查看页**故意不同**:查看页写"本页只读:一切写操作走对话",管理页恰恰相反
 * (它是运维入口,写操作都在这里)。若沿用那句话,会让人以为管理页上的表单是 bug。
 * 但 R9 的代价、以及"管理页没有独立监听口"这两条照写 —— 它们是这套加固的一部分。
 */
function adminLayout(args: { title: string; current: string; content: string }): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(args.title)} · 管理页</title>
<style>${STYLE}</style>
</head>
<body>
<header>${adminNav(args.current)}</header>
<main>
${args.content}
</main>
<footer>管理页与查看页共用同一个绑定地址(FA_WEB_HOST),没有独立监听口。局域网内没有 HTTPS,口令以明文经过 Wi-Fi —— 家庭自托管的已知代价(设计 §10 R9)。</footer>
</body>
</html>`;
}

/** 域函数失败信封在页面上的呈现:code + message(+ hint)。响亮、不吞错。 */
function envelopeNotice(env: Envelope): string {
  if (env.ok) return "";
  return `<div class="denied"><strong>${h(env.code)}</strong>:${h(env.message)}${
    env.hint === undefined ? "" : `<div class="meta">${h(env.hint)}</div>`
  }</div>`;
}

// ─────────────────────────────────── 登录页 ───────────────────────────────────

/**
 * `未设置管理口令` 页面(**503**)。
 *
 * 设计 §6 加固①:"不得存在默认口令,首次启动强制设置"。所以这里**没有任何"临时进入"的口子**,
 * 页面明确给出该跑哪条 CLI。管理页自己**不是**设置入口 —— 否则"打开管理页给自己开门"
 * 就等于绕过口令这道闸,那这页就不是保护而是摆设。
 */
export function renderAdminNotConfigured(hint: string): string {
  const content = `<h1>管理页未启用</h1>
<div class="denied">
  <p><strong>还没有设置管理口令,管理页一律 503。</strong></p>
  <p>本系统<strong>没有默认口令</strong>,也不会回落到任何默认口令或空口令(设计方案 §6 加固①)。</p>
  <p>请在运行本服务的机器上执行:</p>
  <pre class="once">${h(hint)}</pre>
  <p class="meta">设置之后回到本页登录。管理口令与查看页口令是两回事:它保护的是运维入口
  (成员管理、family token、整库备份),因此不会经由查看页的成员登录进入。</p>
</div>`;
  return adminLayout({ title: "未设置管理口令", current: "", content });
}

/** 管理登录页。口令框 + 明确说明"这是运维入口"。 */
export function renderAdminLogin(opts: { lockedMinutes?: number; denied?: boolean }): string {
  const content = `<h1>管理页登录</h1>
${opts.lockedMinutes !== undefined ? `<div class="denied">失败次数过多,已临时锁定。请在 <strong>${h(String(opts.lockedMinutes))} 分钟</strong>后再试。</div>` : ""}
${opts.denied === true ? `<div class="denied">管理口令不对。</div>` : ""}
<form method="post" action="/admin/login">
  <p><label>管理口令 <input type="password" name="password" autocomplete="current-password" required></label></p>
  <p><button type="submit">登录管理页</button></p>
</form>
<p class="meta">管理页是**运维入口**:成员管理、按成员生成/吊销 family token、分类、审计日志、
整库备份与健康状态。它日常不碰(设计方案 §6),所以没有"记住我"——会话 1 小时后失效,
口令也不设默认。忘了口令就在服务所在机器上执行 <code>npm run admin -- admin set-password</code>。</p>`;
  return adminLayout({ title: "管理登录", current: "", content });
}

// ─────────────────────────────────── 总览 ───────────────────────────────────

/**
 * 总览页:六个区块的入口 + 关键计数。
 *
 * 刻意**只给计数与状态**,不列任何家庭内容:总览是"运维导航",不是数据出口。
 */
export function renderAdminOverview(db: Db): string {
  const members = listActiveMembers(db);
  const tokens = listTokens(db);
  const active = tokens.filter((t) => t.revoked_at === null).length;
  const cats = categoriesOf(db);
  const content = `<h1>管理页</h1>
<p>这是一个运维入口,日常不碰。下面六块是本阶段做的全部管理能力。</p>
<div class="card">
  <h2>成员(<a href="/admin/members">${h(String(members.length))}</a>)</h2>
  <p class="meta">新增 / 软删 / 维护别名 / 重置查看页口令。名下数据一律保留。</p>
</div>
<div class="card">
  <h2>family token(<a href="/admin/tokens">${h(String(active))} 个有效 / 共 ${h(String(tokens.length))}</a>)</h2>
  <p class="meta">按成员生成与吊销。明文只在生成的那一次响应里出现,库里只存 SHA-256。</p>
</div>
<div class="card">
  <h2>分类(<a href="/admin/categories">${h(String(cats.length))}</a>)</h2>
  <p class="meta">按 kind 分组列出;新增走与 <code>add_category</code> 同一个域函数。</p>
</div>
<div class="card">
  <h2>审计日志(<a href="/admin/audit">最近 ${h(String(AUDIT_PAGE_DEFAULT))} 条</a>)</h2>
  <p class="meta">时间 / 说话人 / 工具 / 关键参数元数据 / 结果码。<strong>不含</strong>备注类自由文本,
  也<strong>不含</strong>任何 token 明文或口令。</p>
</div>
<div class="card">
  <h2>数据备份(<a href="/admin/backup">下载</a>)</h2>
  <p class="meta">用 <code>VACUUM INTO</code> 在线快照到临时文件再下发,<strong>下发后立即清理</strong>,
  临时文件不落在共享目录(WAL 模式下直接拷库文件会丢掉最新数据)。</p>
</div>
<div class="card">
  <h2>健康状态(<a href="/admin/health">查看</a>)</h2>
  <p class="meta">MCP 端点是否在服务、DB 是否可读与文件大小、最近备份时间、cron 最近投递(只读展示)。</p>
</div>
<div class="warn">管理口令:已设置。换口令请在服务所在机器上执行 <code>npm run admin -- admin set-password</code>
(换口令会让已签发的管理会话一并失效)。</div>`;
  return adminLayout({ title: "管理页", current: "/admin", content });
}

// ─────────────────────────────────── 成员管理 ───────────────────────────────────

/** 成员在页面上的形态:附 token 统计与查看页口令状态(§6 要求的四列)。 */
function memberRow(db: Db, m: MemberRow): string {
  const tokens = listTokens(db, m.id);
  const active = tokens.filter((t) => t.revoked_at === null).length;
  const webPw = hasWebPassword(db, m.id);
  return `<tr data-member-id="${h(m.id)}">
<td>${h(m.name)}</td>
<td>${m.aliases.length === 0 ? `<span class="meta">(无)</span>` : h(m.aliases.join("、"))}</td>
<td>${webPw ? "已设置" : `<span class="warn-inline meta">未设置</span>`}</td>
<td>${active} 个有效 / 共 ${tokens.length}</td>
<td>${h(m.id)}</td>
</tr>`;
}

/** 成员列表 + 四张操作表单(新增 / 改别名 / 软删 / 重置查看页口令)。 */
export function renderAdminMembers(db: Db, notice: Envelope | null): string {
  const members = listActiveMembers(db);
  const options = members.map((m) => `<option value="${h(m.name)}">${h(m.name)}</option>`).join("");
  const content = `<h1>成员管理</h1>
${notice === null ? "" : envelopeNotice(notice)}
<table>
<tr><th>name</th><th>aliases</th><th>查看页口令</th><th>token</th><th>id</th></tr>
${members.map((m) => memberRow(db, m)).join("\n")}
</table>
<p class="meta">软删的成员不在此列(它不再参与归属解析,其 token 也一并失效)。</p>

<h2>新增成员</h2>
<form method="post" action="/admin/members/add">
  <p><label>name <input name="name" required></label></p>
  <p><label>aliases(逗号分隔,可空) <input name="aliases" placeholder="老妈,王丽"></label></p>
  <p><button type="submit">新增</button></p>
</form>
<p class="meta">名称与别名撞上现有成员的名称/别名会**响亮报错**并指出冲突的是哪一个,
不会"先存着"(别名是归属解析的一级,冲突会让日常说话直接变成 AMBIGUOUS)。</p>

<h2>维护别名</h2>
<form method="post" action="/admin/members/aliases">
  <p><label>成员 <select name="member">${options}</select></label></p>
  <p><label>新的 aliases(逗号分隔;整体替换) <input name="aliases" placeholder="老妈,妈妈,王丽"></label></p>
  <p><button type="submit">保存别名</button></p>
</form>

<h2>软删成员</h2>
<form method="post" action="/admin/members/remove">
  <p><label>成员 <select name="member">${options}</select></label></p>
  <p><button type="submit">软删</button></p>
</form>
<p class="meta">软删后:<strong>名下数据一律保留</strong>(待办、日程、流水都不动),
其 token **立即失效**——用该 token 调 /mcp 会得到 <code>DENIED(unknown_profile)</code>。</p>

<h2>重置查看页口令</h2>
<form method="post" action="/admin/members/reset-password">
  <p><label>成员 <select name="member">${options}</select></label></p>
  <p><button type="submit">重置口令</button></p>
</form>
<p class="meta">生成随机口令,<strong>明文只在重置的那一次响应里出现</strong>,之后无法从库里取回。
该成员已有的查看页会话会一并失效(会话校验要求口令仍存在)。</p>`;
  return adminLayout({ title: "成员管理", current: "/admin/members", content });
}

/**
 * 「一次性明文」页面:重置出来的查看页口令 / 生成的 token / profile 配置片段。
 *
 * **只在这一次响应里出现**:它由 POST 的返回值直接渲染,不写库、不进 session、
 * 刷新页面(GET)就再也拿不到。这是"明文只显示一次"的落点。
 */
export function renderAdminOneTime(args: {
  title: string;
  lead: string;
  plain: string | null;
  snippet: string | null;
  footnote: string;
}): string {
  const content = `<h1>${h(args.title)}</h1>
<div class="warn">${h(args.lead)}</div>
${args.plain === null ? "" : `<pre class="once">${h(args.plain)}</pre>`}
${args.snippet === null ? "" : `<pre class="once">${h(args.snippet)}</pre>`}
<p class="meta">${h(args.footnote)}</p>
<p class="tabs"><a href="/admin/members">回成员管理</a><a href="/admin/tokens">回 token 管理</a><a href="/admin">回总览</a></p>`;
  return adminLayout({ title: args.title, current: "", content });
}

// ─────────────────────────────────── token 管理 ───────────────────────────────────

/** 一行 token:id / label / 状态 / 创建与吊销时刻 / 吊销按钮。**永不显示哈希或明文**。 */
function tokenRowHtml(t: TokenRow): string {
  const revokeCell =
    t.revoked_at === null
      ? `<form method="post" action="/admin/tokens/revoke">
  <input type="hidden" name="token" value="${h(t.id)}">
  <button type="submit">吊销</button>
</form>`
      : "";
  return `<tr data-token-id="${h(t.id)}">
<td>${h(t.id)}</td>
<td>${h(t.label)}</td>
<td>${t.revoked_at === null ? "有效" : `<span class="meta">已吊销</span>`}</td>
<td class="meta">${h(t.created_at)}</td>
<td class="meta">${h(t.revoked_at ?? "—")}</td>
<td>${revokeCell}</td>
</tr>`;
}

/** token 列表:按成员分组。 */
export function renderAdminTokens(db: Db, notice: Envelope | null): string {
  const members = listActiveMembers(db);
  const all = listTokens(db);
  const byMember = new Map<string, TokenRow[]>();
  for (const t of all) {
    const bucket = byMember.get(t.member_id);
    if (bucket === undefined) byMember.set(t.member_id, [t]);
    else bucket.push(t);
  }

  const sections = members.map((m) => {
    const rows = byMember.get(m.id) ?? [];
    const table =
      rows.length === 0
        ? `<p class="empty">该成员还没有 token。</p>`
        : [
            `<table>`,
            `<tr><th>id</th><th>label</th><th>状态</th><th>创建</th><th>吊销</th><th></th></tr>`,
            ...rows.map(tokenRowHtml),
            `</table>`,
          ].join("\n");
    return `<h2>${h(m.name)}(${h(String(rows.length))} 个)</h2>\n${table}`;
  });

  const options = members.map((m) => `<option value="${h(m.name)}">${h(m.name)}</option>`).join("");
  const content = `<h1>family token 管理(按成员)</h1>
${notice === null ? "" : envelopeNotice(notice)}
${sections.join("\n")}
<h2>为成员生成新 token</h2>
<form method="post" action="/admin/tokens/issue">
  <p><label>成员 <select name="member">${options}</select></label></p>
  <p><label>label <input name="label" value="hermes profile"></label></p>
  <p><button type="submit">生成 token</button></p>
</form>
<p class="meta">明文<strong>只在生成的那一次响应里出现</strong>(库里只有 SHA-256),同时给出可直接粘贴的
Hermes profile 配置片段。两个头(<code>Authorization</code> 与 <code>X-Family-Member</code>)都必须填,
少填会静默串号 —— 这是配置写错时唯一的响亮失败通道。</p>`;
  return adminLayout({ title: "token 管理", current: "/admin/tokens", content });
}

// ─────────────────────────────────── 分类管理 ───────────────────────────────────

/** 分类列表(按 kind 分组)。数据来自 `listCategories` —— 与 MCP 侧同一份实现。 */
export function renderAdminCategories(db: Db, notice: Envelope | null): string {
  const cats = categoriesOf(db);
  const group = (kind: CategoryKind, label: string) => {
    const items = cats.filter((c) => c.kind === kind);
    return `<h2>${h(label)}(${h(String(items.length))})</h2>
${
      items.length === 0
        ? `<p class="empty">这一组还没有分类。</p>`
        : `<table>
<tr><th>name</th><th>kind</th><th>排序</th><th>id</th></tr>
${items
  .map(
    (c) =>
      `<tr data-category-id="${h(c.id)}"><td>${h(c.name)}</td><td>${h(c.kind)}</td><td>${c.sort_order}</td><td>${h(c.id)}</td></tr>`,
  )
  .join("\n")}
</table>`
    }`;
  };
  const content = `<h1>分类管理</h1>
${notice === null ? "" : envelopeNotice(notice)}
${group("expense", "支出分类")}
${group("income", "收入分类")}
<h2>新增分类</h2>
<form method="post" action="/admin/categories/add">
  <p><label>name <input name="name" required></label></p>
  <p><label>kind <select name="kind"><option value="expense">expense(支出)</option><option value="income">income(收入)</option></select></label></p>
  <p><button type="submit">新增</button></p>
</form>
<p class="meta">唯一性是 <code>(name, kind)</code>:支出与收入可以各有一个同名分类(如两个「其他」)。
同类重名会**响亮报错**并告诉你已有的分类 id,不必重建。</p>`;
  return adminLayout({ title: "分类管理", current: "/admin/categories", content });
}

/** `listCategories` 成功信封里的分类数组(失败时给空数组:页面别抛)。 */
function categoriesOf(db: Db): CategoryView[] {
  const env = listCategories(db, { memberId: "__admin__", memberName: "管理员", source: "web" }, "", {});
  if (!env.ok) return [];
  return (env.data as { categories?: CategoryView[] }).categories ?? [];
}

// ─────────────────────────────────── 审计日志 ───────────────────────────────────

/** 审计页默认条数与上限(任务书:N 可查询、给上限)。 */
export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;

/**
 * 审计日志页:最近 N 条。
 *
 * **展示什么**:时间 / 说话人 / 工具 / 关键参数元数据 / 结果码。
 * **不展示什么**:`args_summary` 里本来就没有备注类自由文本(工具层与管理端都只挑
 * 元数据字段,见 src/mcp/tools.ts 与 src/admin/audit.ts),而 **token 明文与任何口令
 * 从来不进入审计表** —— 生成 token 时记的是 token **id**,记口令时只记成员名。
 * 这是页面层之外的一道防线:即便将来某个审计摘要器写错了,这里也不会**主动去显示**
 * 任何形似凭据的字段。
 */
export function renderAdminAudit(db: Db, effectiveLimit: number, capped: boolean): string {
  const rows = listAudit(db, effectiveLimit);
  const content = `<h1>审计日志(最近 ${h(String(effectiveLimit))} 条)</h1>
<p class="tabs">
  ${[20, 50, 100, AUDIT_PAGE_MAX]
    .map(
      (n) =>
        `<a class="${n === effectiveLimit ? "on" : ""}" href="/admin/audit?limit=${n}">${n}</a>`,
    )
    .join("\n  ")}
</p>
${capped ? `<div class="warn">请求的条数超过上限,已按上限 ${h(String(AUDIT_PAGE_MAX))} 条截断。</div>` : ""}
${
  rows.length === 0
    ? `<p class="empty">还没有任何写操作记录。</p>`
    : `<table>
<tr><th>时间</th><th>说话人</th><th>工具</th><th>关键参数</th><th>结果</th></tr>
${rows
  .map(
    (r) => `<tr data-audit-id="${r.id}">
<td class="meta">${h(r.at)}</td>
<td>${h(r.member_name)}</td>
<td>${h(r.tool)}</td>
<td class="meta">${h(r.args_summary)}</td>
<td>${r.ok ? h(r.result_code) : `<span class="denied-inline">${h(r.result_code)}</span>`}</td>
</tr>`,
  )
  .join("\n")}
</table>`
}
<p class="meta">只看元数据与关键字段,不看备注全文(§6:不把私账内容再复制一份)。
管理端写操作记为固定身份「管理员」(<code>__admin__</code>)——管理端没有家庭成员身份,
也绝不借用某位家人的身份来背锅。</p>`;
  return adminLayout({ title: "审计日志", current: "/admin/audit", content });
}

// ─────────────────────────────────── 健康与备份 ───────────────────────────────────

/** 健康状态页。JSON 原样贴出来 —— 运维要能 `curl` 同一份数据做外部监控。 */
export function renderAdminHealth(json: string): string {
  const content = `<h1>健康状态</h1>
<p class="meta">下面就是 <code>GET /admin/health</code> 返回的 JSON 原样内容(可直接 curl 同一份做监控)。
<strong>不含成员数据,也不含任何 token</strong>(连哈希都没有):只给状态、计数与路径。</p>
<pre class="card">${h(json)}</pre>`;
  return adminLayout({ title: "健康状态", current: "/admin/health", content });
}

/** 备份页:说明 + 下载按钮(GET 触发下载,不含参数所以不是写路由的形态问题)。 */
export function renderAdminBackup(healthNote: string): string {
  const content = `<h1>数据备份</h1>
<p class="card">${h(healthNote)}</p>
<p><a class="tabs" href="/admin/backup/download">下载 SQLite 在线备份(.db)</a></p>
<p class="meta">实现要点:用 SQLite 的 <code>VACUUM INTO</code> 在一个读事务里把整库(含 WAL 里已提交的页)
写成**不含 WAL 的单文件**快照,再从临时文件读出字节下发,读完立刻删除临时文件。</p>
<p class="meta"><strong>为什么不能直接拷库文件</strong>:本程序开着 WAL,已提交的数据可能只存在于
<code>-wal</code> 里,直接拷主库文件得到的是"少了一截 WAL"的库 —— 它能打开(所以坏得很有欺骗性),
但最近的数据不在里面,而备份的意义恰恰是那部分数据。</p>
<p class="meta">临时文件落在系统临时目录,<strong>不落在共享目录</strong>:备份是一次性的整库副本,
留在库里旁边的目录里就等于多了一个"谁都能读到"的整库(设计 §10 R9)。
下载完立即清理,不留残留。</p>
<div class="warn">备份文件包含全家的待办、日程与记账数据。<strong>请存到只有你能打开的地方</strong>,
不要放进网盘同步目录或群聊。局域网内没有 HTTPS,下载本身也是明文传输(R9)。</div>`;
  return adminLayout({ title: "数据备份", current: "/admin/backup", content });
}