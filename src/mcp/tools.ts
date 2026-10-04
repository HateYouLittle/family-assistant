import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny, z } from "zod";
import { recordAudit } from "../audit/audit.js";
import type { Db } from "../db/db.js";
import type { Envelope } from "../domain/envelope.js";
import { addEvent, deleteEvent, listEvents, updateEvent } from "../domain/events.js";
import {
  addCategory,
  addEntry,
  deleteEntry,
  listCategories,
  listEntries,
  summarizeEntries,
  updateEntry,
} from "../domain/ledger.js";
import { listMembersEnvelope } from "../domain/members.js";
import { restoreDeleted } from "../domain/restore.js";
import { addTodo, completeTodo, deleteTodo, listTodos, reopenTodo, updateTodo } from "../domain/todos.js";
import type { Viewer } from "../domain/viewer.js";
import {
  addCategorySchema,
  addEntrySchema,
  addEventSchema,
  addTodoSchema,
  completeTodoSchema,
  deleteEntrySchema,
  deleteEventSchema,
  deleteTodoSchema,
  listCategoriesSchema,
  listEntriesSchema,
  listEventsSchema,
  listMembersSchema,
  listTodosSchema,
  parseToolArgs,
  reopenTodoSchema,
  restoreDeletedSchema,
  summarizeEntriesSchema,
  updateEntrySchema,
  updateEventSchema,
  updateTodoSchema,
} from "./schemas.js";

/**
 * 工具面(S3:list_members + 待办域 6 个 + 日程域 4 个 + 记账域 7 个 + restore_deleted = 19 个;
 * 其中 restore_deleted 是三域共用的软删逆操作,排在最后)。description 即契约(P8):中文、显式写出拒绝条件、
 * 给一个正确示例、并声明"说话人不是参数"。description 与 schema 变更同等对待,走 golden 测试。
 *
 * 工具层保持薄壳:参数转换 + 话术拼装之外的规则全部在 domain 层。
 * 说话人以 Viewer 形态从上层传进来(连接身份),工具面没有身份参数、也不感知身份。
 *
 * 审计纪律(S2b 复核):**有 audit 字段即视为写操作**,成功与失败都留一行。
 * list_events 的**惰性续期是续期写,不是读** —— 它由读触发、不经用户发起,
 * 所以不单独记审计(否则一次查日历会在审计里留下一串"写",R1/R6 的追溯会被噪声淹没);
 * 用户真正发起的写(add_event / update_event / delete_event / restore_deleted)仍各留一行。
 * S3 同理:记账域的 4 个写工具(add_entry / update_entry / delete_entry / add_category)留痕,
 * 3 个读工具(list_entries / summarize_entries / list_categories)不记;
 * `note` 是自由文本,**不进审计摘要**(不把私账备注再复制一份)。
 */

export interface ToolDefinition {
  name: string;
  description: string;
  /** 给 MCP 客户端看的 JSON Schema(strict:additionalProperties=false) */
  inputSchema: Record<string, unknown>;
  /** 运行前校验;失败返回 P2 协议信封 */
  parse: (raw: unknown) => { ok: true; args: unknown } | { ok: false; envelope: Envelope };
  run: (db: Db, viewer: Viewer, timezone: string, args: unknown) => Envelope;
}

/** 审计摘要里单个字段值的最大长度(整体长度由 recordAudit 再截断)。 */
const AUDIT_FIELD_MAX = 40;

/**
 * 写操作的审计摘要:只挑关键字段(§6"只记元数据与关键字段,不记全文")。
 * 自由文本字段(notes 等)一律不进白名单,避免把私账/备注再复制一份。
 */
function summarizeArgs(args: Record<string, unknown>, fields: readonly string[]): string {
  const parts: string[] = [];
  for (const field of fields) {
    const v = args[field];
    if (v === undefined || v === null) continue;
    const text = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
    parts.push(`${field}=${text.length > AUDIT_FIELD_MAX ? `${text.slice(0, AUDIT_FIELD_MAX)}…` : text}`);
  }
  return parts.join(" ");
}

function defineTool<S extends ZodTypeAny>(def: {
  name: string;
  description: string;
  schema: S;
  /**
   * 写操作的审计摘要器(§6)。
   * **存在即视为写操作**:成功与失败都留一条审计(配错导致的 DENIED 正是最该被追溯的)。
   * 读操作不提供本字段 → 不记审计。
   */
  audit?: (args: z.output<S>) => string;
  run: (db: Db, viewer: Viewer, timezone: string, args: z.output<S>) => Envelope;
}): ToolDefinition {
  return {
    name: def.name,
    description: def.description,
    inputSchema: zodToJsonSchema(def.schema, { $refStrategy: "none" }) as Record<string, unknown>,
    parse: (raw) => parseToolArgs(def.schema, def.name, raw),
    run: (db, viewer, tz, rawArgs) => {
      const args = rawArgs as z.output<S>;
      const envelope = def.run(db, viewer, tz, args);
      // 审计记录点统一在这里(工具层入口),domain 层不感知审计。
      if (def.audit) recordAudit(db, viewer, def.name, def.audit(args), envelope);
      return envelope;
    },
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  defineTool({
    name: "list_members",
    description:
      "列出家庭成员的名称与别名,用于把「我妈」这类称呼解析成 owner 等归属参数;成员匹配失败后也可重查名单再试。" +
      "它不能用来确认「你是谁」——说话人由连接确定,与成员名单无关。" +
      "示例:list_members()。",
    schema: listMembersSchema,
    run: (db, viewer) => listMembersEnvelope(db, viewer),
  }),
  defineTool({
    name: "add_todo",
    description:
      "添加一条待办。待办一律是个人项,仅归属人本人可见。" +
      "owner 缺省为说话人本人;指定他人即代记,条目仅对方可见,回执会注明「由你代记」。" +
      "先调 list_members 确认称呼:成员匹配不到会返回 MISSING_PARAMS(附成员名单),重名会返回 AMBIGUOUS(附候选),此时列出候选让用户确认,不要瞎猜。" +
      "due_date 为 YYYY-MM-DD;相对日期(明天、下周三)先自行换算再传。" +
      '示例:add_todo(owner="妈妈", title="交物业费", due_date="2026-10-05")。' +
      "注意:说话人由连接确定,本工具没有、也不接受任何身份参数(传 as_member 之类会被拒绝)。",
    schema: addTodoSchema,
    // 审计只留关键字段:notes 是自由文本,按设计 §6 不入审计。
    audit: (args) => summarizeArgs(args as Record<string, unknown>, ["owner", "title", "due_date"]),
    run: (db, viewer, tz, args) => addTodo(db, viewer, tz, args),
  }),
  defineTool({
    name: "list_todos",
    description:
      "列出待办。只返回说话人本人的待办,以及本人代他人记的待办(可看,但不能替对方完成);" +
      "没有查询他人待办的参数,家人的待办互相不可见——若用户打听他人待办,直接说明这一点,不要换参数重试。" +
      "done=true 只看已完成、false 只看未完成;due_before / due_after 为 YYYY-MM-DD,均含边界;q 按标题或备注模糊过滤。" +
      '示例:list_todos(due_after="2026-10-05", done=false)。' +
      "注意:说话人由连接确定,没有 owner / as_member 等任何身份参数,传入未知参数会被拒绝(INVALID_PARAMS)。",
    schema: listTodosSchema,
    run: (db, viewer, tz, args) => listTodos(db, viewer, tz, args),
  }),
  defineTool({
    name: "update_todo",
    description:
      "修改一条待办的标题、备注、截止日期。必须先 list_todos 拿到精确 id,程序不接受模糊指定。" +
      "置空语义:字段缺省=不改动;显式传 null=清空(due_date=null 去掉截止日期、notes=null 清空备注)。" +
      "仅限本人待办:改他人(含你代记给他人的)待办返回 DENIED——代记的条目只能由归属人本人改,原因原样转述,不要重试。" +
      "不接受 done:完成用 complete_todo、取消完成用 reopen_todo,传 done 会按未知参数被拒(INVALID_PARAMS)。" +
      "owner(归属)不可修改:与现值相同的值(成员名/别名/成员 id 都算)幂等放行,供读-改-写时原样回传;" +
      "与现值不同则返回 DENIED(reason=immutable)——归属/账本不可修改,如需变更请删除后重建(用 delete_todo + add_todo)。" +
      '示例:update_todo(id="t-261004-a7k3", due_date=null)。' +
      "注意:说话人由连接确定,本工具没有、也不接受任何身份参数(as_member 之类会被拒绝)。",
    schema: updateTodoSchema,
    // 审计只留关键字段:notes 是自由文本,按设计 §6 不入审计。
    audit: (args) => summarizeArgs(args as Record<string, unknown>, ["id", "title", "due_date", "owner"]),
    run: (db, viewer, tz, args) => updateTodo(db, viewer, tz, args),
  }),
  defineTool({
    name: "complete_todo",
    description:
      "完成一条待办。必须先 list_todos 拿到精确 id,程序不接受模糊指定。" +
      "仅限本人待办:完成他人(含自己代记)的待办会返回 DENIED,请把原因原样转述给用户,不要重试。" +
      "对已完成的待办重复调用无副作用。" +
      "注意:说话人由连接确定,本工具没有任何身份参数。" +
      '示例:complete_todo(id="t-261004-a7k3")。',
    schema: completeTodoSchema,
    audit: (args) => summarizeArgs(args as Record<string, unknown>, ["id"]),
    run: (db, viewer, tz, args) => completeTodo(db, viewer, tz, (args as { id: string }).id),
  }),
  defineTool({
    name: "reopen_todo",
    description:
      "把一条已完成的待办重新打开(取消完成)。必须先 list_todos 拿到精确 id。" +
      "仅限本人待办:重开他人的待办返回 DENIED(not_visible);重开你代记给他人的待办返回 DENIED(not_writable)——" +
      "那是 TA 自己的完成状态,只能由 TA 本人重开,原因原样转述即可,不要重试。" +
      "对本来就未完成的待办重复调用无副作用(不会改动完成时间)。" +
      "注意:说话人由连接确定,本工具没有、也不接受任何身份参数。" +
      '示例:reopen_todo(id="t-261004-a7k3")。',
    schema: reopenTodoSchema,
    audit: (args) => summarizeArgs(args as Record<string, unknown>, ["id"]),
    run: (db, viewer, _tz, args) => reopenTodo(db, viewer, (args as { id: string }).id),
  }),
  defineTool({
    name: "delete_todo",
    description:
      "删除一条待办(软删,可恢复)。必须先 list_todos 拿到精确 id,程序永远不接受模糊删除。" +
      "权限:本人的待办随时可删;你代他人记的待办也可撤回(回执会说明「已撤回你代记的条目」);" +
      "别人的待办一律 DENIED(not_visible),原样转述、不要重试。" +
      "删除是软删:条目不再出现在 list_todos 里,误删可用 restore_deleted(kind=\"todo\", id=...) 找回。" +
      "注意:说话人由连接确定,本工具没有、也不接受任何身份参数。" +
      '示例:delete_todo(id="t-261004-a7k3")。',
    schema: deleteTodoSchema,
    audit: (args) => summarizeArgs(args as Record<string, unknown>, ["id"]),
    run: (db, viewer, _tz, args) => deleteTodo(db, viewer, (args as { id: string }).id),
  }),
  defineTool({
    name: "add_event",
    description:
      "添加一条日程。日程分两种:owner 缺省 = **全家日程**(全员可见);指定 owner = 那位成员的个人日程(仅 TA 可见)。" +
      "指定他人即代记,回执会注明「仅 TA 可见,由你代记」。" +
      "先调 list_members 确认称呼:成员匹配不到会返回 MISSING_PARAMS(附成员名单),重名会返回 AMBIGUOUS(附候选),此时列出候选让用户确认,不要瞎猜。" +
      '时间格式随 all_day 走:all_day=true 时 start/end 为纯日期 YYYY-MM-DD;缺省或 false 时为 "YYYY-MM-DD HH:MM"。' +
      "格式与 all_day 不符、end 早于 start 都返回 INVALID_PARAMS 并指明字段。相对日期(明天、下周三)先自行换算再传。" +
      "重复日程(repeat=\"daily\"/\"weekly\"/\"monthly\",repeat_interval=每隔几个单位,repeat_until=截止日):" +
      "创建时按规则把**未来 92 天**展开成多条日程,回执写明展开到哪一天;" +
      "list_events 读到已展开范围之外时程序自动续期(续期失败时读照常返回,并在回执里说明只展开到哪一天),所以不必手工补齐。" +
      "重复日程的修改与删除只作用于**整个系列**,不支持只改其中一次。" +
      "repeat_until 是纯日期 YYYY-MM-DD 且**含当天为止**;早于 start(或早于今天、一次都不会发生)返回 INVALID_PARAMS;" +
      "repeat=\"none\"(缺省)时传 repeat_interval / repeat_until 也返回 INVALID_PARAMS(非重复日程不接受这两个参数)。" +
      '示例:add_event(title="家长会", start="2026-10-05 09:00", end="2026-10-05 10:00", location="学校");' +
      '每周三游泳用 add_event(title="游泳", start="2026-10-07 19:00", repeat="weekly", repeat_until="2026-12-31");' +
      '代记用 add_event(owner="妈妈", …)。' +
      "注意:说话人由连接确定,本工具没有、也不接受任何身份参数(传 as_member 之类会被拒绝)。",
    schema: addEventSchema,
    // 审计只留关键字段:location/notes 是自由文本,按设计 §6 不入审计。
    audit: (args) =>
      summarizeArgs(args as Record<string, unknown>, [
        "owner",
        "title",
        "start",
        "end",
        "all_day",
        "repeat",
        "repeat_interval",
        "repeat_until",
      ]),
    run: (db, viewer, tz, args) => addEvent(db, viewer, tz, args),
  }),
  defineTool({
    name: "list_events",
    description:
      "列出时间窗内的日程,返回的是日程实例(每条自带 id 与 series_id)。" +
      "可见范围:全家日程人人可见(V2);个人日程仅归属人本人可见(V1);你代他人记的个人日程你能看到,但那是 TA 的日程、只能由 TA 本人修改(V8)。" +
      "scope 缺省 = 全家日程 + 本人的个人日程 + 本人代记的个人日程;scope=\"family\" 只看全家日程;scope=\"mine\" 只看本人名下的个人日程。" +
      '没有查询他人个人日程的参数形态:传 owner 之类未知字段返回 INVALID_PARAMS,不要换个参数重试 —— 静默空表会让 Agent 误报「TA 那几天没安排」(X3)。' +
      'start/end 为时间窗,两者都含边界,按与日程时间的重叠判定(仍在进行中的日程也会出现);纯日期的 end 覆盖当天整天。' +
      '示例:list_events(start="2026-10-05", end="2026-10-05")。' +
      "注意:说话人由连接确定,没有 owner / as_member 等任何身份参数。",
    schema: listEventsSchema,
    run: (db, viewer, tz, args) => listEvents(db, viewer, tz, args),
  }),
  defineTool({
    name: "update_event",
    description:
      "修改一条日程的标题、地点、备注与时间。必须先 list_events 拿到精确 id(实例 id 形如 ei-…;系列 id 形如 e-… 也接受),程序不接受模糊指定。" +
      "置空语义:字段缺省=不改动;显式传 null=清空(location=null 清空地点、notes=null 清空备注、end=null 去掉结束时间)。" +
      "权限:全家日程任何成员都能改(V3 家庭内互信,回执会标注「已由 <你> 更新」);个人日程仅归属人本人能改;" +
      "你代记给他人的个人日程改不了,返回 DENIED(reason=not_writable)——那是 TA 的日程,记错了用 delete_event 撤回;别人的个人日程返回 DENIED(not_visible)。" +
      "两种拒绝都请原样转述、不要重试。时间格式随 all_day 走:all_day=true 时 start/end 为纯日期 YYYY-MM-DD,否则为 \"YYYY-MM-DD HH:MM\";" +
      "要改时间粒度(全天 ↔ 带时刻)必须同时显式传 all_day,否则返回 INVALID_PARAMS 并指明字段;end 不得早于 start。" +
      "owner(归属)不可修改:与现值相同的值(成员名/别名/成员 id 都算)幂等放行,供读-改-写时原样回传;" +
      "与现值不同则返回 DENIED(reason=immutable)——归属/账本不可修改,如需变更请删除后重建(用 delete_event + add_event);" +
      "把全家日程改成个人日程同样被这条拒绝(X11)。" +
      "重复日程:repeat / repeat_interval / repeat_until 缺省=不改动,可改重复形态;" +
      "重复日程**不支持只改其中一次**,改 start / all_day / repeat* 都作用于**整个系列** —— " +
      "尚未发生的日程按新规则重新展开未来 92 天(回执会写明重建了多少次、展开到哪天)," +
      "更远的日程由 list_events 自动续期;严格早于今天的那些次原样保留(历史不被改写);" +
      "标题/地点/备注则同步到系列的每一次。" +
      'repeat="none" = 折叠成"就一次":保留接下来最早的那一次(沿用它自己原来的时间),其余未来的展开收起,' +
      '整个系列都在过去时不新建、回执说明「这个系列没有更晚的一次了」;' +
      "已经发生过的那些次一律保留,不会被删掉。" +
      '非重复日程不接受 repeat_interval / repeat_until(传了返回 INVALID_PARAMS);repeat_until 是纯日期 YYYY-MM-DD 且**含当天为止**(早于 start 同样返回 INVALID_PARAMS)。' +
      '示例:update_event(id="ei-261004-a7k3", start="2026-10-06 14:00", location=null);' +
      '每周改成每天用 update_event(id="ei-261004-a7k3", repeat="daily")。' +
      "注意:说话人由连接确定,本工具没有、也不接受任何身份参数(as_member 之类会被拒绝)。",
    schema: updateEventSchema,
    // 审计只留关键字段:location/notes 是自由文本,按设计 §6 不入审计。
    audit: (args) =>
      summarizeArgs(args as Record<string, unknown>, [
        "id",
        "title",
        "start",
        "end",
        "all_day",
        "owner",
        "repeat",
        "repeat_interval",
        "repeat_until",
      ]),
    run: (db, viewer, tz, args) => updateEvent(db, viewer, tz, args),
  }),
  defineTool({
    name: "delete_event",
    description:
      "删除一条日程(软删,可恢复)。必须先 list_events 拿到精确 id(实例 id 或系列 id 都接受),程序永远不接受模糊删除。" +
      "删除按**整个系列**进行:该系列的所有日程实例一并删除(回执里的「系列 e-…」就是 restore_deleted 要用的 id)。" +
      "权限:全家日程任何成员都能删(V3 家庭内互信,回执标注操作者);个人日程归属人本人可删;" +
      "你代他人记的日程也可撤回(回执会说明「已撤回你代记的日程」);别人的个人日程一律 DENIED(not_visible),原样转述、不要重试。" +
      '删除是软删:日程不再出现在 list_events 里,误删可用 restore_deleted(kind="event", id=<系列 id>) 找回。' +
      '示例:delete_event(id="ei-261004-a7k3")。' +
      "注意:说话人由连接确定,本工具没有、也不接受任何身份参数。",
    schema: deleteEventSchema,
    audit: (args) => summarizeArgs(args as Record<string, unknown>, ["id"]),
    run: (db, viewer, _tz, args) => deleteEvent(db, viewer, (args as { id: string }).id),
  }),
  defineTool({
    name: "add_category",
    description:
      "新建一个记账分类。分类表预置了支出 9 类(餐饮/交通/购物/居住/娱乐/医疗/教育/人情/其他)与收入 4 类(工资/理财/红包/其他)," +
      "所以绝大多数情况**不需要**建新分类——先调 list_categories 看看有没有能用的。" +
      "支出与收入可以各有一个同名分类(如两个「其他」),所以唯一性是 (name, kind):同一类里重名返回 INVALID_PARAMS 并告知已有分类的 id。" +
      'kind 必须是 "expense" 或 "income",且它决定这个分类能挂在哪种流水上(记流水时分类的 kind 必须与 type 一致)。' +
      '示例:add_category(name="宠物", kind="expense");记工资之外的收入用 add_category(name="报销", kind="income")。' +
      "注意:说话人由连接确定,本工具没有、也不接受任何身份参数(建分类是全家共用的,不属于任何人的账本)。",
    schema: addCategorySchema,
    audit: (args) => summarizeArgs(args as Record<string, unknown>, ["name", "kind"]),
    run: (db, viewer, tz, args) => addCategory(db, viewer, tz, args),
  }),
  defineTool({
    name: "list_categories",
    description:
      "列出记账分类(缺省 = 支出与收入全列,回执按支出/收入分组)。返回的 id 就是 add_entry / list_entries / summarize_entries 里要传的 category_id。" +
      'kind 可传 "expense" 或 "income" 只看一类。**分类不是必填的**:add_entry 不给 category_id 就是「未分类」,汇总里会单列,所以不必为了记账先建分类。' +
      "查某笔花在哪用 list_entries(category_id=…);要按分类看这个月花销用 summarize_entries(group_by=\"category\")。" +
      '示例:list_categories(kind="expense");或 list_categories() 看全部。' +
      "注意:说话人由连接确定,本工具没有、也不接受任何身份参数。",
    schema: listCategoriesSchema,
    run: (db, viewer, tz, args) => listCategories(db, viewer, tz, args),
  }),
  defineTool({
    name: "add_entry",
    description:
      "记一笔流水。金额是**整数分**(35 元 = 3500 分,程序不解析「35 块」这类自由文本,请自行换算);必须 > 0,返回的 message 里用「元」显示(¥35.00)。" +
      "账本与归属:ledger 缺省 = \"shared\"(共享账本,全家成员都能看到,member_id 指定这笔算谁的,可以代记他人);" +
      "ledger=\"personal\" 是**本人的个人账本,仅本人可见**。" +
      "**个人账本只能本人写**(V4):ledger=\"personal\" 时 member_id 必须等于说话人(缺省即说话人本人)," +
      "写成他人返回 DENIED(reason=not_visible)——私账的语义是「这笔钱只有我认」,代记会让对账对不上。" +
      "member_id **必填**(这笔算谁的必须明确);先调 list_members 对齐称呼:匹配不到返回 MISSING_PARAMS(附成员名单),重名返回 AMBIGUOUS(附候选),此时列出候选让用户确认,不要瞎猜。" +
      "分类可缺省:不给 category_id 就是「未分类」(汇总里单列)。给了就必须存在(否则 NOT_FOUND),且分类的 kind 必须与 type 一致——" +
      "收入分类不能记在支出上(否则 INVALID_PARAMS 并指明字段)。occurred_date 缺省 = 今天(按家庭配置时区),只到日。" +
      "单笔金额达到 ¥10,000.00 时**不会拒绝**,但回执会追加一句确认提示(金额较大…),请向用户确认后再继续。" +
      '示例:add_entry(member_id="妈妈", type="expense", amount_fen=3500);记自己的私账用 add_entry(ledger="personal", member_id="妈妈", type="expense", amount_fen=3500, category_id="cat-expense-food")。' +
      "注意:说话人由连接确定,本工具没有、也不接受任何身份参数(member_id 是归属,不是身份)。",
    schema: addEntrySchema,
    // 审计只留关键字段元数据(金额/类型/账本/归属/日期);note 是自由文本,不入审计。
    audit: (args) =>
      summarizeArgs(args as Record<string, unknown>, ["member_id", "ledger", "type", "amount_fen", "category_id", "occurred_date"]),
    run: (db, viewer, tz, args) => addEntry(db, viewer, tz, args),
  }),
  defineTool({
    name: "list_entries",
    description:
      "列出记账流水(按发生日期倒序)。可见范围:ledger=\"shared\" 的共享账本**全员可见**(V2),ledger=\"personal\" 的个人账本**仅归属人本人可见**(V1)。" +
      "ledger 缺省 = 共享账本 + 本人的个人账本,回执分成两栏。" +
      "**显式要他人的个人账本(ledger=\"personal\" + 他人的 member_id)返回 DENIED(reason=not_visible),不是空表**(X2)——" +
      "静默空表会让 Agent 误报「TA 没花钱」。本人查自己的私账(ledger=\"personal\" + 自己的 member_id)是**允许**的。" +
      "member_id 是**归属人筛选**,只在可见范围内生效:共享账本里可以按人筛(问「我们家这个月妈妈花了多少」就靠它)。" +
      "start / end 是发生日期的上下界(均含边界,YYYY-MM-DD,缺省不限);category_id 按分类筛;type 区分支出/收入;q 按备注模糊过滤。" +
      "**合计不要自己算** —— 要数字用 summarize_entries(P4:数学在程序做)。" +
      '示例:list_entries(start="2026-10-01", end="2026-10-05");问妈妈这个月花了什么用 list_entries(member_id="妈妈", type="expense")。' +
      "注意:说话人由连接确定,本工具没有、也不接受任何身份参数(member_id 是归属筛选,不是身份)。",
    schema: listEntriesSchema,
    run: (db, viewer, tz, args) => listEntries(db, viewer, tz, args),
  }),
  defineTool({
    name: "summarize_entries",
    description:
      "统计记账流水:返回**总额 + 分组明细**,由程序在 SQL 里算出(P4:数学在程序做,不要把明细拉回来自己加)。" +
      "区间:period ∈ today/this_week/this_month/last_month/this_year,与 start/end **二选一**——同时给返回 INVALID_PARAMS,都不给 = 本月;" +
      "一周从周一开始,边界按家庭配置时区算。要具体区间就用 start + end(含两端,必须同时给)。" +
      'group_by **必填**:"category" 按分类(未分类单列)、"member" 按归属人、"ledger" 按账本。' +
      "**group_by=\"member\" 时 ledger 必填**:默认范围跨共享与个人两个账本,按人分组要么混算要么拆两张表,语义不唯一," +
      "所以缺省一律返回 MISSING_PARAMS 要求显式指定;只有 group_by=\"ledger\" 时 ledger 才可缺省。" +
      "ledger 缺省时输出按**共享 / 个人(本人)分两栏**,不混算。type 可收窄成只统计支出或只统计收入;" +
      "不传则支出与收入分别给数(相加没有意义)。" +
      "可见性与 list_entries 一致:共享账本全员可见;显式要他人的个人账本(ledger=\"personal\" + 他人 member_id)返回 DENIED(not_visible),不是空表。" +
      '示例:summarize_entries(period="this_month", group_by="category") 看这个月花在哪儿;' +
      'summarize_entries(period="this_month", ledger="shared", group_by="member") 看我们家这个月各人花了多少;' +
      'summarize_entries(group_by="ledger") 不指定 ledger 时分两栏。' +
      "注意:说话人由连接确定,本工具没有、也不接受任何身份参数(member_id 是归属筛选,不是身份)。",
    schema: summarizeEntriesSchema,
    run: (db, viewer, tz, args) => summarizeEntries(db, viewer, tz, args),
  }),
  defineTool({
    name: "update_entry",
    description:
      "修改一笔记账流水(金额、分类、备注、发生日期、类型)。必须先 list_entries 拿到精确 id,程序不接受模糊指定;**member_id 不是定位符**(定位靠 id)。" +
      "置空语义:字段缺省 = 不改动;显式传 null = 清空(note=null 清空备注、category_id=null 置为**未分类**)。" +
      "金额是整数分且必须 > 0;分类必须存在(NOT_FOUND)且其 kind 与 type 一致(INVALID_PARAMS)——" +
      "改 type 而保留原分类会被这条拒绝,请同时传 category_id=null 置为未分类(程序不会悄悄把分类弄丢)。" +
      "权限(V3):共享账本任何成员都能改(家庭内互信,回执标注「已由 <你> 更新」);个人账本**仅归属人本人**能改。" +
      "别人的个人账本返回 DENIED(reason=not_visible),原样转述、不要重试。" +
      "ledger 与 member_id 是**不可变字段**(V7):schema 保留它们只是为了让你「读-改-写」时能原样回传," +
      "与现值相同(含别名/成员 id)幂等放行;与现值不同返回 DENIED(reason=immutable)——" +
      "**归属/账本不可修改,如需变更请删除后重建**(用 delete_entry + add_entry)。" +
      "把自己的私账改成共享(X12)、把公共支出挪进个人账本(X13)都会被这条拒绝。" +
      "没有字段变化时不写库,回执说明「未做修改」。" +
      '示例:update_entry(id="en-261004-a7k3", amount_fen=3800);记错分类了用 update_entry(id="en-261004-a7k3", category_id=null)。' +
      "注意:说话人由连接确定,本工具没有、也不接受任何身份参数(member_id 是不可变的归属,不是身份)。",
    schema: updateEntrySchema,
    // 审计只留关键字段元数据(金额/类型/账本/归属/日期);note 是自由文本,不入审计。
    audit: (args) =>
      summarizeArgs(args as Record<string, unknown>, [
        "id",
        "amount_fen",
        "category_id",
        "occurred_date",
        "type",
        "ledger",
        "member_id",
      ]),
    run: (db, viewer, tz, args) => updateEntry(db, viewer, tz, args),
  }),
  defineTool({
    name: "delete_entry",
    description:
      "删除一笔记账流水(软删,可恢复)。必须先 list_entries 拿到精确 id,程序永远不接受模糊删除。" +
      "权限(V3):共享账本任何成员都能删(家庭内互信,回执标注操作者);个人账本仅归属人本人;" +
      "别人的个人账本一律 DENIED(reason=not_visible),原样转述、不要重试(X5)。" +
      "删除是软删:这笔不再出现在 list_entries / summarize_entries 里,误删可用 restore_deleted(kind=\"entry\", id=…) 找回。" +
      '示例:delete_entry(id="en-261004-a7k3")。' +
      "注意:说话人由连接确定,本工具没有、也不接受任何身份参数。",
    schema: deleteEntrySchema,
    audit: (args) => summarizeArgs(args as Record<string, unknown>, ["id"]),
    run: (db, viewer, _tz, args) => deleteEntry(db, viewer, _tz, (args as { id: string }).id),
  }),
  defineTool({
    name: "restore_deleted",
    description:
      "恢复一条被删除的记录(删除是软删,所以误删都能找回)。必须带精确 id,程序不接受模糊恢复。" +
      'kind 支持 "todo"(待办)、"event"(日程,恢复整个系列及其全部实例)与 "entry"(记账流水);传其它值返回 INVALID_PARAMS。' +
      "权限与删除同源:本人的条目本人可恢复;共享账本的记账流水任何成员可恢复(家庭内互信);" +
      "你代他人记的待办/日程你也能恢复(否则代记者删了却救不回来);" +
      "别人的条目(含他人的个人账本)返回 DENIED(not_visible),原样转述、不要重试。" +
      "对未被删除的 id 重复调用无副作用(回执会说明无需恢复)。" +
      "注意:说话人由连接确定,本工具没有、也不接受任何身份参数。" +
      '示例:restore_deleted(kind="todo", id="t-261004-a7k3");恢复日程用 restore_deleted(kind="event", id="e-261004-a7k3");' +
      '恢复记账流水用 restore_deleted(kind="entry", id="en-261004-a7k3")。',
    schema: restoreDeletedSchema,
    audit: (args) => summarizeArgs(args as Record<string, unknown>, ["kind", "id"]),
    run: (db, viewer, _tz, args) => {
      const a = args as { kind: string; id: string };
      return restoreDeleted(db, viewer, a.kind, a.id);
    },
  }),
];
