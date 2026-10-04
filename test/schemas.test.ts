import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FailEnvelope } from "../src/domain/envelope.js";
import { parseToolArgs } from "../src/mcp/schemas.js";
import {
  addTodoSchema,
  completeTodoSchema,
  listMembersSchema,
  listTodosSchema,
} from "../src/mcp/schemas.js";

type Schema = Parameters<typeof parseToolArgs>[0];

function parse(schema: Schema, raw: unknown) {
  return parseToolArgs(schema, "test", raw);
}

function parseFail(schema: Schema, raw: unknown): FailEnvelope {
  const r = parse(schema, raw);
  if (r.ok) assert.fail(`期望失败信封,实际成功:${JSON.stringify(r.args)}`);
  return r.envelope as FailEnvelope;
}

describe("参数 schema:X1 / X15(说话人不是参数)", () => {
  it("X1:list_todos 传 owner → INVALID_PARAMS(未知字段)", () => {
    const env = parseFail(listTodosSchema, { owner: "妈妈" });
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "owner");
    assert.match(env.message, /不接受未知参数:owner/);
  });

  it("X15:list_todos 传 as_member → INVALID_PARAMS,并点破身份参数不存在", () => {
    const env = parseFail(listTodosSchema, { as_member: "爸爸" });
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "as_member");
    assert.match(env.message, /不接受未知参数:as_member/);
    assert.match(env.message, /说话人由连接确定/);
  });

  it("bind_key 之类的身份参数同样被拒", () => {
    const env = parseFail(addTodoSchema, { title: "x", bind_key: "k" });
    assert.equal(env.code, "INVALID_PARAMS");
  });

  it("list_members 不接受任何参数", () => {
    const env = parseFail(listMembersSchema, { q: "x" });
    assert.equal(env.code, "INVALID_PARAMS");
    const okCase = parse(listMembersSchema, {});
    assert.ok(okCase.ok);
  });
});

describe("参数 schema:必填与类型(MISSING_PARAMS / INVALID_PARAMS)", () => {
  it("缺 title → MISSING_PARAMS,missing 指明字段", () => {
    const env = parseFail(addTodoSchema, {});
    assert.equal(env.code, "MISSING_PARAMS");
    assert.deepEqual(env.missing, ["title"]);
  });

  it("title 类型错误 → INVALID_PARAMS", () => {
    const env = parseFail(addTodoSchema, { title: 123 });
    assert.equal(env.code, "INVALID_PARAMS");
  });

  it("空 title / 空 owner → INVALID_PARAMS", () => {
    assert.equal(parseFail(addTodoSchema, { title: "  " }).code, "INVALID_PARAMS");
    assert.equal(parseFail(addTodoSchema, { title: "x", owner: "" }).code, "INVALID_PARAMS");
  });

  it("complete_todo 缺 id → MISSING_PARAMS", () => {
    const env = parseFail(completeTodoSchema, {});
    assert.equal(env.code, "MISSING_PARAMS");
    assert.deepEqual(env.missing, ["id"]);
  });

  it("raw 为 undefined(客户端未传 arguments)按空对象处理", () => {
    const okCase = parse(listTodosSchema, undefined);
    assert.ok(okCase.ok);
    const missing = parseFail(completeTodoSchema, undefined);
    assert.equal(missing.code, "MISSING_PARAMS");
  });
});

describe("参数 schema:日期校验(格式 + 真实日历日)", () => {
  it("格式错误 → INVALID_PARAMS", () => {
    for (const bad of ["明天", "2026/10/05", "2026-2-5", "20261005"]) {
      const env = parseFail(addTodoSchema, { title: "x", due_date: bad });
      assert.equal(env.code, "INVALID_PARAMS", `应拒绝:${bad}`);
      assert.match(env.message, /YYYY-MM-DD/);
    }
  });

  it("不存在的日历日(2 月 30 日)→ INVALID_PARAMS", () => {
    const env = parseFail(addTodoSchema, { title: "x", due_date: "2026-02-30" });
    assert.equal(env.code, "INVALID_PARAMS");
    assert.match(env.message, /不是真实存在的日历日期/);
  });

  it("合法日期放行", () => {
    const r = parse(addTodoSchema, { title: "x", due_date: "2028-02-29" });
    assert.ok(r.ok);
  });
});
