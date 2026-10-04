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

export type ListMembersArgs = z.infer<typeof listMembersSchema>;
export type AddTodoArgs = z.infer<typeof addTodoSchema>;
export type ListTodosArgs = z.infer<typeof listTodosSchema>;
export type CompleteTodoArgs = z.infer<typeof completeTodoSchema>;

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
