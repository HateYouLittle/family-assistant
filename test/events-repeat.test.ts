import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { listAudit } from "../src/audit/audit.js";
import { todayInTz } from "../src/db/id.js";
import type { Envelope, FailEnvelope, OkEnvelope } from "../src/domain/envelope.js";
import {
  MATERIALIZE_DAYS,
  addEvent,
  deleteEvent,
  listEvents,
  updateEvent,
  type AddEventInput,
  type EventView,
} from "../src/domain/events.js";
import { restoreDeleted } from "../src/domain/restore.js";
import { TOOL_DEFINITIONS } from "../src/mcp/tools.js";
import { newFixture, TZ, type Fixture, type FixtureKey } from "./helpers.js";

/**
 * 重复日程(S2b:写时物化 92 天 + 惰性续期与失败降级 + 改删只作用整系列 N4)。
 * 设计依据:设计方案 §4「event(日程)= 系列 + 实例」的三条 —— 写时物化、读取越过边界时
 * 惰性续期、**续期是读路径上的写、失败必须降级而不是让读报错**;以及 N4 不做单次实例修改。
 *
 * 四条纪律(与 S1/S2 一致):
 * 1. **能算出来的都算出来**:实例条数、每一次的日期、"已展开到哪天"都用**可复算的算式**
 *    断言(窗口 = [今天, 今天+91],weekly ⇒ floor(91/7)+1 = 14 次),不写 "> 0" 这类断言。
 * 2. **只读实例的地方直读裸 SQL**:续期有没有写入、过去那次有没有被改写、续期失败时
 *    有没有留下"补了一半"的系列,都必须靠 `event_instance` 的原始行来证明。
 * 3. **失败必须是真失败**:降级用例用 `PRAGMA query_only = ON` 让写真的失败,
 *    不用 mock / stub 假装失败;读完立刻把失败条件撤掉(用 try/finally 双保险)。
 * 4. **权限判定排在任何行内信息之前**:重复日程的重建路径也走同一道闸门,
 *    越权者的拒绝信封里同样不许出现标题与时间。
 */

let f: Fixture;
afterEach(() => f?.db.close());

function ok(env: { ok: boolean; message?: string }): asserts env is OkEnvelope {
  assert.equal(env.ok, true, `期望成功信封,实际:${JSON.stringify(env)}`);
}
function fail(env: { ok: boolean; message?: string }): asserts env is FailEnvelope {
  assert.equal(env.ok, false, `期望失败信封,实际:${JSON.stringify(env)}`);
}

/** list_events 的信封 data 形状。 */
interface ListData {
  family: EventView[];
  mine: EventView[];
  delegated: EventView[];
}

interface RawInstanceRow {
  id: string;
  series_id: string;
  start: string;
  end: string | null;
  all_day: number;
  title: string;
  location: string | null;
  deleted_at: string | null;
}

const TODAY = todayInTz(TZ);

/** 日历日加 n 天。测试里独立实现一份(用 toISOString),不与被测代码共用 helper。 */
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** 两个日历日之间相差的天数(测试内独立实现)。 */
function daysBetweenDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** 物化窗口的天数:含今天、含两端,共 MATERIALIZE_DAYS 天(2026-10-05 → 2027-01-04)。 */
const WINDOW_LAST_DAY = addDays(TODAY, MATERIALIZE_DAYS - 1);

/** 某系列下的全部实例(裸 SQL,按 start 排序)。 */
function startsOf(seriesId: string): string[] {
  const rows = f.db
    .prepare("SELECT start FROM event_instance WHERE series_id = ? ORDER BY start, id")
    .all(seriesId) as { start: string }[];
  return rows.map((r) => r.start);
}

/** 某系列下的全部实例行(裸 SQL)。 */
function instancesOf(seriesId: string): RawInstanceRow[] {
  return f.db
    .prepare(
      "SELECT id, series_id, start, end, all_day, title, location, deleted_at FROM event_instance WHERE series_id = ? ORDER BY start, id",
    )
    .all(seriesId) as RawInstanceRow[];
}

/** 逐字段快照:断言"一个字节都没变"时用它(而不是只比 start)。 */
function snapshotOf(seriesId: string): RawInstanceRow[] {
  return instancesOf(seriesId).map((r) => ({ ...r }));
}

/**
 * 往库里**直接注入**一条实例(裸 SQL),用来造"历史上已经发生过"的形状。
 *
 * 为什么必须注入:创建路径的物化窗口是 [今天, 今天+91](materializeWindow 的裁决 ——
 * 不回填已经过去的那几次),所以"系列是在过去创建的、那几次已经发生过"这个状态在正常
 * 调用序列里造不出来。家人三个月前真的游过泳 —— 这条事实只能靠注入历史行来表达。
 */
function injectRawInstance(
  seriesId: string,
  id: string,
  time: { start: string; end?: string | null; allDay?: boolean; title?: string },
): RawInstanceRow {
  f.db
    .prepare(
      `INSERT INTO event_instance (id, series_id, owner_id, title, created_by, created_at, start, end, all_day)
       VALUES (?, ?, NULL, ?, ?, '2026-10-05T00:00:00Z', ?, ?, ?)`,
    )
    .run(id, seriesId, time.title ?? "游泳", f.members.mama.id, time.start, time.end ?? null, time.allDay ? 1 : 0);
  return f.db
    .prepare("SELECT id, series_id, start, end, all_day, title, location, deleted_at FROM event_instance WHERE id = ?")
    .get(id) as RawInstanceRow;
}

function countInstances(seriesId: string): number {
  return (f.db.prepare("SELECT COUNT(*) AS n FROM event_instance WHERE series_id = ?").get(seriesId) as { n: number }).n;
}

function seriesRow(seriesId: string): { repeat: string; repeat_interval: number; repeat_until: string | null } {
  const row = f.db
    .prepare("SELECT repeat, repeat_interval, repeat_until FROM event_series WHERE id = ?")
    .get(seriesId) as { repeat: string; repeat_interval: number; repeat_until: string | null } | undefined;
  assert.ok(row, `库里没有这个系列:${seriesId}`);
  return row;
}

/** 建一条日程(走 domain),返回系列 id 与首次实例 id。 */
function newEvent(key: FixtureKey, input: AddEventInput): { seriesId: string; instanceId: string } {
  const env = addEvent(f.db, f.callers[key], TZ, input);
  ok(env);
  const v = env.data as EventView;
  return { seriesId: v.series_id, instanceId: v.id };
}

/** 建一条重复日程并顺手断言成功,返回系列 id。 */
function newRepeating(key: FixtureKey, input: AddEventInput): string {
  const env = addEvent(f.db, f.callers[key], TZ, input);
  ok(env);
  return (env.data as EventView).series_id;
}

/** 走工具层(参数校验 + 审计留痕)。 */
function callTool(key: FixtureKey, name: string, args: unknown): Envelope {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
  assert.ok(tool, `未知工具 ${name}`);
  const parsed = tool!.parse(args);
  return parsed.ok ? tool!.run(f.db, f.callers[key], TZ, parsed.args) : parsed.envelope;
}

/** 读一个时间窗,返回 data 与 message。 */
function listWindow(
  key: FixtureKey,
  start: string,
  end: string,
  scope?: "family" | "mine",
): { data: ListData; message: string } {
  const env = listEvents(f.db, f.callers[key], TZ, { start, end, ...(scope ? { scope } : {}) });
  ok(env);
  return { data: env.data as ListData, message: env.message };
}

// ───────────────────────── 写时物化(设计 §4) ─────────────────────────

describe("写时物化:创建即把未来 92 天展开成实例", () => {
  it("MATERIALIZE_DAYS 是常量 92,窗口 = [今天, 今天+91](含今天、含两端)", () => {
    // 把这个数字钉死:它是回执里"已展开 N 次"与下面所有算式的分母,不该被悄悄改动。
    assert.equal(MATERIALIZE_DAYS, 92);
    assert.equal(addDays(TODAY, MATERIALIZE_DAYS - 1), WINDOW_LAST_DAY);
  });

  it("weekly + 今天起 → 实例数 = floor(91/7)+1 = 14 次,且每一次都落在同一条 7 天网格上", () => {
    f = newFixture();
    const env = addEvent(f.db, f.callers.mama, TZ, {
      title: "游泳",
      start: `${TODAY} 19:00`,
      end: `${TODAY} 20:00`,
      repeat: "weekly",
      location: "体育馆",
    });
    ok(env);
    const v = env.data as EventView;

    // 算式:窗口 [today, today+91] 里每隔 7 天一次 ⇒ k=0..floor(91/7)=13 ⇒ 14 次
    const expectedCount = Math.floor((MATERIALIZE_DAYS - 1) / 7) + 1;
    assert.equal(expectedCount, 14, "算式本身:floor(91/7)+1");
    const starts = startsOf(v.series_id);
    assert.equal(starts.length, expectedCount);
    // 逐次核对网格(不只是数数):第 k 次 = today + 7k 天,时刻恒为 19:00
    starts.forEach((start, k) => {
      assert.equal(start, `${addDays(TODAY, k * 7)} 19:00`, `第 ${k + 1} 次应是 today+${k * 7} 天`);
    });
    // 首次 = start 给的那一次;末次 = 窗口最后一天
    assert.equal(starts[0], `${TODAY} 19:00`);
    assert.equal(starts[expectedCount - 1], `${WINDOW_LAST_DAY} 19:00`);
    // 结束时间随日期平移,时刻不变
    assert.deepEqual(
      instancesOf(v.series_id).map((r) => r.end),
      starts.map((s) => `${s.slice(0, 10)} 20:00`),
    );

    assert.deepEqual(seriesRow(v.series_id), { repeat: "weekly", repeat_interval: 1, repeat_until: null });
    assert.match(env.message, new RegExp(`^已添加每周重复的全家日程 \\[${v.id}\\]:游泳\\(.*已展开 14 次至 ${WINDOW_LAST_DAY}\\)。`));
    assert.match(env.message, /全家成员都能看到;修改\/删除会作用于整个系列。$/, "N4 的可见性必须写在回执里");
  });

  it("daily + repeat_until 落在窗口内 → 以 repeat_until 为界,且**含当天**(边界含端点)", () => {
    f = newFixture();
    const until = addDays(TODAY, 10);
    const seriesId = newRepeating("mama", {
      title: "吃药",
      start: `${TODAY} 08:00`,
      repeat: "daily",
      repeat_until: until,
    });

    // 算式:daily 从今天起、到 today+10(含)为止 ⇒ 11 次
    const starts = startsOf(seriesId);
    assert.equal(starts.length, 11, "daily + until=today+10 ⇒ 11 次");
    assert.deepEqual(
      starts,
      Array.from({ length: 11 }, (_, k) => `${addDays(TODAY, k)} 08:00`),
    );
    assert.equal(starts[10], `${until} 08:00`, "repeat_until 含当天:截止日那天仍然生成一次");
    assert.equal(seriesRow(seriesId).repeat_until, until);
  });

  it("repeat_until 恰好落在窗口最后一天 → 正好 92 次(窗口边界也是含端点的)", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", {
      title: "吃药",
      start: `${TODAY} 08:00`,
      repeat: "daily",
      repeat_until: WINDOW_LAST_DAY,
    });
    const starts = startsOf(seriesId);
    assert.equal(starts.length, MATERIALIZE_DAYS, "until = 窗口最后一天 ⇒ 恰好 92 次");
    assert.equal(starts[MATERIALIZE_DAYS - 1], `${WINDOW_LAST_DAY} 08:00`);
  });

  it("repeat_interval=2 + weekly = 每两周:floor(91/14)+1 = 7 次", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", { title: "游泳", start: `${TODAY} 19:00`, repeat: "weekly", repeat_interval: 2 });
    const starts = startsOf(seriesId);
    assert.equal(starts.length, Math.floor((MATERIALIZE_DAYS - 1) / 14) + 1);
    assert.deepEqual(
      starts,
      Array.from({ length: 7 }, (_, k) => `${addDays(TODAY, k * 14)} 19:00`),
    );
    assert.equal(seriesRow(seriesId).repeat_interval, 2);
  });

  it("monthly 的裁决:目标月没有该日时钳到当月最后一天(1 月 31 日 → 2 月 28 日,且 3 月回到 31 日)", () => {
    f = newFixture();
    // 用一个确定的将来锚点(2031 不是闰年,2 月 28 天),算式可复算:
    // 窗口 = [2031-01-31, +91 天 = 2031-05-01] ⇒ 01-31 / 02-28 / 03-31 / 04-30 共 4 次
    const anchor = "2031-01-31";
    const seriesId = newRepeating("mama", { title: "交房租", start: `${anchor} 10:00`, repeat: "monthly" });
    const starts = startsOf(seriesId);
    assert.deepEqual(starts, [
      "2031-01-31 10:00",
      "2031-02-28 10:00", // 钳到当月最后一天,而不是跳过 2 月
      "2031-03-31 10:00", // 按索引钳位:3 月回到 31 号,不会一路漂到 28 号
      "2031-04-30 10:00",
    ]);
  });

  it("all_day 的重复日程:每一次都是纯日期,跨天的 end 保持天数差", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", {
      title: "回老家",
      start: TODAY,
      end: addDays(TODAY, 2),
      all_day: true,
      repeat: "weekly",
    });
    const rows = instancesOf(seriesId);
    assert.equal(rows.length, 14);
    for (const r of rows) {
      assert.equal(r.all_day, 1);
      assert.match(r.start, /^\d{4}-\d{2}-\d{2}$/, "全天日程的 start 是纯日期");
      assert.equal(r.end, addDays(r.start, 2), "跨天 all_day:每一次的 end = start + 2 天");
    }
  });

  it("锚点在过去(补记一条从一个月前开始的重复日程)→ 只展开今天及以后,不回填已经过去的那些次", () => {
    f = newFixture();
    const past = addDays(TODAY, -30);
    const seriesId = newRepeating("mama", { title: "游泳", start: `${past} 19:00`, repeat: "weekly" });
    const starts = startsOf(seriesId);
    assert.ok(starts.length > 0);
    for (const s of starts) {
      assert.ok(s >= TODAY, `不该回填过去的日程:${s}`);
    }
    // 算式:网格每 7 天一次,第一次 = 网格上第一个 >= 今天的日期 ⇒ k = ceil(30/7) = 5 ⇒ past+35 天(距今 +5 天)
    const k = Math.ceil(daysBetweenDays(past, TODAY) / 7);
    assert.equal(k, 5);
    assert.equal(starts[0], `${addDays(past, k * 7)} 19:00`, "第一次 = 网格上第一个 >= 今天的日期");
    const firstOffset = k * 7 - daysBetweenDays(past, TODAY);
    assert.equal(
      countInstances(seriesId),
      Math.floor((MATERIALIZE_DAYS - 1 - firstOffset) / 7) + 1,
      "窗口 [今天, 今天+91] 内共 13 次(从今天 +5 天起,每 7 天一次)",
    );
  });
});

// ───────────────────────── 重复规则的拒绝条件 ─────────────────────────

describe("重复规则的拒绝条件:不静默忽略,也不落库", () => {
  it("repeat_until 早于 start(一次都不会发生)→ INVALID_PARAMS + field,系列不得落库", () => {
    f = newFixture();
    const env = addEvent(f.db, f.callers.mama, TZ, {
      title: "游泳",
      start: `${TODAY} 19:00`,
      repeat: "weekly",
      repeat_until: addDays(TODAY, -1),
    });
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "repeat_until");
    assert.match(env.message, /早于 start 的日期/);
    const n = f.db.prepare("SELECT COUNT(*) AS n FROM event_series").get() as { n: number };
    assert.equal(n.n, 0, "被拒的调用不得留下系列");
  });

  it('repeat="none"(缺省)时传 repeat_interval / repeat_until → INVALID_PARAMS,话术点名这两个参数', () => {
    f = newFixture();
    const onlyInterval = addEvent(f.db, f.callers.mama, TZ, { title: "家长会", start: `${TODAY} 09:00`, repeat_interval: 2 });
    fail(onlyInterval);
    assert.equal(onlyInterval.code, "INVALID_PARAMS");
    assert.equal(onlyInterval.field, "repeat_interval");
    assert.match(onlyInterval.message, /非重复日程不接受 repeat_interval \/ repeat_until 这两个参数/);
    assert.match(onlyInterval.hint ?? "", /要重复请同时传 repeat="daily" \/ "weekly" \/ "monthly"/);

    const onlyUntil = addEvent(f.db, f.callers.mama, TZ, {
      title: "家长会",
      start: `${TODAY} 09:00`,
      repeat: "none",
      repeat_until: addDays(TODAY, 30),
    });
    fail(onlyUntil);
    assert.equal(onlyUntil.code, "INVALID_PARAMS");
    assert.equal(onlyUntil.field, "repeat_until");

    // update_event 上同样成立:单次日程传这两个参数也被拒
    const single = newEvent("mama", { title: "家长会", start: `${TODAY} 09:00` });
    const upd = updateEvent(f.db, f.callers.mama, TZ, { id: single.instanceId, repeat_interval: 2 });
    fail(upd);
    assert.equal(upd.code, "INVALID_PARAMS");
    assert.equal(upd.field, "repeat_interval");
    assert.equal(seriesRow(single.seriesId).repeat_interval, 1, "被拒的调用不得落库");
  });

  it("repeat_interval 非法(0 / 非整数)→ INVALID_PARAMS,指明字段", () => {
    f = newFixture();
    const zero = callTool("mama", "add_event", { title: "游泳", start: `${TODAY} 19:00`, repeat: "weekly", repeat_interval: 0 });
    fail(zero);
    assert.equal(zero.code, "INVALID_PARAMS");
    assert.equal(zero.field, "repeat_interval");

    // 1.5 走 domain 直调(zod 那层已挡掉,domain 层仍要自己守住:纵深防御)
    const frac = addEvent(f.db, f.callers.mama, TZ, {
      title: "游泳",
      start: `${TODAY} 19:00`,
      repeat: "weekly",
      repeat_interval: 1.5,
    });
    fail(frac);
    assert.equal(frac.code, "INVALID_PARAMS");
    assert.equal(frac.field, "repeat_interval");
    assert.match(frac.message, /必须是 1-366 的整数/);
  });

  it("间隔大到窗口里一次都不会发生 / 截止日早于今天 → INVALID_PARAMS(不制造空壳系列)", () => {
    f = newFixture();
    // 锚点在 30 天前 + 每 200 天一次 ⇒ 今天起 92 天的窗口里一次都没有
    const tooSparse = addEvent(f.db, f.callers.mama, TZ, {
      title: "体检",
      start: `${addDays(TODAY, -30)} 09:00`,
      repeat: "daily",
      repeat_interval: 200,
    });
    fail(tooSparse);
    assert.equal(tooSparse.code, "INVALID_PARAMS");
    assert.equal(tooSparse.field, "repeat_interval");
    assert.match(tooSparse.message, /之前不会产生任何日程/);

    // 截止日早于今天 ⇒ 一次都不会发生
    const pastUntil = addEvent(f.db, f.callers.mama, TZ, {
      title: "游泳",
      start: `${addDays(TODAY, -30)} 19:00`,
      repeat: "daily",
      repeat_until: addDays(TODAY, -1),
    });
    fail(pastUntil);
    assert.equal(pastUntil.code, "INVALID_PARAMS");
    assert.equal(pastUntil.field, "repeat_until");
    assert.match(pastUntil.message, /按这个重复规则不会产生任何日程/);

    const n = f.db.prepare("SELECT COUNT(*) AS n FROM event_series").get() as { n: number };
    assert.equal(n.n, 0, "被拒的调用不得留下系列");
  });

  it("工具层:repeat 取值不认识 / repeat_until 格式不对 → INVALID_PARAMS", () => {
    f = newFixture();
    const badEnum = callTool("mama", "add_event", { title: "x", start: `${TODAY} 09:00`, repeat: "yearly" });
    fail(badEnum);
    assert.equal(badEnum.code, "INVALID_PARAMS");
    assert.equal(badEnum.field, "repeat");
    assert.match(badEnum.message, /repeat 只支持/);

    const badUntil = callTool("mama", "add_event", { title: "x", start: `${TODAY} 09:00`, repeat: "weekly", repeat_until: "年底" });
    fail(badUntil);
    assert.equal(badUntil.code, "INVALID_PARAMS");
    assert.equal(badUntil.field, "repeat_until");
  });
});

// ───────────────────────── 惰性续期 + 幂等 ─────────────────────────

describe("惰性续期:窗口越过已展开边界就补齐,且反复读不重样", () => {
  it("同一窗口连续读三次 → 库里实例总数一次都不变(幂等)", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", { title: "游泳", start: `${TODAY} 19:00`, repeat: "weekly" });
    const before = countInstances(seriesId);
    assert.equal(before, 14);

    for (let i = 0; i < 3; i++) {
      const { data } = listWindow("mama", TODAY, WINDOW_LAST_DAY);
      assert.equal(data.family.length, 14, `第 ${i + 1} 次读`);
      assert.equal(countInstances(seriesId), before, `第 ${i + 1} 次读后总数不该变`);
    }
  });

  it("先读窗口 A(在已展开范围内)→ 再读更远的窗口 B:B 被补齐,A 里的那几次不被重复生成", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", { title: "游泳", start: `${TODAY} 19:00`, repeat: "weekly" });
    // 窗口 A = 前 4 次(在 92 天的已展开范围内)
    const aEnd = addDays(TODAY, 21);
    const inA = listWindow("mama", TODAY, aEnd).data.family.map((v) => v.start);
    assert.deepEqual(
      inA,
      [0, 7, 14, 21].map((k) => `${addDays(TODAY, k)} 19:00`),
      "窗口 A 应含前 4 次",
    );
    const afterA = startsOf(seriesId);
    assert.equal(afterA.length, 14, "读 A 不触发续期(A 在已展开范围内)");

    // 窗口 B = 越过边界(today+91)一直读到 today+147 ⇒ 应补齐 today+98 … today+147
    // (窗口按**重叠**判定,所以 A 的最后那次 today+21 在 B 里也会出现 —— 边界含端点)
    const bEnd = addDays(TODAY, 147);
    const inB = listWindow("mama", aEnd, bEnd).data.family.map((v) => v.start);
    const expectedB = [21, 28, 35, 42, 49, 56, 63, 70, 77, 84, 91, 98, 105, 112, 119, 126, 133, 140, 147].map(
      (k) => `${addDays(TODAY, k)} 19:00`,
    );
    assert.deepEqual(inB, expectedB, "窗口 B 的每一次都应补齐(从 today+21 到 today+147)");

    // 补齐后总数 = A ∪ B,无重复
    const afterB = startsOf(seriesId);
    assert.deepEqual(afterB, Array.from(new Set([...afterA, ...expectedB])), "A 的那几次仍在,且没有多出重复行");
    assert.equal(new Set(afterB).size, afterB.length, "同一天的实例不许出现两次");
    assert.equal(afterB.length, 22, "14(已展开) + 8(新补的 98…147)");

    // 再读一次 B:总数仍不变
    listWindow("mama", aEnd, bEnd);
    assert.equal(countInstances(seriesId), afterB.length, "重复读同一个远窗不得再长出实例");
  });

  it("续期只补未来:窗口落在过去 → 不写库,也不提示", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", { title: "游泳", start: `${TODAY} 19:00`, repeat: "weekly" });
    const before = startsOf(seriesId);
    const { message } = listWindow("mama", addDays(TODAY, -60), addDays(TODAY, -30));
    assert.equal(message.includes("只展开到"), false, "没越过边界就不该有降级说明");
    assert.deepEqual(startsOf(seriesId), before, "窗口在过去不该有任何写入");
    for (const s of before) assert.ok(s >= TODAY, "库里不该出现过去的实例");
  });

  it("续期有结构性兜底:UNIQUE(series_id, start) 挡住重名(所以幂等不只靠代码约定)", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", { title: "游泳", start: `${TODAY} 19:00`, repeat: "weekly" });
    const first = instancesOf(seriesId)[0]!;
    // 模拟"续期被重试 / 将来新增的续期入口忘了查重":直接插一条同一次
    assert.throws(
      () =>
        f.db
          .prepare(
            `INSERT INTO event_instance (id, series_id, owner_id, title, created_by, created_at, start, all_day)
             VALUES ('ei-retry-0000', ?, NULL, '游泳', ?, '2026-10-05T00:00:00Z', ?, 0)`,
          )
          .run(seriesId, f.members.mama.id, first.start),
      /UNIQUE/,
      "同一系列的同一次不允许落两行",
    );
    assert.equal(countInstances(seriesId), 14);
  });
});

// ─────────────────── 续期失败降级:真失败,读不得报错(设计 §4) ───────────────────

describe("续期失败降级:写在读路径上的写失败了,读照常返回", () => {
  it("PRAGMA query_only = ON 让写真的失败 → 仍 ok:true、已展开范围内的实例照常返回、话术说清只展开到哪天", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", { title: "游泳", start: `${TODAY} 19:00`, repeat: "weekly" });
    const before = startsOf(seriesId);
    assert.equal(before.length, 14);

    // 真实失败条件:连接进入 query_only,任何 INSERT 都会被 SQLite 拒绝(不是 mock)
    f.db.pragma("query_only = ON");
    try {
      // 读一个越过边界的窗口:续期必须去写库 → 写失败
      const env = listEvents(f.db, f.callers.mama, TZ, { start: TODAY, end: addDays(TODAY, 147) });
      // ① 读不报错:ok 仍为 true(调用本身返回了信封,没有异常冒出来)
      ok(env);
      // ② 已物化范围内的实例照常返回(14 次全在),一条不少
      const data = env.data as ListData;
      assert.equal(data.family.length, 14);
      assert.deepEqual(data.family.map((v) => v.start), before);
      // ③ 话术写清降级:只展开到哪天 + 之后的要稍后重试
      assert.match(env.message, new RegExp(`日程只展开到 ${WINDOW_LAST_DAY},之后的重复日程需稍后重试。$`));
      // ④ 没有留下"补了一半"的系列(事务回滚,一条都没写进去)
      assert.deepEqual(startsOf(seriesId), before);
      // 不把底层异常文本转述给家人
      assert.doesNotMatch(env.message, /readonly|SQLITE|SqliteError|attempt to write/i);
    } finally {
      // 读完立刻撤掉失败条件(同一文件后续用例不应被污染)
      f.db.pragma("query_only = OFF");
    }

    // 撤掉之后同一个窗口再读:续期恢复,缺口补齐
    const after = listWindow("mama", TODAY, addDays(TODAY, 147));
    assert.equal(after.data.family.length, 22);
    assert.equal(after.message.includes("只展开到"), false, "续期成功后不再有降级说明");
    assert.equal(countInstances(seriesId), 22);
  });

  it("续期失败也不影响读别人的个人日程:不可见系列不参与续期,话术里也不泄露它的边界", () => {
    f = newFixture();
    // 妈妈的秘密重复日程(个人日程,仅妈妈可见)
    const secret = newRepeating("mama", { owner: "妈妈", title: "妈妈的秘密日程", start: `${TODAY} 15:00`, repeat: "weekly" });
    // 小明读一个越过边界的窗口:既看不到内容,也不会触发对它的续期写入
    f.db.pragma("query_only = ON");
    try {
      const env = listEvents(f.db, f.callers.kid, TZ, { start: TODAY, end: addDays(TODAY, 147) });
      ok(env);
      const data = env.data as ListData;
      assert.deepEqual(data.family, []);
      assert.deepEqual(data.mine, []);
      assert.doesNotMatch(JSON.stringify(env), /妈妈的秘密日程/);
      assert.doesNotMatch(env.message, /只展开到/, "没有可见的重复日程时不该冒出降级说明");
    } finally {
      f.db.pragma("query_only = OFF");
    }
    assert.equal(countInstances(secret), 14, "不可见的系列不被续期写库");
  });
});

// ─────────────────── 窗口与实例的边界语义(重复实例上同样成立) ───────────────────

describe("窗口与实例的边界语义:含端点、跨窗口仍在进行的日程也要出现", () => {
  it("start/end 都含边界:窗口起点/终点正好是某一次时都能查到,结束之后就没有了", () => {
    f = newFixture();
    newRepeating("mama", { title: "游泳", start: `${TODAY} 19:00`, end: `${TODAY} 20:00`, repeat: "weekly" });

    const edgeStart = listWindow("mama", `${TODAY} 19:00`, `${TODAY} 19:00`).data.family;
    assert.deepEqual(edgeStart.map((v) => v.start), [`${TODAY} 19:00`], "窗口 = 某一次的开始时刻 ⇒ 含端点命中");

    const edgeEnd = listWindow("mama", `${addDays(TODAY, 7)} 20:00`, `${addDays(TODAY, 7)} 20:00`).data.family;
    assert.deepEqual(edgeEnd.map((v) => v.start), [`${addDays(TODAY, 7)} 19:00`], "只给结束时刻也要命中(重叠判定)");

    // 19:01 的窗口仍然命中(19:00 那次还在进行中,按重叠判定)⇒ 真正"开始之后"要用结束之后
    const stillRunning = listWindow("mama", `${addDays(TODAY, 7)} 19:01`, `${addDays(TODAY, 7)} 23:59`).data.family;
    assert.deepEqual(stillRunning.map((v) => v.start), [`${addDays(TODAY, 7)} 19:00`], "仍在进行中的也要出现");
    const after = listWindow("mama", `${addDays(TODAY, 7)} 21:00`, `${addDays(TODAY, 7)} 23:59`).data.family;
    assert.deepEqual(after, [], "结束之后就没有了");
  });

  it("跨天 all_day 的重复日程:中间那一天 / 窗口起点当天都要出现", () => {
    f = newFixture();
    newRepeating("mama", { title: "回老家", start: TODAY, end: addDays(TODAY, 2), all_day: true, repeat: "weekly" });

    // 中间那天:仍在进行中 → 出现
    const middle = listWindow("mama", addDays(TODAY, 1), addDays(TODAY, 1)).data.family;
    assert.equal(middle.length, 1);
    assert.equal(middle[0]!.start, TODAY, "出现的是仍在进行的那一次");
    // 纯日期的 end 覆盖当天整天:窗口 = 该次的第一天也能查到
    const firstDay = listWindow("mama", TODAY, TODAY).data.family;
    assert.equal(firstDay.length, 1);
    // 下一次重复的前一天之后就不再出现
    const gap = listWindow("mama", addDays(TODAY, 3), addDays(TODAY, 6)).data.family;
    assert.deepEqual(gap, [], "两次重复之间没有日程");
  });
});

// ─────────────────── 改系列(N4):未来按新规则重建,过去保持不动 ───────────────────

describe("改系列:整系列联动(裸 SQL 验分布,不只看回执话术)", () => {
  /** 造一条"历史上已经发生过一次"的实例(裸 SQL),模拟系列是在过去创建的、那次已物化。 */
  function insertHistoricalInstance(seriesId: string, start: string): RawInstanceRow {
    f.db
      .prepare(
        `INSERT INTO event_instance (id, series_id, owner_id, title, created_by, created_at, start, end, all_day)
         VALUES (?, ?, NULL, '游泳', ?, '2026-10-05T00:00:00Z', ?, ?, 0)`,
      )
      .run("ei-historic-01", seriesId, f.members.mama.id, start, `${start.slice(0, 10)} 20:00`);
    return f.db
      .prepare("SELECT id, series_id, start, end, all_day, title, location, deleted_at FROM event_instance WHERE id = ?")
      .get("ei-historic-01") as RawInstanceRow;
  }

  it("weekly → daily:未来的那几次按新规则重建,已经过去的那次原样保留", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", { title: "游泳", start: `${TODAY} 19:00`, end: `${TODAY} 20:00`, repeat: "weekly" });
    // 历史那次:7 天前,已过去
    const historicStart = `${addDays(TODAY, -7)} 19:00`;
    const historic = insertHistoricalInstance(seriesId, historicStart);

    const env = updateEvent(f.db, f.callers.mama, TZ, { id: seriesId, repeat: "daily" });
    ok(env);
    assert.match(
      env.message,
      new RegExp(`改动:重复→「每天」;未来日程已按新规则重建\\(该系列现有 93 次,展开至 ${WINDOW_LAST_DAY}\\)。`),
    );
    assert.match(env.message, /重复日程不支持只改其中一次:这条改动作用于整个系列。$/);

    // 裸 SQL 看 start 的分布:过去的还在,未来的是 daily(相邻差 1 天)
    const rows = instancesOf(seriesId);
    const past = rows.filter((r) => r.start < TODAY);
    const future = rows.filter((r) => r.start >= TODAY);
    assert.deepEqual(past.map((r) => r.start), [historicStart], "历史那次原样保留,不得被改写或删掉");
    // 历史那次的**全部字段**都不许变(不只是 start):折叠路径曾经把历史整行物理删掉,
    // 这条断言把同一条纪律钉在"重复 → 重复"的重建路径上 —— 两条路径共用"只删未来"的口径。
    assert.deepEqual(past, [historic], "历史那次一个字段都不许变(含 id / end / all_day / title / deleted_at)");
    assert.equal(f.db.prepare("SELECT id FROM event_instance WHERE id = ?").get("ei-historic-01") !== undefined, true);
    assert.equal(historic.deleted_at, null, "历史那次不该被软删");
    assert.equal(future.length, MATERIALIZE_DAYS, "未来的按 daily 重建 = 92 次");
    const gaps = new Set(
      future.slice(1).map((r, i) => daysBetweenDays(future[i]!.start.slice(0, 10), r.start.slice(0, 10))),
    );
    assert.deepEqual([...gaps], [1], "相邻的两次只差 1 天 ⇒ 已是 daily,不再是每周");
    assert.equal(future[0]!.start, `${TODAY} 19:00`);
    assert.deepEqual(seriesRow(seriesId), { repeat: "daily", repeat_interval: 1, repeat_until: null });
  });

  it("改 start:整系列按新的首次时间重建(锚点平移)", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", { title: "游泳", start: `${TODAY} 19:00`, repeat: "weekly" });
    const newStart = `${addDays(TODAY, 7)} 19:30`;
    const env = updateEvent(f.db, f.callers.mama, TZ, { id: seriesId, start: newStart });
    ok(env);
    assert.match(env.message, /改动:开始时间改为 .*;未来日程已按新规则重建/);
    // 窗口跟着锚点走:[today+7, today+7+91] ⇒ floor(91/7)+1 = 14 次
    const starts = startsOf(seriesId);
    assert.equal(starts.length, 14);
    assert.equal(starts[0], newStart, "第一次 = 新传的 start");
    assert.equal(starts[13], `${addDays(TODAY, 7 + 91)} 19:30`, "时刻随 start 一起平移");
  });

  it('repeat="none":没有历史时折叠成"最早的未来那一次",之后也不再续期', () => {
    f = newFixture();
    const seriesId = newRepeating("mama", { title: "游泳", start: `${TODAY} 19:00`, end: `${TODAY} 20:00`, repeat: "weekly" });
    assert.equal(countInstances(seriesId), 14);

    const env = updateEvent(f.db, f.callers.mama, TZ, { id: seriesId, repeat: "none" });
    ok(env);
    assert.match(
      env.message,
      new RegExp(
        `改动:重复→「不重复」;整个系列已改为单次日程\\(保留 ${TODAY} 19:00 那一次,其余未来的展开已收起\\)。`,
      ),
      "回执要说清:保留了那一次(带时间)、其余未来的展开收起;这个系列没有历史实例,所以不提历史",
    );
    assert.deepEqual(startsOf(seriesId), [`${TODAY} 19:00`], "只剩最早的未来那一次");
    assert.equal(countInstances(seriesId), 1);
    assert.deepEqual(seriesRow(seriesId), { repeat: "none", repeat_interval: 1, repeat_until: null });

    // 不再是重复系列:读再远的窗口也不会续期
    const far = listWindow("mama", addDays(TODAY, -60), addDays(TODAY, 300));
    assert.equal(far.data.family.length, 1);
    assert.equal(far.message.includes("只展开到"), false);
    assert.equal(countInstances(seriesId), 1, "读再远也不续期");
  });

  it("改标题/地点/备注:系列与**每一次**实例同步(含已经过去的那次)", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", { title: "游泳", start: `${TODAY} 19:00`, repeat: "weekly" });
    const historic = insertHistoricalInstance(seriesId, `${addDays(TODAY, -7)} 19:00`);

    const env = updateEvent(f.db, f.callers.kid, TZ, { id: seriesId, title: "游泳课", location: "体育馆" });
    ok(env);
    assert.match(env.message, /^已由 小明 更新全家日程 /, "全家日程任何成员可改(V3)");
    const titles = new Set(instancesOf(seriesId).map((r) => r.title));
    assert.deepEqual([...titles], ["游泳课"], "每一次实例的标题都要同步,否则 list_events 会读出旧标题");
    const seriesTitle = (
      f.db.prepare("SELECT title FROM event_series WHERE id = ?").get(seriesId) as { title: string }
    ).title;
    assert.equal(seriesTitle, "游泳课");
    const historicRow = instancesOf(seriesId).find((r) => r.id === historic.id)!;
    assert.equal(historicRow.start, historic.start, "改标题不重建时间");
  });

  it("权限顺序在重复场景仍成立:他人个人重复日程 → DENIED(not_visible),且不留下任何写入", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", { owner: "妈妈", title: "妈妈的秘密日程", start: `${TODAY} 15:00`, repeat: "weekly" });
    const before = instancesOf(seriesId);

    const env = updateEvent(f.db, f.callers.baba, TZ, { id: seriesId, repeat: "daily", title: "偷偷改" });
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assert.doesNotMatch(JSON.stringify(env), /妈妈的秘密日程/, "拒绝信封不得泄露标题(V5)");
    assert.doesNotMatch(JSON.stringify(env), new RegExp(TODAY), "拒绝信封不得泄露时间(V5)");
    assert.deepEqual(instancesOf(seriesId), before, "被拒的调用不得留下任何写入");
    assert.deepEqual(seriesRow(seriesId), { repeat: "weekly", repeat_interval: 1, repeat_until: null });

    // 归属人本人可以改(V1),代记者仍然改不了(V8)
    const byOwner = updateEvent(f.db, f.callers.mama, TZ, { id: seriesId, repeat: "daily" });
    ok(byOwner);
    const byDelegate = updateEvent(f.db, f.callers.kid, TZ, { id: seriesId, title: "x" });
    fail(byDelegate);
    assert.equal(byDelegate.reason, "not_visible");
  });

  it("同值幂等:把现值原样回传 → 未做修改,且一个字都不写库", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", { title: "游泳", start: `${TODAY} 19:00`, repeat: "weekly", repeat_interval: 1 });
    const beforeSeries = seriesRow(seriesId);
    const beforeStarts = startsOf(seriesId);

    const env = updateEvent(f.db, f.callers.mama, TZ, {
      id: seriesId,
      title: "游泳",
      repeat: "weekly",
      repeat_interval: 1,
      start: `${TODAY} 19:00`,
    });
    ok(env);
    assert.match(env.message, /未做修改\(没有字段发生变化\)/);
    assert.deepEqual(seriesRow(seriesId), beforeSeries);
    assert.deepEqual(startsOf(seriesId), beforeStarts);
  });
});

// ─────── 折叠(repeat → "none"):只删未来,历史一行都不动(S2c 修复轮) ───────

/**
 * 这一组针对 S2c 的那个 bug:`repeat: ≠none → "none"` 时 `rebuildInstances` 曾经
 * **无条件 DELETE 掉整个系列的实例**(含历史、且是物理删除),再拿"最早那一次"当锚点
 * 重建一条。结果是:家人三个月前真的游过泳,可今天把日程改成"只一次"就从日历里消失;
 * 而且保留下来的那一条取的是**最早**(常常在过去的)一次,未来反而空着。
 *
 * 正确口径(与"重复 → 重复"的重建路径同一条):**只删未来**(start >= today),
 * 保留"最早的未来一次"作为折叠后仅存的那次,全在过去时**不新建**;
 * 历史实例一个字节都不许动。
 */
describe("折叠(repeat → \"none\"):保留接下来那一次,历史物理删除是错的", () => {
  it("注入 2 条过去实例 → 折叠:那 2 条**仍在**、deleted_at 为空、字段一个字节没变", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", {
      title: "游泳",
      start: `${TODAY} 19:00`,
      end: `${TODAY} 20:00`,
      repeat: "weekly",
    });
    // 造两次"已经发生过":两周前、上周各一次(裸 SQL 注入,理由见 injectRawInstance)
    const pastStarts = [`${addDays(TODAY, -14)} 19:00`, `${addDays(TODAY, -7)} 19:00`];
    injectRawInstance(seriesId, "ei-past-01", { start: pastStarts[0]!, end: `${addDays(TODAY, -14)} 20:00` });
    injectRawInstance(seriesId, "ei-past-02", { start: pastStarts[1]!, end: `${addDays(TODAY, -7)} 20:00` });
    const pastBefore = instancesOf(seriesId).filter((r) => r.start < TODAY);
    assert.equal(pastBefore.length, 2, "前置条件:两条历史实例都在库里");

    const env = updateEvent(f.db, f.callers.mama, TZ, { id: seriesId, repeat: "none" });
    ok(env);

    // 折叠之后:历史原样保留。物理删除会让这两行直接消失且不可恢复 —— 家人真的去过。
    const pastAfter = instancesOf(seriesId).filter((r) => r.start < TODAY);
    assert.equal(pastAfter.length, 2, "两条历史实例都必须还在库里");
    assert.deepEqual(pastAfter, pastBefore, "历史实例一个字段都不许变(含 id / start / end / all_day / deleted_at)");
    assert.deepEqual(pastAfter.map((r) => r.start), pastStarts);
    assert.deepEqual(pastAfter.map((r) => r.deleted_at), [null, null], "历史不该被软删,更不该被物理删");
    // 历史那两次仍然查得到(被物理删的话这里是空的)
    const pastWindow = listWindow("mama", addDays(TODAY, -14), addDays(TODAY, -7)).data.family;
    assert.deepEqual(pastWindow.map((v) => v.start), pastStarts, "过去的记录仍在 list_events 里");
  });

  it("折叠后未来恰好只剩 1 条 = **最早的未来一次**(裸 SQL 断言 start,不是拿回执凑)", () => {
    f = newFixture();
    // 锚点放在两周前:网格 = today-14 + 7k,物化窗口 [today, today+91] ⇒ k=2..15 共 14 次,
    // 第一次恰好落在今天。
    const seriesId = newRepeating("mama", {
      title: "游泳",
      start: `${addDays(TODAY, -14)} 19:00`,
      end: `${addDays(TODAY, -14)} 20:00`,
      repeat: "weekly",
    });
    assert.deepEqual(startsOf(seriesId), Array.from({ length: 14 }, (_, k) => `${addDays(TODAY, k * 7)} 19:00`));
    // 再注入一条更早的历史:于是"系列里最早的那一次"落在过去 —— 取锚点取到它就意味着
    // 折叠后留下一条过去的日程、未来全空(那正是这个 bug 的第二个症状)。
    const past = injectRawInstance(seriesId, "ei-past-00", { start: `${addDays(TODAY, -7)} 19:00`, end: `${addDays(TODAY, -7)} 20:00` });
    assert.equal(instancesOf(seriesId)[0]!.id, past.id, "前置条件:系列里最早的那一次确实在过去");

    const env = updateEvent(f.db, f.callers.mama, TZ, { id: seriesId, repeat: "none" });
    ok(env);

    const rows = instancesOf(seriesId);
    const future = rows.filter((r) => r.start >= TODAY);
    assert.equal(future.length, 1, "折叠后未来只留一条");
    assert.equal(future[0]!.start, `${TODAY} 19:00`, "留的是最早的未来一次(今天),不是系列里最早的那次(上周)");
    assert.equal(future[0]!.end, `${TODAY} 20:00`, "沿用它自己的 end");
    assert.notEqual(future[0]!.id, past.id, "留的那条不是过去那条");
    assert.deepEqual(rows.filter((r) => r.start < TODAY).map((r) => r.start), [past.start], "过去那条仍在");
    // 回执三件事:保留了一次(带时间)/ 其余未来的展开已收起 / 过去的记录没有改动
    assert.match(env.message, new RegExp(`保留 ${TODAY} 19:00 那一次`));
    assert.match(env.message, /其余未来的展开已收起/);
    assert.match(env.message, /已经过去的记录没有改动/);

    // 不再是重复系列:读再远的窗口也不会续期
    const far = listWindow("mama", addDays(TODAY, -60), addDays(TODAY, 300));
    assert.equal(far.message.includes("只展开到"), false, "折叠后不再续期,不该有降级说明");
    assert.equal(countInstances(seriesId), 2, "读再远也不长出新实例");
  });

  it("折叠的同时改标题/地点:保留下来的那一次用**新值**;历史那次的时间字段不动", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", {
      title: "游泳",
      start: `${TODAY} 19:00`,
      end: `${TODAY} 20:00`,
      location: "体育馆",
      repeat: "weekly",
    });
    const past = injectRawInstance(seriesId, "ei-past-01", { start: `${addDays(TODAY, -7)} 19:00`, end: `${addDays(TODAY, -7)} 20:00` });

    const env = updateEvent(f.db, f.callers.mama, TZ, { id: seriesId, repeat: "none", title: "游泳课", location: "市立游泳馆" });
    ok(env);

    const rows = instancesOf(seriesId);
    const kept = rows.filter((r) => r.start >= TODAY);
    assert.equal(kept.length, 1, "未来只留一条");
    assert.equal(kept[0]!.title, "游泳课", "保留的那一次用新标题");
    assert.equal(kept[0]!.location, "市立游泳馆", "新地点也生效(重建时取系列的新值)");
    assert.equal(kept[0]!.start, `${TODAY} 19:00`, "时间沿用它自己的,不因折叠而移动");
    const pastAfter = rows.find((r) => r.id === past.id)!;
    assert.equal(pastAfter.start, past.start, "历史那次的时间不许被改写");
    assert.equal(pastAfter.end, past.end);
    assert.equal(pastAfter.all_day, past.all_day);
  });

  it("整个系列都在过去 → 折叠后**不新建**(不造一条过去的单次日程),回执说清没有更晚的一次", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", {
      title: "游泳",
      start: `${addDays(TODAY, -14)} 19:00`,
      end: `${addDays(TODAY, -14)} 20:00`,
      repeat: "weekly",
    });
    assert.equal(countInstances(seriesId), 14);
    // 造出"全在过去"的系列:正常调用序列造不出来(创建时物化只从今天起算),所以把
    // 今天起的那 14 次收走(裸 SQL),只留两次历史 —— 这是一个"只补记过历史"的系列。
    f.db.prepare("DELETE FROM event_instance WHERE series_id = ? AND start >= ?").run(seriesId, TODAY);
    const pastStarts = [`${addDays(TODAY, -14)} 19:00`, `${addDays(TODAY, -7)} 19:00`];
    injectRawInstance(seriesId, "ei-past-01", { start: pastStarts[0]!, end: `${addDays(TODAY, -14)} 20:00` });
    injectRawInstance(seriesId, "ei-past-02", { start: pastStarts[1]!, end: `${addDays(TODAY, -7)} 20:00` });
    const before = snapshotOf(seriesId);
    assert.equal(before.length, 2, "前置条件:系列只剩两条历史实例");

    const env = updateEvent(f.db, f.callers.mama, TZ, { id: seriesId, repeat: "none" });
    ok(env);

    const rows = instancesOf(seriesId);
    assert.equal(rows.filter((r) => r.start >= TODAY).length, 0, "没有未来实例 ⇒ 不新建任何实例(尤其不许造一条过去的)");
    assert.deepEqual(rows, before, "过去那两次原样保留");
    assert.deepEqual(seriesRow(seriesId), { repeat: "none", repeat_interval: 1, repeat_until: null }, "系列静静变成不再重复");
    assert.match(env.message, /这个系列没有更晚的一次了/);
    assert.equal(
      (env.data as EventView).start,
      pastStarts[0],
      "没有更晚的一次时,回执指向系列里最早的那次(即过去那条),不编一个未来的日期出来",
    );
  });

  it("折叠后保留下来的那一次出现在 list_events 里;历史那次所在的窗口也还在", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", {
      title: "游泳",
      start: `${addDays(TODAY, -14)} 19:00`,
      end: `${addDays(TODAY, -14)} 20:00`,
      repeat: "weekly",
    });
    injectRawInstance(seriesId, "ei-past-00", { start: `${addDays(TODAY, -7)} 19:00`, end: `${addDays(TODAY, -7)} 20:00` });

    const env = updateEvent(f.db, f.callers.mama, TZ, { id: seriesId, repeat: "none" });
    ok(env);
    assert.equal(countInstances(seriesId), 2, "一条未来(保留的那次)+ 一条历史");

    // 窗口取保留下来的那一天
    assert.deepEqual(listWindow("mama", TODAY, TODAY).data.family.map((v) => v.start), [`${TODAY} 19:00`]);
    // 窗口取历史那一天
    assert.deepEqual(listWindow("mama", addDays(TODAY, -7), addDays(TODAY, -7)).data.family.map((v) => v.start), [
      `${addDays(TODAY, -7)} 19:00`,
    ]);
  });

  it("折叠时同时传 start:保留下来的那一次沿用它自己的时间,回执不谎称时间已改", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", { title: "游泳", start: `${TODAY} 19:00`, end: `${TODAY} 20:00`, repeat: "weekly" });
    // 折叠的选点是"接下来最早的那一次",按时间挑,不按传入的 start 挑(S2c 裁决):
    // 否则同一次会被挪到与历史行相同的日期上,撞 UNIQUE(series_id, start) 而悄悄消失。
    const env = updateEvent(f.db, f.callers.mama, TZ, {
      id: seriesId,
      repeat: "none",
      start: `${addDays(TODAY, 3)} 08:00`,
      end: `${addDays(TODAY, 3)} 09:00`,
    });
    ok(env);
    assert.deepEqual(startsOf(seriesId), [`${TODAY} 19:00`], "保留最早的未来一次,时间不动");
    assert.match(env.message, new RegExp(`保留 ${TODAY} 19:00 那一次`));
    assert.match(env.message, /折叠后保留下来的那一次沿用它原来的时间/, "话术要说清传入的时间没落到实例上");
    assert.doesNotMatch(env.message, /开始时间改为/, "库里没改,话术就不许说改了");
  });

  it("全天日程折叠:保留下来的那一次仍是全天(纯日期形态与跨天天数差不丢)", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", {
      title: "回老家",
      start: TODAY,
      end: addDays(TODAY, 2),
      all_day: true,
      repeat: "weekly",
    });
    injectRawInstance(seriesId, "ei-past-01", { start: addDays(TODAY, -7), end: addDays(TODAY, -5), allDay: true });

    const env = updateEvent(f.db, f.callers.mama, TZ, { id: seriesId, repeat: "none" });
    ok(env);
    const rows = instancesOf(seriesId);
    const kept = rows.filter((r) => r.start >= TODAY);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.start, TODAY, "纯日期形态保留");
    assert.equal(kept[0]!.all_day, 1, "仍是全天(重建时取的是那一次自己的 all_day)");
    assert.equal(kept[0]!.end, addDays(TODAY, 2), "跨天的天数差保留");
    assert.deepEqual(
      rows.filter((r) => r.start < TODAY).map((r) => r.start),
      [addDays(TODAY, -7)],
      "历史那次仍在",
    );
  });

  it("折叠路径的权限纪律不变:他人个人日程 → DENIED(not_visible),拒绝信封不泄露标题/时间,库里一行不动", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", {
      owner: "妈妈",
      title: "妈妈的秘密日程",
      start: `${TODAY} 15:00`,
      repeat: "weekly",
    });
    const past = injectRawInstance(seriesId, "ei-past-01", { start: `${addDays(TODAY, -7)} 15:00`, end: `${addDays(TODAY, -7)} 16:00` });
    const before = snapshotOf(seriesId);

    const env = updateEvent(f.db, f.callers.kid, TZ, { id: seriesId, repeat: "none" });
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assert.doesNotMatch(JSON.stringify(env), /妈妈的秘密日程/, "折叠路径同样不许泄露标题(V5)");
    assert.doesNotMatch(env.message, new RegExp(`${TODAY} 15:00`), "折叠路径同样不许泄露时间(V5)");
    assert.deepEqual(snapshotOf(seriesId), before, "被拒的调用不得留下任何写入(历史那行也还在)");
    assert.equal(instancesOf(seriesId).some((r) => r.id === past.id), true);
    assert.deepEqual(seriesRow(seriesId), { repeat: "weekly", repeat_interval: 1, repeat_until: null });
  });
});

// ─────────────────── 删 / 恢复整系列在重复场景仍成立 ───────────────────

describe("delete_event / restore_deleted:整系列及其全部实例(N4)", () => {
  it("删 → 全部实例软删、读不到;恢复 → 全部回来且一次不少", () => {
    f = newFixture();
    const { seriesId } = newEvent("mama", { title: "游泳", start: `${TODAY} 19:00`, repeat: "weekly" });
    assert.equal(countInstances(seriesId), 14);
    const idsBefore = instancesOf(seriesId).map((r) => r.id);

    const del = deleteEvent(f.db, f.callers.mama, seriesId);
    ok(del);
    assert.match(del.message, /系列 e-/);
    const live = (
      f.db
        .prepare("SELECT COUNT(*) AS n FROM event_instance WHERE series_id = ? AND deleted_at IS NULL")
        .get(seriesId) as { n: number }
    ).n;
    assert.equal(live, 0, "14 次全部软删(联动),不是只删一次");
    assert.equal(listWindow("mama", TODAY, WINDOW_LAST_DAY).data.family.length, 0);

    // 已删的系列不再参与续期:读一个远窗也不会有写入或降级说明
    const far = listWindow("mama", TODAY, addDays(TODAY, 300));
    assert.equal(far.message.includes("只展开到"), false);
    assert.equal(countInstances(seriesId), 14, "已删系列不续期");

    const res = restoreDeleted(f.db, f.callers.mama, "event", seriesId);
    ok(res);
    assert.match(res.message, /恢复的是整个系列及其全部日程实例/);
    assert.deepEqual(instancesOf(seriesId).map((r) => r.id), idsBefore, "恢复后还是原来那 14 次");
    assert.equal(countInstances(seriesId), 14);
    assert.equal(listWindow("mama", TODAY, WINDOW_LAST_DAY).data.family.length, 14);
  });
});

// ───────────────────────── 审计(§6) ─────────────────────────

describe("审计:用户发起的写各留一行,续期这种内部写不留痕", () => {
  it("add_event(重复)/ update_event(改规则) 各留一行,args_summary 含重复参数", () => {
    f = newFixture();
    const add = callTool("mama", "add_event", {
      title: "游泳",
      start: `${TODAY} 19:00`,
      repeat: "weekly",
      repeat_until: WINDOW_LAST_DAY,
    });
    ok(add);
    const seriesId = (add.data as EventView).series_id;
    const rowsAfterAdd = listAudit(f.db);
    assert.deepEqual(rowsAfterAdd.map((r) => r.tool), ["add_event"]);
    assert.match(rowsAfterAdd[0]!.args_summary, /repeat=weekly/);
    assert.match(rowsAfterAdd[0]!.args_summary, new RegExp(`repeat_until=${WINDOW_LAST_DAY}`));

    const upd = callTool("mama", "update_event", { id: seriesId, repeat_interval: 2 });
    ok(upd);
    assert.match(upd.message, /重复间隔→「2」/);
    assert.deepEqual(listAudit(f.db).map((r) => r.tool), ["update_event", "add_event"]);
    assert.match(listAudit(f.db)[0]!.args_summary, /repeat_interval=2/);
    assert.equal(countInstances(seriesId), 7, "每两周 ⇒ floor(91/14)+1 = 7 次");

    // 有 repeat_until 的系列续期到截止日为止,读再远也不会新增 —— 这是"截止日真的生效"
    const far = callTool("mama", "list_events", { start: TODAY, end: addDays(TODAY, 300) });
    ok(far);
    assert.equal(countInstances(seriesId), 7, "截止日之后不再生成");
  });

  it("list_events 触发的续期(写在读路径上的写)刻意不记审计", () => {
    f = newFixture();
    const seriesId = newRepeating("mama", { title: "游泳", start: `${TODAY} 19:00`, repeat: "weekly" });
    assert.equal(countInstances(seriesId), 14);
    const before = listAudit(f.db).length;

    const read = callTool("mama", "list_events", { start: TODAY, end: addDays(TODAY, 147) });
    ok(read);
    // 算式:每 7 天一次、直到 today+147 ⇒ floor(147/7)+1 = 22 次(比创建时的 14 次多 8 次)
    assert.equal(countInstances(seriesId), Math.floor(147 / 7) + 1, "确实续期了(补到 today+147)");
    assert.equal(listAudit(f.db).length, before, "续期不是用户发起的写,不单独记审计");
  });
});
