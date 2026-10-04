import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { listAudit } from "../src/audit/audit.js";
import { todayInTz } from "../src/db/id.js";
import { addEvent, type EventView } from "../src/domain/events.js";
import type { Envelope, FailEnvelope, OkEnvelope } from "../src/domain/envelope.js";
import { getToday, type TodayData } from "../src/domain/today.js";
import { addTodo, completeTodo, listTodos } from "../src/domain/todos.js";
import { TOOL_DEFINITIONS } from "../src/mcp/tools.js";
import { newFixture, TZ, type Fixture, type FixtureKey } from "./helpers.js";

/**
 * S4 通用域:get_today(**无参数**的今日概览)。
 *
 * 对照:设计 §5「get_today → 本人今日待办(到期 + 逾期未完成)+ 今日全家日程」、
 * §8.1 走查 8(开场提醒)与走查 9(cron 个人摘要)、反例 X15(as_member 在通用域的落点)。
 *
 * 本阶段钉的四条不变量:
 * 1. **「今天」按配置时区算**(不读系统本地时区)—— 用两个相差整日的时区
 *    (Pacific/Kiritimati 与 America/Los_Angeles 恒差一天)对**同一份数据**跑两次,
 *    两次的分类必须不同;若"今天"来自任何固定值(含系统本地),两次结果会一致。
 * 2. **V1/V2:绝不含他人的个人项** —— 他人的待办、他人的个人日程,
 *    连"我代他人记的"(V8 查看权可见)都不进今日概览。
 * 3. **分列**:三块(今日到期 / 逾期 / 今日日程)各自成列,日程再分全家/我的两列。
 * 4. **读工具不记审计**。
 *
 * 直调 domain 函数(业务规则在这一层);参数校验与审计走工具层(callTool)。
 */

let f: Fixture;
afterEach(() => f?.db.close());

function ok(env: { ok: boolean; message?: string }): asserts env is OkEnvelope {
  assert.equal(env.ok, true, `期望成功信封,实际:${JSON.stringify(env)}`);
}
function fail(env: { ok: boolean; message?: string }): asserts env is FailEnvelope {
  assert.equal(env.ok, false, `期望失败信封,实际:${JSON.stringify(env)}`);
}

/** 走工具层(参数校验 + 审计留痕);参数不合规时直接返回 parse 的失败信封。 */
function callTool(key: FixtureKey, name: string, args: unknown): Envelope {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
  assert.ok(tool, `未知工具 ${name}`);
  const parsed = tool!.parse(args);
  return parsed.ok ? tool!.run(f.db, f.callers[key], TZ, parsed.args) : parsed.envelope;
}

/** 拉一次今日概览,直接拿 data(话术在需要时另外断言)。 */
function todayOf(key: FixtureKey, timezone: string = TZ): TodayData {
  const env = getToday(f.db, f.callers[key], timezone);
  ok(env);
  return env.data as TodayData;
}

/** 日历日加 n 天(负数往前推);测试里造"今天/明天/昨天/后天"用。 */
function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const p2 = (x: number): string => String(x).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
}

/** 造一条待办,返回它的 id。`owner` 缺省 = 说话人本人;给别人的名字就是"代记"(V4)。 */
function newTodo(key: FixtureKey, title: string, due?: string, owner?: string): string {
  const env = addTodo(f.db, f.callers[key], TZ, {
    title,
    ...(due ? { due_date: due } : {}),
    ...(owner ? { owner } : {}),
  });
  ok(env);
  return (env.data as { id: string }).id;
}

/** 造一条日程,返回实例 id。 */
function newEvent(
  key: FixtureKey,
  input: { title: string; start: string; end?: string; allDay?: boolean; owner?: string; repeat?: "daily" | "weekly" },
): string {
  const env = addEvent(f.db, f.callers[key], TZ, {
    title: input.title,
    start: input.start,
    end: input.end ?? null,
    all_day: input.allDay === true,
    ...(input.owner ? { owner: input.owner } : {}),
    ...(input.repeat ? { repeat: input.repeat } : {}),
  });
  ok(env);
  return (env.data as EventView).id;
}

describe("get_today:待办的取舍(今日到期 / 逾期 / 已完成 / 无截止)", () => {
  it("四类待办各归其位:今日到期与逾期分列,今日已完成与无截止都不出现", () => {
    f = newFixture();
    const today = todayInTz(TZ);

    const dueToday = newTodo("mama", "交电费", today);
    const dueTomorrow = newTodo("mama", "买牛奶", shiftDay(today, 1));
    const overdue1 = newTodo("mama", "交物业费", shiftDay(today, -1));
    const overdue4 = newTodo("mama", "预约体检", shiftDay(today, -4));
    const noDue = newTodo("mama", "想想周末去哪玩");
    // 今天到期、但已经完成:不该再提醒(已经办完,再提一次是噪声)。
    const doneToday = newTodo("mama", "倒垃圾", today);
    ok(completeTodo(f.db, f.callers.mama, TZ, doneToday));

    const data = todayOf("mama");
    assert.equal(data.today, today);
    assert.deepEqual(
      data.due_today.map((t) => t.title),
      ["交电费"],
      "第一块只应是今日到期的未完成待办",
    );
    assert.deepEqual(
      data.overdue.map((t) => t.title),
      ["预约体检", "交物业费"],
      "第二块只应是逾期未完成的待办,且按截止日期升序(最久的排最前)",
    );
    // 明天的、今天已完成的、无截止日期的:三块里都不能出现。
    const all = [...data.due_today, ...data.overdue, ...data.events.family, ...data.events.mine];
    const titles = all.map((x) => (("due_text" in x ? x.title : x.title)));
    for (const gone of [dueTomorrow, "买牛奶", "倒垃圾", noDue, "想想周末去哪玩"]) {
      assert.equal(titles.includes(gone), false, `不该出现:${gone}`);
    }

    // 定位信息齐:每条待办带 id + 标题 + 相对截止说法 + 天数差。
    const first = data.due_today[0]!;
    assert.equal(first.id, dueToday);
    assert.equal(first.title, "交电费");
    assert.equal(first.due_date, today);
    assert.equal(first.due_text, "今天截止");
    assert.equal(first.days_from_today, 0);
    const late = data.overdue[0]!;
    assert.equal(late.id, overdue4);
    assert.equal(late.due_text, `截止 ${shiftDay(today, -4).slice(5)},已逾期 4 天`);
    assert.equal(late.days_from_today, -4);
  });

  it("话术逐块成句、可直接读给家人听", () => {
    f = newFixture();
    const today = todayInTz(TZ);
    newTodo("mama", "交电费", today);
    newTodo("mama", "交物业费", shiftDay(today, -4));

    const env = getToday(f.db, f.callers.mama, TZ);
    ok(env);
    assert.match(env.message, new RegExp(`^今天\\(${today}\\)`));
    assert.match(env.message, /今日到期 1 条:1\. \[t-\d{6}-[a-z2-9]{4}\] 交电费\(今天截止\)/);
    assert.match(env.message, /已逾期 1 条:1\. \[t-\d{6}-[a-z2-9]{4}\] 交物业费\(截止 \d{2}-\d{2},已逾期 4 天\)/);
    // 三块分列:每块自带标题与条数,Agent 可以分别转述。
    assert.match(env.message, /。/);
    assert.doesNotMatch(env.message, /没有到期或逾期/, "非空状态不该出现空状态话术");
  });

  it("只有一块非空时,只说那一块(空块不进话术)", () => {
    f = newFixture();
    const today = todayInTz(TZ);
    newTodo("mama", "交电费", today);

    const env = getToday(f.db, f.callers.mama, TZ);
    ok(env);
    assert.match(env.message, /今日到期 1 条/);
    assert.doesNotMatch(env.message, /已逾期/, "没有逾期就不该出现「已逾期 0 条」");
    assert.doesNotMatch(env.message, /全家日程/, "没有日程就不该出现「全家日程 0 条」");
  });
});

describe("get_today:可见范围(V1/V2 —— 绝不包含他人的个人项)", () => {
  it("他人的待办与个人日程一概不出现(含代记者可见的那些)", () => {
    f = newFixture();
    const today = todayInTz(TZ);

    // 爸爸自己的一条今日到期待办 + 一条今日的个人日程(owner=爸爸 才是个人日程)。
    newTodo("baba", "爸爸的今日待办", today);
    newEvent("baba", { title: "爸爸的私人日程", start: `${today} 15:00`, owner: "爸爸" });
    // 妈妈代爸爸记的(V8:妈妈在 list_todos / list_events 里**看得到**,但它仍是爸爸的私人项)。
    newTodo("mama", "妈妈代爸爸记的待办", today, "爸爸");
    newEvent("mama", { title: "妈妈代爸爸记的日程", start: `${today} 16:00`, owner: "爸爸" });

    const data = todayOf("mama");
    const titles = [
      ...data.due_today.map((t) => t.title),
      ...data.overdue.map((t) => t.title),
      ...data.events.family.map((e) => e.title),
      ...data.events.mine.map((e) => e.title),
    ];
    for (const hidden of ["爸爸的今日待办", "爸爸的私人日程", "妈妈代爸爸记的待办", "妈妈代爸爸记的日程"]) {
      assert.equal(titles.includes(hidden), false, `他人(或他人名下)的项不该出现在今日概览:${hidden}`);
    }

    // 反面:可见性没有被削弱 —— 代记者仍然看得到(V8),只是不进"我的今天"。
    const l = listTodos(f.db, f.callers.mama, TZ, {});
    ok(l);
    assert.deepEqual(
      (l.data as { delegated: { title: string }[] }).delegated.map((t) => t.title),
      ["妈妈代爸爸记的待办"],
      "V8 的查看权必须在 list_todos 里保留",
    );

    // 换个人看:两条待办都是**爸爸名下的**(谁记的不改归属),所以都进他的今天;
    // 妈妈代记的那条也在内 —— 归属决定它归谁,记不记是另一回事(V7 归属不可变)。
    const baba = todayOf("baba");
    assert.deepEqual(baba.due_today.map((t) => t.title).sort(), ["妈妈代爸爸记的待办", "爸爸的今日待办"]);
    assert.deepEqual(
      baba.events.mine.map((e) => e.title).sort(),
      ["妈妈代爸爸记的日程", "爸爸的私人日程"].sort(),
      "归属是爸爸的两条都在他的「我的个人日程」列里",
    );
    assert.deepEqual(baba.events.family, []);
  });

  it("归属人自己的代记者条目进他的今天;代记者本人看不到", () => {
    f = newFixture();
    const today = todayInTz(TZ);
    // 小明代妈妈记的:归属是妈妈(V7 归属不可变)。
    newTodo("kid", "小明代妈妈记的待办", today, "妈妈");
    newEvent("kid", { title: "小明代妈妈记的日程", start: `${today} 08:00`, owner: "妈妈" });

    // 妈妈:两条都是她的(自己记的 + 小明代记的),代记者是谁不影响归属。
    const mama = todayOf("mama");
    assert.deepEqual(mama.due_today.map((t) => t.title), ["小明代妈妈记的待办"]);
    assert.deepEqual(mama.events.mine.map((e) => e.title), ["小明代妈妈记的日程"]);
    // 小明:他是创建者(V8 看得到),但那是**妈妈的**私人项,不属于"我的今天"。
    const kid = todayOf("kid");
    assert.deepEqual(kid.due_today, []);
    assert.deepEqual(kid.overdue, []);
    assert.deepEqual(kid.events, { family: [], mine: [] });
  });

  it("本人自己的项与全家日程照常出现(V1/V2 的正面)", () => {
    f = newFixture();
    const today = todayInTz(TZ);
    newEvent("mama", { title: "全家牙医", start: `${today} 15:00` });
    newTodo("mama", "自己的事", today);

    const data = todayOf("mama");
    assert.deepEqual(data.due_today.map((t) => t.title), ["自己的事"]);
    assert.deepEqual(data.events.family.map((e) => e.title), ["全家牙医"]);
    assert.deepEqual(data.events.mine, []);
  });
});

describe("get_today:今天的日程(重叠判定 / 全家与本人分列)", () => {
  it("全家日程与本人个人日程今天都出现,并各自标明归属列", () => {
    f = newFixture();
    const today = todayInTz(TZ);
    newEvent("mama", { title: "牙医", start: `${today} 15:00`, end: `${today} 16:00` });
    const mineId = newEvent("mama", { title: "看牙", start: `${today} 17:00`, owner: "妈妈" });

    const data = todayOf("mama");
    assert.deepEqual(data.events.family.map((e) => e.title), ["牙医"]);
    assert.deepEqual(data.events.mine.map((e) => e.title), ["看牙"]);
    assert.equal(data.events.family[0]!.column, "family");
    assert.equal(data.events.mine[0]!.id, mineId);
    // 定位信息:id + 时间 + 系列 id(update_event / restore_deleted 的句柄)。
    const e = data.events.family[0]!;
    assert.match(e.id, /^ei-\d{6}-[a-z2-9]{4}$/);
    assert.match(e.series_id, /^e-\d{6}-[a-z2-9]{4}$/);
    assert.equal(e.time_text, `${today} 15:00–16:00`);

    const env = getToday(f.db, f.callers.mama, TZ);
    ok(env);
    assert.match(env.message, /全家日程 1 条:1\. \[ei-\d{6}-[a-z2-9]{4}\] 牙医\(.*\)\(全家日程\)/);
    assert.match(env.message, /我的个人日程 1 条:1\. \[ei-\d{6}-[a-z2-9]{4}\] 看牙\(.*\)\(我的个人日程\)/);
  });

  it("跨今天的进行中日程出现(昨天开始、后天结束),明天的日程不出现", () => {
    f = newFixture();
    const today = todayInTz(TZ);
    newEvent("mama", {
      title: "跨天出差",
      start: `${shiftDay(today, -1)} 22:00`,
      end: `${shiftDay(today, 2)} 06:00`,
    });
    newEvent("mama", { title: "明天的事", start: `${shiftDay(today, 1)} 09:00` });
    newEvent("mama", { title: "昨天已结束", start: `${shiftDay(today, -1)} 09:00`, end: `${shiftDay(today, -1)} 18:00` });

    const data = todayOf("mama");
    assert.deepEqual(data.events.family.map((e) => e.title), ["跨天出差"]);
    assert.equal(data.events.family[0]!.time_text, `${shiftDay(today, -1)} 22:00 至 ${shiftDay(today, 2)} 06:00`);
  });

  it("all_day 的纯日期日程今天出现,邻日的不出现", () => {
    f = newFixture();
    const today = todayInTz(TZ);
    newEvent("mama", { title: "外婆生日", start: today, allDay: true });
    // 全天、跨天(昨天到明天):与今天有重叠 → 出现。
    newEvent("mama", { title: "全家出游", start: shiftDay(today, -1), end: shiftDay(today, 1), allDay: true });
    newEvent("mama", { title: "明天的全天", start: shiftDay(today, 1), allDay: true });

    const data = todayOf("mama");
    assert.deepEqual(
      data.events.family.map((e) => e.title).sort(),
      ["全家出游", "外婆生日"],
    );
    assert.equal(data.events.family.find((e) => e.title === "外婆生日")!.all_day, true);
    assert.equal(data.events.family.find((e) => e.title === "外婆生日")!.time_text, `全天 ${today}`);
  });

  it("重复日程:今天的那一次出现在今天的日程里(与物化/续期同一套读)", () => {
    f = newFixture();
    const today = todayInTz(TZ);
    newEvent("mama", { title: "每天遛狗", start: `${today} 07:30`, repeat: "daily" });

    const data = todayOf("mama");
    assert.deepEqual(data.events.family.map((e) => e.title), ["每天遛狗"]);
    assert.equal(data.events.family[0]!.time_text, `${today} 07:30 起`);
  });

  it("软删的日程不进今天的日程", () => {
    f = newFixture();
    const today = todayInTz(TZ);
    const id = newEvent("mama", { title: "已取消的会", start: `${today} 09:00` });
    // 软删走工具层(与实际调用同一条路:参数校验 + 审计留痕都在这一层)。
    ok(callTool("mama", "delete_event", { id }));

    assert.deepEqual(todayOf("mama").events.family, []);
  });

  it("重复日程已展开到边界之外时,get_today 会先续期再返回(不静默少一条)", () => {
    f = newFixture();
    const today = todayInTz(TZ);
    newEvent("mama", { title: "每天遛狗", start: `${today} 07:30`, repeat: "daily" });

    // 把这个系列的**全部实例整体前移 200 天**,模拟"200 天前创建、之后一直没人读它":
    // 物化边界(最晚的一次)因而落到过去,今天的这一次在库里并不存在。
    const instances = f.db
      .prepare("SELECT id, start, end FROM event_instance ORDER BY start")
      .all() as { id: string; start: string; end: string | null }[];
    assert.ok(instances.length > 0, "前置条件:系列已物化出实例");
    f.db.transaction(() => {
      for (const row of instances) {
        f.db
          .prepare("UPDATE event_instance SET start = ?, end = ? WHERE id = ?")
          .run(
            shiftDay(row.start.slice(0, 10), -200) + row.start.slice(10),
            row.end === null ? null : shiftDay(row.end.slice(0, 10), -200) + row.end.slice(10),
            row.id,
          );
      }
    })();
    const raw = f.db
      .prepare("SELECT COUNT(*) AS n FROM event_instance WHERE start LIKE ?")
      .get(`${today}%`) as { n: number };
    assert.equal(raw.n, 0, "前置条件:今天这一次的实例不在库里(已滚出物化窗口)");

    // get_today 仍然要给出今天的那一次 —— 它与 list_events 走同一条惰性续期路径。
    // 少一条每天重复的日程比多一句解释更糟(回执静默失真)。
    const data = todayOf("mama");
    assert.deepEqual(data.events.family.map((e) => e.title), ["每天遛狗"]);
    assert.equal(data.events.family[0]!.time_text, `${today} 07:30 起`);

    // 续期是写在读路径上的写,但读工具**不记审计**(与 list_events 同一纪律)。
    assert.deepEqual(listAudit(f.db), []);
  });
});

describe("get_today:「今天」按配置时区算(不读系统本地时区)", () => {
  /**
   * 选这两个时区的原因:Pacific/Kiritimati(UTC+14)与 America/Los_Angeles(UTC-7/-8)
   * 恒差**一整天**,所以无论测试在哪个时刻跑,两地的日历日都不相同。
   * 于是"同一条数据、换 FA_TIMEZONE、分类必须不同"就成了可复现的断言 ——
   * 若「今天」来自任何固定值(系统本地时区、UTC、或写死日期),两次结果会完全一样。
   */
  const TZ_EARLY = "Pacific/Kiritimati"; // 总是比下面那个"早一天"(即日期更晚)
  const TZ_LATE = "America/Los_Angeles";

  it("同一条待办在两个时区下分别算「今日到期」与「逾期」", () => {
    f = newFixture();
    const lateToday = todayInTz(TZ_LATE);
    const earlyToday = todayInTz(TZ_EARLY);

    // 前置事实:两地日历日恒差一天(否则这条用例说明不了问题)。
    assert.equal(earlyToday, shiftDay(lateToday, 1), "两个时区的今天应恰好差一天");

    newTodo("mama", "边界待办", lateToday);
    newTodo("mama", "另一天的待办", earlyToday);

    // 在"晚一天"的时区看:lateToday 是今天 → 第一块。
    const asLate = todayOf("mama", TZ_LATE);
    assert.equal(asLate.today, lateToday);
    assert.deepEqual(asLate.due_today.map((t) => t.title), ["边界待办"]);
    assert.deepEqual(asLate.overdue, []);

    // 换到"早一天"的时区:同一条待办已经逾期;而"另一天的待办"成了今天。
    const asEarly = todayOf("mama", TZ_EARLY);
    assert.equal(asEarly.today, earlyToday);
    assert.deepEqual(asEarly.overdue.map((t) => t.title), ["边界待办"]);
    assert.equal(asEarly.overdue[0]!.due_text, `截止 ${lateToday.slice(5)},已逾期 1 天`);
    assert.deepEqual(asEarly.due_today.map((t) => t.title), ["另一天的待办"]);
  });

  it("日程的「今天」同样按配置时区:昨天的全天日程在一个时区出现、在另一个不出现", () => {
    f = newFixture();
    const lateToday = todayInTz(TZ_LATE);
    // 这条全天日程落在"晚一天时区"的今天,在"早一天时区"里是昨天。
    newEvent("mama", { title: "跨时区的全天", start: lateToday, allDay: true });

    assert.deepEqual(todayOf("mama", TZ_LATE).events.family.map((e) => e.title), ["跨时区的全天"]);
    assert.deepEqual(todayOf("mama", TZ_EARLY).events.family, []);
  });

  it("同一条待办在两个时区下的逾期天数不同", () => {
    f = newFixture();
    const lateToday = todayInTz(TZ_LATE);
    newTodo("mama", "很早以前的事", shiftDay(lateToday, -10));

    assert.equal(todayOf("mama", TZ_LATE).overdue[0]!.days_from_today, -10);
    assert.equal(todayOf("mama", TZ_EARLY).overdue[0]!.days_from_today, -11);
  });
});

describe("get_today:空状态与参数纪律", () => {
  it("三块都空:ok:true,并给一句明确的空状态话术(不返回空壳)", () => {
    f = newFixture();
    // 别人的事不算数:爸爸的待办与**个人**日程都不进妈妈的今天。
    newTodo("baba", "爸爸的事", todayInTz(TZ));
    newEvent("baba", { title: "爸爸的私人日程", start: `${todayInTz(TZ)} 15:00`, owner: "爸爸" });

    const env = getToday(f.db, f.callers.mama, TZ);
    ok(env);
    const data = env.data as TodayData;
    assert.deepEqual(data.due_today, []);
    assert.deepEqual(data.overdue, []);
    assert.deepEqual(data.events, { family: [], mine: [] });
    assert.match(env.message, /^今天\(\d{4}-\d{2}-\d{2}\)没有你的日程,也没有到期或逾期的待办/);
    assert.match(env.message, /今天没有需要你处理的事。/);
  });

  it("X15:传任何参数都返回 INVALID_PARAMS(含 as_member / owner)", () => {
    f = newFixture();
    for (const args of [{ as_member: "爸爸" }, { owner: "爸爸" }, { timezone: "UTC" }, { date: "2026-10-05" }]) {
      const env = callTool("mama", "get_today", args);
      fail(env);
      assert.equal(env.code, "INVALID_PARAMS", `应拒绝:${JSON.stringify(args)}`);
      assert.match(env.message, /不接受未知参数/);
    }
    // 身份参数那一档还要点破"说话人不是参数"(X15 的落点)。
    const withIdentity = callTool("mama", "get_today", { as_member: "爸爸" });
    fail(withIdentity);
    assert.equal(withIdentity.field, "as_member");
    assert.match(withIdentity.message, /说话人由连接确定/);
    assert.match(withIdentity.hint ?? "", /不接收任何参数|本工具/);

    // 不传参数才是唯一正确用法。
    const fine = callTool("mama", "get_today", {});
    ok(fine);
    const alsoFine = callTool("mama", "get_today", undefined);
    ok(alsoFine);
  });

  it("schema 是 strict 的空对象:没有身份参数形态,additionalProperties=false", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "get_today")!;
    assert.deepEqual(tool.inputSchema.properties, {});
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.required, undefined);
  });

  it("审计:get_today 是读工具,不留痕", () => {
    f = newFixture();
    newTodo("mama", "交电费", todayInTz(TZ));
    newEvent("mama", { title: "牙医", start: `${todayInTz(TZ)} 15:00` });

    ok(callTool("mama", "get_today", {}));
    assert.deepEqual(listAudit(f.db), [], "读工具不得留下审计行");

    // 对照:写工具仍然留痕,证明"没留痕"不是因为审计坏了。
    ok(callTool("mama", "add_todo", { title: "另一件事" }));
    const rows = listAudit(f.db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tool, "add_todo");
  });

  it("get_today 读出的是**说话人**的今天,两个 token 各看各的", () => {
    f = newFixture();
    const today = todayInTz(TZ);
    newTodo("mama", "妈妈的今日待办", today);
    newTodo("baba", "爸爸的今日待办", today);
    newEvent("mama", { title: "全家的会", start: `${today} 19:00` });

    const mama = todayOf("mama");
    const baba = todayOf("baba");
    assert.deepEqual(mama.due_today.map((t) => t.title), ["妈妈的今日待办"]);
    assert.deepEqual(baba.due_today.map((t) => t.title), ["爸爸的今日待办"]);
    // 全家日程两人都看得到(V2)。
    assert.deepEqual(mama.events.family.map((e) => e.title), ["全家的会"]);
    assert.deepEqual(baba.events.family.map((e) => e.title), ["全家的会"]);
  });
});