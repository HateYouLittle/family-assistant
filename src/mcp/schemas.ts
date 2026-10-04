import { z } from "zod";
import { isCalendarDate } from "../db/id.js";
import { failEnvelope, type Envelope } from "../domain/envelope.js";

/**
 * 工具参数 schema(P1/P2/P8)。
 * 一律 strictObject:未知字段直接报 INVALID_PARAMS(未知字段)——
 * 这是 X1(传 owner 查他人待办)与 X15(被诱导传 as_member)的落点,
 * 说话人不是参数,模型没有可填的位置。
 */

function dateString(label: string) {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: `${label} 格式应为 YYYY-MM-DD(如 2026-10-05)` })
    .refine((v) => isCalendarDate(v), { message: `${label} 不是真实存在的日历日期` });
}

export const listMembersSchema = z.strictObject({});

export const addTodoSchema = z.strictObject({
  owner: z
    .string()
    .min(1, "owner 不能为空")
    .max(100)
    .optional()
    .describe("归属人:成员名、别名或成员 id;缺省 = 说话人本人。指定他人 = 代记,条目仅对方可见。"),
  title: z.string().trim().min(1, "title 不能为空").max(200, "title 过长(上限 200 字)").describe("待办标题,一句话。"),
  due_date: dateString("due_date")
    .optional()
    .describe("截止日期,YYYY-MM-DD,可缺省。相对日期(明天/下周三)先自行换算再传。"),
  notes: z.string().max(2000, "notes 过长(上限 2000 字)").optional().describe("补充备注,可缺省。"),
});

export const listTodosSchema = z.strictObject({
  done: z.boolean().optional().describe("true=只看已完成,false=只看未完成;缺省=全部。"),
  due_before: dateString("due_before").optional().describe("截止日期上界(含边界),YYYY-MM-DD。"),
  due_after: dateString("due_after").optional().describe("截止日期下界(含边界),YYYY-MM-DD。"),
  q: z.string().min(1).max(100).optional().describe("按标题/备注模糊过滤的关键词。"),
});

export const completeTodoSchema = z.strictObject({
  id: z.string().min(1).max(40).describe("待办 id,从 list_todos 的结果里原样复制,不要凭记忆转述。"),
});

export const updateTodoSchema = z.strictObject({
  id: z.string().min(1).max(40).describe("待办 id,从 list_todos 的结果里原样复制。"),
  title: z
    .string()
    .trim()
    .min(1, "title 不能为空")
    .max(200, "title 过长(上限 200 字)")
    .optional()
    .describe("新标题。缺省 = 不改动。"),
  notes: z
    .string()
    .max(2000, "notes 过长(上限 2000 字)")
    .nullable()
    .optional()
    .describe("新备注。缺省 = 不改动;传 null = 清空备注。"),
  due_date: dateString("due_date")
    .nullable()
    .optional()
    .describe("新截止日期 YYYY-MM-DD。缺省 = 不改动;传 null = 去掉截止日期。"),
  owner: z
    .string()
    .min(1, "owner 不能为空")
    .max(100)
    .optional()
    .describe(
      "归属人:仅供读-改-写时原样回传。缺省 = 不传;" +
        "与现值相同(含别名/成员 id)幂等放行,与现值不同 → DENIED(immutable):归属不可修改,如需变更请删除后重建。" +
        "本工具不接受 done(完成用 complete_todo、取消完成用 reopen_todo)。",
    ),
});

export const reopenTodoSchema = z.strictObject({
  id: z.string().min(1).max(40).describe("待办 id,从 list_todos 的结果里原样复制。"),
});

export const deleteTodoSchema = z.strictObject({
  id: z.string().min(1).max(40).describe("待办 id,从 list_todos 的结果里原样复制。软删,可恢复。"),
});

export const restoreDeletedSchema = z.strictObject({
  kind: z.enum(["todo"], {
    errorMap: () => ({
      message: `kind 本阶段只支持 "todo"(日程/记账域接入后再扩展);收到的是非 todo 的值`,
    }),
  }).describe('要恢复的记录类型,本阶段仅 "todo"。'),
  id: z.string().min(1).max(40).describe("待办 id,原样使用 delete_todo 回执里的 id。"),
});

export type ListMembersArgs = z.infer<typeof listMembersSchema>;
export type AddTodoArgs = z.infer<typeof addTodoSchema>;
export type ListTodosArgs = z.infer<typeof listTodosSchema>;
export type CompleteTodoArgs = z.infer<typeof completeTodoSchema>;
export type UpdateTodoArgs = z.infer<typeof updateTodoSchema>;
export type ReopenTodoArgs = z.infer<typeof reopenTodoSchema>;
export type DeleteTodoArgs = z.infer<typeof deleteTodoSchema>;
export type RestoreDeletedArgs = z.infer<typeof restoreDeletedSchema>;

const IDENTITY_PARAM_HINT = "说话人由连接确定,本工具没有、也不接受任何身份参数。";

/** 把 zod 校验失败映射到 P2 协议:缺参 → MISSING_PARAMS,结构问题 → INVALID_PARAMS。 */
export function parseToolArgs<S extends z.ZodTypeAny>(
  schema: S,
  toolName: string,
  raw: unknown,
): { ok: true; args: z.output<S> } | { ok: false; envelope: Envelope } {
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return { ok: true, args: parsed.data };
  const issue = parsed.error.issues[0]!;
  const path = issue.path.join(".");
  const accepted = schema instanceof z.ZodObject ? Object.keys(schema.shape).join("、") : "";

  if (issue.code === "unrecognized_keys") {
    const unknownKeys = issue.keys;
    const looksLikeIdentity = unknownKeys.some((k) =>
      ["as_member", "asMember", "bind_key", "bindKey", "speaker", "caller", "whoami"].includes(k),
    );
    return {
      ok: false,
      envelope: failEnvelope("INVALID_PARAMS", {
        message: `工具 ${toolName} 不接受未知参数:${unknownKeys.join("、")}。${looksLikeIdentity ? IDENTITY_PARAM_HINT : ""}`,
        hint: accepted ? `可用参数:${accepted}。` : "本工具不接收任何参数。",
        field: unknownKeys[0],
      }),
    };
  }
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return {
      ok: false,
      envelope: failEnvelope("MISSING_PARAMS", {
        message: `缺少必填参数 ${path || "(参数)"}:${issue.message}`,
        hint: accepted ? `可用参数:${accepted}。` : undefined,
        missing: path ? [path] : [],
      }),
    };
  }
  return {
    ok: false,
    envelope: failEnvelope("INVALID_PARAMS", {
      message: `参数 ${path || "(参数)"} 有误:${issue.message}`,
      hint: accepted ? `可用参数:${accepted}。` : undefined,
      field: path || undefined,
    }),
  };
}
