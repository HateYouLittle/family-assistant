import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { todayInTz } from "../src/db/id.js";
import { authenticate, issueToken, revokeToken, type AuthResult } from "../src/domain/auth.js";
import { addEvent, deleteEvent, listEvents, updateEvent, type EventView } from "../src/domain/events.js";
import type { Envelope, FailEnvelope, OkEnvelope } from "../src/domain/envelope.js";
import {
  addEntry,
  deleteEntry,
  listEntries,
  summarizeEntries,
  updateEntry,
  type EntryView,
  type SummaryResult,
} from "../src/domain/ledger.js";
import { restoreDeleted } from "../src/domain/restore.js";
import { getToday, type TodayData } from "../src/domain/today.js";
import {
  addTodo,
  completeTodo,
  deleteTodo,
  listTodos,
  reopenTodo,
  updateTodo,
  type TodoView,
} from "../src/domain/todos.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { TOOL_DEFINITIONS } from "../src/mcp/tools.js";
import { newFixture, TZ, type Fixture, type FixtureKey } from "./helpers.js";

/**
 * S5 可见性全景:把 `docs/设计方案.md` §4 的**三张可见性真值表**与**反例清单 X1–X16**
 * 逐格钉成测试,并放一张可执行的 COVERAGE 矩阵(V1–V9 / X1–X16 → 用例名)。
 *
 * ## 这份文件的形状
 *
 * - 用例名统一为 `TT <域>/<操作>/<可见性类>`(真值表的一格 = 一个用例),
 *   报告里"域 / 操作 / 可见性类 → 用例名"那张表可以直接由用例名生成。
 * - 反例一律 `X<编号>: …`,每条一个独立用例,错误码 + reason + 可转述话术都断言。
 * - 末尾的 `COVERAGE` 矩阵 + meta 用例让"某条不变量没有用例"变成一条会红的断言:
 *   键缺失、数组为空、引用的名字不是真用例、某个 `X<编号>:` 用例漏登记,meta 都失败。
 *
 * ## 两条纪律
 *
 * 1. **读一律用集合相等断言**(排序后的 id 列表 deepEqual),不用"包含/不包含":
 *   后者对"多返回了一条别人的"完全无感,而那恰恰是唯一危险的方向。
 * 2. **拒绝类用例钉死泄露面**:整个响应信封(data + message + hint)里都不得出现
 *   被保护对象的标题 / 金额 / 备注 —— 只断 reason 不够,话术里夹带一句标题同样是泄露。
 *
 * ## 真值表与 X1 的分叉裁决(写在这里,便于日后回查)
 *
 * §4 待办表 list 行的"owner=他人"格写的是 `DENIED`,而同页 X1 写的是
 * `INVALID_PARAMS`(未知字段),§5.1② 又明确"这条分界让 X1(未知字段)与
 * X11–X14(不可变字段)各自落在正确的码上"。本文件按**实际工具形态**断言:
 * 待办 / 日程没有"查他人"的参数形态 → 强行传入落 `INVALID_PARAMS(未知字段)`
 * (它同样是"明确失败",绝不是静默空表);记账有真实参数
 * (ledger=personal + 他人 member_id)→ 落 `DENIED(not_visible)`。
 *
 * ## "get by id" 一格的落点
 *
 * 真值表有 "get by id" 一行,但工具面**没有**独立的 get 工具(id 只出现在 list 的结果里)。
 * 所以那一格落成两半,两半都断:
 * ① 该 id 出现在本人可见的读结果中(V6 的前提:权限与读取同源);
 * ② 拿该 id 去定位任何写工具,本人放行、他人一律 DENIED(not_visible) 且信封不含行内信息。
 */

let f: Fixture;
afterEach(() => f?.db.close());

/** 记录全部用例名:COVERAGE 的 meta 用例据此校验"引用的确实是真用例"。 */
const CASE_NAMES: string[] = [];
function itCase(name: string, fn: () => void | Promise<void>): void {
  CASE_NAMES.push(name);
  it(name, fn);
}

function ok(env: { ok: boolean; message?: string }, why?: string): asserts env is OkEnvelope {
  assert.equal(env.ok, true, `${why ? `${why}:` : "期望成功信封"}实际:${JSON.stringify(env)}`);
}
function fail(env: { ok: boolean; message?: string }, why?: string): asserts env is FailEnvelope {
  assert.equal(env.ok, false, `${why ? `${why}:` : "期望失败信封"}实际:${JSON.stringify(env)}`);
}

/** 工具层 parse 失败:断言它真的失败,并把类型收窄到 FailEnvelope(否则下面的 code/field 访问无从校验)。 */
function parseFail(
  parsed: { ok: true; args: unknown } | { ok: false; envelope: Envelope },
  why: string,
): asserts parsed is { ok: false; envelope: FailEnvelope } {
  assert.equal(parsed.ok, false, `${why}:必须失败。实际:${JSON.stringify(parsed)}`);
  if (parsed.ok) throw new Error("unreachable");
  fail(parsed.envelope, why);
}

/** message 必须非空、可直接转述给家人的中文,且含关键说法。 */
function assertSpeakable(env: Envelope, mustInclude: RegExp, why: string): void {
  const message = env.message;
  assert.ok(typeof message === "string" && message.length > 0, `${why}:message 不得为空(P3)`);
  assert.match(message, /[\u4e00-\u9fff]/, `${why}:message 必须是中文(P3),实际「${message}」`);
  assert.match(message, mustInclude, `${why}:message 缺少关键说法,实际「${message}」`);
}

/** 失败信封不得带 data(§5.1①)。 */
function assertNoData(env: Envelope, why: string): void {
  assert.equal("data" in (env as unknown as Record<string, unknown>), false, `${why}:失败信封不得带 data`);
}

/**
 * 泄露面断言:整个响应信封里都不得出现被保护对象的标题 / 金额 / 备注。
 * 逐字比对整个 JSON(data + message + hint + code …),而不是只看 message。
 */
function assertNoLeak(env: Envelope, secrets: readonly string[], why: string): void {
  const json = JSON.stringify(env);
  for (const secret of secrets) {
    assert.equal(json.includes(secret), false, `${why}:响应信封泄露了受保护的内容「${secret}」: ${json}`);
  }
  assertNoData(env, why);
}

// ─────────────────────────── 三人世界夹具 ───────────────────────────

/** 受保护内容的字面量:读类反例(X1/X2/X3/X9)与泄露面断言都拿它们当"绝不能出现"的东西。 */
const SECRET = {
  todoTitle: "妈妈专属待办·标题",
  todoNote: "妈妈待办备注·绝密",
  eventTitle: "妈妈专属日程·标题",
  eventPlace: "妈妈专属日程·地点",
  entryNote: "妈妈私账备注·绝密",
  entryYuan: "¥66.66",
} as const;

interface EventHandle {
  seriesId: string;
  instanceId: string;
}

interface World {
  f: Fixture;
  today: string;
  todo: {
    /** owner=妈妈,created_by=妈妈 */
    mamaOwn: string;
    /** owner=爸爸,created_by=爸爸 */
    babaOwn: string;
    /** owner=爸爸,created_by=妈妈(V4 代记 + V8 适用) */
    mamaForBaba: string;
    /** owner=妈妈,created_by=爸爸 */
    babaForMama: string;
    /** 妈妈自己的、已软删 */
    mamaDeleted: string;
    mamaDueToday: string;
    mamaOverdue: string;
    babaDueToday: string;
    /** owner=爸爸、created_by=妈妈,且今天到期(get_today 不得把它算进「我的今天」) */
    mamaForBabaDueToday: string;
  };
  event: {
    family: EventHandle;
    mamaOwn: EventHandle;
    babaOwn: EventHandle;
    /** owner=爸爸、created_by=妈妈(V8 代记者) */
    mamaForBaba: EventHandle;
    familyDeleted: EventHandle;
    familyToday: EventHandle;
    mamaOwnToday: EventHandle;
    babaOwnToday: EventHandle;
  };
  entry: {
    sharedMama: string;
    sharedBaba: string;
    personalMama: string;
    personalBaba: string;
    /** 共享账本、已软删 */
    deleted: string;
  };
}

function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const p2 = (x: number) => String(x).padStart(2, "0");
  return `${String(dt.getUTCFullYear()).padStart(4, "0")}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
}

/**
 * 三人世界(妈妈 / 爸爸 / 小明)在三域各造出代表性的行:
 * 待办 9 行(含已软删与今天到期的)、日程 8 个系列(含已软删与今天的)、记账 5 笔(含已软删)。
 * 每个用例用**独立**夹具,互不串味。
 */
function world(): World {
  const fx = newFixture();
  const today = todayInTz(TZ);
  const mkTodo = (key: FixtureKey, input: Parameters<typeof addTodo>[3]): string => {
    const env = addTodo(fx.db, fx.callers[key], TZ, input);
    ok(env, `建待办失败:${JSON.stringify(input)}`);
    return (env.data as TodoView).id;
  };
  const mkEvent = (key: FixtureKey, input: Parameters<typeof addEvent>[3]): EventHandle => {
    const env = addEvent(fx.db, fx.callers[key], TZ, input);
    ok(env, `建日程失败:${JSON.stringify(input)}`);
    const v = env.data as EventView;
    return { seriesId: v.series_id, instanceId: v.id };
  };
  const mkEntry = (key: FixtureKey, input: Parameters<typeof addEntry>[3]): string => {
    const env = addEntry(fx.db, fx.callers[key], TZ, input);
    ok(env, `记流水失败:${JSON.stringify(input)}`);
    return (env.data as EntryView).id;
  };

  const w: World = {
    f: fx,
    today,
    todo: {
      mamaOwn: mkTodo("mama", { title: SECRET.todoTitle, due_date: "2031-06-10", notes: SECRET.todoNote }),
      babaOwn: mkTodo("baba", { title: "爸爸自己的待办·私密", due_date: "2031-06-11" }),
      mamaForBaba: mkTodo("mama", { owner: "爸爸", title: "妈妈代记给爸爸·私密" }),
      babaForMama: mkTodo("baba", { owner: "妈妈", title: "爸爸代记给妈妈·私密" }),
      mamaDeleted: mkTodo("mama", { title: "妈妈已删待办·私密" }),
      mamaDueToday: mkTodo("mama", { title: "妈妈今日到期", due_date: today }),
      mamaOverdue: mkTodo("mama", { title: "妈妈已逾期", due_date: shiftDay(today, -1) }),
      babaDueToday: mkTodo("baba", { title: "爸爸今日到期", due_date: today }),
      mamaForBabaDueToday: mkTodo("mama", { owner: "爸爸", title: "妈妈代记给爸爸今日到期", due_date: today }),
    },
    event: {
      family: mkEvent("mama", { title: "全家会议·私密", start: "2031-06-01 09:00" }),
      mamaOwn: mkEvent("mama", {
        owner: "妈妈",
        title: SECRET.eventTitle,
        start: "2031-06-02 09:00",
        location: SECRET.eventPlace,
      }),
      babaOwn: mkEvent("baba", { owner: "爸爸", title: "爸爸个人日程·私密", start: "2031-06-03 09:00" }),
      mamaForBaba: mkEvent("mama", { owner: "爸爸", title: "妈妈代记给爸爸·私密", start: "2031-06-04 09:00" }),
      familyDeleted: mkEvent("mama", { title: "已删全家日程·私密", start: "2031-06-05 09:00" }),
      familyToday: mkEvent("mama", { title: "今天全家日程", start: `${today} 09:00` }),
      mamaOwnToday: mkEvent("mama", { owner: "妈妈", title: "今天妈妈个人日程", start: `${today} 10:00` }),
      babaOwnToday: mkEvent("baba", { owner: "爸爸", title: "今天爸爸个人日程", start: `${today} 11:00` }),
    },
    entry: {
      sharedMama: mkEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 1000, occurred_date: "2031-06-01" }),
      sharedBaba: mkEntry("baba", { member_id: "爸爸", type: "expense", amount_fen: 2000, occurred_date: "2031-06-01" }),
      personalMama: mkEntry("mama", {
        member_id: "妈妈",
        ledger: "personal",
        type: "expense",
        amount_fen: 6666,
        occurred_date: "2031-06-01",
        note: SECRET.entryNote,
      }),
      personalBaba: mkEntry("baba", {
        member_id: "爸爸",
        ledger: "personal",
        type: "expense",
        amount_fen: 7777,
        occurred_date: "2031-06-01",
        note: "爸爸私账备注·绝密",
      }),
      deleted: mkEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 3000, occurred_date: "2031-06-01" }),
    },
  };

  ok(deleteTodo(fx.db, fx.callers.mama, w.todo.mamaDeleted));
  ok(deleteEvent(fx.db, fx.callers.mama, w.event.familyDeleted.instanceId));
  ok(deleteEntry(fx.db, fx.callers.mama, TZ, w.entry.deleted));
  return w;
}

// ─────────────────────────── 读路径的小工具 ───────────────────────────

function listTodosOf(w: World, key: FixtureKey): { todos: TodoView[]; delegated: TodoView[] } {
  const env = listTodos(w.f.db, w.f.callers[key], TZ, {});
  ok(env, "list_todos");
  return env.data as { todos: TodoView[]; delegated: TodoView[] };
}

function allTodoIds(w: World, key: FixtureKey): string[] {
  const d = listTodosOf(w, key);
  return [...d.todos.map((t) => t.id), ...d.delegated.map((t) => t.id)].sort();
}

interface EventList {
  family: EventView[];
  mine: EventView[];
  delegated: EventView[];
}

function listEventsOf(w: World, key: FixtureKey, scope?: "family" | "mine"): EventList {
  const env = listEvents(w.f.db, w.f.callers[key], TZ, { ...JUNE, ...(scope ? { scope } : {}) });
  ok(env, "list_events");
  return env.data as EventList;
}

function allEventIds(d: EventList): string[] {
  return [...d.family, ...d.mine, ...d.delegated].map((e) => e.id).sort();
}

interface EntryList {
  entries: EntryView[];
  shared: EntryView[];
  personal: EntryView[];
}

function listEntriesOf(w: World, key: FixtureKey, args: Parameters<typeof listEntries>[3] = {}): EntryList {
  const env = listEntries(w.f.db, w.f.callers[key], TZ, args);
  ok(env, "list_entries");
  return env.data as EntryList;
}

function summarizeOf(w: World, key: FixtureKey, args: Parameters<typeof summarizeEntries>[3]): SummaryResult {
  const env = summarizeEntries(w.f.db, w.f.callers[key], TZ, args);
  ok(env, "summarize_entries");
  return env.data as SummaryResult;
}

function todayOf(w: World, key: FixtureKey): TodayData {
  const env = getToday(w.f.db, w.f.callers[key], TZ);
  ok(env, "get_today");
  return env.data as TodayData;
}

function tableCount(w: World, table: "todo" | "entry" | "event_series"): number {
  return (w.f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function deletedAt(w: World, table: "todo" | "entry", id: string): string | null {
  return (w.f.db.prepare(`SELECT deleted_at FROM ${table} WHERE id = ?`).get(id) as { deleted_at: string | null })
    .deleted_at;
}

// ─────────────────────────── 真值表:待办 todo ───────────────────────────

describe("真值表·待办 todo(一律个人项,owner 必填)", () => {
  itCase("TT todo/list/owner=本人", () => {
    const w = world();
    f = w.f;
    const d = listTodosOf(w, "mama");
    // 集合相等:本人名下全部 + 自己代记的(V8 查看权),一个不多一个不少。
    assert.deepEqual(allTodoIds(w, "mama"), [
      w.todo.mamaOwn,
      w.todo.babaForMama,
      w.todo.mamaDueToday,
      w.todo.mamaOverdue,
      w.todo.mamaForBaba,
      w.todo.mamaForBabaDueToday,
    ].sort());
    assert.deepEqual(
      d.delegated.map((t) => t.id).sort(),
      [w.todo.mamaForBaba, w.todo.mamaForBabaDueToday].sort(),
      "自己代记的那些单列一组",
    );
    // 第三人读到的集合恰好为空(不是"爸爸的"或"妈妈的")
    assert.deepEqual(allTodoIds(w, "kid"), []);
  });

  itCase("TT todo/list/owner=他人", () => {
    const w = world();
    f = w.f;
    // 工具面没有 owner 参数形态:强行传入 → INVALID_PARAMS(未知字段),绝不是空表。
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "list_todos")!;
    const parsed = tool.parse({ owner: "妈妈" });
    parseFail(parsed, "TT todo/list 他人");
    assert.equal(parsed.envelope.code, "INVALID_PARAMS");
    assert.equal(parsed.envelope.field, "owner");
    assertSpeakable(parsed.envelope, /list_todos 不接受未知参数:owner/, "TT todo/list 他人");
    assertNoLeak(parsed.envelope, [SECRET.todoTitle, SECRET.todoNote], "TT todo/list 他人");
  });

  itCase("TT todo/get-by-id/owner=本人", () => {
    const w = world();
    f = w.f;
    // ① id 出现在本人可见的读结果里(V6 的前提)
    assert.ok(
      listTodosOf(w, "mama").todos.some((t) => t.id === w.todo.mamaOwn),
      "本人的 id 必须出现在自己的读结果里",
    );
    // ② 拿该 id 去定位写工具 → 放行并回出完整记录
    const env = updateTodo(f.db, f.callers.mama, TZ, { id: w.todo.mamaOwn, title: "妈妈自己的待办·改名" });
    ok(env, "本人按 id 定位");
    assert.equal((env.data as TodoView).title, "妈妈自己的待办·改名");
  });

  itCase("TT todo/get-by-id/owner=他人", () => {
    const w = world();
    f = w.f;
    // 第三人拿别人的 id 试探,四个写工具一律 not_visible,信封零泄露。
    for (const key of ["baba", "kid"] as const) {
      const probes: { tool: string; env: Envelope }[] = [
        { tool: "update", env: updateTodo(f.db, f.callers[key], TZ, { id: w.todo.mamaOwn, title: "偷偷改" }) },
        { tool: "complete", env: completeTodo(f.db, f.callers[key], TZ, w.todo.mamaOwn) },
        { tool: "reopen", env: reopenTodo(f.db, f.callers[key], w.todo.mamaOwn) },
        { tool: "delete", env: deleteTodo(f.db, f.callers[key], w.todo.mamaOwn) },
        { tool: "restore", env: restoreDeleted(f.db, f.callers[key], "todo", w.todo.mamaOwn) },
      ];
      for (const p of probes) {
        fail(p.env, `${key} 用 ${p.tool} 碰别人的 id`);
        assert.equal(p.env.code, "DENIED", `${key}/${p.tool}`);
        assert.equal(p.env.reason, "not_visible", `${key}/${p.tool}`);
        assertSpeakable(p.env, /仅归属人本人可见/, `TT todo/get-by-id 他人(${key}/${p.tool})`);
        assertNoLeak(p.env, [SECRET.todoTitle, SECRET.todoNote], `TT todo/get-by-id 他人(${key}/${p.tool})`);
      }
    }
  });

  itCase("TT todo/add/owner=本人", () => {
    const w = world();
    f = w.f;
    const env = addTodo(f.db, f.callers.mama, TZ, { title: "新待办" });
    ok(env);
    const v = env.data as TodoView;
    assert.equal(v.owner_id, f.members.mama.id);
    assert.equal(v.delegated, false);
    assertSpeakable(env, /仅你自己可见/, "TT todo/add 本人");
  });

  itCase("TT todo/add/owner=他人", () => {
    const w = world();
    f = w.f;
    const env = addTodo(f.db, f.callers.mama, TZ, { owner: "爸爸", title: "代记" });
    ok(env, "V4:允许代记");
    const v = env.data as TodoView;
    assert.equal(v.owner_id, f.members.baba.id);
    assert.equal(v.created_by, f.members.mama.id);
    assert.equal(v.delegated, true);
    assertSpeakable(env, /仅 爸爸 可见,由 妈妈 代记/, "TT todo/add 他人(代记回执必须标注说话人)");
  });

  itCase("TT todo/update/owner=本人", () => {
    const w = world();
    f = w.f;
    ok(updateTodo(f.db, f.callers.mama, TZ, { id: w.todo.mamaOwn, title: "改名成功" }));
    assert.equal(listTodosOf(w, "mama").todos.find((t) => t.id === w.todo.mamaOwn)?.title, "改名成功");
  });

  itCase("TT todo/update/owner=他人", () => {
    const w = world();
    f = w.f;
    // 第三人 → not_visible
    const third = updateTodo(f.db, f.callers.kid, TZ, { id: w.todo.mamaOwn, title: "偷偷改" });
    fail(third);
    assert.equal(third.code, "DENIED");
    assert.equal(third.reason, "not_visible");
    assertNoLeak(third, [SECRET.todoTitle, SECRET.todoNote], "TT todo/update 他人");
    // 代记者 → not_writable(V8 的横向补充:update 仍是 ❌)
    const delegator = updateTodo(f.db, f.callers.mama, TZ, { id: w.todo.mamaForBaba, title: "偷偷改" });
    fail(delegator);
    assert.equal(delegator.reason, "not_writable");
    assertSpeakable(delegator, /这条待办是你代 爸爸 记的/, "TT todo/update 他人(代记者)");
    assert.equal(listTodosOf(w, "mama").delegated.find((t) => t.id === w.todo.mamaForBaba)?.title, "妈妈代记给爸爸·私密");
  });

  itCase("TT todo/complete/owner=本人", () => {
    const w = world();
    f = w.f;
    ok(completeTodo(f.db, f.callers.mama, TZ, w.todo.mamaOwn));
    assert.equal(listTodosOf(w, "mama").todos.find((t) => t.id === w.todo.mamaOwn)?.done, true);
  });

  itCase("TT todo/complete/owner=他人", () => {
    const w = world();
    f = w.f;
    const third = completeTodo(f.db, f.callers.kid, TZ, w.todo.mamaOwn);
    fail(third);
    assert.equal(third.reason, "not_visible");
    const delegator = completeTodo(f.db, f.callers.mama, TZ, w.todo.mamaForBaba);
    fail(delegator);
    assert.equal(delegator.reason, "not_writable");
    assert.equal(
      listTodosOf(w, "baba").todos.find((t) => t.id === w.todo.mamaForBaba)?.done,
      false,
      "代记者不得替归属人完成",
    );
  });

  itCase("TT todo/reopen/owner=本人", () => {
    const w = world();
    f = w.f;
    ok(completeTodo(f.db, f.callers.mama, TZ, w.todo.mamaOwn));
    ok(reopenTodo(f.db, f.callers.mama, w.todo.mamaOwn));
    assert.equal(listTodosOf(w, "mama").todos.find((t) => t.id === w.todo.mamaOwn)?.done, false);
  });

  itCase("TT todo/reopen/owner=他人", () => {
    const w = world();
    f = w.f;
    // 造一条「已完成」且"owner=爸爸、created_by=妈妈"的行,才能分别试出两种 reason。
    f.db.prepare("UPDATE todo SET done = 1, done_at = ? WHERE id = ?").run("2026-10-01T00:00:00.000Z", w.todo.mamaForBaba);
    const third = reopenTodo(f.db, f.callers.kid, w.todo.mamaForBaba);
    fail(third, "第三人");
    assert.equal(third.reason, "not_visible");
    assertNoLeak(third, ["妈妈代记给爸爸·私密"], "TT todo/reopen 他人(第三人)");
    const delegator = reopenTodo(f.db, f.callers.mama, w.todo.mamaForBaba);
    fail(delegator, "代记者");
    assert.equal(delegator.reason, "not_writable");
    assertSpeakable(delegator, /只能由 爸爸 本人重开/, "TT todo/reopen 他人(代记者)");
    assert.equal(
      (f.db.prepare("SELECT done FROM todo WHERE id = ?").get(w.todo.mamaForBaba) as { done: number }).done,
      1,
      "被拒的重开不得改完成状态",
    );
  });

  itCase("TT todo/delete/owner=本人", () => {
    const w = world();
    f = w.f;
    const env = deleteTodo(f.db, f.callers.mama, w.todo.mamaOwn);
    ok(env);
    assert.equal(listTodosOf(w, "mama").todos.some((t) => t.id === w.todo.mamaOwn), false, "软删后不再出现");
  });

  itCase("TT todo/delete/owner=他人", () => {
    const w = world();
    f = w.f;
    const third = deleteTodo(f.db, f.callers.kid, w.todo.mamaOwn);
    fail(third);
    assert.equal(third.code, "DENIED");
    assert.equal(third.reason, "not_visible");
    assertSpeakable(third, /仅归属人本人可见/, "TT todo/delete 他人");
    assertNoLeak(third, [SECRET.todoTitle, SECRET.todoNote], "TT todo/delete 他人");
    assert.equal(deletedAt(w, "todo", w.todo.mamaOwn), null, "被拒的删除不得生效");
  });

  itCase("TT todo/restore/owner=本人", () => {
    const w = world();
    f = w.f;
    // 夹具里这条已经是软删态(§4:已删退出活跃范围)
    assert.notEqual(deletedAt(w, "todo", w.todo.mamaDeleted), null, "夹具前提:这条已被软删");
    assert.equal(listTodosOf(w, "mama").todos.some((t) => t.id === w.todo.mamaDeleted), false);
    const env = restoreDeleted(f.db, f.callers.mama, "todo", w.todo.mamaDeleted);
    ok(env, "本人恢复自己删的待办");
    assertSpeakable(env, /它重新出现在你的待办列表里/, "TT todo/restore 本人");
    assert.equal(listTodosOf(w, "mama").todos.some((t) => t.id === w.todo.mamaDeleted), true);
    assert.equal(deletedAt(w, "todo", w.todo.mamaDeleted), null, "恢复后 deleted_at 必须为空");
  });

  itCase("TT todo/restore/owner=他人", () => {
    const w = world();
    f = w.f;
    ok(deleteTodo(f.db, f.callers.baba, w.todo.babaOwn));
    for (const key of ["mama", "kid"] as const) {
      const env = restoreDeleted(f.db, f.callers[key], "todo", w.todo.babaOwn);
      fail(env, `${key} 恢复别人的待办`);
      assert.equal(env.code, "DENIED");
      assert.equal(env.reason, "not_visible");
      assertNoLeak(env, ["爸爸自己的待办·私密"], `TT todo/restore 他人(${key})`);
      assert.doesNotMatch(env.message, /已被删除|无需恢复/, "不可见者不得据此推断删除状态(V5)");
    }
    assert.notEqual(deletedAt(w, "todo", w.todo.babaOwn), null, "被拒的恢复不得生效");
  });

  itCase("TT todo/软删行", () => {
    const w = world();
    f = w.f;
    // 任何人的 list 都不含已软删行(含归属人自己)
    for (const key of ["mama", "baba", "kid"] as const) {
      assert.equal(allTodoIds(w, key).includes(w.todo.mamaDeleted), false, `${key} 的 list 不得含已软删行`);
    }
    // 归属人本人对已软删行按 id 操作 → NOT_FOUND(§4:已删退出活跃范围)
    const env = updateTodo(f.db, f.callers.mama, TZ, { id: w.todo.mamaDeleted, title: "x" });
    fail(env);
    assert.equal(env.code, "NOT_FOUND");
    assert.equal(env.reason, undefined, "看得见的人才拿到 NOT_FOUND,不是权限拒绝");
    assertSpeakable(env, /已被删除,无法修改/, "TT todo/软删行");
    assert.match(env.hint ?? "", /restore_deleted/, "TT todo/软删行:必须给出恢复出路");
  });
});

// ─────────────────────────── 真值表:日程 event ───────────────────────────

const JUNE = { start: "2031-06-01", end: "2031-06-30" } as const;
const JUNE_SUMMARY = { start: "2031-06-01", end: "2031-06-30" } as const;

describe("真值表·日程 event(全家 owner 空 / 个人 owner 指定)", () => {
  itCase("TT event/list/owner=空(全家)", () => {
    const w = world();
    f = w.f;
    for (const key of ["mama", "baba", "kid"] as const) {
      const d = listEventsOf(w, key);
      assert.deepEqual(d.family.map((e) => e.id), [w.event.family.instanceId], `${key}:全家日程恰好一条(V2 全员可见)`);
      assert.equal(d.family[0]?.owner_id, null, "全家日程的 owner_id 必须是空");
    }
  });

  itCase("TT event/list/owner=本人", () => {
    const w = world();
    f = w.f;
    const d = listEventsOf(w, "mama");
    assert.deepEqual(d.mine.map((e) => e.id), [w.event.mamaOwn.instanceId], "本人的个人日程单列");
    assert.equal(d.mine[0]?.owner_id, f.members.mama.id);
    // 自己代记给别人的单列 delegated(V8 的查看权),不混进 mine
    assert.deepEqual(d.delegated.map((e) => e.id), [w.event.mamaForBaba.instanceId], "V8 查看权单列一组");
    assert.deepEqual(
      [...d.mine, ...d.delegated].some((e) => e.owner_id !== f.members.mama.id && e.owner_id !== null),
      true,
      "代记者看到的那条 owner 是别人,不是本人",
    );
    const scoped = listEventsOf(w, "mama", "mine");
    assert.deepEqual(scoped.family, [], "scope=mine 只看本人个人日程");
    assert.deepEqual(scoped.mine.map((e) => e.id), [w.event.mamaOwn.instanceId]);
    assert.deepEqual(scoped.delegated, [], "scope=mine 不含自己代记的");
    // 集合相等:爸爸的 June 可见集合 = 全家 + 自己的 + 自己代记的
    assert.deepEqual(allEventIds(listEventsOf(w, "baba")), [
      w.event.family.instanceId,
      w.event.babaOwn.instanceId,
      w.event.mamaForBaba.instanceId,
    ].sort());
    assert.deepEqual(allEventIds(listEventsOf(w, "kid")), [w.event.family.instanceId]);
  });

  itCase("TT event/list/owner=他人", () => {
    const w = world();
    f = w.f;
    // 他人的个人日程既不进 family 也不进 mine;自己代记的那条单列 delegated(V8)。
    const d = listEventsOf(w, "baba");
    assert.deepEqual(d.delegated, [], "爸爸不是任何个人日程的代记者");
    assert.equal(allEventIds(d).includes(w.event.mamaOwn.instanceId), false, "别人的个人日程不得出现");
    const mamaView = listEventsOf(w, "mama");
    assert.deepEqual(mamaView.delegated.map((e) => e.id), [w.event.mamaForBaba.instanceId], "V8:代记者可见");
    // 显式指定他人 → 没有这个参数形态,落 INVALID_PARAMS(明确失败,不是空表)
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "list_events")!;
    const parsed = tool.parse({ ...JUNE, owner: "妈妈" });
    parseFail(parsed, "TT event/list 他人");
    assert.equal(parsed.envelope.code, "INVALID_PARAMS");
    assert.equal(parsed.envelope.field, "owner");
    assertNoLeak(parsed.envelope, [SECRET.eventTitle, SECRET.eventPlace], "TT event/list 他人");
  });

  itCase("TT event/add/owner=空(全家)", () => {
    const w = world();
    f = w.f;
    const env = addEvent(f.db, f.callers.mama, TZ, { title: "新全家日程", start: "2031-06-06 09:00" });
    ok(env);
    assert.equal((env.data as EventView).owner_id, null);
    assertSpeakable(env, /全家成员都能看到/, "TT event/add 全家");
    assert.equal(listEventsOf(w, "kid").family.length, 2, "新全家日程对第三人也可见(V2)");
  });

  itCase("TT event/add/owner=本人", () => {
    const w = world();
    f = w.f;
    const env = addEvent(f.db, f.callers.mama, TZ, { owner: "妈妈", title: "新个人日程", start: "2031-06-07 09:00" });
    ok(env);
    assert.equal((env.data as EventView).owner_id, f.members.mama.id);
    assert.equal((env.data as EventView).delegated, false);
    assertSpeakable(env, /仅你自己可见/, "TT event/add 本人");
    assert.equal(
      listEventsOf(w, "baba").mine.some((e) => e.title === "新个人日程"),
      false,
      "个人日程不得对他人出现",
    );
  });

  itCase("TT event/add/owner=他人", () => {
    const w = world();
    f = w.f;
    const env = addEvent(f.db, f.callers.mama, TZ, { owner: "爸爸", title: "新代记日程", start: "2031-06-08 09:00" });
    ok(env, "V4:允许代记");
    const v = env.data as EventView;
    assert.equal(v.owner_id, f.members.baba.id);
    assert.equal(v.delegated, true);
    assertSpeakable(env, /仅 爸爸 可见,由 妈妈 代记/, "TT event/add 他人");
    assert.equal(listEventsOf(w, "baba").mine.some((e) => e.id === v.id), true, "归属人本人看得到");
  });

  itCase("TT event/update/owner=空(全家)", () => {
    const w = world();
    f = w.f;
    // 第三人(既非创建者也非归属人)也能改全家日程:V3 家庭内互信。
    const env = updateEvent(f.db, f.callers.kid, TZ, { id: w.event.family.instanceId, title: "全家会议·改期" });
    ok(env, "V3:任何成员可改全家日程");
    assertSpeakable(env, /已由 小明 更新全家日程/, "V3:互信回执必须标注操作者");
    assert.equal(listEventsOf(w, "mama").family[0]?.title, "全家会议·改期");
  });

  itCase("TT event/update/owner=本人", () => {
    const w = world();
    f = w.f;
    ok(updateEvent(f.db, f.callers.mama, TZ, { id: w.event.mamaOwn.instanceId, title: "妈妈个人日程·改" }));
    assert.equal(listEventsOf(w, "mama").mine[0]?.title, "妈妈个人日程·改");
  });

  itCase("TT event/update/owner=他人", () => {
    const w = world();
    f = w.f;
    const third = updateEvent(f.db, f.callers.kid, TZ, { id: w.event.mamaOwn.instanceId, title: "偷偷改" });
    fail(third);
    assert.equal(third.code, "DENIED");
    assert.equal(third.reason, "not_visible");
    assertNoLeak(third, [SECRET.eventTitle, SECRET.eventPlace], "TT event/update 他人");
    const delegator = updateEvent(f.db, f.callers.mama, TZ, { id: w.event.mamaForBaba.instanceId, title: "偷偷改" });
    fail(delegator);
    assert.equal(delegator.reason, "not_writable");
    assertSpeakable(delegator, /这条日程是你代 爸爸 记的/, "TT event/update 他人(代记者)");
  });

  itCase("TT event/delete/owner=空(全家)", () => {
    const w = world();
    f = w.f;
    const env = deleteEvent(f.db, f.callers.kid, w.event.family.instanceId);
    ok(env, "V3:任何成员可删全家日程");
    assertSpeakable(env, /已由 小明 删除全家日程/, "V3:互信删除回执必须标注操作者");
    assert.deepEqual(listEventsOf(w, "mama").family, [], "软删后全家都看不到了");
  });

  itCase("TT event/delete/owner=本人", () => {
    const w = world();
    f = w.f;
    ok(deleteEvent(f.db, f.callers.mama, w.event.mamaOwn.instanceId));
    assert.deepEqual(listEventsOf(w, "mama").mine, []);
    assert.deepEqual(listEventsOf(w, "baba").mine.some((e) => e.id === w.event.mamaOwn.instanceId), false);
  });

  itCase("TT event/delete/owner=他人", () => {
    const w = world();
    f = w.f;
    const third = deleteEvent(f.db, f.callers.kid, w.event.mamaOwn.instanceId);
    fail(third);
    assert.equal(third.code, "DENIED");
    assert.equal(third.reason, "not_visible");
    assertSpeakable(third, /仅归属人本人可见/, "TT event/delete 他人");
    assertNoLeak(third, [SECRET.eventTitle, SECRET.eventPlace], "TT event/delete 他人");
    assert.equal(listEventsOf(w, "mama").mine.length, 1, "被拒的删除不得生效");
    // V8:代记者可撤回自己代记的日程
    const delegator = deleteEvent(f.db, f.callers.mama, w.event.mamaForBaba.instanceId);
    ok(delegator, "V8:代记者有删除权");
    assertSpeakable(delegator, /已撤回你代记的日程/, "V8:撤回回执必须标注");
  });

  itCase("TT event/软删系列", () => {
    const w = world();
    f = w.f;
    for (const key of ["mama", "baba", "kid"] as const) {
      assert.equal(allEventIds(listEventsOf(w, key)).includes(w.event.familyDeleted.instanceId), false, `${key} 不得看到已软删系列`);
    }
    // 恢复的是**整个系列**及其全部实例
    const env = restoreDeleted(f.db, f.callers.mama, "event", w.event.familyDeleted.seriesId);
    ok(env);
    assertSpeakable(env, /恢复的是整个系列及其全部日程实例/, "TT event/软删系列");
    assert.equal(allEventIds(listEventsOf(w, "kid")).includes(w.event.familyDeleted.instanceId), true, "恢复后对全家重新可见");
  });
});

// ─────────────────────────── 真值表:记账 entry ───────────────────────────

describe("真值表·记账 entry(ledger 决定可见性)", () => {
  itCase("TT entry/list/ledger=shared", () => {
    const w = world();
    f = w.f;
    for (const key of ["mama", "baba", "kid"] as const) {
      const d = listEntriesOf(w, key, { ledger: "shared" });
      assert.deepEqual(
        d.entries.map((e) => e.id).sort(),
        [w.entry.sharedMama, w.entry.sharedBaba].sort(),
        `${key}:共享账本必须恰好两笔(V2 全员可见)`,
      );
      assert.equal(d.personal.length, 0, `${key}:显式要 shared 时不得混入个人账本`);
    }
    // 缺省 ledger = 共享 + 本人个人,两栏分开
    const mama = listEntriesOf(w, "mama");
    assert.deepEqual(mama.shared.map((e) => e.id).sort(), [w.entry.sharedMama, w.entry.sharedBaba].sort());
    assert.deepEqual(mama.personal.map((e) => e.id), [w.entry.personalMama]);
    const kid = listEntriesOf(w, "kid");
    assert.deepEqual(kid.personal, [], "小明的个人账本就是空的");
  });

  itCase("TT entry/list/ledger=personal+本人", () => {
    const w = world();
    f = w.f;
    const d = listEntriesOf(w, "mama", { ledger: "personal" });
    assert.deepEqual(d.entries.map((e) => e.id), [w.entry.personalMama]);
    assert.equal(d.entries[0]?.ledger, "personal");
    assert.equal(d.shared.length, 0, "显式要 personal 时不得混入共享账本");
  });

  itCase("TT entry/list/ledger=personal+他人", () => {
    const w = world();
    f = w.f;
    const env = listEntries(f.db, f.callers.kid, TZ, { ledger: "personal", member_id: "妈妈" });
    fail(env, "V5:显式要他人私账必须 DENIED");
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assertSpeakable(env, /个人账本仅归属人本人可见/, "TT entry/list personal+他人");
    assert.match(env.hint ?? "", /互相不可见/, "TT entry/list personal+他人:hint 也要能直接转述");
    assertNoLeak(env, [SECRET.entryNote, SECRET.entryYuan, "6666"], "TT entry/list personal+他人");
  });

  itCase("TT entry/summarize/ledger=shared", () => {
    const w = world();
    f = w.f;
    for (const key of ["mama", "baba", "kid"] as const) {
      const r = summarizeOf(w, key, { ...JUNE_SUMMARY, group_by: "ledger", ledger: "shared" });
      assert.deepEqual(r.ledgers.map((b) => b.ledger), ["shared"], `${key}:显式指定账本只出那一块`);
      assert.equal(r.ledgers[0]?.count, 2, `${key}:共享账本合计必须恰好两笔(已软删的不计)`);
      assert.equal(r.ledgers[0]?.expense_fen, 3000, "1000 + 2000 = 3000 分 = ¥30.00(P4:数学在程序做)");
    }
  });

  itCase("TT entry/summarize/ledger=personal+本人", () => {
    const w = world();
    f = w.f;
    const r = summarizeOf(w, "mama", { ...JUNE_SUMMARY, group_by: "ledger", ledger: "personal" });
    assert.equal(r.ledgers[0]?.count, 1);
    assert.equal(r.ledgers[0]?.total_fen, 6666);
    const baba = summarizeOf(w, "baba", { ...JUNE_SUMMARY, group_by: "ledger", ledger: "personal" });
    assert.equal(baba.ledgers[0]?.total_fen, 7777, "每个人只看得到自己的私账合计");
    const kid = summarizeOf(w, "kid", { ...JUNE_SUMMARY, group_by: "ledger", ledger: "personal" });
    assert.equal(kid.ledgers[0]?.count, 0, "小明的个人账本合计为 0");
  });

  itCase("TT entry/summarize/ledger=personal+他人", () => {
    const w = world();
    f = w.f;
    const env = summarizeEntries(f.db, f.callers.kid, TZ, {
      ...JUNE_SUMMARY,
      group_by: "ledger",
      ledger: "personal",
      member_id: "妈妈",
    });
    fail(env, "TT entry/summarize:与 list 同口径");
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assertSpeakable(env, /个人账本仅归属人本人可见/, "TT entry/summarize personal+他人");
    assertNoLeak(env, [SECRET.entryNote, SECRET.entryYuan], "TT entry/summarize personal+他人");
  });

  itCase("TT entry/add/ledger=shared", () => {
    const w = world();
    f = w.f;
    // 可代记并指定 member_id
    const env = addEntry(f.db, f.callers.mama, TZ, { member_id: "爸爸", type: "expense", amount_fen: 500 });
    ok(env, "V4:共享账本可代记");
    const v = env.data as EntryView;
    assert.equal(v.ledger, "shared");
    assert.equal(v.member_id, f.members.baba.id);
    assert.equal(v.created_by, f.members.mama.id);
    assertSpeakable(env, /全家成员都能看到;由 妈妈 代记/, "TT entry/add shared 代记回执");
  });

  itCase("TT entry/add/ledger=personal+本人", () => {
    const w = world();
    f = w.f;
    const env = addEntry(f.db, f.callers.mama, TZ, {
      member_id: "妈妈",
      ledger: "personal",
      type: "expense",
      amount_fen: 800,
    });
    ok(env);
    assert.equal((env.data as EntryView).ledger, "personal");
    assert.equal((env.data as EntryView).member_id, f.members.mama.id);
    assertSpeakable(env, /仅你自己可见/, "TT entry/add personal 本人");
  });

  itCase("TT entry/add/ledger=personal+他人", () => {
    const w = world();
    f = w.f;
    const env = addEntry(f.db, f.callers.kid, TZ, {
      member_id: "妈妈",
      ledger: "personal",
      type: "expense",
      amount_fen: 900,
    });
    fail(env, "V4:个人账本只能本人写");
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assertSpeakable(env, /个人账本只能本人记/, "TT entry/add personal 他人");
    assertNoLeak(env, [SECRET.entryNote], "TT entry/add personal 他人");
  });

  itCase("TT entry/update/ledger=shared", () => {
    const w = world();
    f = w.f;
    const env = updateEntry(f.db, f.callers.kid, TZ, { id: w.entry.sharedMama, amount_fen: 1500 });
    ok(env, "V3:共享账本任何成员可改");
    assertSpeakable(env, /已由 小明 更新共享账本流水/, "V3:互信回执必须标注操作者");
    assert.equal((env.data as EntryView).amount_fen, 1500);
  });

  itCase("TT entry/update/ledger=personal+本人", () => {
    const w = world();
    f = w.f;
    const env = updateEntry(f.db, f.callers.mama, TZ, { id: w.entry.personalMama, amount_fen: 7000 });
    ok(env);
    assert.equal((env.data as EntryView).amount_fen, 7000);
    assertSpeakable(env, /已更新你的个人账本流水/, "TT entry/update personal 本人");
  });

  itCase("TT entry/update/ledger=personal+他人", () => {
    const w = world();
    f = w.f;
    const env = updateEntry(f.db, f.callers.kid, TZ, { id: w.entry.personalMama, amount_fen: 1 });
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assertSpeakable(env, /个人账本仅归属人本人可见/, "TT entry/update personal 他人");
    assertNoLeak(env, [SECRET.entryNote, SECRET.entryYuan], "TT entry/update personal 他人");
    assert.equal(
      (f.db.prepare("SELECT amount_fen FROM entry WHERE id = ?").get(w.entry.personalMama) as { amount_fen: number })
        .amount_fen,
      6666,
      "被拒的修改不得生效",
    );
  });

  itCase("TT entry/delete/ledger=shared", () => {
    const w = world();
    f = w.f;
    const env = deleteEntry(f.db, f.callers.kid, TZ, w.entry.sharedBaba);
    ok(env, "V3:共享账本任何成员可删");
    assertSpeakable(env, /已由 小明 删除共享账本流水/, "V3:互信删除回执必须标注操作者");
    assert.deepEqual(listEntriesOf(w, "mama", { ledger: "shared" }).entries.map((e) => e.id), [w.entry.sharedMama]);
  });

  itCase("TT entry/delete/ledger=personal+本人", () => {
    const w = world();
    f = w.f;
    ok(deleteEntry(f.db, f.callers.mama, TZ, w.entry.personalMama));
    assert.deepEqual(listEntriesOf(w, "mama", { ledger: "personal" }).entries, []);
  });

  itCase("TT entry/delete/ledger=personal+他人", () => {
    const w = world();
    f = w.f;
    const env = deleteEntry(f.db, f.callers.kid, TZ, w.entry.personalMama);
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assertSpeakable(env, /个人账本仅归属人本人可见/, "TT entry/delete personal 他人");
    assertNoLeak(env, [SECRET.entryNote, SECRET.entryYuan], "TT entry/delete personal 他人");
    assert.equal(deletedAt(w, "entry", w.entry.personalMama), null, "越权删除不得生效");
  });

  itCase("TT entry/软删行", () => {
    const w = world();
    f = w.f;
    for (const key of ["mama", "baba", "kid"] as const) {
      assert.equal(
        listEntriesOf(w, key).entries.some((e) => e.id === w.entry.deleted),
        false,
        `${key}:list 不得含已软删流水`,
      );
    }
    const r = summarizeOf(w, "mama", { ...JUNE_SUMMARY, group_by: "ledger", ledger: "shared" });
    assert.equal(r.ledgers[0]?.count, 2, "已软删流水不得计入合计");
    assert.equal(r.ledgers[0]?.total_fen, 3000, "已软删流水不得计入金额");
    // 本人可恢复
    const env = restoreDeleted(f.db, f.callers.mama, "entry", w.entry.deleted);
    ok(env);
    assert.equal(listEntriesOf(w, "mama", { ledger: "shared" }).entries.some((e) => e.id === w.entry.deleted), true);
  });
});

// ─────────────────────────── 真值表:通用域 get_today ───────────────────────────

describe("真值表·get_today(无参数的本人今日概览)", () => {
  itCase("TT get_today/读", () => {
    const w = world();
    f = w.f;
    const d = todayOf(w, "mama");
    assert.equal(d.today, w.today);
    // ① 今日到期:恰好本人名下到期的两条(代记者自己、爸爸的都不算)
    assert.deepEqual(d.due_today.map((t) => t.id), [w.todo.mamaDueToday]);
    // ② 逾期:恰好本人的那一条
    assert.deepEqual(d.overdue.map((t) => t.id), [w.todo.mamaOverdue]);
    // ③ 日程两列:全家 + 本人个人;**不含**他人个人日程,也不含自己代记的
    assert.deepEqual(d.events.family.map((e) => e.id), [w.event.familyToday.instanceId]);
    assert.deepEqual(d.events.mine.map((e) => e.id), [w.event.mamaOwnToday.instanceId]);
    assert.equal(d.events.family[0]?.column, "family");
    assert.equal(d.events.mine[0]?.column, "mine");

    // 爸爸那边:集合相等,同样不含妈妈的个人日程
    const bd = todayOf(w, "baba");
    assert.deepEqual(bd.due_today.map((t) => t.id).sort(), [w.todo.babaDueToday, w.todo.mamaForBabaDueToday].sort());
    assert.deepEqual(bd.overdue, []);
    assert.deepEqual(bd.events.family.map((e) => e.id), [w.event.familyToday.instanceId]);
    assert.deepEqual(bd.events.mine.map((e) => e.id), [w.event.babaOwnToday.instanceId]);
    assert.equal(bd.events.mine.some((e) => e.id === w.event.mamaOwnToday.instanceId), false, "他人的个人日程绝不出现");

    // 第三人:只有全家那一列
    const kd = todayOf(w, "kid");
    assert.deepEqual([kd.due_today, kd.overdue, kd.events.mine], [[], [], []]);
    assert.deepEqual(kd.events.family.map((e) => e.id), [w.event.familyToday.instanceId]);
  });
});

// ─────────────────────────── 横向补充:V3 / V5 / V7 / V8 ───────────────────────────

describe("横向补充:V3 / V5 / V7 / V8", () => {
  itCase("V3: 共享项家庭内互信 —— 全家日程与共享账本任何成员可改删,回执标注操作者", () => {
    const w = world();
    f = w.f;
    // 全家日程:创建者之外的成员都能改删
    const u1 = updateEvent(f.db, f.callers.baba, TZ, { id: w.event.family.instanceId, title: "全家会议·爸爸改的" });
    ok(u1);
    assert.match(u1.message, /已由 爸爸 更新全家日程/);
    const u2 = updateEvent(f.db, f.callers.kid, TZ, { id: w.event.family.instanceId, title: "全家会议·小明改的" });
    ok(u2);
    assert.match(u2.message, /已由 小明 更新全家日程/);
    const d1 = deleteEvent(f.db, f.callers.kid, w.event.family.instanceId);
    ok(d1);
    assert.match(d1.message, /已由 小明 删除全家日程/);
    // 共享账本:同样任何人可改删,回执都写"已由 <你>"
    const u3 = updateEntry(f.db, f.callers.baba, TZ, { id: w.entry.sharedMama, amount_fen: 1600 });
    ok(u3);
    assert.match(u3.message, /已由 爸爸 更新共享账本流水/);
    const d2 = deleteEntry(f.db, f.callers.kid, TZ, w.entry.sharedMama);
    ok(d2);
    assert.match(d2.message, /已由 小明 删除共享账本流水/);
  });

  itCase("V5: 显式指向他人个人数据一律明确失败,而非静默空表(todo / event / entry 三域)", () => {
    const w = world();
    f = w.f;
    // ① 待办:工具无此参数形态 → 未知字段 INVALID_PARAMS(明确失败)
    const todos = TOOL_DEFINITIONS.find((t) => t.name === "list_todos")!;
    const t1 = todos.parse({ owner: "妈妈" });
    parseFail(t1, "V5 待办");
    assert.equal(t1.envelope.code, "INVALID_PARAMS");
    // ② 日程:同样没有"看他人个人日程"的参数形态
    const events = TOOL_DEFINITIONS.find((t) => t.name === "list_events")!;
    const t2 = events.parse({ ...JUNE, owner: "妈妈" });
    parseFail(t2, "V5 日程");
    assert.equal(t2.envelope.code, "INVALID_PARAMS");
    // ③ 记账:有真实参数 → DENIED(not_visible),**不是空表**
    const t3 = listEntries(f.db, f.callers.kid, TZ, { ledger: "personal", member_id: "妈妈" });
    fail(t3, "V5 记账");
    assert.equal(t3.code, "DENIED");
    // ④ 汇总同样不是空表
    const t4 = summarizeEntries(f.db, f.callers.kid, TZ, {
      ...JUNE_SUMMARY,
      group_by: "ledger",
      ledger: "personal",
      member_id: "妈妈",
    });
    fail(t4, "V5 汇总");
    assert.equal(t4.code, "DENIED");
    // ⑤ 对照:不带任何指向的读照常返回(证明 ①–④ 是"拒绝",不是"工具坏了")
    assert.equal(allTodoIds(w, "kid").length, 0, "V5 对照:无指向的读照常工作");
    assert.deepEqual(allEventIds(listEventsOf(w, "kid")).length, 1, "V5 对照:无指向的读照常工作");
  });

  itCase("V7: 归属与账本创建后不可变 —— 四个不可变字段传异值 DENIED(immutable),传同值幂等放行", () => {
    const w = world();
    f = w.f;
    const cases: { label: string; run: () => Envelope }[] = [
      { label: "todo.owner_id", run: () => updateTodo(f.db, f.callers.mama, TZ, { id: w.todo.mamaOwn, owner: "爸爸" }) },
      {
        label: "event_series.owner_id",
        run: () => updateEvent(f.db, f.callers.mama, TZ, { id: w.event.family.instanceId, owner: "妈妈" }),
      },
      {
        label: "entry.ledger",
        run: () => updateEntry(f.db, f.callers.mama, TZ, { id: w.entry.personalMama, ledger: "shared" }),
      },
      {
        label: "entry.member_id",
        run: () => updateEntry(f.db, f.callers.mama, TZ, { id: w.entry.sharedMama, member_id: "爸爸" }),
      },
    ];
    for (const c of cases) {
      const env = c.run();
      fail(env, `V7 ${c.label}`);
      assert.equal(env.code, "DENIED", `V7 ${c.label}`);
      assert.equal(env.reason, "immutable", `V7 ${c.label}`);
      assertSpeakable(env, /归属\/账本不可修改,如需变更请删除后重建/, `V7 ${c.label}(固定话术)`);
      assert.match(env.hint ?? "", /删除/, `V7 ${c.label}:hint 必须给出删除后重建的出路`);
      assertNoData(env, `V7 ${c.label}`);
    }
    // 同值幂等放行(成员名 / 别名 / 成员 id 三种写法都算同值)
    for (const owner of ["妈妈", "老妈", f.members.mama.id]) {
      ok(updateTodo(f.db, f.callers.mama, TZ, { id: w.todo.mamaOwn, owner }), `V7 todo 同值放行:${owner}`);
    }
    ok(updateEvent(f.db, f.callers.mama, TZ, { id: w.event.mamaOwn.instanceId, owner: "王丽" }));
    ok(updateEntry(f.db, f.callers.mama, TZ, { id: w.entry.personalMama, ledger: "personal" }));
    ok(updateEntry(f.db, f.callers.mama, TZ, { id: w.entry.sharedMama, member_id: f.members.mama.id }));
    // 幂等回执不得出现 immutable 话术(否则模型会以为这条路不通)
    const again = updateTodo(f.db, f.callers.mama, TZ, { id: w.todo.mamaOwn, owner: "妈妈" });
    ok(again);
    assert.doesNotMatch(again.message, /归属\/账本不可修改/, "V7 同值不得说成拒绝");
  });

  itCase("V8: 代记者对「我创建、归属他人」的条目有查看权与删除权,无修改权与完成权", () => {
    const w = world();
    f = w.f;
    // 查看权:list 里单列一组
    assert.deepEqual(
      listTodosOf(w, "mama").delegated.map((t) => t.id).sort(),
      [w.todo.mamaForBaba, w.todo.mamaForBabaDueToday].sort(),
      "V8 查看权(待办)",
    );
    assert.deepEqual(listEventsOf(w, "mama").delegated.map((e) => e.id), [w.event.mamaForBaba.instanceId], "V8 查看权(日程)");
    // 修改权 / 完成权:❌
    const u = updateTodo(f.db, f.callers.mama, TZ, { id: w.todo.mamaForBaba, title: "偷偷改" });
    fail(u);
    assert.equal(u.reason, "not_writable");
    const c = completeTodo(f.db, f.callers.mama, TZ, w.todo.mamaForBaba);
    fail(c);
    assert.equal(c.reason, "not_writable");
    const ue = updateEvent(f.db, f.callers.mama, TZ, { id: w.event.mamaForBaba.instanceId, title: "偷偷改" });
    fail(ue);
    assert.equal(ue.reason, "not_writable");
    // 删除权 + 恢复权:✅(恢复权与删除权同源)
    const d = deleteTodo(f.db, f.callers.mama, w.todo.mamaForBaba);
    ok(d, "V8 删除权");
    assertSpeakable(d, /已撤回你代记的条目/, "V8 删除回执必须标注撤回");
    const r = restoreDeleted(f.db, f.callers.mama, "todo", w.todo.mamaForBaba);
    ok(r, "V8 恢复权与删除权同源");
    // 归属人本人照常全能
    ok(updateTodo(f.db, f.callers.baba, TZ, { id: w.todo.mamaForBaba, title: "爸爸自己改了" }));
    // 记账域不给 V8 开口子:个人账本无法被代记(V4),所以不存在这条路径
    assert.deepEqual(listEntriesOf(w, "mama", { ledger: "personal" }).entries.map((e) => e.created_by), [f.members.mama.id]);
    assert.deepEqual(listEntriesOf(w, "baba", { ledger: "personal" }).entries.map((e) => e.created_by), [f.members.baba.id]);
  });
});

// ─────────────────────────── V9:没有有效 token 就没有身份 ───────────────────────────

const AUTH_CONFIG = { identityHeader: "x-family-member", requireIdentityHeader: true } as const;

/**
 * 走真实 MCP 通道(内存传输):**全部 20 个工具**在 auth 失败时一律返回 auth 的拒绝信封,
 * 不解析参数、不落库、更不回落任何默认成员(server.ts 里 `!auth.ok` 短路)。
 */
async function sweepAllTools(fx: Fixture, auth: AuthResult): Promise<Map<string, Envelope>> {
  const server = buildMcpServer(fx.db, { timezone: TZ }, auth);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "visibility-sweep", version: "0.0.0" });
  await server.connect(serverT);
  await client.connect(clientT);
  try {
    const out = new Map<string, Envelope>();
    for (const t of TOOL_DEFINITIONS) {
      const res = await client.callTool({ name: t.name, arguments: {} });
      const text = (res.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
      out.set(t.name, JSON.parse(text) as Envelope);
    }
    return out;
  } finally {
    await client.close();
    await server.close();
  }
}

function assertAllDeniedUnknownProfile(envelopes: Map<string, Envelope>, why: string): void {
  assert.equal(envelopes.size, 20, `${why}:必须扫过全部 20 个工具,实际 ${envelopes.size}`);
  for (const [name, env] of envelopes) {
    assert.equal(env.ok, false, `${why}:${name} 必须被拒`);
    if (env.ok) continue;
    assert.equal(env.code, "DENIED", `${why}:${name} 的码`);
    assert.equal(env.reason, "unknown_profile", `${why}:${name} 的 reason`);
    assertNoData(env, `${why}:${name}`);
  }
}

describe("V9:没有有效 token 就没有身份(整表皆 DENIED,不回落默认成员)", () => {
  itCase("V9: 无 token → 全部 20 个工具 DENIED(unknown_profile),不回落任何默认成员", async () => {
    const w = world();
    f = w.f;
    const auth = authenticate(f.db, AUTH_CONFIG, undefined, undefined);
    assert.equal(auth.ok, false, "V9:无 token 必须没有身份");
    assertAllDeniedUnknownProfile(await sweepAllTools(f, auth), "V9 无 token");
    // 不回落默认成员:没有任何写入,也没有一条审计
    assert.equal(
      (f.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n,
      0,
      "V9:不得留下任何写入",
    );
    assert.equal(tableCount(w, "todo"), 9, "V9:夹具数据一个都没变");
  });

  itCase("V9: 未知 token → 全部 20 个工具 DENIED(unknown_profile),不回落任何默认成员", async () => {
    const w = world();
    f = w.f;
    const auth = authenticate(f.db, AUTH_CONFIG, "Bearer fam_not_a_real_token", f.identity.mama);
    assert.equal(auth.ok, false);
    assertAllDeniedUnknownProfile(await sweepAllTools(f, auth), "V9 未知 token");
    assert.equal(
      (f.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n,
      0,
      "V9:不得留下任何写入",
    );
  });

  itCase("V9: 已吊销 token → 全部 20 个工具 DENIED(unknown_profile),不回落任何默认成员", async () => {
    const w = world();
    f = w.f;
    const issued = issueToken(f.db, f.members.mama.id, "to-be-revoked");
    assert.ok(revokeToken(f.db, issued.id), "先吊销这个 token");
    const auth = authenticate(f.db, AUTH_CONFIG, `Bearer ${issued.token}`, f.identity.mama);
    assert.equal(auth.ok, false);
    assertAllDeniedUnknownProfile(await sweepAllTools(f, auth), "V9 已吊销 token");
  });

  itCase("V9: token 持有成员已软删 → 全部 20 个工具 DENIED(unknown_profile),不回落任何默认成员", async () => {
    const w = world();
    f = w.f;
    f.db.prepare("UPDATE member SET deleted_at = ? WHERE id = ?").run("2026-10-04T00:00:00Z", f.members.mama.id);
    const auth = authenticate(f.db, AUTH_CONFIG, `Bearer ${f.tokens.mama}`, f.identity.mama);
    assert.equal(auth.ok, false);
    assertAllDeniedUnknownProfile(await sweepAllTools(f, auth), "V9 成员已软删");
  });
});

// ─────────────────────────── 反例清单 X1–X16 ───────────────────────────

describe("反例清单 X1–X16(逐条:错误码 + reason + 可转述话术 + 泄露面)", () => {
  itCase('X1: B 传 owner 查 A 的待办 → INVALID_PARAMS(未知字段),信封不泄露 A 的待办', () => {
    const w = world();
    f = w.f;
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "list_todos")!;
    const parsed = tool.parse({ owner: "妈妈" });
    parseFail(parsed, "X1");
    const env = parsed.envelope;
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "owner", "必须点名是哪个未知字段");
    assert.equal(env.reason, undefined, "X1 是结构问题,不是语义拒绝:不得带 reason");
    assertSpeakable(env, /list_todos 不接受未知参数:owner/, "X1");
    assert.match(env.hint ?? "", /可用参数/, "X1:hint 必须列出可用参数,让模型别再瞎试");
    assertNoLeak(env, [SECRET.todoTitle, SECRET.todoNote], "X1");
  });

  itCase("X2: B list_entries(ledger=personal, member_id=A) → DENIED(not_visible),不是空表", () => {
    const w = world();
    f = w.f;
    const env = listEntries(f.db, f.callers.kid, TZ, { ledger: "personal", member_id: "妈妈" });
    fail(env, "X2");
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible", "X2 必须带 reason(DENIED 一律带 reason)");
    assertSpeakable(env, /个人账本仅归属人本人可见/, "X2");
    assert.match(env.hint ?? "", /互相不可见/, "X2:hint 也要能直接转述");
    assertNoLeak(env, [SECRET.entryNote, SECRET.entryYuan, "6666", "妈妈"], "X2");
  });

  itCase("X3: B list_events 显式要 A 的个人日程 → INVALID_PARAMS(未知字段),信封不泄露 A 的日程", () => {
    const w = world();
    f = w.f;
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "list_events")!;
    const parsed = tool.parse({ ...JUNE, owner: "妈妈" });
    parseFail(parsed, "X3");
    const env = parsed.envelope;
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "owner");
    assert.equal(env.reason, undefined);
    assertSpeakable(env, /list_events 不接受未知参数:owner/, "X3");
    assertNoLeak(env, [SECRET.eventTitle, SECRET.eventPlace], "X3");
    // 语义侧:X3 真正的病根是"静默空表会让 Agent 报'A 那几天没安排'"。
    const kid = listEventsOf(w, "kid");
    assert.deepEqual(kid.family.map((e) => e.id), [w.event.family.instanceId], "第三人只看得到全家日程");
    assert.deepEqual(kid.mine, []);
    assert.deepEqual(kid.delegated, []);
  });

  itCase("X4: B complete_todo(A 的 id) → DENIED(not_visible),且不留下任何写入", () => {
    const w = world();
    f = w.f;
    const env = completeTodo(f.db, f.callers.kid, TZ, w.todo.mamaOwn);
    fail(env, "X4");
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assertSpeakable(env, /仅归属人本人可见/, "X4");
    assertNoLeak(env, [SECRET.todoTitle, SECRET.todoNote], "X4");
    const row = f.db.prepare("SELECT done FROM todo WHERE id = ?").get(w.todo.mamaOwn) as { done: number };
    assert.equal(row.done, 0, "越权写入比读更严重:完成状态不得被改");
  });

  itCase("X5: B delete_entry(A 个人账本的 id) → DENIED(not_visible),且那笔还在", () => {
    const w = world();
    f = w.f;
    const env = deleteEntry(f.db, f.callers.kid, TZ, w.entry.personalMama);
    fail(env, "X5");
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assertSpeakable(env, /个人账本仅归属人本人可见/, "X5");
    assertNoLeak(env, [SECRET.entryNote, SECRET.entryYuan], "X5");
    assert.equal(deletedAt(w, "entry", w.entry.personalMama), null, "越权删除不得生效");
    assert.deepEqual(
      listEntriesOf(w, "mama", { ledger: "personal" }).entries.map((e) => e.id),
      [w.entry.personalMama],
      "那笔还在归属人自己的账本里",
    );
  });

  itCase('X6: B add_entry(ledger=personal, member_id=A) → DENIED"个人账本只能本人记",且不落库', () => {
    const w = world();
    f = w.f;
    const before = tableCount(w, "entry");
    const env = addEntry(f.db, f.callers.kid, TZ, {
      member_id: "妈妈",
      ledger: "personal",
      type: "expense",
      amount_fen: 1234,
    });
    fail(env, "X6");
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assertSpeakable(env, /个人账本只能本人记/, "X6");
    assert.match(env.hint ?? "", /共享账本/, "X6:hint 必须给出路(记到共享账本)");
    assert.equal(tableCount(w, "entry"), before, "不得落库");
  });

  itCase("X7: A list_entries(ledger=personal, member_id=自己) → ✅ 必须放行(假阴性同样致命)", () => {
    const w = world();
    f = w.f;
    const env = listEntries(f.db, f.callers.mama, TZ, { ledger: "personal", member_id: "妈妈" });
    ok(env, "X7:本人查自己的私账必须放行");
    assert.equal("reason" in env, false, "X7:放行的信封不得带 reason");
    assert.deepEqual((env.data as EntryList).entries.map((e) => e.id), [w.entry.personalMama]);
    // 放行也要给一句可直接转述的话(这是"必须放行"的假阴性用例,话术同样在契约里)
    assertSpeakable(env, /你的个人账本 1 条\(仅本人可见\)/, "X7:本人查私账的回执");
    // 同样口径对 summarize 成立
    const sum = summarizeEntries(f.db, f.callers.mama, TZ, {
      ...JUNE_SUMMARY,
      group_by: "ledger",
      ledger: "personal",
      member_id: "妈妈",
    });
    ok(sum, "X7:汇总侧同样必须放行");
    // 成员 id 的写法同样放行(参数形态不同,语义同一条)
    ok(listEntries(f.db, f.callers.mama, TZ, { ledger: "personal", member_id: f.members.mama.id }), "X7:成员 id 写法");
    // 对照:共享账本里按他人筛是**合法**用法(V2/V4),不得被这条一起误伤
    ok(listEntries(f.db, f.callers.kid, TZ, { ledger: "shared", member_id: "妈妈" }), "X7:共享账本按人筛必须放行");
  });

  itCase("X8: C update_event(全家日程) → ✅ 必须放行,回执标注操作者(V3 互信不是漏洞)", () => {
    const w = world();
    f = w.f;
    const env = updateEvent(f.db, f.callers.kid, TZ, { id: w.event.family.instanceId, title: "全家会议·小明改的" });
    ok(env, "X8:任何成员改全家日程必须放行");
    assert.equal("reason" in env, false, "X8:放行的信封不得带 reason");
    // X8 是"必须放行"的假阴性用例:话术也要能直接转述,并且**标注操作者**(V3)
    assertSpeakable(env, /已由 小明 更新全家日程/, "X8:回执必须标注操作者");
    assert.equal((env.data as EventView).title, "全家会议·小明改的");
    // 同样放行的还有删除与记账侧的共享流水(V3 的横向)
    ok(deleteEvent(f.db, f.callers.kid, w.event.family.instanceId), "X8:任何成员删全家日程");
    ok(updateEntry(f.db, f.callers.kid, TZ, { id: w.entry.sharedBaba, amount_fen: 2100 }), "X8:任何成员改共享流水");
  });

  itCase("X9: 未知 / 已吊销 token 调 get_today() → DENIED(unknown_profile),不回落默认成员,信封零泄露", async () => {
    const w = world();
    f = w.f;
    const revoked = issueToken(f.db, f.members.mama.id, "revoke-me");
    assert.ok(revokeToken(f.db, revoked.id), "先吊销这个 token");
    const headers = [undefined, "Bearer fam_not_a_real_token", `Bearer ${revoked.token}`];
    for (const header of headers) {
      const auth = authenticate(f.db, AUTH_CONFIG, header, f.identity.mama);
      assert.equal(auth.ok, false, `X9:无有效 token 必须没有身份(${String(header)})`);
      const env = (await sweepAllTools(f, auth)).get("get_today");
      assert.ok(env, "X9:必须扫到 get_today");
      if (env.ok) return;
      assert.equal(env.code, "DENIED");
      assert.equal(env.reason, "unknown_profile");
      assertSpeakable(env, /无法确认调用身份/, "X9");
      assertNoLeak(env, [SECRET.todoTitle, SECRET.todoNote, SECRET.eventTitle, SECRET.entryNote, SECRET.entryYuan], "X9");
    }
    // token 持有成员已软删:同样没有身份
    f.db.prepare("UPDATE member SET deleted_at = ? WHERE id = ?").run("2026-10-04T00:00:00Z", f.members.baba.id);
    const soft = authenticate(f.db, AUTH_CONFIG, `Bearer ${f.tokens.baba}`, f.identity.baba);
    const env2 = (await sweepAllTools(f, soft)).get("get_today");
    assert.ok(env2 && !env2.ok && env2.reason === "unknown_profile", "X9:成员已软删同样没有身份");
  });

  itCase('X10: 爸爸 add_todo(owner="妈") 匹配不到 / 重名 → MISSING_PARAMS + 成员名单 / AMBIGUOUS + 候选', () => {
    const w = world();
    f = w.f;
    const before = tableCount(w, "todo");
    // ① 匹配不到 → MISSING_PARAMS + 成员名单
    const notFound = addTodo(f.db, f.callers.baba, TZ, { owner: "查无此人", title: "x" });
    fail(notFound, "X10 匹配不到");
    assert.equal(notFound.code, "MISSING_PARAMS");
    assert.deepEqual(notFound.missing, ["owner"]);
    assertSpeakable(notFound, /家庭成员有:妈妈、爸爸、小明/, "X10");
    assert.match(notFound.hint ?? "", /list_members/, "X10:hint 要指向名单工具");
    // ② 别名撞车 → AMBIGUOUS + 候选(createMember 会挡这种脏数据,这里直接插一行复现)
    f.db
      .prepare("INSERT INTO member (id, name, aliases, created_at) VALUES (?, ?, ?, ?)")
      .run("m-261005-dup1", "姥姥", JSON.stringify(["老妈"]), new Date().toISOString());
    const ambiguous = addTodo(f.db, f.callers.baba, TZ, { owner: "老妈", title: "x" });
    fail(ambiguous, "X10 重名");
    assert.equal(ambiguous.code, "AMBIGUOUS");
    assert.ok((ambiguous.candidates ?? []).length >= 2, "X10:必须附候选");
    assert.ok(
      (ambiguous.candidates ?? []).some((c) => c.name === "妈妈") && (ambiguous.candidates ?? []).some((c) => c.name === "姥姥"),
      "X10:候选必须列出两位撞名的成员",
    );
    assertSpeakable(ambiguous, /匹配到多位成员/, "X10");
    // ③ 两种拒绝都不得落库:归属写错人是最难自查的一类事故
    assert.equal(tableCount(w, "todo"), before, "X10:拒绝时不得留下待办");
  });

  itCase("X11: A update_event(全家日程, owner=A) 把全家日程藏进个人 → DENIED(immutable),归属不可修改", () => {
    const w = world();
    f = w.f;
    const env = updateEvent(f.db, f.callers.mama, TZ, { id: w.event.family.instanceId, owner: "妈妈" });
    fail(env, "X11");
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "immutable");
    assertSpeakable(env, /归属\/账本不可修改,如需变更请删除后重建/, "X11");
    assert.match(env.message, /是全家日程,不能把它改成「妈妈」名下的个人日程/, "X11:话术要点明这是全家日程");
    assert.match(env.hint ?? "", /delete_event[\s\S]*add_event/, "X11:hint 必须给出删除后重建的出路");
    // 全家日程仍然是全家日程(对第三人也仍可见)
    assert.equal(listEventsOf(w, "kid").family.length, 1, "X11 不得生效");
    assert.equal(
      (f.db.prepare("SELECT owner_id FROM event_series WHERE id = ?").get(w.event.family.seriesId) as {
        owner_id: string | null;
      }).owner_id,
      null,
      "X11:系列 owner_id 不得被改",
    );
  });

  itCase("X12: A update_entry(A 的个人流水, ledger=shared) 把私账发布给全家 → DENIED(immutable)", () => {
    const w = world();
    f = w.f;
    const env = updateEntry(f.db, f.callers.mama, TZ, { id: w.entry.personalMama, ledger: "shared" });
    fail(env, "X12");
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "immutable");
    assertSpeakable(env, /归属\/账本不可修改,如需变更请删除后重建/, "X12");
    assert.match(env.message, /不能把它改成共享账本/, "X12:话术要点明改成共享");
    assert.match(env.hint ?? "", /delete_entry[\s\S]*add_entry/, "X12:hint 必须给出删除后重建的出路");
    // 隐私断言:那笔私账仍然不在别人的可见范围里
    assert.equal(
      listEntriesOf(w, "baba", { ledger: "shared" }).entries.some((e) => e.id === w.entry.personalMama),
      false,
      "X12:私账不得被发布给全家",
    );
    assert.equal(
      (f.db.prepare("SELECT ledger FROM entry WHERE id = ?").get(w.entry.personalMama) as { ledger: string }).ledger,
      "personal",
      "X12:账本不得被改",
    );
  });

  itCase("X13: B update_entry(共享流水, ledger=personal, member_id=B) 把公共支出挪进私账 → DENIED(immutable)", () => {
    const w = world();
    f = w.f;
    // 只改 ledger / 同时改 ledger+member_id(+顺带改别的字段)三种写法都要被挡
    const attempts: Parameters<typeof updateEntry>[3][] = [
      { id: w.entry.sharedMama, ledger: "personal" },
      { id: w.entry.sharedMama, ledger: "personal", member_id: "小明" },
      { id: w.entry.sharedMama, ledger: "personal", member_id: "小明", amount_fen: 1234 },
    ];
    for (const args of attempts) {
      const env = updateEntry(f.db, f.callers.kid, TZ, args);
      fail(env, `X13 ${JSON.stringify(args)}`);
      assert.equal(env.code, "DENIED");
      assert.equal(env.reason, "immutable");
      assertSpeakable(env, /归属\/账本不可修改,如需变更请删除后重建/, "X13");
    }
    // 汇总与对账不失真:共享账本里那笔仍在、笔数与金额都未变
    const r = summarizeOf(w, "mama", { ...JUNE_SUMMARY, group_by: "ledger", ledger: "shared" });
    assert.equal(r.ledgers[0]?.count, 2, "X13:共享账本笔数不得变");
    assert.equal(r.ledgers[0]?.total_fen, 3000, "X13:金额不得被改(1000+2000)");
    assert.deepEqual(
      listEntriesOf(w, "kid", { ledger: "personal" }).entries,
      [],
      "X13:小明的个人账本不得凭空多出公共支出",
    );
  });

  itCase("X14: A update_todo(A 的待办, owner=B) 把待办甩给别人 → DENIED(immutable),归属不得漂移", () => {
    const w = world();
    f = w.f;
    const env = updateTodo(f.db, f.callers.mama, TZ, { id: w.todo.mamaOwn, owner: "爸爸" });
    fail(env, "X14");
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "immutable");
    assertSpeakable(env, /归属\/账本不可修改,如需变更请删除后重建/, "X14");
    assert.match(env.message, /记在 妈妈 名下,你不能把它改成「爸爸」名下的/, "X14");
    // 归属没漂移:爸爸的待办列表里不多出这条,妈妈的也还在(本人仍能自查)
    assert.equal(listTodosOf(w, "baba").todos.some((t) => t.id === w.todo.mamaOwn), false, "X14:不得凭空多出别人没写过的待办");
    assert.equal(listTodosOf(w, "baba").delegated.some((t) => t.id === w.todo.mamaOwn), false, "X14:也不得进代记那一栏");
    assert.equal(listTodosOf(w, "mama").todos.some((t) => t.id === w.todo.mamaOwn), true, "X14:本人仍能自查");
  });

  itCase('X15: 妈妈 list_todos(as_member="爸爸") 被诱导传身份参数 → INVALID_PARAMS(说话人不是参数)', () => {
    const w = world();
    f = w.f;
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "list_todos")!;
    for (const identity of ["as_member", "bind_key", "speaker", "caller", "whoami", "asMember", "bindKey"]) {
      const parsed = tool.parse({ [identity]: "爸爸" });
      parseFail(parsed, `X15 ${identity}`);
      assert.equal(parsed.envelope.code, "INVALID_PARAMS", `X15 ${identity}`);
      assert.equal(parsed.envelope.field, identity, `X15 ${identity}:必须点名是哪个未知字段`);
      assert.equal(parsed.envelope.reason, undefined, "X15 是结构问题,不是语义拒绝");
      assertSpeakable(parsed.envelope, /说话人由连接确定/, `X15 ${identity}`);
      assertNoLeak(parsed.envelope, [SECRET.todoTitle, SECRET.todoNote], `X15 ${identity}`);
    }
    // 同一个形态在 get_today(无参数工具)上也必须被挡
    const today = TOOL_DEFINITIONS.find((t) => t.name === "get_today")!;
    const p = today.parse({ as_member: "爸爸" });
    parseFail(p, "X15 get_today");
    assert.equal(p.envelope.code, "INVALID_PARAMS");
  });

  itCase("X16: A 的待办由 B 代记 —— B 可见、可删、不可改;C 一律不可见不可删不可改", () => {
    const w = world();
    f = w.f;
    const id = w.todo.mamaForBaba;
    const row = f.db.prepare("SELECT owner_id, created_by FROM todo WHERE id = ?").get(id) as {
      owner_id: string;
      created_by: string;
    };
    assert.equal(row.owner_id, f.members.baba.id, "夹具前提:owner=爸爸");
    assert.equal(row.created_by, f.members.mama.id, "夹具前提:created_by=妈妈(代记者 B)");

    // B(代记者)可见
    assert.ok(listTodosOf(w, "mama").delegated.some((t) => t.id === id), "X16:B 必须看得见");
    // B 可删
    const del = deleteTodo(f.db, f.callers.mama, id);
    ok(del, "X16:B 必须可删");
    assertSpeakable(del, /已撤回你代记的条目/, "X16:B 的删除回执必须标注撤回");
    // B 可恢复(恢复权与删除权同源)
    ok(restoreDeleted(f.db, f.callers.mama, "todo", id), "X16:B 必须可恢复");
    // B 不可改
    const upd = updateTodo(f.db, f.callers.mama, TZ, { id, title: "偷偷改" });
    fail(upd, "X16:B 不得有修改权");
    assert.equal(upd.reason, "not_writable");
    // C 一律 ❌
    assert.equal(listTodosOf(w, "kid").todos.some((t) => t.id === id), false, "X16:C 不得看见");
    assert.equal(listTodosOf(w, "kid").delegated.some((t) => t.id === id), false, "X16:C 不得看见");
    const cDel = deleteTodo(f.db, f.callers.kid, id);
    fail(cDel, "X16:C 不得可删");
    assert.equal(cDel.reason, "not_visible");
    const cUpd = updateTodo(f.db, f.callers.kid, TZ, { id, title: "偷偷改" });
    fail(cUpd, "X16:C 不得可改");
    assert.equal(cUpd.reason, "not_visible");
    const cReo = reopenTodo(f.db, f.callers.kid, id);
    fail(cReo, "X16:C 不得可重开");
    assert.equal(cReo.reason, "not_visible");
    assert.equal(deletedAt(w, "todo", id), null, "X16:C 的越权删除不得生效");
    assertNoLeak(cUpd, ["妈妈代记给爸爸·私密"], "X16:C");
  });
});

// ─────────────────────────── COVERAGE 矩阵 + meta 用例 ───────────────────────────

/**
 * 可追溯矩阵:V1–V9 与 X1–X16 每一项 → 至少一个用例名。
 * meta 用例校验:键齐全、数组非空、引用的名字确实是本文件里的用例、
 * 且每个 `X<编号>:` 用例都已登记进矩阵(改名 / 漏登记直接变红)。
 */
const COVERAGE: Record<string, string[]> = {
  V1: [
    "TT todo/list/owner=本人",
    "TT event/list/owner=本人",
    "TT entry/list/ledger=personal+本人",
    "TT entry/summarize/ledger=personal+本人",
    "TT get_today/读",
  ],
  V2: [
    "TT event/list/owner=空(全家)",
    "TT event/update/owner=空(全家)",
    "TT entry/list/ledger=shared",
    "TT entry/summarize/ledger=shared",
    "TT todo/add/owner=他人",
  ],
  V3: [
    "TT todo/update/owner=本人",
    "TT todo/complete/owner=本人",
    "TT todo/reopen/owner=本人",
    "TT todo/delete/owner=本人",
    "TT todo/restore/owner=本人",
    "TT event/update/owner=空(全家)",
    "TT event/delete/owner=空(全家)",
    "TT entry/update/ledger=shared",
    "TT entry/delete/ledger=shared",
    "V3: 共享项家庭内互信 —— 全家日程与共享账本任何成员可改删,回执标注操作者",
  ],
  V4: [
    "TT todo/add/owner=他人",
    "TT event/add/owner=他人",
    "TT entry/add/ledger=shared",
  ],
  V5: [
    "V5: 显式指向他人个人数据一律明确失败,而非静默空表(todo / event / entry 三域)",
    "X2: B list_entries(ledger=personal, member_id=A) → DENIED(not_visible),不是空表",
    "X3: B list_events 显式要 A 的个人日程 → INVALID_PARAMS(未知字段),信封不泄露 A 的日程",
  ],
  V6: [
    "TT todo/get-by-id/owner=本人",
    "TT todo/get-by-id/owner=他人",
    "X4: B complete_todo(A 的 id) → DENIED(not_visible),且不留下任何写入",
  ],
  V7: [
    "V7: 归属与账本创建后不可变 —— 四个不可变字段传异值 DENIED(immutable),传同值幂等放行",
    "X11: A update_event(全家日程, owner=A) 把全家日程藏进个人 → DENIED(immutable),归属不可修改",
    "X12: A update_entry(A 的个人流水, ledger=shared) 把私账发布给全家 → DENIED(immutable)",
    "X13: B update_entry(共享流水, ledger=personal, member_id=B) 把公共支出挪进私账 → DENIED(immutable)",
    "X14: A update_todo(A 的待办, owner=B) 把待办甩给别人 → DENIED(immutable),归属不得漂移",
  ],
  V8: [
    "V8: 代记者对「我创建、归属他人」的条目有查看权与删除权,无修改权与完成权",
    "X16: A 的待办由 B 代记 —— B 可见、可删、不可改;C 一律不可见不可删不可改",
  ],
  V9: [
    "V9: 无 token → 全部 20 个工具 DENIED(unknown_profile),不回落任何默认成员",
    "V9: 未知 token → 全部 20 个工具 DENIED(unknown_profile),不回落任何默认成员",
    "V9: 已吊销 token → 全部 20 个工具 DENIED(unknown_profile),不回落任何默认成员",
    "V9: token 持有成员已软删 → 全部 20 个工具 DENIED(unknown_profile),不回落任何默认成员",
    "X9: 未知 / 已吊销 token 调 get_today() → DENIED(unknown_profile),不回落默认成员,信封零泄露",
  ],
  X1: ["X1: B 传 owner 查 A 的待办 → INVALID_PARAMS(未知字段),信封不泄露 A 的待办"],
  X2: ["X2: B list_entries(ledger=personal, member_id=A) → DENIED(not_visible),不是空表"],
  X3: ["X3: B list_events 显式要 A 的个人日程 → INVALID_PARAMS(未知字段),信封不泄露 A 的日程"],
  X4: ["X4: B complete_todo(A 的 id) → DENIED(not_visible),且不留下任何写入"],
  X5: ["X5: B delete_entry(A 个人账本的 id) → DENIED(not_visible),且那笔还在"],
  X6: ['X6: B add_entry(ledger=personal, member_id=A) → DENIED"个人账本只能本人记",且不落库'],
  X7: ["X7: A list_entries(ledger=personal, member_id=自己) → ✅ 必须放行(假阴性同样致命)"],
  X8: ["X8: C update_event(全家日程) → ✅ 必须放行,回执标注操作者(V3 互信不是漏洞)"],
  X9: ["X9: 未知 / 已吊销 token 调 get_today() → DENIED(unknown_profile),不回落默认成员,信封零泄露"],
  X10: ['X10: 爸爸 add_todo(owner="妈") 匹配不到 / 重名 → MISSING_PARAMS + 成员名单 / AMBIGUOUS + 候选'],
  X11: ["X11: A update_event(全家日程, owner=A) 把全家日程藏进个人 → DENIED(immutable),归属不可修改"],
  X12: ["X12: A update_entry(A 的个人流水, ledger=shared) 把私账发布给全家 → DENIED(immutable)"],
  X13: ["X13: B update_entry(共享流水, ledger=personal, member_id=B) 把公共支出挪进私账 → DENIED(immutable)"],
  X14: ["X14: A update_todo(A 的待办, owner=B) 把待办甩给别人 → DENIED(immutable),归属不得漂移"],
  X15: ['X15: 妈妈 list_todos(as_member="爸爸") 被诱导传身份参数 → INVALID_PARAMS(说话人不是参数)'],
  X16: ["X16: A 的待办由 B 代记 —— B 可见、可删、不可改;C 一律不可见不可删不可改"],
};

const REQUIRED_KEYS = [
  "V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9",
  "X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9", "X10", "X11", "X12", "X13", "X14", "X15", "X16",
];

it("COVERAGE meta:V1–V9 与 X1–X16 每一项都存在,且至少映射到一个真实用例", () => {
  for (const key of REQUIRED_KEYS) {
    assert.ok(key in COVERAGE, `COVERAGE 缺键:${key}`);
    const names = COVERAGE[key];
    assert.ok(Array.isArray(names) && names.length > 0, `COVERAGE[${key}] 是空数组:该项没有任何用例`);
    for (const name of names) {
      assert.ok(
        CASE_NAMES.includes(name),
        `COVERAGE[${key}] 引用了不存在的用例名「${name}」:用例名与矩阵必须逐字一致`,
      );
    }
  }
  // 反向:每个 `X<编号>:` 用例都必须登记进矩阵(漏登记即失败)。
  for (const name of CASE_NAMES) {
    const m = /^(X\d+):/.exec(name);
    if (!m) continue;
    assert.ok((COVERAGE[m[1]!] ?? []).includes(name), `用例「${name}」没有登记进 COVERAGE.${m[1]}`);
  }
  // 矩阵本身不得有 COVERAGE 之外的键(避免打错键名后"看起来覆盖了")。
  assert.deepEqual(Object.keys(COVERAGE).sort(), [...REQUIRED_KEYS].sort(), "COVERAGE 的键必须恰好是 V1–V9 与 X1–X16");
});