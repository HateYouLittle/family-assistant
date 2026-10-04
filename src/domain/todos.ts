import type { Db } from "../db/db.js";
import { daysBetween, generateId, todayInTz } from "../db/id.js";
import { failEnvelope, okEnvelope, type Envelope, type FailEnvelope } from "./envelope.js";
import { resolveMemberOrEnvelope } from "./members.js";
import type { Caller } from "./viewer.js";

/**
 * 待办域(设计方案 §4/§5)。可见性收敛在本层,工具层不可绕过:
 * - V1 待办一律个人项,仅归属人本人可见;
 * - V3/V6 仅本人可改删完成;
 * - V4 可代记(owner ≠ 说话人),回执由服务端标注"仅 TA 可见,由 <说话人> 代记";
 * - V8 代记者保留查看权与删除权、无修改/完成权;
 * - V7 归属(todo.owner_id)写入后不可变,update 传入不同值 → DENIED(immutable);
 * - 说话人来自连接(Caller,见 ./viewer.ts),工具面没有身份参数(P7/D13)。
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

/**
 * delete_todo / restore_deleted 的回执 data:在 TodoView 之外补上 deleted_at,
 * 让 Agent 一眼看出这条当前是"已删"还是"已恢复"(不删不能删的字段不加)。
 */
export type TodoMutationView = TodoView & { deleted_at: string | null };

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

/**
 * 本人**未完成且有截止日期、截止 ≤ day** 的待办(今日到期 + 逾期合成一份,get_today 的数据源)。
 *
 * 口径说明:
 * - 只取 `owner_id = 说话人`:**不含**"本人代他人记的待办"(V8 的查看权)。
 *   理由同 listEventsOnDay —— 「我今天有什么事」不该混进别人家的私人待办;
 *   要看代记的那些用 list_todos(V8 仍完整保留)。
 * - `done = 0`:今日已完成的不进「今天」(它已经办完了,再提醒一次是噪声)。
 * - `due_date IS NOT NULL AND due_date <= day`:无截止日期的不进「今天」也不进「逾期」——
 *   「没有截止」不等于「今天要做」,把它算进逾期会凭空造出一个不存在的 deadline。
 */
export function listOwnOpenTodosDueBy(db: Db, caller: Caller, day: string): TodoView[] {
  return queryTodos(db, "t.owner_id = ? AND t.done = 0 AND t.due_date IS NOT NULL AND t.due_date <= ?", [
    caller.memberId,
    day,
  ], {});
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

// ─────────────────────────── 写路径共用:取行 / 拒绝 / 话术 ───────────────────────────

/** 取行(含已删):只有 restore_deleted 需要看到已删的行。 */
function loadTodo(db: Db, id: string): TodoJoinRow | undefined {
  return db.prepare(`${SELECT_TODO} WHERE t.id = ?`).get(id) as TodoJoinRow | undefined;
}

/** 行根本不存在 → NOT_FOUND(P5:删除/修改必须带精确 id,先 list 拿)。 */
function todoMissing(id: string, action: string): FailEnvelope {
  return failEnvelope("NOT_FOUND", {
    message: `没有找到这条待办(${id}),无法${action}。`,
    id,
    hint: "先调 list_todos 拿到当前有效的精确 id 再操作(不要凭记忆转述 id)。",
  });
}

/** 行存在但已软删 → 同样按 NOT_FOUND(§4:已删即不在可见范围),但要给出恢复出路。 */
function todoAlreadyDeleted(id: string, action: string): FailEnvelope {
  return failEnvelope("NOT_FOUND", {
    message: `待办 [${id}] 已被删除,无法${action}。`,
    id,
    hint: `已删除的条目不再出现在 list_todos 里;若要找回,用 restore_deleted(kind="todo", id="${id}")。`,
  });
}

/**
 * update/reopen/complete/delete 的统一取行。
 *
 * **判定顺序本身是可见性纪律的一部分**(S1c 修复轮):先答"你看得见这条吗",
 * 再答"它删没删过"。反过来就等于先给信息、后判权限——第三人拿别人的 id 试探,
 * 会读到"这条待办已被删除"外加一条现成的 restore_deleted 命令,而**同一条待办在
 * 未删状态下回的是 DENIED(not_visible)**:判定口径随 deleted_at 漂移,这本身就是泄露(V5)。
 *
 * 顺序:行不存在 → NOT_FOUND;看不见 → DENIED(not_visible);已软删 → NOT_FOUND(§4)。
 * V8 的 not_writable 交给各写函数自己判(见 denyIfNotOwner),因为它要按 action 措辞。
 * 返回 `{ row }` 可继续,返回 `{ envelope }` 直接回给调用方。
 */
function loadWritableTodo(
  db: Db,
  caller: Caller,
  id: string,
  action: string,
): { row: TodoJoinRow } | { envelope: FailEnvelope } {
  const row = loadTodo(db, id);
  if (!row) return { envelope: todoMissing(id, action) };
  // 可见性先于行内信息:能不能看这条,与它删没删过无关(V1 + V8 的查看权)。
  if (!canSeeTodo(toView(row), caller)) return { envelope: denyNotVisible() };
  if (row.deleted_at !== null) return { envelope: todoAlreadyDeleted(id, action) };
  return { row };
}

/** V3/V6:条目不是本人的 → 明确拒绝(V5:绝不允许"看起来成功")。 */
function denyNotVisible(): FailEnvelope {
  return failEnvelope("DENIED", {
    reason: "not_visible",
    message: "这条待办仅归属人本人可见,你无法查看或操作它。",
    hint: "直接向用户转述:家人之间的待办互相不可见。",
  });
}

/**
 * V8:代记者对"我创建、归属他人"的条目只有查看权与删除权,没有修改/完成权。
 * `action` 只影响话术里的动词(完成/修改/重开),拒绝语义完全一致。
 */
function denyNotWritable(view: TodoView, action: "完成" | "修改" | "重开"): FailEnvelope {
  return failEnvelope("DENIED", {
    reason: "not_writable",
    message: `这条待办是你代 ${view.owner_name} 记的,只能由 ${view.owner_name} 本人${action}。`,
    hint: `向用户说明:代记的条目只有归属人本人能${action};你在记错时可以用 delete_todo 撤回。`,
  });
}

/** V7:归属不可变。传入值与现值不同 → DENIED(immutable)+ 固定话术(X14)。 */
function denyImmutable(view: TodoView, given: string): FailEnvelope {
  return failEnvelope("DENIED", {
    reason: "immutable",
    message:
      `归属/账本不可修改,如需变更请删除后重建。` +
      `待办 [${view.id}] 记在 ${view.owner_name} 名下,你不能把它改成「${given}」名下的。`,
    hint: `要换归属人:先用 delete_todo 删除这条(软删,可恢复),再用 add_todo(owner="${given}") 重建;不要试图用 update 改归属。`,
  });
}

/**
 * 写权限闸门:本人 → 放行(null);自己代记的条目 → V8 not_writable;他人 → not_visible。
 * V8 只给创建者**可见与删除**权,所以 delete_todo 不用本函数(见 canDeleteTodo)。
 */
function denyIfNotOwner(view: TodoView, caller: Caller, action: "完成" | "修改" | "重开"): FailEnvelope | null {
  if (view.owner_id === caller.memberId) return null;
  if (view.created_by === caller.memberId) return denyNotWritable(view, action);
  return denyNotVisible();
}

/**
 * 可见性(V1 + V8 的查看权):归属人本人,或该条目的创建者(自己代记的条目)。
 *
 * 这是所有其它判定的**前提**——读路径(listTodos)按它过滤,写路径(loadWritableTodo)
 * 按它先拒绝,所以它必须独立于"删没删过""完没完成"这类状态。
 */
export function canSeeTodo(view: TodoView, caller: Caller): boolean {
  return view.owner_id === caller.memberId || view.created_by === caller.memberId;
}

/**
 * 删除权(V3 + V8):归属人本人,或该条目的创建者(自己代记的条目)。
 * 与可见性同源,所以直接建立在 canSeeTodo 上。
 *
 * **恢复权与删除权同源(S1 裁决)**:`restore_deleted` 直接复用本判定
 * (见 ./restore.ts)。理由:V8 给代记者删除权的目的就是让他纠正自己的笔误,
 * "能删不能恢复"等于把笔误变成不可挽回——恢复权必须跟着删除权一起给。
 */
export function canDeleteTodo(view: TodoView, caller: Caller): boolean {
  return canSeeTodo(view, caller);
}

/** 话术里的"这条待办现在什么样":[id]:标题(截止 01-02),与 add/list/complete 同一形状。 */
function todoHeadline(view: TodoView, timezone: string): string {
  const dueText = view.due_date ? `(${describeDue(view.due_date, todayInTz(timezone))})` : "";
  return `[${view.id}]:${view.title}${dueText}`;
}

export function completeTodo(db: Db, caller: Caller, _timezone: string, id: string): Envelope {
  const loaded = loadWritableTodo(db, caller, id, "完成");
  if ("envelope" in loaded) return loaded.envelope;
  const view = toView(loaded.row);
  // V8:代记者可看可删,但不能替归属人完成。
  const denied = denyIfNotOwner(view, caller, "完成");
  if (denied) return denied;

  if (view.done) {
    return okEnvelope(view, "该待办已完成,无需重复操作。");
  }
  const now = new Date().toISOString();
  db.prepare("UPDATE todo SET done = 1, done_at = ? WHERE id = ?").run(now, id);
  const updated = toView(db.prepare(`${SELECT_TODO} WHERE t.id = ?`).get(id) as TodoJoinRow);
  return okEnvelope(updated, `已完成待办 [${id}]:${view.title}。`);
}

export interface UpdateTodoInput {
  id: string;
  /** 缺省 = 不改;传字符串 = 改成它(§5.1③) */
  title?: string;
  /** 缺省 = 不改;null = 清空备注 */
  notes?: string | null;
  /** 缺省 = 不改;null = 去掉截止日期 */
  due_date?: string | null;
  /**
   * V7 的不可变字段:schema 保留它是为了让模型做"读-改-写"时能原样回传,
   * 因此同值幂等放行、不同值 DENIED(immutable)。**不接受 done**
   * (done 只走 complete_todo / reopen_todo,避免两条路径话术不一致)。
   */
  owner?: string;
}

export function updateTodo(db: Db, caller: Caller, timezone: string, input: UpdateTodoInput): Envelope {
  const loaded = loadWritableTodo(db, caller, input.id, "修改");
  if ("envelope" in loaded) return loaded.envelope;
  const view = toView(loaded.row);

  // 权限先于不可变:不可见的行连"归属是谁"都不该顺带泄露(V5/X4 的教训)。
  const denied = denyIfNotOwner(view, caller, "修改");
  if (denied) return denied;

  // V7:同值幂等放行(别名/id 命中同一成员也算同值);不同值一律拒绝。
  if (input.owner !== undefined) {
    const resolved = resolveMemberOrEnvelope(db, input.owner);
    if (!resolved.ok) return resolved.envelope;
    if (resolved.member.id !== view.owner_id) return denyImmutable(view, input.owner);
  }

  // §5.1③:缺省 = 不改;null = 清空。值与现值相同的不写库(顺带得到幂等语义)。
  const sets: string[] = [];
  const params: unknown[] = [];
  const changes: string[] = [];
  if (input.title !== undefined && input.title !== view.title) {
    sets.push("title = ?");
    params.push(input.title);
    changes.push(`标题→「${input.title}」`);
  }
  if (input.notes !== undefined && input.notes !== view.notes) {
    sets.push("notes = ?");
    params.push(input.notes);
    // 自由文本不进话术(与 §6 审计不记全文同理),只说改没改。
    changes.push(input.notes === null ? "备注已清空" : "备注已更新");
  }
  if (input.due_date !== undefined && input.due_date !== view.due_date) {
    sets.push("due_date = ?");
    params.push(input.due_date);
    changes.push(input.due_date === null ? "已去掉截止日期" : `截止日期改为 ${input.due_date}`);
  }

  if (sets.length === 0) {
    return okEnvelope(view, `待办 ${todoHeadline(view, timezone)} 未做修改(没有字段发生变化)。`);
  }
  db.prepare(`UPDATE todo SET ${sets.join(", ")} WHERE id = ?`).run(...params, input.id);
  const updated = toView(db.prepare(`${SELECT_TODO} WHERE t.id = ?`).get(input.id) as TodoJoinRow);
  return okEnvelope(updated, `已更新待办 ${todoHeadline(updated, timezone)}。改动:${changes.join(";")}。`);
}

export function reopenTodo(db: Db, caller: Caller, id: string): Envelope {
  const loaded = loadWritableTodo(db, caller, id, "重开");
  if ("envelope" in loaded) return loaded.envelope;
  const view = toView(loaded.row);

  const denied = denyIfNotOwner(view, caller, "重开");
  if (denied) return denied;

  // 本就未完成:幂等,不动 done_at(没有"完成时间"可言)。
  if (!view.done) {
    return okEnvelope(view, `待办 [${id}]:${view.title} 尚未完成,无需重开。`);
  }
  db.prepare("UPDATE todo SET done = 0, done_at = NULL WHERE id = ?").run(id);
  const updated = toView(db.prepare(`${SELECT_TODO} WHERE t.id = ?`).get(id) as TodoJoinRow);
  return okEnvelope(updated, `已重开待办 [${id}]:${updated.title}。`);
}

export function deleteTodo(db: Db, caller: Caller, id: string): Envelope {
  const loaded = loadWritableTodo(db, caller, id, "删除");
  if ("envelope" in loaded) return loaded.envelope;
  const view = toView(loaded.row);
  const now = new Date().toISOString();

  // V8:代记者可撤回自己代记的条目(删除权与修改权分开给)。
  if (view.owner_id !== caller.memberId) {
    // 可见性闸门已在 loadWritableTodo 里跑过;这里是纵深防御,防止日后调序时静默放行。
    if (!canDeleteTodo(view, caller)) return denyNotVisible();
    db.prepare("UPDATE todo SET deleted_at = ? WHERE id = ?").run(now, id);
    return okEnvelope(
      { ...view, deleted_at: now },
      `已撤回你代记的条目 [${id}]:${view.title}(归属:${view.owner_name})。` +
        `${view.owner_name} 的待办列表里不再有它;可用 restore_deleted 恢复。`,
    );
  }
  db.prepare("UPDATE todo SET deleted_at = ? WHERE id = ?").run(now, id);
  return okEnvelope(
    { ...view, deleted_at: now },
    `已删除待办 [${id}]:${view.title}。已删除,可用 restore_deleted(kind="todo", id="${id}") 恢复。`,
  );
}

/**
 * 恢复一条已软删的待办(§4:软删可逆)。与 delete_todo 的差别只有"要看到已删的行"。
 * 权限复用 canDeleteTodo:**恢复权与删除权同源**,理由见该函数注释。
 *
 * **判定顺序:权限先于幂等**(S1c 修复轮)。幂等回执带标题("…未被删除,无需恢复。"),
 * 若它排在 canDeleteTodo 之前,第三人拿别人的 id 就能读出该条目的标题,
 * 还顺带读出"它存在、且它没被删"——违反 V1/V3/V5/V6(X4:跨成员传他人条目 id 必须拒绝)。
 * 调序之后幂等分支只剩"本人/自己代记的条目本来就未删除"这一种情况,话术照旧。
 */
export function restoreTodo(db: Db, caller: Caller, id: string): Envelope {
  const row = loadTodo(db, id);
  if (!row) return todoMissing(id, "恢复");
  const view = toView(row);
  if (!canDeleteTodo(view, caller)) return denyNotVisible();
  // 未删除 → 幂等:不动任何字段(P2:重复调用不产生副作用)。
  if (row.deleted_at === null) {
    return okEnvelope({ ...view, deleted_at: null }, `待办 [${id}]:${view.title} 未被删除,无需恢复。`);
  }

  db.prepare("UPDATE todo SET deleted_at = NULL WHERE id = ?").run(id);
  const restored = toView(db.prepare(`${SELECT_TODO} WHERE t.id = ?`).get(id) as TodoJoinRow);
  const message =
    view.owner_id === caller.memberId
      ? `已恢复待办 [${id}]:${view.title}。它重新出现在你的待办列表里(待办仅归属人可见)。`
      : `已恢复你代记的条目 [${id}]:${view.title}(归属:${view.owner_name})。${view.owner_name} 现在又能看到这条待办了。`;
  return okEnvelope({ ...restored, deleted_at: null }, message);
}
