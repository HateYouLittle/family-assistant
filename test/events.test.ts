import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { listAudit } from "../src/audit/audit.js";
import { todayInTz } from "../src/db/id.js";
import type { Envelope, FailEnvelope, OkEnvelope } from "../src/domain/envelope.js";
import { addEvent, deleteEvent, listEvents, updateEvent, type AddEventInput, type EventView } from "../src/domain/events.js";
import { restoreDeleted } from "../src/domain/restore.js";
import { TOOL_DEFINITIONS } from "../src/mcp/tools.js";
import { newFixture, TZ, type Fixture, type FixtureKey } from "./helpers.js";

/**
 * 日程域(S2:add_event / list_events / update_event / delete_event + restore_deleted(kind="event"))。
 * 对照:设计方案 §4 日程真值表 + V1/V2/V3/V4/V5/V7/V8,反例 X3/X8/X11/X15。
 *
 * 三条纪律(与 S1 一致,且是本阶段的硬要求):
 * 1. **权限判定排在任何"行内信息"之前**:凡是会回出标题/时间的分支(包括"未做修改"
 *    这类幂等成功)都必须排在可见性闸门之后。S1 的 restoreTodo 就因为顺序反了,
 *    让越权者凭 id 探到了他人待办的标题 —— 这里用一组否定断言把顺序钉死。
 * 2. 每条用例都直查**原始行**(rawSeries / rawInstance):系列与实例的软删联动、
 *    "被拒的调用不得留下任何写入"、"缺省字段不得被改动"都只能靠读库证明。
 * 3. 直接调 domain 函数(参数校验在工具层,那部分走 callTool)。
 *
 * 本阶段**不含重复日程**:每次 add_event 造 1 个 repeat='none' 的系列 + 1 个实例
 * (S2b 才做按重复规则物化 92 天与惰性续期)。
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

interface RawSeriesRow {
  id: string;
  owner_id: string | null;
  title: string;
  location: string | null;
  notes: string | null;
  repeat: string;
  repeat_interval: number;
  repeat_until: string | null;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
}

interface RawInstanceRow {
  id: string;
  series_id: string;
  owner_id: string | null;
  title: string;
  location: string | null;
  notes: string | null;
  start: string;
  end: string | null;
  all_day: number;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
}

/** 直读原始行:证明"没有写入"要靠库,不能靠信封。 */
function rawSeries(id: string): RawSeriesRow {
  const row = f.db.prepare("SELECT * FROM event_series WHERE id = ?").get(id) as RawSeriesRow | undefined;
  assert.ok(row, `库里没有这个系列:${id}`);
  return row!;
}

function rawInstance(id: string): RawInstanceRow {
  const row = f.db.prepare("SELECT * FROM event_instance WHERE id = ?").get(id) as RawInstanceRow | undefined;
  assert.ok(row, `库里没有这个日程实例:${id}`);
  return row!;
}

/** 某系列下的全部实例(按开始时间排序);用于证明"删系列连带删实例"。 */
function instancesOf(seriesId: string): RawInstanceRow[] {
  return f.db
    .prepare("SELECT * FROM event_instance WHERE series_id = ? ORDER BY start, id")
    .all(seriesId) as RawInstanceRow[];
}

/** 建一条日程,返回系列 id 与实例 id(list_events 返回的是实例)。 */
function newEvent(key: FixtureKey, input: AddEventInput): { seriesId: string; instanceId: string } {
  const env = addEvent(f.db, f.callers[key], TZ, input);
  ok(env);
  const v = env.data as EventView;
  return { seriesId: v.series_id, instanceId: v.id };
}

/** 走工具层(参数校验 + 审计留痕),参数不合规时直接返回 parse 的失败信封。 */
function callTool(key: FixtureKey, name: string, args: unknown): Envelope {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
  assert.ok(tool, `未知工具 ${name}`);
  const parsed = tool!.parse(args);
  return parsed.ok ? tool!.run(f.db, f.callers[key], TZ, parsed.args) : parsed.envelope;
}

/** 查一个固定时间窗(2031-06),避开"今天",让断言只与被测行为有关。 */
function listJune(key: FixtureKey, scope?: "family" | "mine"): ListData {
  const env = listEvents(f.db, f.callers[key], TZ, {
    start: "2031-06-01",
    end: "2031-06-30",
    ...(scope ? { scope } : {}),
  });
  ok(env);
  return env.data as ListData;
}

const JUNE = { start: "2031-06-01", end: "2031-06-30" } as const;

describe("add_event:owner 缺省 = 全家日程(V2),指定 = 个人日程(V1)", () => {
  it("owner 缺省 → owner_id 为空的全家日程,回执写明全家可见;系列 repeat='none' 且只造 1 个实例", () => {
    f = newFixture();
    const env = addEvent(f.db, f.callers.mama, TZ, {
      title: "家长会",
      start: "2031-06-01 09:00",
      end: "2031-06-01 10:00",
      location: "学校",
    });
    ok(env);
    const v = env.data as EventView;
    assert.equal(v.owner_id, null, "owner 缺省必须是全家日程(owner_id 为空)");
    assert.equal(v.owner_name, null);
    assert.equal(v.title, "家长会");
    assert.equal(v.start, "2031-06-01 09:00");
    assert.equal(v.end, "2031-06-01 10:00");
    assert.equal(v.all_day, false);
    assert.equal(v.location, "学校");
    assert.equal(v.delegated, false);
    assert.match(v.id, /^ei-\d{6}-[a-z2-9]{4}$/, "实例 id 前缀为 ei-");
    assert.match(v.series_id, /^e-\d{6}-[a-z2-9]{4}$/, "系列 id 前缀为 e-");
    assert.match(env.message, new RegExp(`^已添加全家日程 \\[${v.id}\\]:家长会\\(2031-06-01 09:00–10:00\\)。全家成员都能看到。$`));

    // 本阶段没有重复日程:系列 repeat='none',且恰好物化出 1 个实例(S2b 才扩到 92 天)。
    const series = rawSeries(v.series_id);
    assert.equal(series.owner_id, null);
    assert.equal(series.repeat, "none");
    assert.equal(series.repeat_interval, 1);
    assert.equal(series.repeat_until, null);
    assert.deepEqual(instancesOf(v.series_id).map((i) => i.id), [v.id]);
  });

  it("owner=他人 → 该人的个人日程 + 代记话术(V4):仅 TA 可见,由 <说话人> 代记", () => {
    f = newFixture();
    const env = addEvent(f.db, f.callers.mama, TZ, {
      owner: "爸爸",
      title: "买酱油",
      start: "2031-06-02 18:00",
    });
    ok(env);
    const v = env.data as EventView;
    assert.equal(v.owner_id, f.members.baba.id);
    assert.equal(v.owner_name, "爸爸");
    assert.equal(v.delegated, true);
    assert.match(env.message, new RegExp(`^已为 爸爸 添加日程 \\[${v.id}\\]:买酱油\\(2031-06-02 18:00 起\\)。仅 爸爸 可见,由 妈妈 代记。$`));
    // 系列的 owner_id 与实例一致(V7 两侧都要钉住归属)
    assert.equal(rawSeries(v.series_id).owner_id, f.members.baba.id);
    assert.equal(rawInstance(v.id).owner_id, f.members.baba.id);
  });

  it("owner=本人 → 个人日程(不是全家日程),回执为「仅你自己可见」", () => {
    f = newFixture();
    const env = addEvent(f.db, f.callers.mama, TZ, {
      owner: "妈妈",
      title: "看牙医",
      start: "2031-06-03 15:00",
    });
    ok(env);
    const v = env.data as EventView;
    assert.equal(v.owner_id, f.members.mama.id, "显式传 owner=本人 也应是个人日程");
    assert.equal(v.delegated, false, "自己给自己记不算代记");
    assert.match(env.message, new RegExp(`^已添加日程 \\[${v.id}\\]:看牙医\\(2031-06-03 15:00 起\\)。仅你自己可见。$`));
  });

  it("owner 名字不存在 → MISSING_PARAMS + 成员名单,且不落库(X10)", () => {
    f = newFixture();
    const env = addEvent(f.db, f.callers.mama, TZ, {
      owner: "查无此人",
      title: "买酱油",
      start: "2031-06-02 18:00",
    });
    fail(env);
    assert.equal(env.code, "MISSING_PARAMS");
    assert.deepEqual(env.missing, ["owner"]);
    assert.match(env.message, /家庭成员有:妈妈、爸爸、小明/);
    assert.match(env.hint ?? "", /先调 list_members/);
    const n = f.db.prepare("SELECT COUNT(*) AS n FROM event_series").get() as { n: number };
    assert.equal(n.n, 0, "归属解析失败不得留下系列");
  });

  it("all_day=true → start/end 为纯日期,实例 all_day=1", () => {
    f = newFixture();
    const env = addEvent(f.db, f.callers.kid, TZ, {
      title: "春游",
      start: "2031-06-05",
      end: "2031-06-05",
      all_day: true,
    });
    ok(env);
    const v = env.data as EventView;
    assert.equal(v.all_day, true);
    assert.equal(v.start, "2031-06-05");
    assert.equal(v.end, "2031-06-05");
    assert.match(env.message, new RegExp(`^已添加全家日程 \\[${v.id}\\]:春游\\(全天 2031-06-05\\)。`));
    assert.equal(rawInstance(v.id).all_day, 1);
  });
});

describe("list_events:可见性过滤(V1/V2/V5/X3)", () => {
  it("全家日程人人可见;妈妈的个人日程不出现在爸爸的结果里", () => {
    f = newFixture();
    newEvent("mama", { title: "家长会", start: "2031-06-01 09:00" });
    newEvent("mama", { owner: "妈妈", title: "看牙医", start: "2031-06-02 15:00" });

    const babaView = listJune("baba");
    assert.deepEqual(babaView.family.map((v) => v.title), ["家长会"], "爸爸应看到全家日程");
    assert.deepEqual(babaView.mine, [], "爸爸没有个人日程");
    assert.doesNotMatch(JSON.stringify(babaView), /看牙医/, "妈妈的个人日程不得出现在爸爸的结果里(V1)");

    const mamaView = listJune("mama");
    assert.deepEqual(mamaView.family.map((v) => v.title), ["家长会"]);
    assert.deepEqual(mamaView.mine.map((v) => v.title), ["看牙医"]);

    const kidView = listJune("kid");
    assert.deepEqual(kidView.family.map((v) => v.title), ["家长会"]);
    assert.deepEqual(kidView.mine, []);
  });

  it("scope=family 只返回全家日程;scope=mine 只返回本人的个人日程", () => {
    f = newFixture();
    newEvent("mama", { title: "家长会", start: "2031-06-01 09:00" });
    newEvent("mama", { owner: "妈妈", title: "看牙医", start: "2031-06-02 15:00" });

    const family = listJune("mama", "family");
    assert.deepEqual(family.family.map((v) => v.title), ["家长会"]);
    assert.deepEqual(family.mine, [], "scope=family 不得带出本人的个人日程");
    assert.deepEqual(family.delegated, []);

    const mine = listJune("mama", "mine");
    assert.deepEqual(mine.mine.map((v) => v.title), ["看牙医"]);
    assert.deepEqual(mine.family, [], "scope=mine 不得带出全家日程");

    // 爸爸:scope=mine 看不到妈妈的个人日程(V1),scope=family 看得见全家日程(V2)
    assert.deepEqual(listJune("baba", "mine").mine, []);
    assert.deepEqual(listJune("baba", "family").family.map((v) => v.title), ["家长会"]);
  });

  it("X3:爸爸 list_events(owner=妈妈) → INVALID_PARAMS(未知字段),不是静默空表", () => {
    f = newFixture();
    newEvent("mama", { owner: "妈妈", title: "看牙医", start: "2031-06-02 15:00" });

    const env = callTool("baba", "list_events", { ...JUNE, owner: "妈妈" });
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "owner");
    assert.match(env.message, /不接受未知参数:owner/);
    // 关键:必须响亮失败。若实现成"忽略未知字段 + 返回空表",Agent 会误报"妈妈六月没安排"。
    const viaDomain = listEvents(f.db, f.callers.baba, TZ, { ...JUNE, scope: "mine" });
    ok(viaDomain);
    assert.deepEqual((viaDomain.data as ListData).mine, [], "确认真值:爸爸的 mine 视图本就是空的");
  });

  it("X15:list_events 传 as_member → INVALID_PARAMS,并点破说话人不是参数", () => {
    f = newFixture();
    const env = callTool("mama", "list_events", { ...JUNE, as_member: "爸爸" });
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "as_member");
    assert.match(env.message, /说话人由连接确定/);
  });

  it("时间窗按重叠判定、边界含端点;纯日期的 end 覆盖当天整天", () => {
    f = newFixture();
    newEvent("mama", { title: "上午会", start: "2031-06-01 09:00", end: "2031-06-01 10:00" });
    newEvent("mama", { title: "全天会", start: "2031-06-03", end: "2031-06-03", all_day: true });

    // 窗口起点正好等于事件开始时刻 → 含端点
    const edgeStart = listEvents(f.db, f.callers.mama, TZ, { start: "2031-06-01 09:00", end: "2031-06-01 09:00" });
    ok(edgeStart);
    assert.deepEqual((edgeStart.data as ListData).family.map((v) => v.title), ["上午会"]);

    // 窗口终点正好等于事件结束时刻 → 含端点
    const edgeEnd = listEvents(f.db, f.callers.mama, TZ, { start: "2031-06-01 10:00", end: "2031-06-01 10:00" });
    ok(edgeEnd);
    assert.deepEqual((edgeEnd.data as ListData).family.map((v) => v.title), ["上午会"]);

    // 纯日期窗口 = 当天整天:09:00 的日程与全天日程都应命中 06-03
    const dayWindow = listEvents(f.db, f.callers.mama, TZ, { start: "2031-06-03", end: "2031-06-03" });
    ok(dayWindow);
    assert.deepEqual((dayWindow.data as ListData).family.map((v) => v.title), ["全天会"]);

    // 窗口在事件之前 → 空表,且 message 说清是哪个时间窗没有日程
    const empty = listEvents(f.db, f.callers.mama, TZ, { start: "2031-06-10", end: "2031-06-11" });
    ok(empty);
    assert.deepEqual(empty.data, { family: [], mine: [], delegated: [] });
    assert.equal(empty.message, "2031-06-10 至 2031-06-11 没有日程。");
  });

  it("家庭时区下「今天」的日程查得到(口径取配置时区,不依赖系统本地时区)", () => {
    f = newFixture();
    const today = todayInTz(TZ);
    newEvent("mama", { title: "今天的会", start: `${today} 09:00`, end: `${today} 10:00` });
    newEvent("mama", { title: "今天全天", start: today, end: today, all_day: true });

    const env = listEvents(f.db, f.callers.mama, TZ, { start: today, end: today });
    ok(env);
    assert.deepEqual((env.data as ListData).family.map((v) => v.title).sort(), ["今天全天", "今天的会"]);
    assert.match(env.message, new RegExp(`^今天 ${today} 至 ${today}:`), "空表话术里的「今天」按配置时区判定");

    // 空表话术里的「今天」同样按配置时区判定:爸爸今天没有个人日程
const emptyToday = listEvents(f.db, f.callers.baba, TZ, { start: today, end: today, scope: "mine" });
    ok(emptyToday);
    assert.equal(emptyToday.message, `今天 ${today} 至 ${today} 没有日程。`);
  });

  it("缺 start / 缺 end 参数 → MISSING_PARAMS(工具层)", () => {
    f = newFixture();
    const noStart = callTool("mama", "list_events", { end: "2031-06-30" });
    fail(noStart);
    assert.equal(noStart.code, "MISSING_PARAMS");
    assert.deepEqual(noStart.missing, ["start"]);

    const noEnd = callTool("mama", "list_events", { start: "2031-06-01" });
    fail(noEnd);
    assert.equal(noEnd.code, "MISSING_PARAMS");
    assert.deepEqual(noEnd.missing, ["end"]);
  });

  it("时间窗 end < start → INVALID_PARAMS", () => {
    f = newFixture();
    const env = callTool("mama", "list_events", { start: "2031-06-30", end: "2031-06-01" });
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "end");
    assert.match(env.message, /结束不能早于开始/);
  });
});

describe("update_event:全家日程任何成员可改(V3 家庭内互信,X8)", () => {
  it("X8:小明改全家日程 → 放行,回执标注操作者;改完妈妈的 list_events 能看到改动", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { title: "家长会", start: "2031-06-01 09:00", location: "学校" });

    const env = updateEvent(f.db, f.callers.kid, TZ, { id: instanceId, title: "家长会(改期)", location: null });
    ok(env);
    assert.match(
      env.message,
      new RegExp(`^已由 小明 更新全家日程 \\[${instanceId}\\]:家长会\\(改期\\)\\(2031-06-01 09:00 起\\)。改动:标题→「家长会\\(改期\\)」;地点已清空。$`),
    );

    // 系列与实例的标题/地点都同步(实例才是 list_events 返回的东西)
    const seriesId = rawInstance(instanceId).series_id;
    assert.equal(rawSeries(seriesId).title, "家长会(改期)");
    assert.equal(rawInstance(instanceId).title, "家长会(改期)");
    assert.equal(rawSeries(seriesId).location, null);
    assert.equal(rawInstance(instanceId).location, null);

    const mamaView = listJune("mama");
    assert.deepEqual(mamaView.family.map((v) => v.title), ["家长会(改期)"]);
  });

  it("改时间只落在实例上(系列没有时间字段);全天↔带时刻必须显式改 all_day", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { title: "家长会", start: "2031-06-01 09:00", end: "2031-06-01 10:00" });

    const shifted = updateEvent(f.db, f.callers.mama, TZ, { id: instanceId, start: "2031-06-02 14:00", end: "2031-06-02 15:00" });
    ok(shifted);
    assert.match(shifted.message, /改动:开始时间改为 2031-06-02 14:00;结束时间改为 2031-06-02 15:00。$/);
    const row = rawInstance(instanceId);
    assert.equal(row.start, "2031-06-02 14:00");
    assert.equal(row.end, "2031-06-02 15:00");

    // 反向:改 all_day 却沿用带时刻的 start → 联合校验拦住(§5.1 ④)
    const half = updateEvent(f.db, f.callers.mama, TZ, { id: instanceId, all_day: true });
    fail(half);
    assert.equal(half.code, "INVALID_PARAMS");
    assert.equal(half.field, "start");
    assert.match(half.message, /全天日程/);
    assert.equal(rawInstance(instanceId).all_day, 0, "被拒的调用不得留下写入");
  });

  it("X11/V7:把全家日程改成个人日程 → DENIED(immutable),话术给出删除后重建的出路", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { title: "家长会", start: "2031-06-01 09:00" });

    const env = updateEvent(f.db, f.callers.baba, TZ, { id: instanceId, owner: "爸爸" });
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "immutable");
    assert.match(env.message, /归属\/账本不可修改,如需变更请删除后重建/);
    assert.match(env.message, /是全家日程,不能把它改成「爸爸」名下的个人日程/);
    assert.match(env.hint ?? "", /delete_event/);
    assert.match(env.hint ?? "", /add_event\(owner="爸爸"\)/);
    assert.equal(rawSeries(rawInstance(instanceId).series_id).owner_id, null, "被拒的调用不得改归属");
  });

  it("V7:个人日程 owner 传现值(成员名/别名/成员 id)→ 幂等放行;异值 → DENIED(immutable)", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { owner: "妈妈", title: "看牙医", start: "2031-06-02 15:00" });

    for (const owner of ["妈妈", f.members.mama.id]) {
      const env = updateEvent(f.db, f.callers.mama, TZ, { id: instanceId, owner });
      ok(env);
      assert.match(env.message, /未做修改\(没有字段发生变化\)/, `同值 owner 应幂等放行:${owner}`);
      assert.equal(rawSeries(rawInstance(instanceId).series_id).owner_id, f.members.mama.id);
    }

    const other = updateEvent(f.db, f.callers.mama, TZ, { id: instanceId, owner: "小明" });
    fail(other);
    assert.equal(other.reason, "immutable");
    assert.match(other.message, /记在 妈妈 名下,你不能把它改成「小明」名下的/);
  });

  it("owner 与现值不符且写对其他字段 → 整次调用被拒,其他字段也不落库", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { owner: "妈妈", title: "看牙医", start: "2031-06-02 15:00" });

    const env = updateEvent(f.db, f.callers.mama, TZ, { id: instanceId, owner: "爸爸", title: "偷偷改" });
    fail(env);
    assert.equal(env.reason, "immutable");
    assert.equal(rawInstance(instanceId).title, "看牙医");
  });

  it("owner 匹配不到成员 → MISSING_PARAMS + 成员名单(复用 X10 口径)", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { owner: "妈妈", title: "看牙医", start: "2031-06-02 15:00" });

    const env = updateEvent(f.db, f.callers.mama, TZ, { id: instanceId, owner: "查无此人" });
    fail(env);
    assert.equal(env.code, "MISSING_PARAMS");
    assert.deepEqual(env.missing, ["owner"]);
    assert.match(env.message, /家庭成员有:妈妈、爸爸、小明/);
  });

  it("不存在的 id → NOT_FOUND + 引导先 list(P5);已删的条目 → NOT_FOUND 并给出恢复出路", () => {
    f = newFixture();
    const missing = updateEvent(f.db, f.callers.mama, TZ, { id: "ei-261001-zzzz", title: "x" });
    fail(missing);
    assert.equal(missing.code, "NOT_FOUND");
    assert.equal(missing.id, "ei-261001-zzzz");
    assert.match(missing.hint ?? "", /先调 list_events/);

    const { instanceId } = newEvent("mama", { title: "家长会", start: "2031-06-01 09:00" });
    ok(deleteEvent(f.db, f.callers.mama, instanceId));
    const afterDelete = updateEvent(f.db, f.callers.mama, TZ, { id: instanceId, title: "x" });
    fail(afterDelete);
    assert.equal(afterDelete.code, "NOT_FOUND");
    assert.match(afterDelete.message, /已被删除,无法修改/);
    assert.match(afterDelete.hint ?? "", /restore_deleted/);
  });

  it("置空语义(§5.1③):location=null 清空;缺省 location 的调用不改动它", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { title: "家长会", start: "2031-06-01 09:00", location: "学校", notes: "带成绩单" });

    // 只改标题:缺省的 location / notes 一律不动
    const renamed = updateEvent(f.db, f.callers.mama, TZ, { id: instanceId, title: "家长会(二)" });
    ok(renamed);
    assert.match(renamed.message, /改动:标题→「家长会\(二\)」。$/);
    assert.equal(rawInstance(instanceId).location, "学校");
    assert.equal(rawInstance(instanceId).notes, "带成绩单");

    // 显式 null:清空
    const cleared = updateEvent(f.db, f.callers.mama, TZ, { id: instanceId, location: null });
    ok(cleared);
    assert.match(cleared.message, /改动:地点已清空。$/);
    assert.equal(rawInstance(instanceId).location, null);
    assert.equal(rawInstance(instanceId).notes, "带成绩单");

    const notesCleared = updateEvent(f.db, f.callers.mama, TZ, { id: instanceId, notes: null });
    ok(notesCleared);
    assert.match(notesCleared.message, /改动:备注已清空。$/);
    assert.equal(rawInstance(instanceId).notes, null);

    // end=null 清空结束时间
    const { instanceId: withEnd } = newEvent("mama", { title: "会", start: "2031-06-01 09:00", end: "2031-06-01 10:00" });
    const noEnd = updateEvent(f.db, f.callers.mama, TZ, { id: withEnd, end: null });
    ok(noEnd);
    assert.match(noEnd.message, /改动:已去掉结束时间。$/);
    assert.equal(rawInstance(withEnd).end, null);
  });

  it("值与现值相同 → 幂等,一个字都不写库", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { title: "家长会", start: "2031-06-01 09:00", location: "学校" });
    const beforeSeries = rawSeries(rawInstance(instanceId).series_id);
    const beforeInstance = rawInstance(instanceId);

    const env = updateEvent(f.db, f.callers.mama, TZ, {
      id: instanceId,
      title: "家长会",
      location: "学校",
      start: "2031-06-01 09:00",
    });
    ok(env);
    assert.match(env.message, /未做修改\(没有字段发生变化\)/);
    assert.deepEqual(rawSeries(rawInstance(instanceId).series_id), beforeSeries);
    assert.deepEqual(rawInstance(instanceId), beforeInstance);
  });

  it("工具层拒绝 done 与身份参数(P8/X15);缺 id → MISSING_PARAMS", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { title: "家长会", start: "2031-06-01 09:00" });

    const done = callTool("mama", "update_event", { id: instanceId, done: true });
    fail(done);
    assert.equal(done.code, "INVALID_PARAMS");
    assert.equal(done.field, "done");

    const whoami = callTool("mama", "update_event", { id: instanceId, as_member: "爸爸" });
    fail(whoami);
    assert.equal(whoami.code, "INVALID_PARAMS");
    assert.equal(whoami.field, "as_member");
    assert.match(whoami.message, /说话人由连接确定/);

    const noId = callTool("mama", "update_event", { title: "x" });
    fail(noId);
    assert.equal(noId.code, "MISSING_PARAMS");
    assert.deepEqual(noId.missing, ["id"]);
    assert.equal(rawInstance(instanceId).title, "家长会", "被拒的调用不得落库");
  });
});

describe("V8/X16 代记的个人日程:归属人可改可删,代记者可见可删不可改", () => {
  it("归属人(爸爸)本人可改可删", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { owner: "爸爸", title: "买酱油", start: "2031-06-02 18:00" });

    const upd = updateEvent(f.db, f.callers.baba, TZ, { id: instanceId, title: "买酱油 打折时买" });
    ok(upd);
    assert.match(upd.message, new RegExp(`^已更新日程 \\[${instanceId}\\]:买酱油 打折时买\\(2031-06-02 18:00 起\\)。改动:标题→「买酱油 打折时买」。$`));
    assert.equal(rawInstance(instanceId).title, "买酱油 打折时买");

    const del = deleteEvent(f.db, f.callers.baba, instanceId);
    ok(del);
    assert.notEqual(rawInstance(instanceId).deleted_at, null);
  });

  it("代记者(妈妈)能看到自己代记的条目(默认视图的 delegated 桶),但 scope=mine 不含它", () => {
    f = newFixture();
    newEvent("mama", { owner: "爸爸", title: "买酱油", start: "2031-06-02 18:00" });

    const view = listJune("mama");
    assert.deepEqual(view.delegated.map((v) => v.title), ["买酱油"], "V8 的查看权:代记者能在 list_events 里看到");
    assert.deepEqual(view.mine, []);
    assert.deepEqual(listJune("mama", "mine").delegated, [], "scope=mine 严格只含本人名下(V1)");

    const babaView = listJune("baba");
    assert.deepEqual(babaView.mine.map((v) => v.title), ["买酱油"], "归属人看得到它,归在自己名下");
    assert.deepEqual(listJune("kid").delegated, [], "第三人看不到");
    assert.doesNotMatch(JSON.stringify(listJune("kid")), /买酱油/);
  });

  it("代记者 delete → 回执标注已撤回你代记的日程(V8)", () => {
    f = newFixture();
    const { instanceId, seriesId } = newEvent("mama", { owner: "爸爸", title: "买酱油", start: "2031-06-02 18:00" });

    const env = deleteEvent(f.db, f.callers.mama, instanceId);
    ok(env);
    assert.match(
      env.message,
      new RegExp(
        `^已撤回你代记的日程 \\[${instanceId}\\]:买酱油\\(2031-06-02 18:00 起\\)\\(归属:爸爸,系列 ${seriesId}\\)。` +
          `爸爸 的日程列表里不再有它;可用 restore_deleted\\(kind="event", id="${seriesId}"\\) 恢复。$`,
      ),
    );
    assert.notEqual(rawSeries(seriesId).deleted_at, null);
    assert.notEqual(rawInstance(instanceId).deleted_at, null);
  });

  it("代记者 update → DENIED(not_writable),且不留下任何写入", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { owner: "爸爸", title: "买酱油", start: "2031-06-02 18:00", notes: "用微信付" });
    const beforeSeries = rawSeries(rawInstance(instanceId).series_id);
    const beforeInstance = rawInstance(instanceId);

    const env = updateEvent(f.db, f.callers.mama, TZ, { id: instanceId, title: "偷偷改", notes: null, end: null });
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_writable");
    assert.match(env.message, /这条日程是你代 爸爸 记的,只能由 爸爸 本人修改/);
    assert.match(env.hint ?? "", /delete_event 撤回/);
    assert.deepEqual(rawSeries(rawInstance(instanceId).series_id), beforeSeries);
    assert.deepEqual(rawInstance(instanceId), beforeInstance, "被拒的调用不得留下任何写入");
  });

  it("第三人(小明)对代记条目 → 一律 not_visible(不是 not_writable)", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { owner: "爸爸", title: "买酱油", start: "2031-06-02 18:00" });

    const upd = updateEvent(f.db, f.callers.kid, TZ, { id: instanceId, title: "偷偷改" });
    fail(upd);
    assert.equal(upd.reason, "not_visible");

    const del = deleteEvent(f.db, f.callers.kid, instanceId);
    fail(del);
    assert.equal(del.reason, "not_visible");
    assert.equal(rawInstance(instanceId).deleted_at, null, "被拒的删除不得生效");
  });
});

describe("delete_event + restore_deleted:软删联动(系列 + 实例)与可逆", () => {
  it("删除后 list_events 不再出现、系列与实例的 deleted_at 都非空;恢复后字段与删除前一致", () => {
    f = newFixture();
    const { instanceId, seriesId } = newEvent("mama", {
      title: "家长会",
      start: "2031-06-01 09:00",
      end: "2031-06-01 10:00",
      location: "学校",
    });
    const beforeSeries = rawSeries(seriesId);
    const beforeInstance = rawInstance(instanceId);

    const del = deleteEvent(f.db, f.callers.mama, instanceId);
    ok(del);
    assert.match(
      del.message,
      new RegExp(
        `^已由 妈妈 删除全家日程 \\[${instanceId}\\]:家长会\\(2031-06-01 09:00–10:00\\)\\(系列 ${seriesId}\\)。` +
          `已删除,可用 restore_deleted\\(kind="event", id="${seriesId}"\\) 恢复。$`,
      ),
    );
    // 软删不是物理删除:行还在,只是退出可见范围
    assert.notEqual(rawSeries(seriesId).deleted_at, null, "系列必须软删");
    assert.notEqual(rawInstance(instanceId).deleted_at, null, "实例必须一并软删(联动)");
    assert.equal(rawSeries(seriesId).deleted_at, rawInstance(instanceId).deleted_at, "系列与实例用同一时间戳");
    assert.deepEqual(listJune("mama").family, [], "已删的日程不再出现在 list_events");

    // restore_deleted 用系列 id 恢复
    const restored = restoreDeleted(f.db, f.callers.mama, "event", seriesId);
    ok(restored);
    assert.match(
      restored.message,
      new RegExp(`^已恢复全家日程 \\[${instanceId}\\]:家长会\\(2031-06-01 09:00–10:00\\)\\(系列 ${seriesId}\\)。恢复的是整个系列及其全部日程实例`),
    );
    assert.equal(rawSeries(seriesId).deleted_at, null);
    assert.equal(rawInstance(instanceId).deleted_at, null);
    assert.deepEqual({ ...rawSeries(seriesId), deleted_at: null }, { ...beforeSeries, deleted_at: null }, "恢复后字段必须与删除前一致");
    assert.deepEqual({ ...rawInstance(instanceId), deleted_at: null }, { ...beforeInstance, deleted_at: null });
    assert.deepEqual(listJune("mama").family.map((v) => v.title), ["家长会"]);
  });

  it("delete_event 也接受系列 id(与实例 id 等价):按整系列删", () => {
    f = newFixture();
    const { instanceId, seriesId } = newEvent("mama", { title: "家长会", start: "2031-06-01 09:00" });

    const env = deleteEvent(f.db, f.callers.mama, seriesId);
    ok(env);
    assert.notEqual(rawSeries(seriesId).deleted_at, null);
    assert.notEqual(rawInstance(instanceId).deleted_at, null);
  });

  it("删除全家日程 → 回执标注操作者(V3 互信)", () => {
    f = newFixture();
    const { instanceId, seriesId } = newEvent("mama", { title: "家长会", start: "2031-06-01 09:00" });

    const env = deleteEvent(f.db, f.callers.kid, instanceId);
    ok(env);
    assert.match(env.message, new RegExp(`^已由 小明 删除全家日程 \\[${instanceId}\\]:家长会`));
    assert.match(env.message, new RegExp(`系列 ${seriesId}`));
  });

  it("对未删除的 id 重复删 → NOT_FOUND,并指出已删、给出恢复出路", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { title: "家长会", start: "2031-06-01 09:00" });
    ok(deleteEvent(f.db, f.callers.mama, instanceId));
    const deletedAt = rawInstance(instanceId).deleted_at;

    const env = deleteEvent(f.db, f.callers.mama, instanceId);
    fail(env);
    assert.equal(env.code, "NOT_FOUND");
    assert.match(env.message, /已被删除,无法删除/);
    assert.match(env.hint ?? "", /restore_deleted/);
    assert.equal(rawInstance(instanceId).deleted_at, deletedAt);
  });

  it("对不存在的 id 删除 / 恢复 → NOT_FOUND", () => {
    f = newFixture();
    const del = deleteEvent(f.db, f.callers.mama, "ei-261001-zzzz");
    fail(del);
    assert.equal(del.code, "NOT_FOUND");
    assert.match(del.message, /没有找到这条日程/);

    const res = restoreDeleted(f.db, f.callers.mama, "event", "e-261001-zzzz");
    fail(res);
    assert.equal(res.code, "NOT_FOUND");
    assert.equal(res.id, "e-261001-zzzz");
  });

  it("对未删除的 id 恢复 → 幂等回执,不动任何字段", () => {
    f = newFixture();
    const { instanceId, seriesId } = newEvent("mama", { title: "家长会", start: "2031-06-01 09:00" });
    const beforeSeries = rawSeries(seriesId);
    const beforeInstance = rawInstance(instanceId);

    const env = restoreDeleted(f.db, f.callers.mama, "event", seriesId);
    ok(env);
    assert.match(env.message, new RegExp(`^日程 \\[${instanceId}\\]:家长会\\(2031-06-01 09:00 起\\) 未被删除,无需恢复。$`));
    assert.deepEqual(rawSeries(seriesId), beforeSeries);
    assert.deepEqual(rawInstance(instanceId), beforeInstance);
  });

  it('kind="entry" 仍 INVALID_PARAMS(S3 再接),不得静默放行', () => {
    f = newFixture();
    const { seriesId } = newEvent("mama", { title: "家长会", start: "2031-06-01 09:00" });
    ok(deleteEvent(f.db, f.callers.mama, seriesId));

    const viaDomain = restoreDeleted(f.db, f.callers.mama, "entry", seriesId);
    fail(viaDomain);
    assert.equal(viaDomain.code, "INVALID_PARAMS");
    assert.equal(viaDomain.field, "kind");
    assert.match(viaDomain.message, /暂不支持 kind="entry"/);
    assert.match(viaDomain.hint ?? "", /kind="event"/);

    // 工具层同样挡住(未知枚举值),且不落库
    const viaTool = callTool("mama", "restore_deleted", { kind: "entry", id: seriesId });
    fail(viaTool);
    assert.equal(viaTool.code, "INVALID_PARAMS");
    assert.notEqual(rawSeries(seriesId).deleted_at, null, "参数不合规不得落库");
  });

  it("工具层 kind=event 可用:恢复成功", () => {
    f = newFixture();
    const { seriesId } = newEvent("mama", { title: "家长会", start: "2031-06-01 09:00" });
    ok(callTool("mama", "delete_event", { id: seriesId }));
    assert.notEqual(rawSeries(seriesId).deleted_at, null);

    const env = callTool("mama", "restore_deleted", { kind: "event", id: seriesId });
    ok(env);
    assert.equal(rawSeries(seriesId).deleted_at, null);
  });

  it("代记者能撤回并恢复自己代记的日程(V8 的恢复权与删除权同源)", () => {
    f = newFixture();
    const { instanceId, seriesId } = newEvent("mama", { owner: "爸爸", title: "买酱油", start: "2031-06-02 18:00" });
    ok(deleteEvent(f.db, f.callers.mama, instanceId));

    const res = restoreDeleted(f.db, f.callers.mama, "event", seriesId);
    ok(res);
    assert.match(
      res.message,
      new RegExp(
        `^已恢复你代记的日程 \\[${instanceId}\\]:买酱油\\(2031-06-02 18:00 起\\)\\(归属:爸爸,系列 ${seriesId}\\)。爸爸 现在又能看到这条日程了。$`,
      ),
    );
    assert.deepEqual(listJune("baba").mine.map((v) => v.title), ["买酱油"], "归属人重新可见");
  });
});

describe("时间与参数校验(§5.1 ④)", () => {
  it("end < start → INVALID_PARAMS,话术说清结束不能早于开始", () => {
    f = newFixture();
    const env = addEvent(f.db, f.callers.mama, TZ, {
      title: "家长会",
      start: "2031-06-01 10:00",
      end: "2031-06-01 09:00",
    });
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "end");
    assert.match(env.message, /结束不能早于开始/);
    assert.match(env.hint ?? "", /全天日程用纯日期/);
    const n = f.db.prepare("SELECT COUNT(*) AS n FROM event_series").get() as { n: number };
    assert.equal(n.n, 0, "校验失败不得留下系列");
  });

  it("end = start → 放行(边界含端点)", () => {
    f = newFixture();
    ok(addEvent(f.db, f.callers.mama, TZ, { title: "会", start: "2031-06-01 09:00", end: "2031-06-01 09:00" }));
  });

  it("all_day=true 时 end 带时刻 → INVALID_PARAMS + field=end,并说明该传哪种格式", () => {
    f = newFixture();
    const env = addEvent(f.db, f.callers.mama, TZ, {
      title: "春游",
      start: "2031-06-05",
      end: "2031-06-05 09:00",
      all_day: true,
    });
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "end");
    assert.match(env.message, /全天日程\(all_day=true\)的 end 只能是纯日期 YYYY-MM-DD/);
  });

  it("all_day 缺省时 start 为纯日期 → INVALID_PARAMS + field=start", () => {
    f = newFixture();
    const env = addEvent(f.db, f.callers.mama, TZ, { title: "家长会", start: "2031-06-01" });
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "start");
    assert.match(env.message, /非全天日程的 start 应为 YYYY-MM-DD HH:MM/);
  });

  it("all_day=false 显式传 + 纯日期 → 同样 INVALID_PARAMS(联合校验看的是 all_day 的值,不是它有没有出现)", () => {
    f = newFixture();
    const env = addEvent(f.db, f.callers.mama, TZ, { title: "家长会", start: "2031-06-01", all_day: false });
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "start");
  });

  it("update_event 只传 all_day、不传 start/end 也走同一套联合校验(用合并后的值)", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { title: "春游", start: "2031-06-05", end: "2031-06-06", all_day: true });

    const env = updateEvent(f.db, f.callers.mama, TZ, { id: instanceId, all_day: false });
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "start");
    assert.equal(rawInstance(instanceId).all_day, 1, "被拒的调用不得留下写入");
  });

  it("格式完全不对(明天 / 2026/06/01)→ INVALID_PARAMS(工具层)", () => {
    f = newFixture();
    for (const bad of ["明天", "2031/06/01", "20310601", "2031-06-01 9:00"]) {
      const env = callTool("mama", "add_event", { title: "x", start: bad });
      fail(env);
      assert.equal(env.code, "INVALID_PARAMS", `应拒绝:${bad}`);
    }
    // 不存在的日历日
    const feb30 = callTool("mama", "add_event", { title: "x", start: "2031-02-30 09:00" });
    fail(feb30);
    assert.equal(feb30.code, "INVALID_PARAMS");
    assert.match(feb30.message, /不是合法的时间/);
  });

  it("缺 start / 缺 title → MISSING_PARAMS(工具层)", () => {
    f = newFixture();
    const noStart = callTool("mama", "add_event", { title: "家长会" });
    fail(noStart);
    assert.equal(noStart.code, "MISSING_PARAMS");
    assert.deepEqual(noStart.missing, ["start"]);

    const noTitle = callTool("mama", "add_event", { start: "2031-06-01 09:00" });
    fail(noTitle);
    assert.equal(noTitle.code, "MISSING_PARAMS");
    assert.deepEqual(noTitle.missing, ["title"]);

    const noId = callTool("mama", "delete_event", {});
    fail(noId);
    assert.equal(noId.code, "MISSING_PARAMS");
    assert.deepEqual(noId.missing, ["id"]);
  });
});

describe("权限顺序回归(S1 的教训:权限判定必须排在给行内信息之前)", () => {
  it("他人个人日程的 update_event / delete_event → DENIED(not_visible),信封里不得出现标题、时间、地点", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", {
      owner: "妈妈",
      title: "妈妈的秘密日程",
      start: "2031-06-02 15:00",
      end: "2031-06-02 16:00",
      location: "妇幼保健院",
      notes: "复查结果",
    });

    const calls: Envelope[] = [
      updateEvent(f.db, f.callers.baba, TZ, { id: instanceId, title: "偷偷改" }),
      deleteEvent(f.db, f.callers.baba, instanceId),
    ];
    for (const env of calls) {
      fail(env);
      assert.equal(env.code, "DENIED");
      assert.equal(env.reason, "not_visible");
      assert.match(env.message, /这条日程仅归属人本人可见/);
      assert.match(env.hint ?? "", /家人之间的个人日程互相不可见/);
      // 否定断言钉死泄露面:标题、地点、备注一个都不许出现。
      const json = JSON.stringify(env);
      assert.doesNotMatch(json, /妈妈的秘密日程/, "拒绝信封不得泄露标题(V5)");
      assert.doesNotMatch(json, /妇幼保健院/, "拒绝信封不得泄露地点(V5)");
      assert.doesNotMatch(json, /复查结果/, "拒绝信封不得泄露备注(V5)");
      assert.doesNotMatch(json, /2031-06-02/, "拒绝信封不得泄露时间(V5)");
      assert.doesNotMatch(json, /记在 妈妈 名下/, "不得顺带泄露归属(V5)");
    }
    assert.equal(rawInstance(instanceId).title, "妈妈的秘密日程", "被拒的调用不得留下任何写入");
    assert.equal(rawInstance(instanceId).deleted_at, null, "被拒的删除不得生效");
  });

  it("同一条他人个人日程:未删时 DENIED(not_visible),删后仍是 DENIED(not_visible),不得漂移成 NOT_FOUND", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { owner: "妈妈", title: "妈妈的秘密日程", start: "2031-06-02 15:00" });

    // 可见状态:基线
    for (const env of [
      updateEvent(f.db, f.callers.baba, TZ, { id: instanceId, title: "偷偷改" }),
      deleteEvent(f.db, f.callers.baba, instanceId),
    ]) {
      fail(env);
      assert.equal(env.reason, "not_visible");
    }

    // 归属人自己删掉后:判定口径不得因为 deleted_at 而改变
    ok(deleteEvent(f.db, f.callers.mama, instanceId));
    const deletedAt = rawInstance(instanceId).deleted_at;

    for (const env of [
      updateEvent(f.db, f.callers.baba, TZ, { id: instanceId, title: "偷偷改" }),
      deleteEvent(f.db, f.callers.baba, instanceId),
    ]) {
      fail(env);
      assert.equal(env.reason, "not_visible", "不可见者不得先被告知「这条日程已被删除」——那等于泄露删除状态(V5)");
      assert.doesNotMatch(env.message, /已被删除/);
      assert.doesNotMatch(env.hint ?? "", /restore_deleted/, "不得向不可见者给出针对该条目的操作出路(V5)");
      assert.doesNotMatch(JSON.stringify(env), /妈妈的秘密日程/);
    }
    assert.equal(rawInstance(instanceId).deleted_at, deletedAt);
  });

  it("restore_deleted 的幂等分支不得抢在权限之前:他人未删条目 → not_visible,且不得读出标题与删除状态", () => {
    f = newFixture();
    const { seriesId } = newEvent("mama", { owner: "妈妈", title: "妈妈的秘密日程", start: "2031-06-02 15:00" });

    const env = restoreDeleted(f.db, f.callers.baba, "event", seriesId);
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assert.doesNotMatch(JSON.stringify(env), /妈妈的秘密日程/, "拒绝信封不得泄露标题(V5)");
    assert.doesNotMatch(env.message, /无需恢复|未被删除/, "不可见者不得据此推断该日程的删除状态(V5)");
    assert.equal(rawSeries(seriesId).deleted_at, null);
  });

  it("可见但不可写的那一侧(V8)没有被调序动过:条目回到活跃范围后仍是 not_writable", () => {
    f = newFixture();
    const { instanceId, seriesId } = newEvent("mama", { owner: "爸爸", title: "买酱油", start: "2031-06-02 18:00" });

    // 代记者看得见这条,所以「已删」与「幂等」都可以告诉她(§4:已删退出活跃范围)
    ok(deleteEvent(f.db, f.callers.mama, instanceId));
    const afterDelete = updateEvent(f.db, f.callers.mama, TZ, { id: instanceId, title: "偷偷改" });
    fail(afterDelete);
    assert.equal(afterDelete.code, "NOT_FOUND");
    assert.equal(afterDelete.reason, undefined, "看得见的人拿到的不是权限拒绝,而是范围之外");
    assert.match(afterDelete.message, /已被删除,无法修改/);

    ok(restoreDeleted(f.db, f.callers.mama, "event", seriesId));
    const rewritable = updateEvent(f.db, f.callers.mama, TZ, { id: instanceId, title: "偷偷改" });
    fail(rewritable);
    assert.equal(rewritable.reason, "not_writable", "V8 的修改权归属不因可见性调序而改变");
  });

  it("归属人本人对已删日程 → 仍按 NOT_FOUND(§4 已删即不在可见范围,给出恢复出路)", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { owner: "妈妈", title: "看牙医", start: "2031-06-02 15:00" });
    ok(deleteEvent(f.db, f.callers.mama, instanceId));

    const env = updateEvent(f.db, f.callers.mama, TZ, { id: instanceId, title: "x" });
    fail(env);
    assert.equal(env.code, "NOT_FOUND");
    assert.match(env.message, /已被删除,无法修改/);
    assert.match(env.hint ?? "", /restore_deleted/);
  });
});

describe("审计:3 个写工具各留一行,list_events 不留(§6)", () => {
  it("add/update/delete 各留一行;list_events 不留痕", () => {
    f = newFixture();
    const add = callTool("mama", "add_event", { title: "家长会", start: "2031-06-01 09:00", end: "2031-06-01 10:00" });
    ok(add);
    const instanceId = (add.data as EventView).id;

    ok(callTool("mama", "update_event", { id: instanceId, title: "家长会(二)" }));
    ok(callTool("mama", "delete_event", { id: instanceId }));
    assert.deepEqual(listAudit(f.db).map((r) => r.tool), ["delete_event", "update_event", "add_event"]);

    ok(callTool("mama", "list_events", { ...JUNE }));
    ok(callTool("baba", "list_events", { ...JUNE }));
    assert.equal(listAudit(f.db).length, 3, "读操作不留痕");
  });

  it("member_id 取连接身份:妈妈代记给爸爸时,审计里的身份是妈妈(不是 owner 爸爸)", () => {
    f = newFixture();
    const add = callTool("mama", "add_event", { owner: "爸爸", title: "买酱油", start: "2031-06-02 18:00", notes: "用微信付" });
    ok(add);
    const instanceId = (add.data as EventView).id;
    ok(callTool("mama", "delete_event", { id: instanceId }));

    const rows = listAudit(f.db);
    for (const r of rows) {
      assert.equal(r.member_id, f.members.mama.id, "审计身份必须是连接身份,不是参数里的 owner");
      assert.equal(r.member_name, "妈妈");
    }
    assert.match(rows[1]!.args_summary, /^owner=爸爸 title=买酱油 start=2031-06-02 18:00$/);
    assert.doesNotMatch(rows[1]!.args_summary, /notes|用微信付/, "自由文本不进审计");
    assert.match(rows[0]!.args_summary, new RegExp(`^id=${instanceId}$`));
  });

  it("被拒的写调用也留痕(result_code=信封码,member_id 仍是连接身份)", () => {
    f = newFixture();
    const { instanceId } = newEvent("mama", { owner: "妈妈", title: "看牙医", start: "2031-06-02 15:00" });

    const env = callTool("baba", "update_event", { id: instanceId, title: "偷偷改" });
    fail(env);
    assert.equal(env.code, "DENIED");

    const r = listAudit(f.db)[0]!;
    assert.equal(r.tool, "update_event");
    assert.equal(r.ok, false);
    assert.equal(r.result_code, "DENIED");
    assert.equal(r.member_id, f.members.baba.id);
  });
});