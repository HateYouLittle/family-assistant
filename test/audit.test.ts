import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AUDIT_ARGS_MAX, AUDIT_OK_CODE, listAudit, recordAudit, type AuditRow } from "../src/audit/audit.js";
import { TOOL_DEFINITIONS } from "../src/mcp/tools.js";
import { newFixture, TZ, type Fixture, type FixtureKey } from "./helpers.js";

/**
 * 审计日志(设计方案 §6 / S0)。
 * 纪律:append-only、只记写操作、只记关键字段元数据、member_id 必须是连接身份。
 */

let f: Fixture;
afterEach(() => f?.db.close());

function callTool(key: FixtureKey, name: string, args: unknown) {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
  assert.ok(tool, `未知工具 ${name}`);
  const parsed = tool!.parse(args);
  assert.ok(parsed.ok, `参数校验失败:${JSON.stringify(parsed)}`);
  if (!parsed.ok) throw new Error("unreachable");
  return tool!.run(f.db, f.callers[key], TZ, parsed.args);
}

function auditRows(): AuditRow[] {
  return listAudit(f.db);
}

describe("审计:写操作留痕", () => {
  it("add_todo 留一条记录,字段正确(member 是连接身份)", () => {
    f = newFixture();
    const env = callTool("baba", "add_todo", { owner: "妈妈", title: "交物业费", due_date: "2026-10-05" });
    assert.ok(env.ok);

    const rows = auditRows();
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(r.tool, "add_todo");
    // 说话人 = 连接身份(token → 爸爸),不是参数里的 owner=妈妈
    assert.equal(r.member_id, f.members.baba.id);
    assert.equal(r.member_name, "爸爸");
    assert.equal(r.result_code, AUDIT_OK_CODE);
    assert.equal(r.ok, true);
    assert.match(r.args_summary, /owner=妈妈/);
    assert.match(r.args_summary, /title=交物业费/);
    assert.match(r.args_summary, /due_date=2026-10-05/);
    assert.match(r.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(r.id > 0, "audit_log.id 应为自增整数");
  });

  it("complete_todo 留痕,摘要只含 id", () => {
    f = newFixture();
    const add = callTool("mama", "add_todo", { title: "交电费" });
    assert.ok(add.ok);
    const id = (add.data as { id: string }).id;
    const done = callTool("mama", "complete_todo", { id });
    assert.ok(done.ok);

    const rows = auditRows();
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.tool, "complete_todo");
    assert.equal(rows[0]!.args_summary, `id=${id}`);
    assert.equal(rows[0]!.member_id, f.members.mama.id);
  });

  it("写失败的调用也留痕(result_code = 信封码,ok = 0)——配错正是最该被追溯的", () => {
    f = newFixture();
    const env = callTool("baba", "add_todo", { owner: "查无此人", title: "x" });
    assert.ok(!env.ok && env.code === "MISSING_PARAMS");

    const rows = auditRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.ok, false);
    assert.equal(rows[0]!.result_code, "MISSING_PARAMS");
    assert.equal(rows[0]!.member_id, f.members.baba.id);
  });

  it("读操作不留痕", () => {
    f = newFixture();
    callTool("mama", "add_todo", { title: "交电费" });
    assert.equal(auditRows().length, 1);

    callTool("mama", "list_todos", {});
    callTool("mama", "list_members", {});
    callTool("kid", "list_todos", { q: "电费" });
    assert.equal(auditRows().length, 1, "只有 add_todo 那一条");
    // 且被拒的读(X4 形态)同样不记:读不是写
    callTool("baba", "list_todos", { done: false });
    assert.equal(auditRows().length, 1);
  });

  it("参数校验失败(未进入 run)不留痕", () => {
    f = newFixture();
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "add_todo")!;
    const parsed = tool.parse({});
    assert.ok(!parsed.ok);
    assert.equal(auditRows().length, 0);
  });
});

describe("审计:摘要只留元数据,不记自由文本全文(§6)", () => {
  it("notes 等自由文本不进摘要", () => {
    f = newFixture();
    const secret = "药买了记得刷医保卡,卡号尾号 4321";
    callTool("mama", "add_todo", { title: "买药", notes: secret });
    const r = auditRows()[0]!;
    assert.match(r.args_summary, /title=买药/);
    assert.doesNotMatch(r.args_summary, /notes/);
    assert.doesNotMatch(r.args_summary, /4321/);
  });

  it("单个字段超长 → 截断并加省略号(不把整段长文本塞进审计)", () => {
    f = newFixture();
    const title = "长".repeat(200); // schema 上限,刚好满额
    callTool("mama", "add_todo", { title, owner: "妈妈" });
    const r = auditRows()[0]!;
    assert.match(r.args_summary, /^owner=妈妈 title=长+…$/);
    assert.ok(r.args_summary.length < 100);
  });

  it("recordAudit 也自己截断到 200(纵深防御:调用方忘了截也不会写爆)", () => {
    f = newFixture();
    recordAudit(f.db, f.callers.mama, "unit_test", "x".repeat(500), { ok: true, data: null, message: "" });
    const r = auditRows()[0]!;
    assert.equal(r.args_summary.length, AUDIT_ARGS_MAX);
    assert.equal(r.tool, "unit_test");
    assert.equal(r.ok, true);
  });
});

describe("审计:append-only", () => {
  it("仓库不提供任何 audit_log 的 UPDATE / DELETE 入口", async () => {
    const files = [
      "src/audit/audit.ts",
      "src/mcp/tools.ts",
      "src/domain/todos.ts",
      "src/domain/members.ts",
      "src/domain/auth.ts",
    ];
    const { readFileSync } = await import("node:fs");
    for (const rel of files) {
      const text = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
      assert.doesNotMatch(text, /UPDATE\s+audit_log/i, `${rel} 出现了 audit_log 的 UPDATE`);
      assert.doesNotMatch(text, /DELETE\s+FROM\s+audit_log/i, `${rel} 出现了 audit_log 的 DELETE`);
    }
    // audit.ts 里唯一的写语句是 recordAudit 的 INSERT
    const auditSrc = readFileSync(new URL("../src/audit/audit.ts", import.meta.url), "utf8");
    assert.doesNotMatch(auditSrc, /DELETE\s+FROM/i);
    assert.doesNotMatch(auditSrc, /UPDATE\s+\w/i);
    assert.match(auditSrc, /INSERT INTO audit_log/);
  });

  it("多条写操作按 id 递增,listAudit 按时间倒序", () => {
    f = newFixture();
    for (const t of ["一", "二", "三"]) callTool("mama", "add_todo", { title: t });
    const rows = auditRows();
    assert.deepEqual(rows.map((r) => r.args_summary), ["title=三", "title=二", "title=一"]);
    assert.ok(rows[0]!.id > rows[2]!.id);
  });
});