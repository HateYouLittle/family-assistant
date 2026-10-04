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

  it("Spike 01 范围:恰好 4 个工具,无任何身份参数形态", () => {
    assert.deepEqual(
      TOOL_DEFINITIONS.map((t) => t.name),
      ["list_members", "add_todo", "list_todos", "complete_todo"],
    );
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

  it("所有 schema 均 additionalProperties:false(strict)", () => {
    for (const t of TOOL_DEFINITIONS) {
      assert.equal(t.inputSchema.additionalProperties, false, `${t.name} 的 schema 不是 strict`);
    }
  });
});
