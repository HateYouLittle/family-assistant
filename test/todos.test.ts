import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { FailEnvelope, OkEnvelope } from "../src/domain/envelope.js";
import { addTodo, completeTodo, listTodos } from "../src/domain/todos.js";
import { newFixture, TZ, type Fixture } from "./helpers.js";

let f: Fixture;
afterEach(() => f?.db.close());

function ok(env: { ok: boolean; message?: string }): asserts env is OkEnvelope {
  assert.equal(env.ok, true, `期望成功信封,实际:${JSON.stringify(env)}`);
}
function fail(env: { ok: boolean; message?: string }): asserts env is FailEnvelope {
  assert.equal(env.ok, false, `期望失败信封,实际:${JSON.stringify(env)}`);
}

describe("add_todo", () => {
  it("缺省 owner = 说话人本人;回执标注仅本人可见", () => {
    f = newFixture();
    const env = addTodo(f.db, f.callers.mama, TZ, { title: "交电费" });
    ok(env);
    assert.match(env.message, /^已添加待办 \[t-\d{6}-[a-z2-9]{4}\]:交电费。仅你自己可见。$/);
    const data = env.data as { owner_id: string; created_by: string; delegated: boolean };
    assert.equal(data.owner_id, f.members.mama.id);
    assert.equal(data.created_by, f.members.mama.id);
    assert.equal(data.delegated, false);
  });

  it("带截止日期的回执用相对说法", () => {
    f = newFixture();
    const today = f.db.prepare("SELECT date('now', '+8 hours') AS d").get() as { d: string };
    const env = addTodo(f.db, f.callers.mama, TZ, { title: "交电费", due_date: today.d });
    ok(env);
    assert.match(env.message, /\(今天截止\)/);
  });

  it("V4 代记:owner=他人,回执由服务端标注说话人", () => {
    f = newFixture();
    // 用远离今天的日期,避免落进"今天/明天"的相对话术分支
    const env = addTodo(f.db, f.callers.baba, TZ, { owner: "妈妈", title: "交物业费", due_date: "2031-01-02" });
    ok(env);
    assert.match(env.message, /^已为 妈妈 添加待办 \[t-\d{6}-[a-z2-9]{4}\]:交物业费\(截止 01-02\)。仅 妈妈 可见,由 爸爸 代记。$/);
    const data = env.data as { owner_name: string; created_by_name: string; delegated: boolean };
    assert.equal(data.owner_name, "妈妈");
    assert.equal(data.created_by_name, "爸爸");
    assert.equal(data.delegated, true);
  });

  it("owner 可用别名;也可以显式传自己(不算代记)", () => {
    f = newFixture();
    const byAlias = addTodo(f.db, f.callers.baba, TZ, { owner: "老妈", title: "x" });
    ok(byAlias);
    const self = addTodo(f.db, f.callers.baba, TZ, { owner: "爸爸", title: "x" });
    ok(self);
    assert.match(self.message, /^已添加待办/);
  });

  it("owner 匹配不到 → MISSING_PARAMS + 成员名单(X10)", () => {
    f = newFixture();
    const env = addTodo(f.db, f.callers.baba, TZ, { owner: "妈", title: "x" });
    fail(env);
    assert.equal(env.code, "MISSING_PARAMS");
    assert.match(env.message, /没有找到成员「妈」/);
    assert.match(env.message, /家庭成员有:妈妈、爸爸、小明/);
    assert.deepEqual(env.missing, ["owner"]);
  });

  it("owner 重名 → AMBIGUOUS + 候选(X10)", () => {
    f = newFixture();
    // 注意不能占用"妈妈"已有的别名(老妈),要造一个干净的撞名
    for (const id of [f.members.baba.id, f.members.kid.id]) {
      f.db.prepare("UPDATE member SET aliases = ? WHERE id = ?").run(JSON.stringify(["二叔"]), id);
    }
    const env = addTodo(f.db, f.callers.mama, TZ, { owner: "二叔", title: "x" });
    fail(env);
    assert.equal(env.code, "AMBIGUOUS");
    assert.deepEqual(env.candidates?.map((c) => c.name).sort(), ["小明", "爸爸"]);
  });
});

describe("list_todos 可见性(V1/V8)", () => {
  it("只返回本人待办;他人待办与代记待办不出现(V1)", () => {
    f = newFixture();
    addTodo(f.db, f.callers.mama, TZ, { title: "妈妈的待办" });
    addTodo(f.db, f.callers.baba, TZ, { title: "爸爸的待办" });
    const env = listTodos(f.db, f.callers.mama, TZ, {});
    ok(env);
    const data = env.data as { todos: { title: string }[] };
    assert.deepEqual(data.todos.map((t) => t.title), ["妈妈的待办"]);
  });

  it("X16:代记条目对创建者可见(单列一组)、对第三人不可见", () => {
    f = newFixture();
    const add = addTodo(f.db, f.callers.baba, TZ, { owner: "妈妈", title: "爸爸代妈妈记的" });
    ok(add);
    // 创建者(爸爸):可见,且在"代记"分组
    const babaList = listTodos(f.db, f.callers.baba, TZ, {});
    ok(babaList);
    const babaData = babaList.data as { todos: unknown[]; delegated: { title: string; owner_name: string }[] };
    assert.deepEqual(babaData.todos, []);
    assert.equal(babaData.delegated.length, 1);
    assert.equal(babaData.delegated[0]!.owner_name, "妈妈");
    assert.match(babaList.message, /你代记的待办 1 条/);
    // 第三人(小明):完全不可见
    const kidList = listTodos(f.db, f.callers.kid, TZ, {});
    ok(kidList);
    const kidData = kidList.data as { todos: unknown[]; delegated: unknown[] };
    assert.deepEqual(kidData, { todos: [], delegated: [] });
    assert.match(kidList.message, /没有符合条件的待办/);
  });

  it("过滤器:done / due_before / due_after / q", () => {
    f = newFixture();
    const a = addTodo(f.db, f.callers.mama, TZ, { title: "交电费", due_date: "2026-10-01" });
    ok(a);
    const b = addTodo(f.db, f.callers.mama, TZ, { title: "交物业费", due_date: "2026-10-10" });
    ok(b);
    const c = addTodo(f.db, f.callers.mama, TZ, { title: "买奶茶", notes: "用微信支付" });
    ok(c);
    const aid = (a.data as { id: string }).id;
    const done = completeTodo(f.db, f.callers.mama, TZ, aid);
    ok(done);

    const onlyOpen = listTodos(f.db, f.callers.mama, TZ, { done: false });
    ok(onlyOpen);
    assert.deepEqual(
      (onlyOpen.data as { todos: { title: string }[] }).todos.map((t) => t.title),
      ["交物业费", "买奶茶"], // 无截止日期排在最后
    );

    const range = listTodos(f.db, f.callers.mama, TZ, { due_after: "2026-10-02", due_before: "2026-10-31" });
    ok(range);
    assert.deepEqual((range.data as { todos: { title: string }[] }).todos.map((t) => t.title), ["交物业费"]);

    const byQ = listTodos(f.db, f.callers.mama, TZ, { q: "奶茶" });
    ok(byQ);
    assert.deepEqual((byQ.data as { todos: { title: string }[] }).todos.map((t) => t.title), ["买奶茶"]);

    const byNotesQ = listTodos(f.db, f.callers.mama, TZ, { q: "微信支付" });
    ok(byNotesQ);
    assert.equal((byNotesQ.data as { todos: unknown[] }).todos.length, 1);
  });

  it("list 话术:序号、id、标题同行(§4 输出纪律)", () => {
    f = newFixture();
    addTodo(f.db, f.callers.mama, TZ, { title: "交电费", due_date: "2026-10-01" });
    const env = listTodos(f.db, f.callers.mama, TZ, {});
    ok(env);
    assert.match(env.message, /你的待办 1 条:1\. \[t-\d{6}-[a-z2-9]{4}\] 交电费\(截止 10-01,已逾期 \d+ 天\)/);
  });
});

describe("complete_todo(V3/V6/V8)", () => {
  it("本人完成 → 成功;重复完成幂等", () => {
    f = newFixture();
    const add = addTodo(f.db, f.callers.mama, TZ, { title: "x" });
    ok(add);
    const id = (add.data as { id: string }).id;
    const first = completeTodo(f.db, f.callers.mama, TZ, id);
    ok(first);
    assert.match(first.message, /^已完成待办 \[.+\]:x。$/);
    const again = completeTodo(f.db, f.callers.mama, TZ, id);
    ok(again);
    assert.match(again.message, /无需重复操作/);
  });

  it("不存在的 id → NOT_FOUND + 引导先 list(P5)", () => {
    f = newFixture();
    const env = completeTodo(f.db, f.callers.mama, TZ, "t-261001-zzzz");
    fail(env);
    assert.equal(env.code, "NOT_FOUND");
    assert.equal(env.id, "t-261001-zzzz");
  });

  it("X4:完成他人的待办 → DENIED(not_visible)", () => {
    f = newFixture();
    const add = addTodo(f.db, f.callers.mama, TZ, { title: "妈妈的待办" });
    ok(add);
    const id = (add.data as { id: string }).id;
    const env = completeTodo(f.db, f.callers.baba, TZ, id);
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assert.match(env.message, /仅归属人本人可见/);
  });

  it("X16:代记者不能替归属人完成 → DENIED(not_writable);归属人自己可以", () => {
    f = newFixture();
    const add = addTodo(f.db, f.callers.baba, TZ, { owner: "妈妈", title: "爸爸代记" });
    ok(add);
    const id = (add.data as { id: string }).id;
    const byBaba = completeTodo(f.db, f.callers.baba, TZ, id);
    fail(byBaba);
    assert.equal(byBaba.code, "DENIED");
    assert.equal(byBaba.reason, "not_writable");
    assert.match(byBaba.message, /只能由 妈妈 本人完成/);
    const byMama = completeTodo(f.db, f.callers.mama, TZ, id);
    ok(byMama);
  });

  it("软删后的待办按已删除处理(NOT_FOUND)", () => {
    f = newFixture();
    const add = addTodo(f.db, f.callers.mama, TZ, { title: "x" });
    ok(add);
    const id = (add.data as { id: string }).id;
    f.db.prepare("UPDATE todo SET deleted_at = ? WHERE id = ?").run("2026-10-04T00:00:00Z", id);
    const env = completeTodo(f.db, f.callers.mama, TZ, id);
    fail(env);
    assert.equal(env.code, "NOT_FOUND");
  });
});
