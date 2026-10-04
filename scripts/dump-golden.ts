// 生成工具契约的 golden 基线:test/golden/tools.json
// 用法:npx tsx scripts/dump-golden.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { TOOL_DEFINITIONS } from "../src/mcp/tools.js";

const dump = TOOL_DEFINITIONS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}));
mkdirSync("test/golden", { recursive: true });
writeFileSync("test/golden/tools.json", JSON.stringify(dump, null, 2) + "\n", "utf8");
console.log("golden written:", dump.map((d) => d.name).join(", "));
