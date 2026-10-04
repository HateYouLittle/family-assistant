import type { Db } from "../db/db.js";
import { todayInTz } from "../db/id.js";
import { isFail, type Envelope } from "../domain/envelope.js";
import { describeTime, listEvents, type EventView } from "../domain/events.js";
import { formatYuan, listEntries, summarizeEntries, type EntryView, type SummaryResult } from "../domain/ledger.js";
import { listActiveMembers } from "../domain/members.js";
import { getToday, type TodayData } from "../domain/today.js";
import { describeDue, listTodos, type TodoView } from "../domain/todos.js";
import type { Viewer } from "../domain/viewer.js";
import { h, layout, query } from "./html.js";

/**
 * 三个只读页面(设计方案 §6)。
 *
 * ## 最重要的一条纪律:**可见性一律走 domain,不重写**
 * 本文件**没有一条自己的 SQL、没有一个自己的 WHERE、没有一个自己的可见性判定**。
 * 三个页面做的事只有三步:
 *   1. 用登录态造出统一的 `viewer: Viewer`(`source: "web"`,见 `viewerOf`);
 *   2. **直接调用域函数** `getToday` / `listTodos` / `listEvents` / `listEntries` / `summarizeEntries`;
 *   3. 把域函数返回的**已经过滤好的**视图数组渲染成 HTML(每个动态值过 `h()`)。
 * 因此"查看页与 /mcp 的可见性同源"不是承诺而是结构事实:页面上能出现哪一条数据,
 * 完全等于 MCP 侧同一个 viewer 下读到的集合(test/web.test.ts 有逐条同源断言)。
 *
 * 页面只读:不 INSERT/UPDATE/DELETE,没有任何表单提交到写路径。
 * 唯一"看着像写"的是 `listEvents` 内部的**惰性续期**(重复日程补实例,设计 §4 的读路径写),
 * 那是域函数自己的既有行为,页面既不新增也不绕过它。
 *
 * 顺带说清一件事:`Viewer.source` 只用于审计与排查,**不参与任何可见性判定**
 * (见 src/domain/viewer.ts 的约定 4)。所以"把 source 换成 web"不会让可见性放宽一分。
 */

/** 从登录态造出查看页的 viewer。与 MCP 侧唯一的差别就是 `source`。 */
export function viewerOf(memberId: string, memberName: string): Viewer {
  return { memberId, memberName, source: "web" };
}

/**
 * 条目上的 `data-id` 属性(唯一的机器可读锚点)。
 *
 * 为什么必须有它:页面渲染**标题**,而标题是自由文本 —— 既是注入面,也会重复、
 * 还会被改。把"页面渲染了哪些条目"这件事钉死在**行 id** 上,才能在测试里断言
 * "页面集合 == domain 返回集合"这种**集合相等**,而不是"页面上大致有那几条标题"。
 * 锚点是 id 而不是标题,还顺带让"标题被截断/换行"的展示决策不影响那条断言。
 */
function idAttr(kind: "todo" | "event" | "entry", id: string): string {
  return `data-${kind}-id="${h(id)}"`;
}

// ─────────────────────────────────── /todos ───────────────────────────────────

/** 一条待办:标题 + 截止说法(`describeDue` 是域里那一份,话术只有一处实现)。 */
function todoItem(v: TodoView, today: string): string {
  const due = v.due_date === null ? "无截止日期" : describeDue(v.due_date, today);
  const mark = v.delegated ? `<span class="meta">· 由 ${h(v.created_by_name)} 代记</span>` : "";
  const notes = v.notes === null || v.notes === "" ? "" : `<div class="meta">${h(v.notes)}</div>`;
  return `<li ${idAttr("todo", v.id)}>${h(v.title)} <span class="meta">· ${h(due)}${mark}</span>${notes}</li>`;
}

function todoList(items: TodoView[], today: string, empty: string): string {
  if (items.length === 0) return `<p class="empty">${h(empty)}</p>`;
  return `<ul>${items.map((v) => todoItem(v, today)).join("\n")}</ul>`;
}

/** `listTodos` 成功信封的 data(形状固定在 domain 里,见 todos.listTodos)。 */
function todosOf(env: Envelope): TodoView[] {
  if (isFail(env)) return [];
  const data = env.data as { todos?: TodoView[] };
  return data.todos ?? [];
}

/**
 * `/todos`:**本人待办**(V1,无全家切换),按未完成/已完成分组,顶部一块「今天」。
 *
 * 数据来源:置顶块用 `getToday`,两组列表用两次 `listTodos`。
 * 「今天」也走 `getToday` 而不是页面自己算 —— 它与 MCP 侧开场提醒是同一份口径,
 * 于是页面说的"今天有几件事"与 Agent 说的永远一致(同一份 domain 调用,同一个 viewer)。
 */
export function renderTodos(db: Db, viewer: Viewer, timezone: string): string {
  const today = todayInTz(timezone);
  const t = getToday(db, viewer, timezone);
  const open = todosOf(listTodos(db, viewer, timezone, { done: false }));
  const done = todosOf(listTodos(db, viewer, timezone, { done: true }));
  if (isFail(t)) return problemPage(viewer, t.code, t.message);

  const data = t.data as TodayData;
  const todayItems = [...data.due_today, ...data.overdue].map(
    (x) => `<li ${idAttr("todo", x.id)}>${h(x.title)} <span class="meta">· ${h(x.due_text)}</span></li>`,
  );
  const todayBlock =
    data.due_today.length === 0 && data.overdue.length === 0
      ? `<p class="empty">今天没有到期或逾期的待办。</p>`
      : `<ul>${todayItems.join("\n")}</ul>`;

  const content = `<h1>我的待办</h1>
<h2>今天(${h(data.today)})</h2>
${todayBlock}
<h2>未完成(${open.length})</h2>
${todoList(open, today, "没有未完成的待办。")}
<h2>已完成(${done.length})</h2>
${todoList(done, today, "还没有已完成的待办。")}`;
  return layout({ title: "待办", viewer, content });
}

// ────────────────────────────────── /calendar ──────────────────────────────────

/** `listEvents` 成功信封的 data:三桶(family / mine / delegated)。 */
function eventsOf(env: Envelope): { family: EventView[]; mine: EventView[]; delegated: EventView[] } {
  if (isFail(env)) return { family: [], mine: [], delegated: [] };
  const data = env.data as { family?: EventView[]; mine?: EventView[]; delegated?: EventView[] };
  return { family: data.family ?? [], mine: data.mine ?? [], delegated: data.delegated ?? [] };
}

/**
 * `/calendar`:全家日程 + 本人个人日程(他人个人日程不可见)。
 *
 * **两次 `listEvents`**(scope="family" 与 scope="mine")而不是一次缺省调用:
 * 缺省 scope 还含"我代记的他人个人日程"(V8 的查看权)—— 那是 MCP 侧给 Agent
 * "能撤回自己笔误"的视图,家人自己看日历不需要它,页面口径就是"全家 + 我的"。
 * 可见范围本身仍由域里的 `visibilityWhere` 按 V1/V2 判定,页面不判。
 */
export function renderCalendar(db: Db, viewer: Viewer, timezone: string, window: { start: string; end: string }): string {
  const { start, end } = window;
  const family = eventsOf(listEvents(db, viewer, timezone, { start, end, scope: "family" })).family;
  const mine = eventsOf(listEvents(db, viewer, timezone, { start, end, scope: "mine" })).mine;

  const prev = { start: shiftDays(start, -7), end: shiftDays(start, -1) };
  const next = { start: shiftDays(end, 1), end: shiftDays(end, 7) };

  const content = `<h1>日程</h1>
<p class="meta">${h(start)} 至 ${h(end)}(含两端,共 ${daysBetween(start, end) + 1} 天)</p>
<p class="tabs">
  <a href="/calendar${query({ start: prev.start, end: prev.end })}">← 前 7 天</a>
  <a href="/calendar${query({ start: next.start, end: next.end })}">后 7 天 →</a>
  <a href="/calendar">回到本周</a>
</p>
<h2>全家日程(${family.length})</h2>
${eventList(family, "这段时间没有全家日程。")}
<h2>我的个人日程(${mine.length})</h2>
${eventList(mine, "这段时间我没有个人日程。")}`;
  return layout({ title: "日程", viewer, content });
}

/** 按日历日分组、组内按时刻排序;时间说法复用域里的 `describeTime`。 */
function eventList(items: EventView[], empty: string): string {
  if (items.length === 0) return `<p class="empty">${h(empty)}</p>`;
  const byDay = new Map<string, EventView[]>();
  for (const v of items) {
    const day = v.start.slice(0, 10);
    const bucket = byDay.get(day);
    if (bucket === undefined) byDay.set(day, [v]);
    else bucket.push(v);
  }
  const blocks: string[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const rows = (byDay.get(day) ?? [])
      .slice()
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((v) => {
        const place = v.location === null || v.location === "" ? "" : ` <span class="meta">· ${h(v.location)}</span>`;
        const notes = v.notes === null || v.notes === "" ? "" : `<div class="meta">${h(v.notes)}</div>`;
        const time = describeTime(v.start, v.end, v.all_day);
        return `<li ${idAttr("event", v.id)}>${h(v.title)} <span class="meta">${h(time)}${place}</span>${notes}</li>`;
      });
    blocks.push(`<h3 class="meta">${h(day)}</h3>\n<ul>${rows.join("\n")}</ul>`);
  }
  return blocks.join("\n");
}

// ─────────────────────────────────── /ledger ───────────────────────────────────

/**
 * `/ledger`:共享账本(全员可见)+ 我的个人账本(仅登录者本人),可切换。
 *
 * - 缺省 `?ledger=shared`;`?ledger=personal` 只看自己那份。
 * - **他人个人账本不可见、也不可切换**:切换标签只有"共享账本 / 我的个人账本"两项,
 *   归属人筛选标签**只在共享账本下渲染**(在个人账本里渲染"按归属人筛"就等于
 *   提供"看别人私账"的入口)。URL 里硬塞 `?ledger=personal&member=他人` 由
 *   `listEntries` 判成 `DENIED(not_visible)`(X2),页面渲染成**明确的未授权提示**,
 *   **绝不静默显示空表**(V5 禁止的那种误导)。
 * - `?member=` 是**归属人筛选**(共享账本里"我们家这个月妈妈花了多少"),不是"看谁的私账"。
 * - 流水与汇总直接调 `listEntries` / `summarizeEntries`;金额由域里的 SQL SUM 给出(P4),
 *   页面只做显示格式化(`formatYuan`),**不做任何加总**。
 */
export function renderLedger(
  db: Db,
  viewer: Viewer,
  timezone: string,
  kind: "shared" | "personal",
  memberFilter: string | null,
): string {
  const listEnv = listEntries(db, viewer, timezone, { ledger: kind, member_id: memberFilter ?? undefined });
  if (isFail(listEnv)) return deniedPage(viewer, kind, listEnv.code, listEnv.message);
  const sumEnv = summarizeEntries(db, viewer, timezone, {
    period: "this_month",
    group_by: "category",
    ledger: kind,
    member_id: memberFilter ?? undefined,
  });
  if (isFail(sumEnv)) return deniedPage(viewer, kind, sumEnv.code, sumEnv.message);

  const entries = (listEnv.data as { entries?: EntryView[] }).entries ?? [];
  const summary = sumEnv.data as SummaryResult;
  const title = kind === "shared" ? "共享账本(全家可见)" : "我的个人账本(仅我可见)";
  const ledgerQuery = query({ ledger: kind });

  // 归属人筛选:只在共享账本下出现。个人账本里"按人筛"没有合法目标,
  // 渲染出来就等于给"看别人私账"造了一个入口。
  const filter =
    kind === "shared"
      ? `<h2>按归属人筛选</h2>
<p class="tabs">
  <a class="${memberFilter === null ? "on" : ""}" href="/ledger${ledgerQuery}">全部</a>
  ${listActiveMembers(db)
    .map(
      (m) =>
        `<a class="${memberFilter === m.name ? "on" : ""}" href="/ledger${query({ ledger: "shared", member: m.name })}">${h(m.name)}</a>`,
    )
    .join("\n  ")}
</p>`
      : `<p class="meta">个人账本只有你自己能看:这里不提供任何"切换到他人账本"的入口。</p>`;

  const content = `<h1>${h(title)}</h1>
<p class="tabs">
  <a class="${kind === "shared" ? "on" : ""}" href="/ledger">共享账本</a>
  <a class="${kind === "personal" ? "on" : ""}" href="/ledger${query({ ledger: "personal" })}">我的个人账本</a>
</p>
${filter}
<h2>本月按分类汇总(${h(summary.start)} 至 ${h(summary.end)})</h2>
${summaryTable(summary, kind)}
<h2>本月流水(${entries.length})</h2>
${
  entries.length === 0
    ? `<p class="empty">这个月还没有${kind === "shared" ? "共享" : "个人"}记账记录。</p>`
    : `<table>
<tr><th>日期</th><th>类型</th><th>金额</th><th>分类</th><th>归属</th><th>备注</th></tr>
${entries
  .map(
    (e) =>
      `<tr ${idAttr("entry", e.id)}><td>${h(e.occurred_date)}</td><td>${e.type === "expense" ? "支出" : "收入"}</td>` +
      `<td class="amount">${h(formatYuan(e.amount_fen))}</td><td>${h(e.category_name ?? "未分类")}</td>` +
      `<td>${h(e.member_name)}</td><td>${h(e.note ?? "")}</td></tr>`,
  )
  .join("\n")}
</table>`
}`;
  return layout({ title: kind === "shared" ? "共享账本" : "我的个人账本", viewer, content });
}

/** 分类汇总表:每类一行 + 合计行(金额与笔数全是域里 SQL SUM 的结果,页面不自己算)。 */
function summaryTable(summary: SummaryResult, kind: "shared" | "personal"): string {
  const block = summary.ledgers.find((b) => b.ledger === kind);
  if (block === undefined || block.groups.length === 0) {
    return `<p class="empty">本月还没有${kind === "shared" ? "共享" : "个人"}记账记录。</p>`;
  }
  const rows = block.groups.map(
    (g) =>
      `<tr><td>${h(g.label)}</td><td class="amount">${h(formatYuan(g.total_fen))}</td>` +
      `<td class="amount">${h(formatYuan(g.expense_fen))}</td><td class="amount">${h(formatYuan(g.income_fen))}</td>` +
      `<td>${g.count}</td></tr>`,
  );
  return `<table>
<tr><th>分类</th><th>合计</th><th>支出</th><th>收入</th><th>笔数</th></tr>
${rows.join("\n")}
<tr><th>合计</th><th class="amount">${h(formatYuan(block.total_fen))}</th><th class="amount">${h(formatYuan(block.expense_fen))}</th><th class="amount">${h(formatYuan(block.income_fen))}</th><th>${block.count}</th></tr>
</table>`;
}

/**
 * X2 的未授权分支:**明确的未授权提示**,页面上不出现对方的任何流水、金额或备注。
 * 文案说"没有权限"而不是给一张空表 —— V5 里"看起来成功的空表"正是被禁止的误导。
 */
function deniedPage(viewer: Viewer, kind: "shared" | "personal", code: string, message: string): string {
  const content = `<h1>${kind === "shared" ? "共享账本" : "我的个人账本"}</h1>
<div class="denied">
  <p><strong>没有权限查看这份账本。</strong>(<code>${h(code)}</code>)</p>
  <p>${h(message)}</p>
  <p class="meta">他人的个人账本仅归属人本人可见;查看页不提供任何切换到他人账本的入口。</p>
</div>
<p class="tabs"><a href="/ledger">回到共享账本</a><a href="/ledger${query({ ledger: "personal" })}">看我的个人账本</a></p>`;
  return layout({ title: "没有权限", viewer, content });
}

/** 域函数返回失败信封时的兜底页(入口已校验参数,这里只是别吐 500)。 */
function problemPage(viewer: Viewer, code: string, message: string): string {
  return layout({
    title: "出了点问题",
    viewer,
    content: `<h1>出了点问题</h1><div class="denied">${h(code)}:${h(message)}</div>`,
  });
}

// ───────────────────────────── 日历窗口(纯日历算术,按 UTC) ─────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toUtc(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): string {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** 日历日加减天数(按 UTC 构造,不读系统本地时区 —— 容器默认 UTC 会整体偏一天,§4)。 */
function shiftDays(day: string, n: number): string {
  return fromUtc(toUtc(day) + n * 86_400_000);
}

/** 两个日历日之间相差的天数(同一天为 0)。 */
export function daysBetween(start: string, end: string): number {
  return Math.round((toUtc(end) - toUtc(start)) / 86_400_000);
}

/**
 * 本周 = **周一起 7 天(含两端)**。周一是周首(ISO 8601 / 中国日历习惯),
 * 与记账域 `periodRange("this_week")` 同一口径。
 *
 * 缺省窗口取"本周"而不是"今天起 7 天":周一是家人安排家务的固定参照
 * ("这周还有没有要交物业费"),页面上的"回到本周"也因此总是一个稳定的落点。
 */
export function currentWeek(today: string): { start: string; end: string } {
  const wd = new Date(toUtc(today)).getUTCDay(); // 0 = 周日
  const backToMonday = wd === 0 ? 6 : wd - 1;
  const start = shiftDays(today, -backToMonday);
  return { start, end: shiftDays(start, 6) };
}

/** `?start=&end=` 覆盖窗口;没给 start 就用本周(给了 start 没给 end = 只看那一天)。 */
export function resolveWindow(start: string | undefined, end: string | undefined, today: string): { start: string; end: string } {
  if (start !== undefined && start !== "") return { start, end: end !== undefined && end !== "" ? end : start };
  return currentWeek(today);
}
