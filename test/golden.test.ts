import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { TOOL_DEFINITIONS } from "../src/mcp/tools.js";

/**
 * P8 契约冻结:description 与 inputSchema 变更必须显式更新 golden
 * (scripts/dump-golden.ts),并按 diff 审查——description 就是模型读到的行为契约。
 */

interface GoldenTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

describe("工具面 golden(P8)", () => {
  it("名称、description、inputSchema 与 golden 完全一致", () => {
    const golden = JSON.parse(readFileSync(new URL("./golden/tools.json", import.meta.url), "utf8")) as GoldenTool[];
    assert.equal(TOOL_DEFINITIONS.length, golden.length, "工具数量与 golden 不一致");
    for (let i = 0; i < TOOL_DEFINITIONS.length; i++) {
      const t = TOOL_DEFINITIONS[i]!;
      const g = golden[i]!;
      assert.deepEqual(
        { name: t.name, description: t.description, inputSchema: t.inputSchema },
        { name: g.name, description: g.description, inputSchema: g.inputSchema },
        `工具 ${t.name} 与 golden 不一致:如属有意变更,请运行 scripts/dump-golden.ts 并审查 diff`,
      );
    }
  });

  it("S2 范围:恰好 12 个工具(8 个原有 + 日程域 4 个),无任何身份参数形态", () => {
    assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name), [
      "list_members",
      "add_todo",
      "list_todos",
      "update_todo",
      "complete_todo",
      "reopen_todo",
      "delete_todo",
      "add_event",
      "list_events",
      "update_event",
      "delete_event",
      "restore_deleted",
    ]);
    for (const t of TOOL_DEFINITIONS) {
      const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
      for (const banned of ["as_member", "asMember", "bind_key", "bindKey", "speaker", "caller"]) {
        assert.equal(banned in props, false, `${t.name} 出现了身份参数 ${banned}`);
      }
    }
  });

  it("P8:description 为中文、含拒绝条件、含示例、声明说话人不是参数", () => {
    for (const t of TOOL_DEFINITIONS) {
      assert.match(t.description, /示例:/, `${t.name} 缺少示例`);
      assert.match(t.description, /说话人由连接确定/, `${t.name} 未声明说话人不是参数`);
    }
    assert.match(TOOL_DEFINITIONS[1]!.description, /MISSING_PARAMS/);
    assert.match(TOOL_DEFINITIONS[1]!.description, /AMBIGUOUS/);
    assert.match(TOOL_DEFINITIONS[2]!.description, /INVALID_PARAMS/);
    assert.match(TOOL_DEFINITIONS[2]!.description, /互相不可见/);
    assert.match(TOOL_DEFINITIONS[3]!.description, /DENIED/);
  });

  it("P8 ④:不可变字段的拒绝条件写进 description(V7 固定话术)", () => {
    const update = TOOL_DEFINITIONS.find((t) => t.name === "update_todo");
    assert.ok(update, "缺少 update_todo");
    assert.match(update!.description, /归属\/账本不可修改,如需变更请删除后重建/);
    assert.match(update!.description, /immutable/);
    // S2:update_event 必须同样写明 V7 的固定话术(设计 §5 P8 ④:三条 update_* 都要写)
    const updateEvent = TOOL_DEFINITIONS.find((t) => t.name === "update_event");
    assert.ok(updateEvent, "缺少 update_event");
    assert.match(updateEvent!.description, /归属\/账本不可修改,如需变更请删除后重建/);
    assert.match(updateEvent!.description, /immutable/);
    // S1 的三个新写工具也必须把拒绝条件写出来(P8 ②)
    for (const name of ["reopen_todo", "delete_todo", "restore_deleted"]) {
      const t = TOOL_DEFINITIONS.find((x) => x.name === name);
      assert.ok(t, `缺少 ${name}`);
      assert.match(t!.description, /DENIED/, `${name} 的 description 未写明拒绝条件`);
    }
  });

  it("P8 ②:日程域 4 个工具都写出拒绝条件(V1/V3/V8/X3)", () => {
    const listEvents = TOOL_DEFINITIONS.find((t) => t.name === "list_events");
    assert.ok(listEvents, "缺少 list_events");
    // X3 的落点必须写在契约里:没有"看他人个人日程"的参数形态
    assert.match(listEvents!.description, /没有查询他人个人日程的参数形态/);
    assert.match(listEvents!.description, /INVALID_PARAMS/);
    assert.match(listEvents!.description, /X3/);

    // add_event 没有任何 DENIED 路径(谁都能给谁记),它的拒绝条件是这三种码
    const addEvent = TOOL_DEFINITIONS.find((t) => t.name === "add_event");
    assert.ok(addEvent, "缺少 add_event");
    for (const code of ["MISSING_PARAMS", "AMBIGUOUS", "INVALID_PARAMS"]) {
      assert.match(addEvent!.description, new RegExp(code), `add_event 的 description 未写明 ${code}`);
    }

    for (const name of ["update_event", "delete_event"]) {
      const t = TOOL_DEFINITIONS.find((x) => x.name === name);
      assert.ok(t, `缺少 ${name}`);
      assert.match(t!.description, /DENIED/, `${name} 的 description 未写明拒绝条件`);
      assert.match(t!.description, /示例:/, `${name} 的 description 缺少示例`);
      assert.match(t!.description, /说话人由连接确定/, `${name} 未声明说话人不是参数`);
    }
    // V8 与 V3 互信:两条都要写出来,模型才知道什么时候能改
    assert.match(TOOL_DEFINITIONS.find((t) => t.name === "update_event")!.description, /not_writable/);
    assert.match(TOOL_DEFINITIONS.find((t) => t.name === "delete_event")!.description, /已撤回你代记的日程/);
    assert.match(TOOL_DEFINITIONS.find((t) => t.name === "restore_deleted")!.description, /"event"/);
  });

  it("所有 schema 均 additionalProperties:false(strict)", () => {
    for (const t of TOOL_DEFINITIONS) {
      assert.equal(t.inputSchema.additionalProperties, false, `${t.name} 的 schema 不是 strict`);
    }
  });
});
