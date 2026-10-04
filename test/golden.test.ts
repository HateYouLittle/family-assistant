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

  it("S4 范围:恰好 20 个工具(19 个原有 + 通用域 get_today),无任何身份参数形态", () => {
    assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name), [
      "list_members",
      // get_today 紧跟 list_members:两者都是**通用域**(无参数 / 与域无关的读),
      // 设计 §5 的工具清单也是这么排的(通用(2)排在最前)。
      "get_today",
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
      "add_category",
      "list_categories",
      "add_entry",
      "list_entries",
      "summarize_entries",
      "update_entry",
      "delete_entry",
      // restore_deleted 排在最后:它是三域共用的软删逆操作,跟着它服务的域走不如独立收尾
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
    // 按名字取(不再按下标):S4 在通用域插入了 get_today,下标已经整体后移,
    // 按下标断言会让"改一个工具的位置"静默地换掉被断言的工具。
    const byName = (name: string): string => {
      const t = TOOL_DEFINITIONS.find((x) => x.name === name);
      assert.ok(t, `缺少 ${name}`);
      return t!.description;
    };
    assert.match(byName("add_todo"), /MISSING_PARAMS/);
    assert.match(byName("add_todo"), /AMBIGUOUS/);
    assert.match(byName("list_todos"), /INVALID_PARAMS/);
    assert.match(byName("list_todos"), /互相不可见/);
    assert.match(byName("update_todo"), /DENIED/);
  });

  it("S4:get_today 的 description 把「无参数」与两个用途写出来(P8 ②③)", () => {
    const t = TOOL_DEFINITIONS.find((x) => x.name === "get_today");
    assert.ok(t, "缺少 get_today");
    // ① 无参数 + 说话人来自连接(P7/X15):传任何东西都 INVALID_PARAMS。
    assert.match(t!.description, /无参数/);
    assert.match(t!.description, /说话人由连接确定/);
    assert.match(t!.description, /INVALID_PARAMS/);
    // ② 三块分列 + 归属列标注。
    assert.match(t!.description, /分列/);
    assert.match(t!.description, /全家日程/);
    assert.match(t!.description, /我的个人日程/);
    // ③ 两个用途:开场拉取 + 定时任务个人摘要(设计 §5 / §3.3)。
    assert.match(t!.description, /开场/);
    assert.match(t!.description, /每日摘要/);
    // ④ 时区口径写在契约里(模型读不到设计文档)。
    assert.match(t!.description, /时区/);
    // ⑤ 示例。
    assert.match(t!.description, /示例:get_today\(\)。/);
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
    // S3:update_entry 是第三条 update_*,同样必须含 V7 的固定话术(P8 ④)
    const updateEntry = TOOL_DEFINITIONS.find((t) => t.name === "update_entry");
    assert.ok(updateEntry, "缺少 update_entry");
    assert.match(updateEntry!.description, /归属\/账本不可修改,如需变更请删除后重建/);
    assert.match(updateEntry!.description, /immutable/);
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

  it("S2b:重复日程的契约写在 add_event / update_event 的 description 与 schema 里", () => {
    const addEvent = TOOL_DEFINITIONS.find((t) => t.name === "add_event")!;
    const updateEvent = TOOL_DEFINITIONS.find((t) => t.name === "update_event")!;
    for (const t of [addEvent, updateEvent]) {
      // ① 写时物化 92 天 + 读时惰性续期
      assert.match(t.description, /未来 92 天/, `${t.name} 未写明物化 92 天`);
      assert.match(t.description, /自动续期/, `${t.name} 未写明惰性续期`);
      // ② N4:改删只作用整系列
      assert.match(t.description, /整个系列/, `${t.name} 未写明整系列语义`);
      // ③ repeat_until 的语义(含当天为止)
      assert.match(t.description, /repeat_until/, `${t.name} 未提 repeat_until`);
      assert.match(t.description, /含当天为止/, `${t.name} 未写明 repeat_until 含当天为止`);
      // ④ 非重复日程传 repeat_* 会被拒
      assert.match(t.description, /非重复日程不接受/, `${t.name} 未写明非重复日程拒绝 repeat_*`);
      // ⑤ 三个参数都进了 schema(strictObject 之下)
      const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
      for (const field of ["repeat", "repeat_interval", "repeat_until"]) {
        assert.ok(field in props, `${t.name} 的 schema 少了 ${field}`);
        assert.ok(!(t.inputSchema.required as string[] | undefined)?.includes(field), `${t.name} 的 ${field} 不该是必填`);
      }
    }
    // list_events 的 description 不该被这一阶段改动(golden diff 只允许 add_event / update_event 变)
    const listEvents = TOOL_DEFINITIONS.find((t) => t.name === "list_events")!;
    assert.doesNotMatch(listEvents.description, /repeat/, "本阶段不动 list_events 的契约");
  });

  it("S3:记账域 7 个工具把拒绝条件与 V7 固定话术写进 description(P8 ②④)", () => {
    const ledgerTools = [
      "add_category",
      "list_categories",
      "add_entry",
      "list_entries",
      "summarize_entries",
      "update_entry",
      "delete_entry",
    ];
    for (const name of ledgerTools) {
      const t = TOOL_DEFINITIONS.find((x) => x.name === name);
      assert.ok(t, `缺少 ${name}`);
      assert.match(t!.description, /示例:/, `${name} 的 description 缺少示例(P8 ③)`);
      assert.match(t!.description, /说话人由连接确定/, `${name} 未声明说话人不是参数(P7)`);
      assert.match(t!.description, /[一-龥]/, `${name} 的 description 必须是中文(P8 ①)`);
    }

    // V4 的记账特例:个人账本只能本人写 —— 模型读不到设计文档,只能读 description(P8 ②)
    const addEntry = TOOL_DEFINITIONS.find((t) => t.name === "add_entry")!;
    assert.match(addEntry.description, /个人账本只能本人写/);
    assert.match(addEntry.description, /DENIED/);
    // X2 的落点:显式要他人私账是 DENIED,不是空表
    const listEntries = TOOL_DEFINITIONS.find((t) => t.name === "list_entries")!;
    assert.match(listEntries.description, /DENIED/);
    assert.match(listEntries.description, /不是空表/);
    // group_by=member 必须显式 ledger(设计 §5 的歧义消除)
    const summarize = TOOL_DEFINITIONS.find((t) => t.name === "summarize_entries")!;
    assert.match(summarize.description, /group_by="member" 时 ledger 必填/);
    assert.match(summarize.description, /MISSING_PARAMS/);
    // 写工具的拒绝条件
    for (const name of ["update_entry", "delete_entry"]) {
      const t = TOOL_DEFINITIONS.find((x) => x.name === name)!;
      assert.match(t.description, /DENIED/, `${name} 的 description 未写明拒绝条件`);
    }
    // restore_deleted 在 S3 扩展到 kind="entry"
    assert.match(TOOL_DEFINITIONS.find((t) => t.name === "restore_deleted")!.description, /"entry"/);

    // 记账域的 schema 一律 strict,且没有身份参数形态(X15)
    for (const name of ledgerTools) {
      const t = TOOL_DEFINITIONS.find((x) => x.name === name)!;
      assert.equal(t.inputSchema.additionalProperties, false, `${name} 的 schema 不是 strict`);
      const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
      for (const banned of ["as_member", "asMember", "bind_key", "bindKey", "speaker", "caller", "as", "whoami"]) {
        assert.equal(banned in props, false, `${name} 出现了身份参数 ${banned}`);
      }
    }
  });
});
