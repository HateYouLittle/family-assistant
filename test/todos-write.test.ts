import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { listAudit } from "../src/audit/audit.js";
import type { Envelope, FailEnvelope, OkEnvelope } from "../src/domain/envelope.js";
import { restoreDeleted } from "../src/domain/restore.js";
import {
  addTodo,
  completeTodo,
  deleteTodo,
  listTodos,
  reopenTodo,
  updateTodo,
  type AddTodoInput,
} from "../src/domain/todos.js";
import { TOOL_DEFINITIONS } from "../src/mcp/tools.js";
import { newFixture, TZ, type Fixture, type FixtureKey } from "./helpers.js";

/**
 * 待办域写路径(update_todo / reopen_todo / delete_todo / restore_deleted)。
 * 对照:设计方案 §4 待办真值表 + V3/V5/V6/V7/V8,反例 X4/X5/X14/X15/X16。
 *
 * 两条纪律:
 * 1. 每条用例都直查**原始行**(rawTodo),不只看信封——"被拒的调用不得留下任何写入"
 *    与"幂等不得改写字段"都只能靠读库证明。
 * 2. 直接调 domain 函数(参数校验在工具层,那部分走 callTool 与 schemas.test.ts)。
 */

let f: Fixture;
afterEach(() => f?.db.close());

function ok(env: { ok: boolean; message?: string }): asserts env is OkEnvelope {
  assert.equal(env.ok, true, `期望成功信封,实际:${JSON.stringify(env)}`);
}
function fail(env: { ok: boolean; message?: string }): asserts env is FailEnvelope {
  assert.equal(env.ok, false, `期望失败信封,实际:${JSON.stringify(env)}`);
}

interface RawTodoRow {
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
}

/** 直读原始行:证明"没有写入"要靠库,不能靠信封。 */
function rawTodo(id: string): RawTodoRow {
  const row = f.db.prepare("SELECT * FROM todo WHERE id = ?").get(id) as RawTodoRow | undefined;
  assert.ok(row, `库里没有这条待办:${id}`);
  return row!;
}

/** 建一条待办并返回 id(写路径用例都要先有 id)。 */
function newTodo(key: FixtureKey, input: AddTodoInput): string {
  const env = addTodo(f.db, f.callers[key], TZ, input);
  ok(env);
  return (env.data as { id: string }).id;
}

/** 走工具层(参数校验 + 审计留痕),参数不合规时直接返回 parse 的失败信封。 */
function callTool(key: FixtureKey, name: string, args: unknown): Envelope {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
  assert.ok(tool, `未知工具 ${name}`);
  const parsed = tool!.parse(args);
  return parsed.ok ? tool!.run(f.db, f.callers[key], TZ, parsed.args) : parsed.envelope;
}

describe("update_todo:本人可改(V3/V6)", () => {
  it("改标题/备注/截止日期 → 成功,回执逐项说明改了什么,原始行同步", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交电费", due_date: "2031-01-02", notes: "找王管家" });

    const env = updateTodo(f.db, f.callers.mama, TZ, {
      id,
      title: "交电费线上版",
      notes: "用微信缴",
      due_date: "2031-02-03",
    });
    ok(env);
    assert.match(
      env.message,
      /^已更新待办 \[t-\d{6}-[a-z2-9]{4}\]:交电费线上版\(截止 02-03\)。改动:标题→「交电费线上版」;备注已更新;截止日期改为 2031-02-03。$/,
    );
    const row = rawTodo(id);
    assert.equal(row.title, "交电费线上版");
    assert.equal(row.notes, "用微信缴");
    assert.equal(row.due_date, "2031-02-03");
  });

  it("owner 缺省 → 归属不变(回执不出现 immutable 话术)", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交电费" });

    const env = updateTodo(f.db, f.callers.mama, TZ, { id, title: "交电费改" });
    ok(env);
    assert.doesNotMatch(env.message, /归属\/账本不可修改/);
    assert.equal(rawTodo(id).owner_id, f.members.mama.id);
  });

  it("不存在的 id → NOT_FOUND + 引导先 list(P5)", () => {
    f = newFixture();
    const env = updateTodo(f.db, f.callers.mama, TZ, { id: "t-261001-zzzz", title: "x" });
    fail(env);
    assert.equal(env.code, "NOT_FOUND");
    assert.equal(env.id, "t-261001-zzzz");
    assert.match(env.hint ?? "", /先调 list_todos/);
  });
});

describe("update_todo:他人条目一律 DENIED(not_visible),且不留写入(V3/V6/X4)", () => {
  it("V3/V6:爸爸改妈妈的待办 → DENIED(not_visible),title/deleted_at 原样不动", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费", due_date: "2031-01-02", notes: "找王管家" });
    const before = rawTodo(id);

    const env = updateTodo(f.db, f.callers.baba, TZ, { id, title: "偷偷改", due_date: null, notes: null });
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assert.match(env.message, /仅归属人本人可见/);
    assert.match(env.hint ?? "", /家人之间的待办互相不可见/);

    const after = rawTodo(id);
    assert.equal(after.title, before.title);
    assert.equal(after.notes, before.notes);
    assert.equal(after.due_date, before.due_date);
    assert.equal(after.deleted_at, null);
  });

  it("权限先于不可变:他人在 update_todo 里传 owner=自己也绕不过去(仍是 not_visible,不是 immutable)", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费" });

    const env = updateTodo(f.db, f.callers.baba, TZ, { id, owner: "爸爸", title: "偷偷改" });
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    // 若顺序写反,这里会变成 immutable,并且泄露"这条记在妈妈名下"
    assert.doesNotMatch(env.message, /删除后重建/);
    assert.doesNotMatch(env.message, /记在 妈妈 名下/);
    assert.equal(rawTodo(id).title, "交物业费");
  });
});

describe("update_todo:V7 归属不可变(X14)", () => {
  it("X14:本人把待办改归属给他人 → DENIED(immutable),话术给出删除后重建的出路", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费" });

    const env = updateTodo(f.db, f.callers.mama, TZ, { id, owner: "爸爸" });
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "immutable");
    assert.match(env.message, /归属\/账本不可修改,如需变更请删除后重建/);
    assert.match(env.message, /记在 妈妈 名下,你不能把它改成「爸爸」名下的/);
    assert.match(env.hint ?? "", /delete_todo/);
    assert.match(env.hint ?? "", /add_todo\(owner="爸爸"\)/);
    assert.equal(rawTodo(id).owner_id, f.members.mama.id, "被拒的调用不得改归属");
  });

  it("owner 传现值的三种写法(成员名/别名/成员 id)→ 幂等放行,归属不动", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费" });

    for (const owner of ["妈妈", "老妈", f.members.mama.id]) {
      const env = updateTodo(f.db, f.callers.mama, TZ, { id, owner });
      ok(env);
      assert.match(env.message, /未做修改\(没有字段发生变化\)/, `同值 owner 应幂等放行:${owner}`);
      assert.equal(rawTodo(id).owner_id, f.members.mama.id);
    }
  });

  it("owner 与现值不符且写对其他字段 → 整次调用被拒,其他字段也不落库", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费" });

    const env = updateTodo(f.db, f.callers.mama, TZ, { id, owner: "小明", title: "交物业费改" });
    fail(env);
    assert.equal(env.reason, "immutable");
    assert.equal(rawTodo(id).title, "交物业费");
  });

  it("owner 匹配不到成员 → MISSING_PARAMS + 成员名单(复用 X10 口径)", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费" });

    const env = updateTodo(f.db, f.callers.mama, TZ, { id, owner: "查无此人" });
    fail(env);
    assert.equal(env.code, "MISSING_PARAMS");
    assert.deepEqual(env.missing, ["owner"]);
    assert.match(env.message, /家庭成员有:妈妈、爸爸、小明/);
  });
});

describe("update_todo:置空语义(§5.1③:缺省=不改,null=清空)", () => {
  it("due_date=null → 清空截止日期;同一次调用缺省的 notes 保持原值", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费", due_date: "2031-01-02", notes: "找王管家" });

    const env = updateTodo(f.db, f.callers.mama, TZ, { id, due_date: null });
    ok(env);
    assert.match(env.message, /改动:已去掉截止日期。$/);
    const row = rawTodo(id);
    assert.equal(row.due_date, null);
    assert.equal(row.notes, "找王管家", "缺省的字段不得被改动");
  });

  it("notes=null → 清空备注;同一次调用缺省的 due_date 保持原值", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费", due_date: "2031-01-02", notes: "找王管家" });

    const env = updateTodo(f.db, f.callers.mama, TZ, { id, notes: null });
    ok(env);
    assert.match(env.message, /改动:备注已清空。$/);
    const row = rawTodo(id);
    assert.equal(row.notes, null);
    assert.equal(row.due_date, "2031-01-02", "缺省的字段不得被改动");
  });

  it("值与现值相同 → 幂等,一个字都不写库", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费", due_date: "2031-01-02", notes: "找王管家" });
    const before = rawTodo(id);

    const env = updateTodo(f.db, f.callers.mama, TZ, {
      id,
      title: "交物业费",
      due_date: "2031-01-02",
      notes: "找王管家",
    });
    ok(env);
    assert.match(env.message, /未做修改\(没有字段发生变化\)/);
    assert.deepEqual(rawTodo(id), before);
  });
});

describe("update_todo:工具层拒绝 done 与身份参数(P8/X15)", () => {
  it("传 done → INVALID_PARAMS(未知字段),不写库", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费" });

    const env = callTool("mama", "update_todo", { id, done: true });
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "done");
    assert.match(env.message, /不接受未知参数:done/);
    assert.equal(rawTodo(id).done, 0);
  });

  it("X15:传 as_member → INVALID_PARAMS,并点破说话人不是参数", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费" });

    const env = callTool("mama", "update_todo", { id, as_member: "爸爸" });
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "as_member");
    assert.match(env.message, /说话人由连接确定/);
    assert.equal(rawTodo(id).title, "交物业费");
  });

  it("缺 id → MISSING_PARAMS(missing 指明字段)", () => {
    f = newFixture();
    const env = callTool("mama", "update_todo", { title: "x" });
    fail(env);
    assert.equal(env.code, "MISSING_PARAMS");
    assert.deepEqual(env.missing, ["id"]);
  });
});

describe("reopen_todo(取消完成)", () => {
  it("已完成 → 重开:done=0、done_at=null,回执说明已重开", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交电费" });
    ok(completeTodo(f.db, f.callers.mama, TZ, id));
    const done = rawTodo(id);
    assert.equal(done.done, 1);
    assert.ok(done.done_at !== null);

    const env = reopenTodo(f.db, f.callers.mama, id);
    ok(env);
    assert.match(env.message, /^已重开待办 \[t-\d{6}-[a-z2-9]{4}\]:交电费。$/);
    const reopened = rawTodo(id);
    assert.equal(reopened.done, 0);
    assert.equal(reopened.done_at, null);
  });

  it("本就未完成 → 幂等:done_at 不被改写(不能无条件清空)", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交电费" });
    // 人为造出 done=0 但 done_at 有值的行:幂等分支若执行 UPDATE,这里就会露馅
    f.db.prepare("UPDATE todo SET done_at = ? WHERE id = ?").run("2026-10-01T00:00:00.000Z", id);

    const env = reopenTodo(f.db, f.callers.mama, id);
    ok(env);
    assert.match(env.message, /尚未完成,无需重开。$/);
    assert.equal(rawTodo(id).done_at, "2026-10-01T00:00:00.000Z");
  });

  it("V3/V6:他人重开 → DENIED(not_visible),完成状态不动", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交电费" });
    ok(completeTodo(f.db, f.callers.mama, TZ, id));
    const doneAt = rawTodo(id).done_at;

    const env = reopenTodo(f.db, f.callers.baba, id);
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assert.match(env.message, /仅归属人本人可见/);
    const after = rawTodo(id);
    assert.equal(after.done, 1);
    assert.equal(after.done_at, doneAt);
  });

  it("不存在的 id → NOT_FOUND", () => {
    f = newFixture();
    const env = reopenTodo(f.db, f.callers.mama, "t-261001-zzzz");
    fail(env);
    assert.equal(env.code, "NOT_FOUND");
    assert.equal(env.id, "t-261001-zzzz");
  });
});

describe("delete_todo(软删,可恢复)", () => {
  it("本人删除 → 软删:deleted_at 非空、行还在、list 里不再出现", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费" });

    const env = deleteTodo(f.db, f.callers.mama, id);
    ok(env);
    assert.match(
      env.message,
      /^已删除待办 \[t-\d{6}-[a-z2-9]{4}\]:交物业费。已删除,可用 restore_deleted\(kind="todo", id="t-\d{6}-[a-z2-9]{4}"\) 恢复。$/,
    );
    assert.match(env.message, new RegExp(`\\[${id}\\]`));
    const row = rawTodo(id);
    assert.notEqual(row.deleted_at, null, "软删必须写 deleted_at");
    const count = f.db.prepare("SELECT COUNT(*) AS n FROM todo WHERE id = ?").get(id) as { n: number };
    assert.equal(count.n, 1, "软删不是物理删除,行还在");

    const list = listTodos(f.db, f.callers.mama, TZ, {});
    ok(list);
    assert.deepEqual(list.data, { todos: [], delegated: [] });
    assert.match(list.message, /没有符合条件的待办/);
  });

  it("再次删同一 id → NOT_FOUND,并指出已删、给出恢复出路", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费" });
    ok(deleteTodo(f.db, f.callers.mama, id));
    const deletedAt = rawTodo(id).deleted_at;

    const env = deleteTodo(f.db, f.callers.mama, id);
    fail(env);
    assert.equal(env.code, "NOT_FOUND");
    assert.match(env.message, /已被删除,无法删除/);
    assert.match(env.hint ?? "", /restore_deleted/);
    assert.equal(rawTodo(id).deleted_at, deletedAt);
  });

  it("对不存在的 id 删除 → NOT_FOUND", () => {
    f = newFixture();
    const env = deleteTodo(f.db, f.callers.mama, "t-261001-zzzz");
    fail(env);
    assert.equal(env.code, "NOT_FOUND");
    assert.match(env.message, /没有找到这条待办/);
  });

  it("V3/X5:他人删除 → DENIED(not_visible),deleted_at 仍为 null", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费" });

    const env = deleteTodo(f.db, f.callers.baba, id);
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assert.match(env.message, /仅归属人本人可见/);
    assert.equal(rawTodo(id).deleted_at, null, "被拒的调用不得留下软删");
  });

  it("已删的条目:update / reopen 都按 NOT_FOUND(退出可见范围,提示用 restore_deleted)", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费" });
    ok(deleteTodo(f.db, f.callers.mama, id));

    const upd = updateTodo(f.db, f.callers.mama, TZ, { id, title: "x" });
    fail(upd);
    assert.equal(upd.code, "NOT_FOUND");
    assert.match(upd.hint ?? "", /restore_deleted/);

    const reo = reopenTodo(f.db, f.callers.mama, id);
    fail(reo);
    assert.equal(reo.code, "NOT_FOUND");
    assert.match(reo.message, /已被删除,无法重开/);
  });
});

describe("restore_deleted(§4 软删可逆)", () => {
  it("删后恢复 → 重新可见,且字段与删除前完全一致", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费", due_date: "2031-01-02", notes: "找王管家" });
    ok(completeTodo(f.db, f.callers.mama, TZ, id));
    const before = rawTodo(id);
    ok(deleteTodo(f.db, f.callers.mama, id));

    const env = restoreDeleted(f.db, f.callers.mama, "todo", id);
    ok(env);
    assert.match(env.message, /^已恢复待办 \[t-\d{6}-[a-z2-9]{4}\]:交物业费。它重新出现在你的待办列表里\(待办仅归属人可见\)。$/);

    const after = rawTodo(id);
    assert.deepEqual({ ...after, deleted_at: null }, { ...before, deleted_at: null }, "恢复后字段必须与删除前一致");
    const list = listTodos(f.db, f.callers.mama, TZ, {});
    ok(list);
    assert.deepEqual((list.data as { todos: { id: string }[] }).todos.map((t) => t.id), [id]);
  });

  it("对未删除的 id → 幂等回执,不动任何字段", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费", due_date: "2031-01-02" });
    const before = rawTodo(id);

    const env = restoreDeleted(f.db, f.callers.mama, "todo", id);
    ok(env);
    assert.match(env.message, /未被删除,无需恢复。$/);
    assert.deepEqual(rawTodo(id), before);
  });

  it("不存在的 id → NOT_FOUND", () => {
    f = newFixture();
    const env = restoreDeleted(f.db, f.callers.mama, "todo", "t-261001-zzzz");
    fail(env);
    assert.equal(env.code, "NOT_FOUND");
    assert.equal(env.id, "t-261001-zzzz");
  });

  it('kind="entry" → INVALID_PARAMS + field=kind,并列出本阶段可用的 kind', () => {
    f = newFixture();
    // S2 起 "event" 已接入(S1 时这里断言的是 event);未接入的记账仍是 "entry"。
    const env = restoreDeleted(f.db, f.callers.mama, "entry", "t-261001-zzzz");
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "kind");
    assert.match(env.message, /暂不支持 kind="entry"/);
    assert.match(env.hint ?? "", /kind="todo"/);
  });

  it("工具层同样挡住 kind=entry(INVALID_PARAMS,未知枚举值)", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费" });
    ok(deleteTodo(f.db, f.callers.mama, id));

    const env = callTool("mama", "restore_deleted", { kind: "entry", id });
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.notEqual(rawTodo(id).deleted_at, null, "参数不合规不得落库");
  });

  it("V3/V5/X4:他人条目、未删除 → DENIED(not_visible),话术不得夹带标题(幂等分支不得抢在权限前)", () => {
    f = newFixture();
    // 复现实测场景:爸爸 restore_deleted 妈妈名下、且**未被删除**的待办。
    const id = newTodo("mama", { title: "妈妈的待办", due_date: "2031-01-02", notes: "找王管家" });
    const before = rawTodo(id);

    const env = restoreDeleted(f.db, f.callers.baba, "todo", id);
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assert.match(env.message, /仅归属人本人可见/);
    assert.match(env.hint ?? "", /家人之间的待办互相不可见/);
    // 否定断言钉死泄露面(不只断 reason):
    // 1) 标题/备注一个字都不许出现 —— 否则等于把别人的待办读给第三人;
    assert.doesNotMatch(env.message, /妈妈的待办/, "拒绝话术不得泄露标题(V5)");
    assert.doesNotMatch(JSON.stringify(env), /妈妈的待办/, "拒绝信封(data + 话术)都不得泄露标题(V5)");
    assert.doesNotMatch(JSON.stringify(env), /找王管家/, "拒绝信封不得泄露备注(V5)");
    // 2) "它没被删"同样是关于这条待办的信息:幂等回执的痕迹一样不许漏出去。
    assert.doesNotMatch(env.message, /无需恢复|未被删除/, "不可见者不得据此推断该条目的删除状态(V5)");
    assert.deepEqual(rawTodo(id), before, "被拒的恢复不得留下任何写入");
  });

  it("V3/V5:他人条目、已被删除 → DENIED(not_visible),删除不改变可见性口径", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费", notes: "找王管家" });
    // 先由归属人自己删掉,再让第三人 restore
    ok(deleteTodo(f.db, f.callers.mama, id));
    const deletedAt = rawTodo(id).deleted_at;

    const env = restoreDeleted(f.db, f.callers.kid, "todo", id);
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assert.doesNotMatch(JSON.stringify(env), /交物业费/, "拒绝信封不得泄露标题(V5)");
    assert.equal(rawTodo(id).deleted_at, deletedAt, "被拒的恢复不得生效");
  });
});

describe("V8/X16 代记者:可看可删可恢复,不可改不可重开", () => {
  it("代记者(妈妈给爸爸记)能 delete → 回执标注已撤回你代记的条目", () => {
    f = newFixture();
    const id = newTodo("mama", { owner: "爸爸", title: "买酱油", notes: "用微信付" });

    const env = deleteTodo(f.db, f.callers.mama, id);
    ok(env);
    assert.match(env.message, new RegExp(`^已撤回你代记的条目 \\[${id}\\]:买酱油\\(归属:爸爸\\)。`));
    assert.match(env.message, /可用 restore_deleted 恢复/);
    assert.notEqual(rawTodo(id).deleted_at, null);
  });

  it("代记者对自己代记、**未删除**的条目 restore → 幂等成功(无需恢复):调序不得把代记者的正当路径一起挡掉", () => {
    f = newFixture();
    const id = newTodo("mama", { owner: "爸爸", title: "买酱油" });
    const before = rawTodo(id);

    // 权限先于幂等之后,代记者这一支仍必须放行(恢复权与删除权同源)。
    const env = restoreDeleted(f.db, f.callers.mama, "todo", id);
    ok(env);
    assert.match(env.message, new RegExp(`^待办 \\[${id}\\]:买酱油 未被删除,无需恢复。$`));
    assert.equal((env.data as { deleted_at: string | null }).deleted_at, null);
    assert.deepEqual(rawTodo(id), before, "幂等回执一个字都不写库");
  });

  it("代记者能 restore 自己撤回的条目 → 归属人重新可见", () => {
    f = newFixture();
    const id = newTodo("mama", { owner: "爸爸", title: "买酱油" });
    ok(deleteTodo(f.db, f.callers.mama, id));

    const env = restoreDeleted(f.db, f.callers.mama, "todo", id);
    ok(env);
    assert.match(env.message, new RegExp(`^已恢复你代记的条目 \\[${id}\\]:买酱油\\(归属:爸爸\\)。`));
    assert.match(env.message, /爸爸 现在又能看到这条待办了/);
    assert.equal(rawTodo(id).deleted_at, null);

    const babaList = listTodos(f.db, f.callers.baba, TZ, {});
    ok(babaList);
    assert.deepEqual((babaList.data as { todos: { id: string }[] }).todos.map((t) => t.id), [id]);
  });

  it("代记者 update / reopen → DENIED(not_writable),且不留下任何写入", () => {
    f = newFixture();
    const id = newTodo("mama", { owner: "爸爸", title: "买酱油", due_date: "2031-01-02" });
    ok(completeTodo(f.db, f.callers.baba, TZ, id));
    const before = rawTodo(id);

    const upd = updateTodo(f.db, f.callers.mama, TZ, { id, title: "偷偷改", due_date: null });
    fail(upd);
    assert.equal(upd.code, "DENIED");
    assert.equal(upd.reason, "not_writable");
    assert.match(upd.message, /这条待办是你代 爸爸 记的,只能由 爸爸 本人修改/);
    assert.match(upd.hint ?? "", /delete_todo 撤回/);

    const reo = reopenTodo(f.db, f.callers.mama, id);
    fail(reo);
    assert.equal(reo.code, "DENIED");
    assert.equal(reo.reason, "not_writable");
    assert.match(reo.message, /只能由 爸爸 本人重开/);

    assert.deepEqual(rawTodo(id), before, "被拒的调用不得留下任何写入");
  });

  it("归属人(爸爸)本人 update / reopen / delete 全部正常", () => {
    f = newFixture();
    const id = newTodo("mama", { owner: "爸爸", title: "买酱油" });

    const upd = updateTodo(f.db, f.callers.baba, TZ, { id, title: "买酱油 打折时买" });
    ok(upd);
    assert.equal(rawTodo(id).title, "买酱油 打折时买");

    ok(completeTodo(f.db, f.callers.baba, TZ, id));
    const reo = reopenTodo(f.db, f.callers.baba, id);
    ok(reo);
    assert.match(reo.message, /^已重开待办/);
    assert.equal(rawTodo(id).done, 0);

    const del = deleteTodo(f.db, f.callers.baba, id);
    ok(del);
    assert.match(del.message, /^已删除待办/, "归属人本人删除走本人话术,不是代记撤回话术");
    assert.notEqual(rawTodo(id).deleted_at, null);
  });

  it("第三人(小明)对代记者条目 → 一律 not_visible(不是 not_writable)", () => {
    f = newFixture();
    const id = newTodo("mama", { owner: "爸爸", title: "买酱油" });

    // 可见状态下删除:权限闸门先于写入
    const del = deleteTodo(f.db, f.callers.kid, id);
    fail(del);
    assert.equal(del.code, "DENIED");
    assert.equal(del.reason, "not_visible", "小明既非归属人也非代记者,只能是 not_visible");
    assert.match(del.message, /仅归属人本人可见/);
    assert.equal(rawTodo(id).deleted_at, null, "被拒的删除不得生效");

    // 代记者撤回后,第三人仍然恢复不了(删除不改变可见性口径)
    ok(deleteTodo(f.db, f.callers.mama, id));
    const res = restoreDeleted(f.db, f.callers.kid, "todo", id);
    fail(res);
    assert.equal(res.code, "DENIED");
    assert.equal(res.reason, "not_visible");
    assert.notEqual(rawTodo(id).deleted_at, null, "被拒的恢复不得生效");
  });
});

describe("可见性先于行内信息:四个写工具对他人已删条目不得先回答已被删除", () => {
  it("同一条他人待办:未删时 DENIED(not_visible),删后仍是 DENIED(not_visible),不得漂移成 NOT_FOUND", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费", due_date: "2031-01-02" });

    // 可见状态:四个写工具一律 not_visible(基线)
    const liveCalls: Envelope[] = [
      updateTodo(f.db, f.callers.baba, TZ, { id, title: "偷偷改" }),
      reopenTodo(f.db, f.callers.baba, id),
      completeTodo(f.db, f.callers.baba, TZ, id),
      deleteTodo(f.db, f.callers.baba, id),
    ];
    for (const env of liveCalls) {
      fail(env);
      assert.equal(env.reason, "not_visible");
    }

    // 归属人自己删掉后:判定口径不得因为 deleted_at 而改变
    ok(deleteTodo(f.db, f.callers.mama, id));
    const deletedAt = rawTodo(id).deleted_at;

    const deletedCalls: Envelope[] = [
      updateTodo(f.db, f.callers.baba, TZ, { id, title: "偷偷改" }),
      reopenTodo(f.db, f.callers.baba, id),
      completeTodo(f.db, f.callers.baba, TZ, id),
      deleteTodo(f.db, f.callers.baba, id),
    ];
    for (const env of deletedCalls) {
      fail(env);
      assert.equal(
        env.reason,
        "not_visible",
        "不可见者不得先被告知「这条待办已被删除」——那等于泄露删除状态(V5)",
      );
      // 「已被删除」+ 附赠 restore_deleted 命令 = 先给信息、后判权限。
      assert.doesNotMatch(env.message, /已被删除/, "不得向不可见者泄露该条目的删除状态(V5)");
      assert.doesNotMatch(env.hint ?? "", /restore_deleted/, "不得向不可见者给出针对该条目的操作出路(V5)");
      assert.doesNotMatch(JSON.stringify(env), /交物业费/, "拒绝信封不得泄露标题(V5)");
    }
    assert.equal(rawTodo(id).deleted_at, deletedAt, "被拒的调用不得动这一行");
  });

  it("归属人本人对已删条目 → 仍按 NOT_FOUND(§4 已删即不在可见范围,给出恢复出路)", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交物业费" });
    ok(deleteTodo(f.db, f.callers.mama, id));

    // 可见性闸门不能反过来把本人也挡在 NOT_FOUND 之外 —— 本人本就看得见「已删」。
    const env = updateTodo(f.db, f.callers.mama, TZ, { id, title: "x" });
    fail(env);
    assert.equal(env.code, "NOT_FOUND");
    assert.match(env.message, /已被删除,无法修改/);
    assert.match(env.hint ?? "", /restore_deleted/);
  });

  it("代记者对已删的代记条目 → NOT_FOUND(她看得见这条);第三人对同一条 → not_visible", () => {
    f = newFixture();
    const id = newTodo("mama", { owner: "爸爸", title: "买酱油" });
    ok(deleteTodo(f.db, f.callers.mama, id));

    // 妈妈是创建者 → 看得见这条,所以「已删」可以告诉她(§4:已删退出活跃范围)。
    // 这与归属人本人对已删条目同口径,不因 V8 而变。
    const upd = updateTodo(f.db, f.callers.mama, TZ, { id, title: "偷偷改" });
    fail(upd);
    assert.equal(upd.code, "NOT_FOUND");
    assert.equal(upd.reason, undefined, "看得见的人拿到的不是权限拒绝,而是范围之外");
    assert.match(upd.message, /已被删除,无法修改/);

    // 小明既非归属人也非创建者 → 看不见,连「已删」都不许知道。
    const third = updateTodo(f.db, f.callers.kid, TZ, { id, title: "偷偷改" });
    fail(third);
    assert.equal(third.reason, "not_visible");
    assert.doesNotMatch(third.message, /已被删除/);

    // 可见但仍不可写的那一侧(V8)没有被调序动过:条目回到活跃范围后仍是 not_writable。
    ok(restoreDeleted(f.db, f.callers.mama, "todo", id));
    const rewritable = updateTodo(f.db, f.callers.mama, TZ, { id, title: "偷偷改" });
    fail(rewritable);
    assert.equal(rewritable.reason, "not_writable", "V8 的修改权归属不因可见性调序而改变");
  });
});

describe("审计:4 个新写工具各留一行,读工具不留(§6)", () => {
  it("update/reopen/delete/restore 各留一行;list_todos、list_members 不留", () => {
    f = newFixture();
    // 审计记在工具层,所以这里也走工具层建条目(add_todo 那一条也在表里)
    const add = callTool("mama", "add_todo", { title: "交电费" });
    ok(add);
    const id = (add.data as { id: string }).id;

    ok(callTool("mama", "update_todo", { id, title: "交电费线上版" }));
    ok(callTool("mama", "complete_todo", { id }));
    ok(callTool("mama", "reopen_todo", { id }));
    ok(callTool("mama", "delete_todo", { id }));
    ok(callTool("mama", "restore_deleted", { kind: "todo", id }));
    // add_todo 那一条是 newTodo 留下的,共 6 行
    assert.deepEqual(
      listAudit(f.db).map((r) => r.tool),
      ["restore_deleted", "delete_todo", "reopen_todo", "complete_todo", "update_todo", "add_todo"],
    );

    ok(callTool("mama", "list_todos", {}));
    ok(callTool("mama", "list_members", {}));
    ok(callTool("baba", "list_todos", {}));
    assert.equal(listAudit(f.db).length, 6, "读操作不留痕");
  });

  it("member_id 取连接身份:妈妈代记给爸爸时,审计里的身份是妈妈(不是 owner 爸爸)", () => {
    f = newFixture();
    const add = callTool("mama", "add_todo", { owner: "爸爸", title: "买酱油", notes: "用微信付" });
    ok(add);
    const id = (add.data as { id: string }).id;

    const del = callTool("mama", "delete_todo", { id });
    ok(del);
    ok(callTool("mama", "restore_deleted", { kind: "todo", id }));

    const rows = listAudit(f.db);
    assert.deepEqual(rows.map((r) => r.tool), ["restore_deleted", "delete_todo", "add_todo"]);
    for (const r of rows) {
      assert.equal(r.member_id, f.members.mama.id, "审计身份必须是连接身份,不是参数里的 owner");
      assert.equal(r.member_name, "妈妈");
    }
    assert.match(rows[1]!.args_summary, new RegExp(`^id=${id}$`));
    assert.match(rows[0]!.args_summary, new RegExp(`^kind=todo id=${id}$`));
    // 归属人(爸爸)自己操作时,审计身份才变成爸爸
    ok(callTool("baba", "delete_todo", { id }));
    assert.equal(listAudit(f.db)[0]!.member_id, f.members.baba.id);
  });

  it("摘要只留元数据:notes 不进审计(自由文本不进)", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交电费" });

    ok(callTool("mama", "update_todo", { id, title: "交电费线上版", notes: "药买了记得刷医保卡,尾号 4321" }));
    const r = listAudit(f.db)[0]!;
    assert.equal(r.tool, "update_todo");
    assert.match(r.args_summary, new RegExp(`^id=${id} title=交电费线上版$`));
    assert.doesNotMatch(r.args_summary, /notes/);
    assert.doesNotMatch(r.args_summary, /4321/);
  });

  it("被拒的写调用也留痕(result_code=信封码,member_id 仍是连接身份)", () => {
    f = newFixture();
    const id = newTodo("mama", { title: "交电费" });

    const env = callTool("baba", "delete_todo", { id });
    fail(env);
    assert.equal(env.code, "DENIED");

    const r = listAudit(f.db)[0]!;
    assert.equal(r.tool, "delete_todo");
    assert.equal(r.ok, false);
    assert.equal(r.result_code, "DENIED");
    assert.equal(r.member_id, f.members.baba.id);
  });
});