import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { listAudit, type AuditRow } from "../src/audit/audit.js";
import type { Envelope, OkEnvelope } from "../src/domain/envelope.js";
import { IMMUTABLE_NOTE } from "../src/mcp/schemas.js";
import { TOOL_DEFINITIONS, type ToolDefinition } from "../src/mcp/tools.js";
import { newFixture, TZ, type Fixture, type FixtureKey } from "./helpers.js";

/**
 * S5 契约审计(设计方案 §5 P8「描述即契约」+ §6 审计纪律)。
 *
 * 三块内容:
 * 1. **P8 描述审计**:对 `TOOL_DEFINITIONS` 里**全部 20 个工具**逐个断言
 *    ① 中文且长度合理 / ② 显式写出拒绝条件 / ③ 含一个正确示例 /
 *    ④ 声明"说话人不是参数" / ⑤ schema strict 且无身份参数 /
 *    ⑥ 三条 `update_*` 含 V7 固定话术。每条断言的失败信息都点名是哪个工具、缺了什么。
 * 2. **工具面完整性**:写工具 13 + 读工具 7 恰好覆盖 20 个,不多不少。
 * 3. **审计面 sweep**:所有写工具各跑一次 → 审计行数 ≥ 工具数且身份都是连接身份;
 *    所有读工具跑完 → 审计行数不变;审计摘要里不出现 `notes` / `note` 的自由文本。
 *
 * 纪律:description 就是模型读到的行为契约,模型的权重远高于设计文档 ——
 * 所以这里断言的是**模型能否只靠 description 就知道什么时候会被拒、拒了该怎么办**,
 * 而不是复述 design 文档。变更 description 必须同时更新 golden(test/golden/tools.json)。
 */

/** P8 ②:允许出现在 description 里的"具体拒绝条件"码。 */
const REJECTION_CODES = ["MISSING_PARAMS", "INVALID_PARAMS", "AMBIGUOUS", "DENIED", "NOT_FOUND"] as const;

/** P8 ④:等价声明"说话人不是参数"的几种说法(逐个工具都命中其中之一)。 */
const SPEAKER_DECLARATIONS = [/说话人由连接确定/, /说话人不是参数/, /不接受任何身份参数/, /没有、也不接受任何身份参数/];

/** 工具面**不得**出现的身份参数(P7/D13):说话人来自连接,模型没有可填的位置。 */
const BANNED_IDENTITY_PARAMS = [
  "as_member", "asMember", "as", "bind_key", "bindKey", "speaker", "caller", "whoami", "member", "user", "profile",
];

const MIN_DESC_LENGTH = 60;
const MAX_DESC_LENGTH = 3000;
const MIN_CJK_CHARS = 20;

/** 写工具:有 audit 摘要器 = 写(tools.ts 的纪律:「有 audit 字段即视为写操作」)。 */
const WRITE_TOOLS = [
  "add_todo",
  "update_todo",
  "complete_todo",
  "reopen_todo",
  "delete_todo",
  "add_event",
  "update_event",
  "delete_event",
  "add_entry",
  "update_entry",
  "delete_entry",
  "add_category",
  "restore_deleted",
] as const;

/** 读工具:不记审计(§6「只记写操作」)。 */
const READ_TOOLS = [
  "list_members",
  "list_todos",
  "list_events",
  "list_entries",
  "summarize_entries",
  "list_categories",
  "get_today",
] as const;

let f: Fixture;
afterEach(() => f?.db.close());

function tool(name: string): ToolDefinition {
  const t = TOOL_DEFINITIONS.find((x) => x.name === name);
  assert.ok(t, `TOOL_DEFINITIONS 里没有工具 ${name}(工具面与本文件的清单不一致)`);
  return t!;
}

/** 走工具层(参数校验 + 审计留痕);参数不合规时返回 parse 的失败信封。 */
function callTool(key: FixtureKey, name: string, args: unknown): Envelope {
  const t = tool(name);
  const parsed = t.parse(args);
  return parsed.ok ? t.run(f.db, f.callers[key], TZ, parsed.args) : parsed.envelope;
}

function ok(env: Envelope, why: string): asserts env is OkEnvelope {
  assert.equal(env.ok, true, `${why}:期望成功信封,实际:${JSON.stringify(env)}`);
}

/** 把一段 description 的 P8 契约逐条审一遍;任何一条不过,失败信息点名工具与缺项。 */
function expectP8(t: ToolDefinition): void {
  const { name, description } = t;

  // ① 中文(P8 ①):长度合理 + 中日韩字符够多(防止"只塞一个中文字符骗过断言")
  assert.ok(
    description.length >= MIN_DESC_LENGTH,
    `${name}:description 太短(${description.length} 字 < ${MIN_DESC_LENGTH}),撑不起一份行为契约`,
  );
  assert.ok(
    description.length <= MAX_DESC_LENGTH,
    `${name}:description 过长(${description.length} 字 > ${MAX_DESC_LENGTH}),模型读它也是噪声`,
  );
  const cjk = description.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu) ?? [];
  assert.ok(
    cjk.length >= MIN_CJK_CHARS,
    `${name}:description 必须用中文写(P8 ①),中日韩字符只有 ${cjk.length} 个(下限 ${MIN_CJK_CHARS})`,
  );

  // ② 显式写出拒绝条件(P8 ②):至少一个**具体**的码,不是"可能被拒"这种模糊话
  const codes = REJECTION_CODES.filter((c) => description.includes(c));
  assert.ok(
    codes.length > 0,
    `${name}:description 没有写出任何拒绝条件(P8 ②):` +
      `至少要写出 ${REJECTION_CODES.join(" / ")} 之一,并说清什么情况下会返回它`,
  );
  // ③ 一个正确调用示例(P8 ③)
  assert.ok(
    /示例[:：]/.test(description) || description.includes(`${name}(`),
    `${name}:description 缺少正确调用示例(P8 ③):要有「示例:」或至少一个 ${name}(...) 的调用形状`,
  );
  // ④ 声明"说话人不是参数"(P7/D13/X15):工具面没有身份参数
  assert.ok(
    SPEAKER_DECLARATIONS.some((re) => re.test(description)),
    `${name}:description 未声明「说话人由连接确定」或等价说法(P7):` +
      "模型读不到设计文档,必须靠 description 知道没有身份参数可传",
  );
  // ⑤ schema strict + 无身份参数
  assert.equal(
    t.inputSchema.additionalProperties,
    false,
    `${name}:inputSchema.additionalProperties 必须为 false(strictObject):未知字段要落 INVALID_PARAMS`,
  );
  assert.equal(t.inputSchema.type, "object", `${name}:inputSchema.type 必须是 object`);
  const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
  for (const banned of BANNED_IDENTITY_PARAMS) {
    assert.equal(banned in props, false, `${name}:inputSchema.properties 里出现了身份参数 ${banned}(P7/X15)`);
  }
  // ⑥ 三条 update_* 必须含 V7 固定话术(P8 ④)
  if (name.startsWith("update_")) {
    assert.ok(
      description.includes(IMMUTABLE_NOTE),
      `${name}:description 缺少 V7 固定话术「${IMMUTABLE_NOTE}」(P8 ④):` +
        "模型把「读-改-写」原样回传 owner/ledger 时,必须一次就知道这条路不通",
    );
    assert.ok(
      description.includes("immutable"),
      `${name}:description 必须写出 DENIED 的 reason=immutable,模型才能分辨「换个参数重试」与「这条路不通」`,
    );
  }
}

describe("P8 描述即契约:20 个工具逐个审计", () => {
  for (const t of TOOL_DEFINITIONS) {
    it(`P8: ${t.name} 的 description 满足 ①中文 ②拒绝条件 ③示例 ④说话人非参数 ⑤strict schema`, () => {
      expectP8(t);
    });
  }

  it("工具面恰好 20 个,写工具 13 + 读工具 7 恰好覆盖(分类不得有遗漏或重复)", () => {
    assert.equal(TOOL_DEFINITIONS.length, 20, "工具面数量变了:设计 §5 的清单是 20 个");
    const classified = [...WRITE_TOOLS, ...READ_TOOLS].sort();
    assert.equal(new Set(classified).size, classified.length, "同一个工具不得同时被列为读与写");
    assert.deepEqual(
      classified,
      TOOL_DEFINITIONS.map((t) => t.name).sort(),
      "写/读工具清单必须恰好覆盖工具面:新加工具时这里会红,逼着人补分类",
    );
  });

  it("P8 ④:三条 update_* 都含 V7 固定话术,且 reason=immutable 三者齐备", () => {
    for (const name of ["update_todo", "update_event", "update_entry"]) {
      const d = tool(name).description;
      assert.ok(d.includes(IMMUTABLE_NOTE), `${name}:缺少「${IMMUTABLE_NOTE}」`);
      assert.ok(d.includes("immutable"), `${name}:缺少 reason=immutable`);
    }
  });

  it("P8 ②:三个域的拒绝条件都写在 description 里(缺一条就让模型瞎试)", () => {
    // 待办域:成员解析两种失败 + 未知 owner 参数
    const todos = tool("add_todo").description;
    for (const code of ["MISSING_PARAMS", "AMBIGUOUS"]) {
      assert.ok(todos.includes(code), `add_todo 的 description 缺 ${code}(X10 的归属解析)`);
    }
    // 日程域:结构问题 INVALID_PARAMS + 语义问题 DENIED 两类都要写
    const events = tool("update_event").description;
    for (const code of ["INVALID_PARAMS", "DENIED", "not_writable", "not_visible"]) {
      assert.ok(events.includes(code), `update_event 的 description 缺 ${code}(V1/V3/V8)`);
    }
    // 记账域:五个码全在(它是唯一一个五码齐用的域)
    const addEntry = tool("add_entry").description;
    for (const code of REJECTION_CODES) {
      assert.ok(addEntry.includes(code), `add_entry 的 description 缺 ${code}`);
    }
    const summarize = tool("summarize_entries").description;
    for (const code of ["MISSING_PARAMS", "INVALID_PARAMS", "DENIED"]) {
      assert.ok(summarize.includes(code), `summarize_entries 的 description 缺 ${code}`);
    }
  });

  it("P8:拒绝条件写的是具体形态 —— 点了参数名(无参数工具声明「无参数」),不是「可能被拒」这类模糊话", () => {
    // 模糊话检测:出现这些说法就说明没写清"什么情况、返回什么码"
    const vague = [/可能会?被拒/, /视情况/, /也许会/, /可能会失败/, /大概会/];
    for (const t of TOOL_DEFINITIONS) {
      for (const re of vague) {
        assert.doesNotMatch(
          t.description,
          re,
          `${t.name}:description 出现模糊说法「${re.source}」:必须写成"传什么 → 返回什么码"的具体形态`,
        );
      }
    }
    // 具体形态 = 点名自己 schema 里的旋钮:有参数的工具至少写出一个真实参数名
    // (否则模型不知道是哪个参数会被拒);无参数工具必须声明「无参数」并说明传什么都会被拒。
    for (const t of TOOL_DEFINITIONS) {
      const props = Object.keys((t.inputSchema.properties ?? {}) as Record<string, unknown>);
      if (props.length === 0) {
        assert.match(
          t.description,
          /无参数|不接收任何参数/,
          `${t.name}:这是个无参数工具,description 必须声明「无参数」并说清传任何东西会被拒`,
        );
        assert.ok(
          t.description.includes("INVALID_PARAMS"),
          `${t.name}:无参数工具必须写出"传任何字段 → INVALID_PARAMS"(模型最容易在这里多传一个身份参数)`,
        );
        continue;
      }
      const named = props.filter((p) => t.description.includes(p));
      assert.ok(
        named.length > 0,
        `${t.name}:description 一个参数名都没提到(可用参数:${props.join("、")}):` +
          "模型读不到 schema 的报错,必须靠 description 知道是哪个参数会被拒",
      );
    }
  });
});

// ─────────────────────────── 审计面 sweep ───────────────────────────

/** 自由文本秘密:任何一条都不许进审计摘要(§6「不把私账内容再复制一份」)。 */
const SECRET_NOTE_TODO = "药买了记得刷医保卡,卡号尾号 4321";
const SECRET_NOTE_EVENT = "外婆的生日宴在东门,别忘了带礼物";
const SECRET_PLACE_EVENT = "仅妈妈知道的地点:密码 8899";
const SECRET_NOTE_ENTRY = "私下还了小王 500 元,别声张";

interface SweepWorld {
  todoId: string;
  eventInstanceId: string;
  eventSeriesId: string;
  entryId: string;
}

/**
 * 按固定顺序把 13 个写工具**各跑一次**(全部作为**爸爸**,连接身份 = 爸爸)。
 * add_todo 排在最前:后面 12 个写工具都需要它造出来的 id 当句柄。
 * 它记在**爸爸自己**名下(owner 缺省):代记者改不了自己代记的条目(V8),
 * 所以 sweep 的写路径必须用一条归属人本人的条目,否则后半程全被 not_writable 挡住。
 */
function runAllWriteTools(w: SweepWorld): void {
  const added = callTool("baba", "add_todo", {
    title: "买酱油",
    due_date: "2031-06-10",
    notes: SECRET_NOTE_TODO,
  });
  ok(added, "sweep add_todo");
  w.todoId = (added.data as { id: string }).id;

  ok(callTool("baba", "update_todo", { id: w.todoId, title: "买酱油(打折时买)", notes: SECRET_NOTE_TODO }), "sweep update_todo");
  ok(callTool("baba", "complete_todo", { id: w.todoId }), "sweep complete_todo");
  ok(callTool("baba", "reopen_todo", { id: w.todoId }), "sweep reopen_todo");

  const event = callTool("baba", "add_event", {
    title: "家长会",
    start: "2031-06-01 09:00",
    end: "2031-06-01 10:00",
    location: SECRET_PLACE_EVENT,
    notes: SECRET_NOTE_EVENT,
  });
  ok(event, "sweep add_event");
  const handle = event.data as { id: string; series_id: string };
  w.eventInstanceId = handle.id;
  w.eventSeriesId = handle.series_id;
  ok(callTool("baba", "update_event", { id: w.eventInstanceId, title: "家长会(改到三楼)" }), "sweep update_event");
  ok(callTool("baba", "delete_event", { id: w.eventInstanceId }), "sweep delete_event");

  const entry = callTool("baba", "add_entry", {
    member_id: "妈妈",
    type: "expense",
    amount_fen: 3500,
    note: SECRET_NOTE_ENTRY,
  });
  ok(entry, "sweep add_entry");
  w.entryId = (entry.data as { id: string }).id;
  ok(callTool("baba", "update_entry", { id: w.entryId, amount_fen: 3800, note: SECRET_NOTE_ENTRY }), "sweep update_entry");
  ok(callTool("baba", "delete_entry", { id: w.entryId }), "sweep delete_entry");

  ok(callTool("baba", "add_category", { name: "宠物", kind: "expense" }), "sweep add_category");

  ok(callTool("baba", "delete_todo", { id: w.todoId }), "sweep delete_todo");
  ok(callTool("baba", "restore_deleted", { kind: "todo", id: w.todoId }), "sweep restore_deleted");
}

/** 把 7 个读工具各跑一次(参数合规即可 —— 这一段只关心"读不留痕")。 */
function runAllReadTools(): void {
  ok(callTool("baba", "list_members", {}), "sweep list_members");
  ok(callTool("baba", "list_todos", {}), "sweep list_todos");
  ok(callTool("baba", "list_events", { start: "2031-06-01", end: "2031-06-30" }), "sweep list_events");
  ok(callTool("baba", "list_entries", {}), "sweep list_entries");
  ok(callTool("baba", "summarize_entries", { period: "this_month", group_by: "ledger" }), "sweep summarize_entries");
  ok(callTool("baba", "list_categories", {}), "sweep list_categories");
  ok(callTool("baba", "get_today", {}), "sweep get_today");
}

function auditRows(): AuditRow[] {
  return listAudit(f.db);
}

function summaries(): string[] {
  return auditRows().map((r) => r.args_summary);
}

describe("审计面 sweep(§6:写操作留痕、读操作不留、自由文本不进摘要)", () => {
  it("全部 13 个写工具各留一行,审计行数 ≥ 工具数,且身份一律是连接身份", () => {
    f = newFixture();
    const w: SweepWorld = { todoId: "", eventInstanceId: "", eventSeriesId: "", entryId: "" };
    assert.equal(auditRows().length, 0, "前提:还没有任何写入");

    runAllWriteTools(w);

    const rows = auditRows();
    assert.ok(
      rows.length >= WRITE_TOOLS.length,
      `审计行数 ${rows.length} < 写工具数 ${WRITE_TOOLS.length}:有写工具没留痕`,
    );
    // 13 个写工具的名字必须**逐一**出现在审计里(不只是"数量够了")
    const auditedTools = new Set(rows.map((r) => r.tool));
    for (const name of WRITE_TOOLS) {
      assert.ok(auditedTools.has(name), `写工具 ${name} 没有留下审计行`);
    }
    // 身份一律是连接身份(爸爸)
    for (const r of rows) {
      assert.equal(r.member_id, f.members.baba.id, `审计行 ${r.tool} 的 member_id 不是连接身份,而是 ${r.member_id}`);
      assert.equal(r.member_name, "爸爸", `审计行 ${r.tool} 的 member_name 不是连接身份`);
    }
    // 全部成功 → result_code 都是 OK
    assert.ok(rows.every((r) => r.ok === true && r.result_code === "OK"), "全部写调用都成功,result_code 应都是 OK");
  });

  it("审计里的身份是连接身份,不是参数里的归属人(代记也不串号)", () => {
    f = newFixture();
    // 爸爸代记给妈妈:参数里的 owner=妈妈,审计里的身份必须是爸爸(token → 成员)。
    ok(callTool("baba", "add_todo", { owner: "妈妈", title: "代记一条", due_date: "2031-06-10" }), "sweep 代记");
    // 换成小明做同一个写操作:身份必须跟着**连接**变,而不是跟着 owner 变。
    ok(callTool("kid", "add_todo", { owner: "妈妈", title: "小明代记一条", due_date: "2031-06-10" }), "sweep 换人代记");

    const rows = auditRows().slice().reverse(); // 时间正序
    assert.equal(rows.length, 2);
    assert.match(rows[0]!.args_summary, /owner=妈妈/, "前提:参数里的归属人是妈妈");
    assert.equal(rows[0]!.member_id, f.members.baba.id, "审计身份必须是连接身份爸爸,不是参数里的 owner");
    assert.equal(rows[0]!.member_name, "爸爸");
    assert.equal(rows[1]!.member_id, f.members.kid.id, "审计身份必须跟着连接变");
    assert.equal(rows[1]!.member_name, "小明");
  });

  it("全部 7 个读工具跑完,审计行数一行不变(读不是写)", () => {
    f = newFixture();
    const w: SweepWorld = { todoId: "", eventInstanceId: "", eventSeriesId: "", entryId: "" };
    runAllWriteTools(w);
    const before = auditRows().length;
    assert.ok(before >= WRITE_TOOLS.length);

    runAllReadTools();

    assert.equal(auditRows().length, before, "读工具跑完后审计行数必须一模一样");
  });

  it("被拒的读同样不留痕(X2 的 DENIED 不是一次写)", () => {
    f = newFixture();
    const before = auditRows().length;
    const denied = callTool("kid", "list_entries", { ledger: "personal", member_id: "妈妈" });
    assert.equal(denied.ok, false, "前提:这一次读应被 DENIED");
    const deniedSummary = callTool("kid", "summarize_entries", {
      group_by: "ledger",
      ledger: "personal",
      member_id: "妈妈",
    });
    assert.equal(deniedSummary.ok, false);
    const missingParam = callTool("kid", "add_todo", {});
    assert.equal(missingParam.ok, false, "前提:parse 失败");
    assert.equal(auditRows().length, before, "读(哪怕被拒)与参数校验失败都不进审计");
  });

  it("自由文本不进审计摘要:notes / note / location 一个字都不许出现", () => {
    f = newFixture();
    const w: SweepWorld = { todoId: "", eventInstanceId: "", eventSeriesId: "", entryId: "" };
    runAllWriteTools(w);

    const all = summaries().join("\n");
    for (const secret of [SECRET_NOTE_TODO, SECRET_NOTE_EVENT, SECRET_PLACE_EVENT, SECRET_NOTE_ENTRY]) {
      assert.equal(all.includes(secret), false, `审计摘要泄露了自由文本「${secret}」: ${all}`);
    }
    // 连字段名都不该出现(出现 `notes=` 就说明白名单漏了一个字段)
    for (const field of ["notes", "note", "location"]) {
      assert.equal(
        new RegExp(`(^|\\s)${field}=`).test(all),
        false,
        `审计摘要出现了自由文本字段 ${field}=:${all}`,
      );
    }
    // 但关键元数据必须在(否则"只记元数据"就变成了"什么都不记")
    assert.match(all, /title=/, "标题这类关键元数据应当在摘要里");
    assert.match(all, /member_id=妈妈/, "归属人这类关键元数据应当在摘要里");
    assert.match(all, /amount_fen=3500/, "金额这类关键元数据应当在摘要里");
    assert.match(all, /kind=todo/, "恢复类写操作要记 kind");
  });

  it("审计摘要按字段白名单逐个核对(14 个写工具的字段集合不得漂移)", () => {
    f = newFixture();
    const w: SweepWorld = { todoId: "", eventInstanceId: "", eventSeriesId: "", entryId: "" };
    runAllWriteTools(w);
    const rows = auditRows();
    const byTool = new Map<string, string[]>();
    for (const r of rows) {
      const fields = r.args_summary
        .split(" ")
        .filter((s) => s.includes("="))
        .map((s) => s.slice(0, s.indexOf("=")));
      byTool.set(r.tool, [...(byTool.get(r.tool) ?? []), ...fields]);
    }
    // 每个写工具的摘要里出现的字段名(逐字列出,故意不抽公共常量:字段漂移要一眼看见)
    const expect = new Map<string, string[]>([
      ["add_todo", ["owner", "title", "due_date"]],
      ["update_todo", ["id", "title", "owner"]],
      ["complete_todo", ["id"]],
      ["reopen_todo", ["id"]],
      ["delete_todo", ["id"]],
      ["add_event", ["title", "start", "end"]],
      ["update_event", ["id", "title"]],
      ["delete_event", ["id"]],
      ["add_entry", ["member_id", "type", "amount_fen"]],
      ["update_entry", ["id", "amount_fen"]],
      ["delete_entry", ["id"]],
      ["add_category", ["name", "kind"]],
      ["restore_deleted", ["kind", "id"]],
    ]);
    for (const [name, allowed] of expect) {
      const seen = new Set(byTool.get(name) ?? []);
      assert.ok(seen.size > 0, `写工具 ${name} 没有审计行`);
      for (const field of seen) {
        assert.ok(allowed.includes(field), `写工具 ${name} 的审计摘要多记了字段 ${field}(§6:只记关键字段元数据)`);
      }
    }
  });
});