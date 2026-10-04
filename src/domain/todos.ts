import type { Db } from "../db/db.js";
import { daysBetween, generateId, todayInTz } from "../db/id.js";
import { failEnvelope, okEnvelope, type Envelope } from "./envelope.js";
import { resolveMemberOrEnvelope, type Caller } from "./members.js";

/**
 * 待办域(设计方案 §4/§5)。可见性收敛在本层,工具层不可绕过:
 * - V1 待办一律个人项,仅归属人本人可见;
 * - V3/V6 仅本人可改删完成;
 * - V4 可代记(owner ≠ 说话人),回执由服务端标注"仅 TA 可见,由 <说话人> 代记";
 * - V8 代记者保留查看权与删除权、无修改/完成权;
 * - 说话人来自连接(caller),工具面没有身份参数(P7/D13)。
 */

export interface TodoView {
  id: string;
  owner_id: string;
  owner_name: string;
  title: string;
  notes: string | null;
  due_date: string | null;
  done: boolean;
  done_at: string | null;
  created_by: string;
  created_by_name: string;
  /** 是否代记(owner ≠ created_by) */
  delegated: boolean;
  created_at: string;
}

interface TodoJoinRow {
  id: string;
  owner_id: string;
  title: string;
  notes: string | null;
  due_date: string | null;
  done: number;
  done_at: string | null;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
  owner_name: string;
  created_by_name: string;
}

const SELECT_TODO = `
  SELECT t.id, t.owner_id, t.title, t.notes, t.due_date, t.done, t.done_at,
         t.created_by, t.created_at, t.deleted_at,
         om.name AS owner_name, cm.name AS created_by_name
  FROM todo t
  JOIN member om ON om.id = t.owner_id
  JOIN member cm ON cm.id = t.created_by
`;

function toView(row: TodoJoinRow): TodoView {
  return {
    id: row.id,
    owner_id: row.owner_id,
    owner_name: row.owner_name,
    title: row.title,
    notes: row.notes,
    due_date: row.due_date,
    done: row.done !== 0,
    done_at: row.done_at,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    delegated: row.owner_id !== row.created_by,
    created_at: row.created_at,
  };
}

/** 话术里的截止日期:今天/明天用相对说法,过期明确说已逾期,其余给 MM-DD。 */
export function describeDue(due: string, today: string): string {
  const diff = daysBetween(today, due);
  const mmdd = due.slice(5);
  if (diff === 0) return "今天截止";
  if (diff === 1) return "明天截止";
  if (diff < 0) return `截止 ${mmdd},已逾期 ${-diff} 天`;
  return `截止 ${mmdd}`;
}

export interface AddTodoInput {
  owner?: string;
  title: string;
  due_date?: string;
  notes?: string;
}

export function addTodo(db: Db, caller: Caller, timezone: string, input: AddTodoInput): Envelope {
  let owner;
  if (input.owner !== undefined) {
    const r = resolveMemberOrEnvelope(db, input.owner);
    if (!r.ok) return r.envelope;
    owner = r.member;
  } else {
    owner = { id: caller.memberId, name: caller.memberName };
  }

  const id = generateId(db, "t", "todo", timezone);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO todo (id, owner_id, title, notes, due_date, done, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, owner.id, input.title, input.notes ?? null, input.due_date ?? null, caller.memberId, now);

  const row = db.prepare(`${SELECT_TODO} WHERE t.id = ?`).get(id) as TodoJoinRow;
  const view = toView(row);
  const dueText = input.due_date ? `(${describeDue(input.due_date, todayInTz(timezone))})` : "";
  const message =
    view.owner_id === caller.memberId
      ? `已添加待办 [${id}]:${input.title}${dueText}。仅你自己可见。`
      : `已为 ${owner.name} 添加待办 [${id}]:${input.title}${dueText}。仅 ${owner.name} 可见,由 ${caller.memberName} 代记。`;
  return okEnvelope(view, message);
}

export interface ListTodosInput {
  done?: boolean;
  due_before?: string;
  due_after?: string;
  q?: string;
}

function buildFilters(input: ListTodosInput): { where: string; params: unknown[] } {
  const where: string[] = ["t.deleted_at IS NULL"];
  const params: unknown[] = [];
  if (input.done !== undefined) {
    where.push("t.done = ?");
    params.push(input.done ? 1 : 0);
  }
  // 日期筛选只作用于有截止日期的条目;两个边界都含(描述里已写明)。
  if (input.due_before !== undefined) {
    where.push("t.due_date IS NOT NULL AND t.due_date <= ?");
    params.push(input.due_before);
  }
  if (input.due_after !== undefined) {
    where.push("t.due_date IS NOT NULL AND t.due_date >= ?");
    params.push(input.due_after);
  }
  if (input.q !== undefined && input.q !== "") {
    const escaped = input.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    where.push("(t.title LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\')");
    const like = `%${escaped}%`;
    params.push(like, like);
  }
  return { where: where.join(" AND "), params };
}

function queryTodos(db: Db, extraWhere: string, params: unknown[], input: ListTodosInput): TodoView[] {
  const { where, params: filterParams } = buildFilters(input);
  const rows = db
    .prepare(`${SELECT_TODO} WHERE ${[extraWhere, where].join(" AND ")}
      ORDER BY t.done ASC, (t.due_date IS NULL) ASC, t.due_date ASC, t.created_at ASC, t.id ASC`)
    .all(...params, ...filterParams) as TodoJoinRow[];
  return rows.map(toView);
}

function todoLine(v: TodoView, index: number, today: string): string {
  const state = v.done ? "已完成" : v.due_date ? describeDue(v.due_date, today) : "无截止日期";
  return `${index}. [${v.id}] ${v.title}(${state})`;
}

export function listTodos(db: Db, caller: Caller, timezone: string, input: ListTodosInput): Envelope {
  const today = todayInTz(timezone);
  // V1:只看本人待办;V8:本人代他人记的待办也可见(可看、可删、不可改/完成)。
  const own = queryTodos(db, "t.owner_id = ?", [caller.memberId], input);
  const delegated = queryTodos(db, "t.created_by = ? AND t.owner_id != ?", [caller.memberId, caller.memberId], input);

  const parts: string[] = [];
  if (own.length === 0 && delegated.length === 0) {
    return okEnvelope({ todos: [], delegated: [] }, "没有符合条件的待办。");
  }
  if (own.length > 0) {
    parts.push(`你的待办 ${own.length} 条:${own.map((v, i) => todoLine(v, i + 1, today)).join(";")}`);
  }
  if (delegated.length > 0) {
    parts.push(
      `另外,你代记的待办 ${delegated.length} 条(仅归属人可见,你不能替 TA 完成):` +
        delegated.map((v, i) => `${i + 1}. [${v.id}] ${v.title}(归属:${v.owner_name})`).join(";"),
    );
  }
  return okEnvelope({ todos: own, delegated }, parts.join("。") + "。");
}

export function completeTodo(db: Db, caller: Caller, timezone: string, id: string): Envelope {
  const row = db.prepare(`${SELECT_TODO} WHERE t.id = ? AND t.deleted_at IS NULL`).get(id) as TodoJoinRow | undefined;
  if (!row) {
    return failEnvelope("NOT_FOUND", {
      message: `没有找到这条待办(${id}),可能已被删除。`,
      id,
      hint: "先调 list_todos 拿到当前有效的精确 id 再操作。",
    });
  }
  const view = toView(row);
  if (view.owner_id === caller.memberId) {
    if (view.done) {
      return okEnvelope(view, "该待办已完成,无需重复操作。");
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE todo SET done = 1, done_at = ? WHERE id = ?").run(now, id);
    const updated = db.prepare(`${SELECT_TODO} WHERE t.id = ?`).get(id) as TodoJoinRow;
    return okEnvelope(toView(updated), `已完成待办 [${id}]:${view.title}。`);
  }
  // V8:代记者可看可删,但不能替归属人完成。
  if (view.created_by === caller.memberId) {
    return failEnvelope("DENIED", {
      reason: "not_writable",
      message: `这条待办是你代 ${view.owner_name} 记的,只能由 ${view.owner_name} 本人完成。`,
      hint: `向用户说明:代记的条目仅归属人本人可以完成。`,
    });
  }
  // V3/V6:他人的待办根本不可见(存在性也不必隐瞒成 NOT_FOUND,X4 规定明确拒绝)。
  return failEnvelope("DENIED", {
    reason: "not_visible",
    message: "这条待办仅归属人本人可见,你无法查看或操作它。",
    hint: "直接向用户转述:家人之间的待办互相不可见。",
  });
}
