import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny, z } from "zod";
import { recordAudit } from "../audit/audit.js";
import type { Db } from "../db/db.js";
import type { Envelope } from "../domain/envelope.js";
import { listMembersEnvelope } from "../domain/members.js";
import { addTodo, completeTodo, listTodos } from "../domain/todos.js";
import type { Viewer } from "../domain/viewer.js";
import {
  addTodoSchema,
  completeTodoSchema,
  listMembersSchema,
  listTodosSchema,
  parseToolArgs,
} from "./schemas.js";

/**
 * 工具面(Spike 01 范围:list_members / add_todo / list_todos / complete_todo)。
 * description 即契约(P8):中文、显式写出拒绝条件、给一个正确示例、
 * 并声明"说话人不是参数"。description 与 schema 变更同等对待,走 golden 测试。
 *
 * 工具层保持薄壳:参数转换 + 话术拼装之外的规则全部在 domain 层。
 * 说话人以 Viewer 形态从上层传进来(连接身份),工具面没有身份参数、也不感知身份。
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
];
