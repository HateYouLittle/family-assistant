import type { Db } from "../db/db.js";
import { daysBetween, generateId, isCalendarDate, todayInTz } from "../db/id.js";
import { failEnvelope, okEnvelope, type Envelope, type FailEnvelope } from "./envelope.js";
import { resolveMemberOrEnvelope, type MemberRow } from "./members.js";
import type { Viewer } from "./viewer.js";

/**
 * 日程域(设计方案 §4/§5)。可见性收敛在本层,工具层不可绕过。
 *
 * ## 模型:系列 + 实例
 * - `event_series` 是**日程本体**:归属(V1/V2)、标题、地点、备注、重复规则、软删标记;
 *   它**没有时间字段**。
 * - `event_instance` 是**某一次**:start / end / all_day 都在实例上,并冗余一份
 *   title/location/notes 供读取(list_events 返回的就是实例)。
 * - 一次 `add_event` = 1 个系列 + **1..N 个实例**:repeat='none' 恰好 1 个;
 *   重复日程按规则物化出未来 `MATERIALIZE_DAYS`(=92)天的实例(设计 §4)。
 *
 * ## 重复日程的三条契约(设计 §4,本阶段落地)
 * - **写时物化**:创建/改重复规则时预生成 [今天, 今天+91 天] 内的实例(受 repeat_until 截断)。
 * - **惰性续期**:`list_events` 的时间窗越过已物化边界时先把缺口补齐再返回。
 *   续期是**写在读路径上的写**,所以整个续期包在 `try/catch` 里:失败**降级返回**
 *   (照常返回已物化范围内的实例 + 话术说明"只展开到 YYYY-MM-DD"),读绝不整体报错,
 *   也不把底层异常文本转述给家人。见 `renewRepeatingSeries`。
 * - **N4**:对重复日程的修改/删除只作用于**整系列**;单次日程(repeat='none')的修改
 *   仍然就地落在那一个实例上(实例 id 不变,S2 语义)。
 * 幂等由 `UNIQUE(series_id, start)`(迁移 v3)+ 生成前查重 + INSERT OR IGNORE 三层保证。
 *
 * ## 可见性不变量(逐条落点见各函数注释)
 * - V1 个人日程(owner_id 非空)仅归属人本人可见;
 * - V2 全家日程(owner_id 为空)全员可见;
 * - V3 个人日程仅本人可改删、全家日程任何成员可改删(回执标注操作者);
 * - V4 代记允许(`owner` ≠ 说话人),回执由服务端写"仅 TA 可见,由 <说话人> 代记";
 * - V5 读取一律在 **SQL 层**过滤,显式越权一律 DENIED,绝不静默空表;
 * - V7 归属不可变:同值幂等放行、异值 DENIED(immutable)+ 删除后重建;
 * - V8 代记者保留查看权与删除权,**无修改权**(not_writable)。
 *
 * ## 判定顺序纪律(S1 踩过的坑,本阶段硬要求)
 * **先判权限、后给任何"行内信息"**:凡是会回出标题/时间/删除状态的分支(包括
 * "未做修改""无需恢复"这类幂等成功)都必须排在可见性闸门**之后**。加载统一走
 * `loadWritableEvent`,它的顺序是:行不存在 → NOT_FOUND;看不见 → DENIED(not_visible);
 * 已软删 → NOT_FOUND。`restoreEvent` 同理。
 *
 * 说话人来自连接(Viewer,见 ./viewer.ts),工具面没有身份参数(P7/D13)。
 */

/** list_events 的 scope:缺省 = 全家日程 + 本人个人日程 + 自己代记的个人日程(V8 查看权)。 */
export type EventScope = "family" | "mine";

/** list_events / 写操作回执里的 data 形状:返回的是**实例**。 */
export interface EventView {
  /** 实例 id:update_event / delete_event 的操作句柄 */
  id: string;
  /** 系列 id:restore_deleted(kind="event") 的句柄 */
  series_id: string;
  /** null = 全家日程(V2);非空 = 该成员的个人日程(V1) */
  owner_id: string | null;
  owner_name: string | null;
  title: string;
  location: string | null;
  notes: string | null;
  start: string;
  end: string | null;
  all_day: boolean;
  /** 是否代记(个人日程且 owner_id ≠ created_by,V8) */
  delegated: boolean;
  created_by: string;
  created_by_name: string;
  created_at: string;
}

/** delete / restore 的回执 data:补上 deleted_at,让调用方一眼看出当前状态。 */
export type EventMutationView = EventView & { deleted_at: string | null };

/** 可作为 update/delete/restore 句柄的最小信息(不依赖具体是系列还是实例)。 */
interface SeriesHandle {
  seriesId: string;
  ownerId: string | null;
  ownerName: string | null;
  title: string;
  createdBy: string;
  /** 重复规则三列:判断"这是不是重复日程"以及重建时要写回的现值(S2b 加)。 */
  repeat: RepeatKind;
  repeatInterval: number;
  repeatUntil: string | null;
}

interface SeriesJoinRow {
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
  owner_name: string | null;
  created_by_name: string;
}

interface InstanceJoinRow {
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
  owner_name: string | null;
  created_by_name: string;
}

const SELECT_SERIES = `
  SELECT s.id, s.owner_id, s.title, s.location, s.notes, s.repeat, s.repeat_interval, s.repeat_until,
         s.created_by, s.created_at, s.deleted_at,
         om.name AS owner_name, cm.name AS created_by_name
  FROM event_series s
  LEFT JOIN member om ON om.id = s.owner_id
  JOIN member cm ON cm.id = s.created_by
`;

const SELECT_INSTANCE = `
  SELECT i.id, i.series_id, i.owner_id, i.title, i.location, i.notes, i.start, i.end, i.all_day,
         i.created_by, i.created_at, i.deleted_at,
         om.name AS owner_name, cm.name AS created_by_name
  FROM event_instance i
  LEFT JOIN member om ON om.id = i.owner_id
  JOIN member cm ON cm.id = i.created_by
`;

function seriesToHandle(row: SeriesJoinRow): SeriesHandle {
  return {
    seriesId: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    title: row.title,
    createdBy: row.created_by,
    repeat: row.repeat as RepeatKind,
    repeatInterval: row.repeat_interval,
    repeatUntil: row.repeat_until,
  };
}

function toView(row: InstanceJoinRow): EventView {
  return {
    id: row.id,
    series_id: row.series_id,
    owner_id: row.owner_id,
    owner_name: row.owner_name,
    title: row.title,
    location: row.location,
    notes: row.notes,
    start: row.start,
    end: row.end,
    all_day: row.all_day !== 0,
    delegated: row.owner_id !== null && row.owner_id !== row.created_by,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    created_at: row.created_at,
  };
}

function loadInstance(db: Db, id: string): InstanceJoinRow | undefined {
  return db.prepare(`${SELECT_INSTANCE} WHERE i.id = ?`).get(id) as InstanceJoinRow | undefined;
}

function loadSeries(db: Db, id: string): SeriesJoinRow | undefined {
  return db.prepare(`${SELECT_SERIES} WHERE s.id = ?`).get(id) as SeriesJoinRow | undefined;
}

// ─────────────────────────── 时间:格式、all_day 联合校验、话术 ───────────────────────────

const DATE_LEN = 10;

/** 该串是否为 "YYYY-MM-DD HH:MM" 形状(零填充,故字典序 == 时间序)。 */
function isMomentShape(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value);
}

/**
 * 时刻串是否真实合法:日期部分须是真实日历日,时刻部分须在 00:00–23:59。
 * 工具层用它做**形状**校验;日程域再用它做**语义**校验(与 all_day 联合)。
 * 单一实现,避免两处对"什么算合法时间"给出不同答案。
 */
export function isRealMoment(value: string): boolean {
  const day = value.slice(0, DATE_LEN);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isCalendarDate(day)) return false;
  if (value.length === DATE_LEN) return true;
  if (!isMomentShape(value)) return false;
  return Number(value.slice(11, 13)) <= 23 && Number(value.slice(14, 16)) <= 59;
}

/** 该时刻是否符合 all_day 对应的格式(§5.1 ④):all_day=true → 纯日期;否则 → "YYYY-MM-DD HH:MM"。 */
function timeFormatOk(value: string, allDay: boolean): boolean {
  if (!isRealMoment(value)) return false;
  return allDay ? value.length === DATE_LEN : isMomentShape(value);
}

function timeFieldError(field: "start" | "end", value: string, allDay: boolean): FailEnvelope {
  return failEnvelope("INVALID_PARAMS", {
    message: allDay
      ? `${field}「${value}」格式不符:全天日程(all_day=true)的 ${field} 只能是纯日期 YYYY-MM-DD,不能带时刻。`
      : `${field}「${value}」格式不符:非全天日程的 ${field} 应为 YYYY-MM-DD HH:MM(如 2026-10-05 09:00)。`,
    hint: allDay
      ? `全天日程:${field} 传 YYYY-MM-DD(如 2026-10-05);要带时刻就传 all_day=false。`
      : `带时刻的日程:${field} 传 "YYYY-MM-DD HH:MM";全天日程传 all_day=true 且 ${field} 用 YYYY-MM-DD。`,
    field,
  });
}

function endBeforeStart(start: string, end: string): FailEnvelope {
  return failEnvelope("INVALID_PARAMS", {
    message: `结束不能早于开始(start=${start},end=${end})。`,
    hint: "全天日程用纯日期、带时刻用 YYYY-MM-DD HH:MM;end 可以等于或晚于 start,跨天的日程照常传。",
    field: "end",
  });
}

/**
 * start / end 与 all_day 的**联合**校验(§5.1 ④)。add 与 update 共用同一函数:
 * update 传进来的是"现值 + 新值合并后的结果",所以"只改 all_day 不改时间"这种
 * 半截修改也会被同一套规则挡住(不传全字段就改不动时间粒度,是刻意的)。
 *
 * 比较用字符串:两种格式都是零填充定长,同格式下字典序即时间序。
 */
function validateTimes(start: string, end: string | null, allDay: boolean): FailEnvelope | null {
  if (!timeFormatOk(start, allDay)) return timeFieldError("start", start, allDay);
  if (end === null) return null;
  if (!timeFormatOk(end, allDay)) return timeFieldError("end", end, allDay);
  if (end < start) return endBeforeStart(start, end);
  return null;
}

/**
 * 把时刻归一成可比较的 "YYYY-MM-DD HH:MM" 键(全天日程展开成整天):
 * - 整天日程的 start → 当天 00:00、end → 当天 23:59(§4:all_day 的 start/end 为纯日期);
 * - 查询边界的纯日期同理:start 边界的"当天"= 00:00,end 边界的"当天"= 23:59,
 *   所以 list_events(start=某天, end=某天) 就是"那一天"(含端点)。
 */
function timeKey(value: string, isEnd: boolean): string {
  if (isMomentShape(value)) return value;
  return `${value} ${isEnd ? "23:59" : "00:00"}`;
}

/** 话术里的时间:全天 / 带时刻 / 跨天 三种形状。 */
export function describeTime(start: string, end: string | null, allDay: boolean): string {
  if (allDay) return end !== null && end !== start ? `全天 ${start} 至 ${end}` : `全天 ${start}`;
  if (end === null) return `${start} 起`;
  return end.slice(0, DATE_LEN) === start.slice(0, DATE_LEN) ? `${start}–${end.slice(11)}` : `${start} 至 ${end}`;
}

/** 话术里的这条日程:`[id]:标题(时间)`。 */
function headline(view: EventView): string {
  return `[${view.id}]:${view.title}(${describeTime(view.start, view.end, view.all_day)})`;
}

// ─────────────────────────── 可见性判定(V1/V2/V8 的唯一入口) ───────────────────────────

/**
 * 可见性(V2 + V1 + V8 的查看权),独立于"删没删过"这类状态。
 * 这是所有其它判定的前提:读路径(listEvents)按它过滤,写路径(loadWritableEvent)
 * 按它先拒绝。它也**只**看归属与创建者,不看 source、不看任何参数。
 */
function canSeeEvent(target: SeriesHandle, viewer: Viewer): boolean {
  if (target.ownerId === null) return true; // V2:全家日程全员可见
  if (target.ownerId === viewer.memberId) return true; // V1:个人日程仅归属人
  return target.createdBy === viewer.memberId; // V8:自己代记的条目可见
}

/**
 * 删除权(V3 + V8):全家日程任何成员;个人日程归属人本人;代记者可撤回自己代记的条目。
 * 与可见性同源,所以直接建立在 canSeeEvent 上。
 *
 * **恢复权与删除权同源**(沿用 S1 在 todo 域的裁决):restore_deleted 复用本判定。
 * 理由同 —— V8 给代记者删除权的目的就是纠正自己的笔误,"能删不能恢复"等于把笔误
 * 变成不可挽回。
 */
function canDeleteEvent(target: SeriesHandle, viewer: Viewer): boolean {
  return canSeeEvent(target, viewer);
}

/** V3/V5:个人日程不是本人的 → 明确拒绝(绝不"看起来成功")。 */
function denyNotVisible(): FailEnvelope {
  return failEnvelope("DENIED", {
    reason: "not_visible",
    message: "这条日程仅归属人本人可见,你无法查看或操作它。",
    hint: "直接向用户转述:家人之间的个人日程互相不可见(全家日程人人都能看到)。",
  });
}

/** V8:代记者对"我创建、归属他人"的个人日程只有查看权与删除权,没有修改权。 */
function denyNotWritable(target: SeriesHandle): FailEnvelope {
  return failEnvelope("DENIED", {
    reason: "not_writable",
    message: `这条日程是你代 ${target.ownerName} 记的,只能由 ${target.ownerName} 本人修改。`,
    hint: `向用户说明:代记的日程只有归属人本人能修改;你在记错时可以用 delete_event 撤回。`,
  });
}

/** V7:归属不可变。传入值与现值不同 → DENIED(immutable)+ 固定话术(X11)。 */
function denyImmutable(target: SeriesHandle, view: EventView, given: string): FailEnvelope {
  const isFamily = target.ownerId === null;
  return failEnvelope("DENIED", {
    reason: "immutable",
    message:
      `归属/账本不可修改,如需变更请删除后重建。` +
      (isFamily
        ? `日程 [${view.id}] 是全家日程,不能把它改成「${given}」名下的个人日程。`
        : `日程 [${view.id}] 记在 ${target.ownerName} 名下,你不能把它改成「${given}」名下的。`),
    hint: isFamily
      ? `要把它变成个人日程:先用 delete_event 删除这条(软删,可恢复),再用 add_event(owner="${given}") 重建;` +
        `不要试图用 update_event 改归属。`
      : `要换归属人:先用 delete_event 删除这条(软删,可恢复),再用 add_event(owner="${given}") 重建;` +
        `不要试图用 update_event 改归属。`,
  });
}

/** 行根本不存在 → NOT_FOUND(P5:删除/修改必须带精确 id,先 list 拿)。 */
function eventMissing(id: string, action: string): FailEnvelope {
  return failEnvelope("NOT_FOUND", {
    message: `没有找到这条日程(${id}),无法${action}。`,
    id,
    hint: "先调 list_events 拿到当前有效的日程 id 再操作(不要凭记忆转述 id);日程同时有系列 id 与实例 id,两者都能用。",
  });
}

/** 行存在但已软删 → 按 NOT_FOUND(§4:已删即不在可见范围),但给出恢复出路。 */
function eventAlreadyDeleted(id: string, action: string, seriesId: string): FailEnvelope {
  return failEnvelope("NOT_FOUND", {
    message: `日程 [${id}] 已被删除,无法${action}。`,
    id,
    hint: `已删除的日程不再出现在 list_events 里;若要找回,用 restore_deleted(kind="event", id="${seriesId}")。`,
  });
}

// ─────────────────────────── 写路径:定位 + 取行(判定顺序集中在这里) ───────────────────────────

/**
 * 解析操作句柄 → 系列行。
 *
 * **两种句柄都收**(S2 裁决):list_events 返回的是**实例**,而 restore_deleted 的
 * 规范句柄是**系列**(删除是"整系列"语义,见设计 §4「对重复日程的删除只作用于整系列」)。
 * 模型手上天然同时握着这两个 id,只认一个等于凭空制造一条死路,而死路会诱发
 * "换个参数重试"(P2 的反面)。两者都精确指向同一条日程,不存在歧义。
 *
 * 解析本身**不回传任何行内信息**,所以放在权限判定之前是安全的。
 */
function loadSeriesByHandle(db: Db, id: string): SeriesJoinRow | undefined {
  const bySeries = loadSeries(db, id);
  if (bySeries) return bySeries;
  const inst = db.prepare("SELECT series_id FROM event_instance WHERE id = ?").get(id) as
    | { series_id: string | null }
    | undefined;
  const seriesId = inst?.series_id;
  return seriesId ? loadSeries(db, seriesId) : undefined;
}

/**
 * 系列下的当前实例(含/不含已删),按 start 排序取**最早**的那一次。
 * 重复日程下它同时是"锚点":系列本身没有时间字段(设计 §4 的模型),重复的相位与
 * 时刻都挂在这最早的一次上,续期据此往后推(见 renewRepeatingSeries)。
 */
function loadSeriesInstance(db: Db, seriesId: string, includeDeleted = false): InstanceJoinRow | undefined {
  const sql = `${SELECT_INSTANCE} WHERE i.series_id = ?${includeDeleted ? "" : " AND i.deleted_at IS NULL"}
    ORDER BY i.start, i.id LIMIT 1`;
  return db.prepare(sql).get(seriesId) as InstanceJoinRow | undefined;
}

/**
 * update / delete 的统一取行。**判定顺序本身是可见性纪律的一部分**:
 * 行不存在 → NOT_FOUND;看不见 → DENIED(not_visible);已软删 → NOT_FOUND。
 * 反过来就等于先给信息、后判权限(同一条日程未删时回 not_visible、删后回
 * "已被删除"+ 附赠 restore_deleted 命令,判定口径随 deleted_at 漂移 = 泄露,V5)。
 * V8 的 not_writable 由各写函数自己判(见 denyIfNotWritable),因为要按 action 措辞。
 */
function loadWritableEvent(
  db: Db,
  viewer: Viewer,
  id: string,
  action: string,
): { handle: SeriesHandle; instance: InstanceJoinRow } | { envelope: FailEnvelope } {
  const row = loadSeriesByHandle(db, id);
  if (!row) return { envelope: eventMissing(id, action) };
  const handle = seriesToHandle(row);
  // 可见性先于行内信息:能不能看这条,与它删没删过无关(V1 + V8 的查看权)。
  if (!canSeeEvent(handle, viewer)) return { envelope: denyNotVisible() };
  if (row.deleted_at !== null) return { envelope: eventAlreadyDeleted(id, action, row.id) };
  const instance = loadSeriesInstance(db, row.id);
  if (!instance) return { envelope: eventMissing(id, action) };
  return { handle, instance };
}

/**
 * update 的修改权闸门:全家日程任何成员(V3 家庭内互信);个人日程仅归属人本人;
 * 自己代记的 → V8 not_writable;他人 → not_visible(可见性闸门已跑过,这里纵深防御)。
 */
function denyIfNotWritable(handle: SeriesHandle, viewer: Viewer): FailEnvelope | null {
  if (handle.ownerId === null) return null;
  if (handle.ownerId === viewer.memberId) return null;
  if (handle.createdBy === viewer.memberId) return denyNotWritable(handle);
  return denyNotVisible();
}

// ─────────────────────────── add_event ───────────────────────────

export interface AddEventInput {
  owner?: string;
  title: string;
  start: string;
  end?: string | null;
  all_day?: boolean;
  location?: string | null;
  notes?: string | null;
  /** 缺省 = "none"(单次日程)。非 none 时按规则物化未来 MATERIALIZE_DAYS 天的实例(设计 §4)。 */
  repeat?: RepeatKind;
  /** 每隔几个单位重复一次,正整数,缺省 1;只在 repeat ≠ "none" 时可传。 */
  repeat_interval?: number;
  /** 纯日期 YYYY-MM-DD,含当天为止不再生成;可缺省;只在 repeat ≠ "none" 时可传。 */
  repeat_until?: string | null;
}

/** 造实例所需的系列字段(刚 INSERT 完的系列行,或续期时读出来的系列行——字段一致)。 */
interface NewSeries {
  id: string;
  owner_id: string | null;
  title: string;
  location: string | null;
  notes: string | null;
  created_by: string;
}

/** 续期要用的系列行:NewSeries + 重复规则三列。 */
interface RepeatingSeriesRow extends NewSeries {
  repeat: RepeatKind;
  repeat_interval: number;
  repeat_until: string | null;
}

export interface NewInstanceTime {
  start: string;
  end: string | null;
  allDay: boolean;
}

/** 重复规则(对应 event_series 的 repeat / repeat_interval / repeat_until 三列)。 */
export type RepeatKind = "none" | "daily" | "weekly" | "monthly";

/** 解析出来的重复规则。until 为纯日期、**含当天为止**不再生成;null = 不设截止。 */
export interface RepeatRule {
  repeat: RepeatKind;
  interval: number;
  until: string | null;
}

/** repeat 缺省时的规则:add_event 的起点,也是 update_event 的"不改"基线。 */
const NO_REPEAT: RepeatRule = { repeat: "none", interval: 1, until: null };

/**
 * 物化窗口长度(天)。设计 §4「创建即预生成未来 92 天的实例」的那个 92。
 *
 * 窗口 = [今天, 今天 + 91 天](含今天、含两端),所以 daily 恰好物化 92 次。
 * "今天"按**配置时区**判定(todayInTz),不读系统本地时区(容器默认 UTC 会整体偏一天)。
 * 它同时决定创建回执里的"已展开 N 次",所以抽成具名常量而不是散落的字面量。
 */
export const MATERIALIZE_DAYS = 92;

/** repeat_interval 的参数上限:一年(12 个月 / 52 周 / 365 天都够用),顺带挡住日期溢出。 */
const MAX_REPEAT_INTERVAL = 366;

/**
 * 单次续期最多补多少个实例。续期由**读路径**触发、时间窗由调用方给;没有上限的话,
 * "读一整年"配上 daily 就能一次写几千行,而这只是模型的一次参数失误。
 * 用满了不会让读失败,只是在话术里说清"只展开到哪一天"(见 renewalNote)。
 */
const MAX_RENEWAL_OCCURRENCES = 400;

// ───────────────── 日历算术:日/月推算(全部按 UTC,不受系统本地时区影响) ─────────────────

/** 时刻串的日历日部分:纯日期与 "YYYY-MM-DD HH:MM" 都取前 10 位。 */
function dayOf(value: string): string {
  return value.slice(0, DATE_LEN);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

/** 日历日加 n 天(负数往前推)。 */
function shiftDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${pad4(dt.getUTCFullYear())}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** 某年某月的天数(month1 = 1..12)。 */
function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * 日历日往后推 months 个月,目标月没有该日时**钳到当月最后一天**(S2b 裁决)。
 *
 * 为什么钳位而不是跳过该月:家人说"每月 31 号交房租",2 月就该有一次(28/29 号);
 * 跳过会让"每月"悄悄变成"有些月份没有",而一次错位比一次缺席更难向家人解释。
 * 代价(2 月 28 日 → 3 月该回 31 号)用**按索引钳位**消掉:第 k 次 = 锚点月 + k×interval
 * 个月、日再钳一次,而不是在"上一次"上累加 —— 后者会 1/31 → 2/28 → 3/28 一路漂移。
 */
function shiftMonthsClamped(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${pad4(ny)}-${pad2(nm)}-${pad2(Math.min(d, daysInMonth(ny, nm)))}`;
}

/** 第 k 次发生的日历日(k = 0 即锚点那天)。 */
function occurrenceDay(rule: RepeatRule, anchorDay: string, k: number): string {
  switch (rule.repeat) {
    case "daily":
      return shiftDays(anchorDay, k * rule.interval);
    case "weekly":
      return shiftDays(anchorDay, k * 7 * rule.interval);
    case "monthly":
      return shiftMonthsClamped(anchorDay, k * rule.interval);
    case "none":
      return anchorDay;
  }
}

/**
 * 第一个满足"第 k 次 ≥ fromDay"的 k(闭式解,不线性扫描)。
 * monthly 先用月数差估个下界,再因为钳位只可能提前最多一格而微调。
 */
function firstKAtOrAfter(rule: RepeatRule, anchorDay: string, fromDay: string): number {
  if (rule.repeat === "none") return 0;
  if (rule.repeat === "monthly") {
    const ay = Number(anchorDay.slice(0, 4));
    const am = Number(anchorDay.slice(5, 7));
    const fy = Number(fromDay.slice(0, 4));
    const fm = Number(fromDay.slice(5, 7));
    let k = Math.max(0, Math.floor(((fy - ay) * 12 + (fm - am)) / rule.interval));
    while (k > 0 && occurrenceDay(rule, anchorDay, k - 1) >= fromDay) k -= 1;
    while (occurrenceDay(rule, anchorDay, k) < fromDay) k += 1;
    return k;
  }
  const step = rule.repeat === "daily" ? 1 : 7;
  return Math.max(0, Math.ceil(daysBetween(anchorDay, fromDay) / (step * rule.interval)));
}

/**
 * [fromDay, toDay] 闭区间内(含两端)还**缺**哪些天;truncated = 缺口被单次上限截断。
 *
 * - repeat='none' 恒返回锚点那一次且**不看窗口**:单次日程的"一次"就是用户给的那次,
 *   哪怕 start 在过去(S2 语义:补记一条已经过去的日程是合法的)。
 * - 重复日程受 repeat_until 截断:**含当天为止**(until 那一天仍然生成)。
 * - isMissing 用来把"已经物化过的那几次"从计划里剔掉,cap 也只数**真正要新增的**那些:
 *   否则一个已经展开到今天的 daily 系列,读一次远窗就会因为"计划天数 ≥ 上限"而被
 *   误判成"只展开到某天",话术与事实不符。
 */
function planOccurrences(
  rule: RepeatRule,
  anchorDay: string,
  fromDay: string,
  toDay: string,
  cap: number,
  isMissing: (day: string) => boolean = () => true,
): { days: string[]; truncated: boolean } {
  if (rule.repeat === "none") return { days: isMissing(anchorDay) ? [anchorDay] : [], truncated: false };
  const days: string[] = [];
  let k = firstKAtOrAfter(rule, anchorDay, fromDay);
  for (;;) {
    const day = occurrenceDay(rule, anchorDay, k);
    if (day > toDay) break;
    if (rule.until !== null && day > rule.until) break;
    if (isMissing(day)) {
      if (days.length >= cap) return { days, truncated: true };
      days.push(day);
    }
    k += 1;
  }
  return { days, truncated: false };
}

/** 把锚点时间整体平移到某一天:时刻不变;跨天的 end 保持与 start 的天数差。 */
function occurrenceTime(anchor: NewInstanceTime, day: string): NewInstanceTime {
  const startTail = isMomentShape(anchor.start) ? anchor.start.slice(DATE_LEN) : "";
  const start = `${day}${startTail}`;
  if (anchor.end === null) return { start, end: null, allDay: anchor.allDay };
  const span = daysBetween(dayOf(anchor.start), dayOf(anchor.end));
  const endTail = isMomentShape(anchor.end) ? anchor.end.slice(DATE_LEN) : "";
  return { start, end: `${shiftDays(day, span)}${endTail}`, allDay: anchor.allDay };
}

/** 创建/重建时的物化窗口:[今天或锚点(取晚者), 再往后 MATERIALIZE_DAYS-1 天]。 */
function materializeWindow(today: string, anchorDay: string): { fromDay: string; toDay: string } {
  // 锚点早于今天(补记一条"从两个月前开始"的重复日程)时**从今天起算**:
  // 物化只向前看、不回填已经开始的那几次,否则"上周的游泳"会突然冒出来(设计 §4)。
  const fromDay = anchorDay > today ? anchorDay : today;
  return { fromDay, toDay: shiftDays(fromDay, MATERIALIZE_DAYS - 1) };
}

// ─────────────────────── 物化与续期(写时物化 + 写在读路径上的续期) ───────────────────────

/**
 * 造一个实例。**S2 的接缝函数**,S2b 起同时服务"单次日程"与"重复日程的每一次"。
 *
 * INSERT OR IGNORE:同 (series_id, start) 已存在时**跳过**并返回 null 而不是抛错。
 * 幂等由三层保证 —— 迁移 v3 的 UNIQUE(series_id, start)、补造前的查重(见 materializeRange)、
 * 这里的 OR IGNORE。之所以要"跳过"而不是"报错":续期跑在读路径上,
 * 一条内部约束不该把一次读降级掉。
 */
export function createInstanceForSeries(
  db: Db,
  timezone: string,
  series: NewSeries,
  time: NewInstanceTime,
): string | null {
  const instanceId = generateId(db, "ei", "event_instance", timezone);
  const info = db
    .prepare(`
      INSERT OR IGNORE INTO event_instance (id, series_id, owner_id, title, location, notes, start, end, all_day, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      instanceId,
      series.id,
      series.owner_id,
      series.title,
      series.location,
      series.notes,
      time.start,
      time.end,
      time.allDay ? 1 : 0,
      series.created_by,
      new Date().toISOString(),
    );
  return info.changes > 0 ? instanceId : null;
}

/**
 * 把 [fromDay, toDay] 内缺的实例补进库(写时物化与惰性续期共用这一条路)。
 *
 * **幂等**:先把该系列已有的 start 读进内存,计划阶段就把它们剔掉,剩下的逐条
 * INSERT OR IGNORE 落库 —— 反复读同一个窗口不会长出第二份。
 *
 * cap = 单次**新增**条数上限(创建/重建用 MATERIALIZE_DAYS,续期用 MAX_RENEWAL_OCCURRENCES);
 * truncated 告诉调用方"这次没补全"。
 */
function materializeRange(
  db: Db,
  timezone: string,
  series: RepeatingSeriesRow,
  rule: RepeatRule,
  anchor: NewInstanceTime,
  fromDay: string,
  toDay: string,
  cap: number,
): { inserted: number; truncated: boolean } {
  const existing = new Set(
    (db.prepare("SELECT start FROM event_instance WHERE series_id = ?").all(series.id) as { start: string }[]).map(
      (r) => r.start,
    ),
  );
  const isMissing = (day: string): boolean => !existing.has(occurrenceTime(anchor, day).start);
  const plan = planOccurrences(rule, dayOf(anchor.start), fromDay, toDay, cap, isMissing);
  if (plan.days.length === 0) return { inserted: 0, truncated: plan.truncated };
  let inserted = 0;
  // 一个系列一个事务:中途失败整批回滚,不留"补了一半"的系列(下一次读会接着补)。
  db.transaction(() => {
    for (const day of plan.days) {
      const time = occurrenceTime(anchor, day);
      if (createInstanceForSeries(db, timezone, series, time) !== null) inserted += 1;
    }
  })();
  return { inserted, truncated: plan.truncated };
}

/** 创建时的物化:不重复 = 就那一次;重复 = 未来 MATERIALIZE_DAYS 天。 */
function materializeNewSeries(
  db: Db,
  timezone: string,
  series: RepeatingSeriesRow,
  rule: RepeatRule,
  anchor: NewInstanceTime,
  today: string,
): { inserted: number; truncated: boolean } {
  if (rule.repeat === "none") {
    createInstanceForSeries(db, timezone, series, anchor);
    return { inserted: 1, truncated: false };
  }
  const { fromDay, toDay } = materializeWindow(today, dayOf(anchor.start));
  return materializeRange(db, timezone, series, rule, anchor, fromDay, toDay, MATERIALIZE_DAYS);
}

/**
 * 折叠(重复 → 单次)的结果:回执要说的三件事全在这里,顺带给回执指明该展示哪一条实例。
 *
 * - keptId / keptStart:折叠后仅存的那一次(= 最早的未来那一次)。整个系列都在过去、
 *   按裁决**不新建**实例时为 null。
 * - hasHistory:该系列有没有已经发生过的历史实例 —— 有才在回执里提"过去的记录没有改动"。
 */
interface CollapseResult {
  /** 保留下来的那一次的实例 id;没保留(不新建)= null。 */
  keptId: string | null;
  /** 保留下来的那一次的 start(keptId 为 null 时不读)。 */
  keptStart: string | null;
  /** 有没有历史实例(决定回执要不要提"过去的记录没有改动")。 */
  hasHistory: boolean;
}

/**
 * `update_event` 改了时间或重复规则后的联动(N4:只作用于整系列)。
 *
 * ## "未来 / 过去"的判定口径(S2b 裁决)
 * 按实例 start 的**日历日**与"今天"(配置时区)比:`day >= 今天` 视为**未发生**,按新规则重建;
 * `day < 今天` 属于**历史**,原样保留 —— 历史不该被改写("上周的游泳"不该因为改了规则就变形)。
 * 刻意用"日历日"而不是"时刻是否已过":同一天的日程可能还没开始(今天 19:00),
 * 用时刻判定会让"改时间"的结果取决于调用发生在当天几点,不可复现也难解释。
 *
 * ## 从重复改成单次(折叠):保留"最早的未来一次",历史一行都不动(S2c 裁决)
 * 折叠 = 把"每周一次"改成"就一次"。用户要的是**接下来那一次**,所以:
 * 1. 先按 start 升序取出**最早的未来一次**(`start >= today` 且未删)作为仅存那次的锚点;
 * 2. **只删未来**(`start >= today`),与下面"重复 → 重复"的重建路径同一条口径;
 * 3. 取到锚点就用**它自己的 start / end / all_day** 重建那一条(标题/地点/备注是新值);
 * 4. 一个未来实例都没有(整个系列都在过去)就**不新建** —— 造一条过去的单次日程等于
 *    把历史改写成"计划",而系列就此静静变成"不再重复"。
 *
 * ## 为什么过去的历史绝不删(S2c 修掉的那个 bug)
 * 曾经的写法是 `DELETE FROM event_instance WHERE series_id = ?`(整系列删光)+ 拿
 * "最早那一次"当锚点重建。那条整系列语义只能推出"未来的按新规则换掉",**推不出"删掉历史"**:
 * 家人三个月前真的游过泳,历史是事实,不该因为今天改了个重复形态就从日历里消失,
 * 而且那是**物理删除**、不可恢复(history 不是草稿)。附带症状:锚点取"最早"时,
 * 折叠后留下的是一条**已经过去的**日程、未来反而空着。
 *
 * ## 为什么未来那些行是物理删除
 * 它们是"从未发生、且已被新规则取代"的计划,重建时同 (series_id, start) 只能留一行 ——
 * 而 UNIQUE(series_id, start)(迁移 v3)是**不带 deleted_at 条件的普通唯一索引**,
 * 软删的行照样占着这个位置,留着它们会让下一次展开只能走 INSERT OR IGNORE 的"跳过"分支
 * (那一行还是旧的系列值)。所以未来行物理删(被取代物,不是历史),过去行软删都不做。
 */
function rebuildInstances(
  db: Db,
  timezone: string,
  series: RepeatingSeriesRow,
  rule: RepeatRule,
  anchor: NewInstanceTime,
  today: string,
): CollapseResult | null {
  // 两条路径的"未来"是同一条口径(与上面的 S2b 裁决一致):
  // start 可能是纯日期也可能是带时刻,但两种形状下 `start >= 'YYYY-MM-DD'`
  // 都等价于"日历日 >= 今天"(纯日期相等即命中;带时刻是它的真前缀,字典序更大)。
  if (rule.repeat === "none") {
    // ① 最早的未来那一次 = 折叠后仅存的那次(先取出来,后面整段删未来时它也要被删掉再重建)。
    const kept = db
      .prepare(
        `SELECT id, start, end, all_day FROM event_instance
         WHERE series_id = ? AND deleted_at IS NULL AND start >= ? ORDER BY start, id LIMIT 1`,
      )
      .get(series.id, today) as { id: string; start: string; end: string | null; all_day: number } | undefined;
    // ② 只删未来:过去的那一行都不碰(物理删除只针对被新规则取代的未来行,理由见上)。
    db.prepare("DELETE FROM event_instance WHERE series_id = ? AND start >= ?").run(series.id, today);
    // 有历史才在回执里提"过去的记录没有改动"(这个系列压根没有历史时,提了是废话)。
    const hasHistory =
      db
        .prepare("SELECT 1 AS hit FROM event_instance WHERE series_id = ? AND deleted_at IS NULL AND start < ? LIMIT 1")
        .get(series.id, today) !== undefined;
    // ③ 整个系列都在过去 → 不新建,系列静静变成"不再重复"。
    if (kept === undefined) return { keptId: null, keptStart: null, hasHistory };
    // ④ 用它自己的时间重建那一条:沿用它自己的 start/end/all_day 而不是传入的 anchor ——
    //    折叠是"保留接下来那一次"(选点按时间),而且这样重建的行必然与保留的历史行
    //    不同 start,不会撞上 UNIQUE(series_id, start)。
    const keptId = createInstanceForSeries(db, timezone, series, {
      start: kept.start,
      end: kept.end,
      allDay: kept.all_day !== 0,
    });
    return { keptId, keptStart: kept.start, hasHistory };
  }
  db.prepare("DELETE FROM event_instance WHERE series_id = ? AND start >= ?").run(series.id, today);
  const { fromDay, toDay } = materializeWindow(today, dayOf(anchor.start));
  materializeRange(db, timezone, series, rule, anchor, fromDay, toDay, MATERIALIZE_DAYS);
  return null;
}

/** 某系列当前物化了多少次、展开到哪一天(回执话术用;只数活着的实例)。 */
function materializedSummary(
  db: Db,
  seriesId: string,
): { count: number; firstDay: string | null; lastDay: string | null } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(start) AS first_start, MAX(start) AS last_start
       FROM event_instance WHERE series_id = ? AND deleted_at IS NULL`,
    )
    .get(seriesId) as { n: number; first_start: string | null; last_start: string | null };
  return {
    count: row.n,
    firstDay: row.first_start === null ? null : dayOf(row.first_start),
    lastDay: row.last_start === null ? null : dayOf(row.last_start),
  };
}

/** 可见的、未被删的重复系列(scope 与 list_events 同一套口径 —— 权限先于一切行内信息)。 */
const VISIBLE_REPEATING_SERIES = `
  SELECT s.id, s.owner_id, s.title, s.location, s.notes, s.repeat, s.repeat_interval, s.repeat_until, s.created_by
  FROM event_series s
  WHERE s.deleted_at IS NULL AND s.repeat != 'none' AND (
`;

function visibleRepeatingSeries(db: Db, viewer: Viewer, scope: VisibilityScope | undefined): RepeatingSeriesRow[] {
  const { where, params } = visibilityWhere("s", scope, viewer);
  return db.prepare(`${VISIBLE_REPEATING_SERIES}${where}) ORDER BY s.created_at, s.id`).all(...params) as RepeatingSeriesRow[];
}

/** 该系列已展开到的日期(活着实例里最晚的那次;没有实例 = null)。 */
function materializedBoundaryDay(db: Db, seriesId: string): string | null {
  const row = db
    .prepare("SELECT MAX(start) AS last_start FROM event_instance WHERE series_id = ? AND deleted_at IS NULL")
    .get(seriesId) as { last_start: string | null };
  return row.last_start === null ? null : dayOf(row.last_start);
}

/** 续期结果:只用来拼话术,不参与任何判定。 */
interface RenewalReport {
  /** 可见重复日程当前已展开到的日期;没有重复日程 = null。 */
  boundary: string | null;
  /** 续期的写失败了 → 降级说明。 */
  degraded: boolean;
  /** 补到单次上限了 → 说明只展开到哪一天。 */
  capped: boolean;
}

/**
 * 惰性续期(设计 §4):`list_events` 的时间窗越过已展开边界时,把缺口先补齐再返回。
 *
 * ## 为什么整段包在 try/catch 里
 * 续期是**写在读路径上的写**。磁盘满、WAL 锁竞争、库被以只读方式打开、迁移异常 ——
 * 任何一条都可能在"家人查日历"的时候发生。契约(设计 §4):失败**降级返回**,
 * 照常返回已展开范围内的实例,并在话术里说清"只展开到 YYYY-MM-DD"。
 * **读操作绝不因为续期失败而整体报错**(不返回 ok:false、不抛异常),
 * 也不把底层异常文本转述给家人(只留 degraded 这个布尔量)。
 * 外层 try/catch 兜住"连挑系列都失败"这类意外,内层 try/catch 让单个系列补不动
 * 不影响其它系列。
 *
 * ## 只补未来
 * 生成起点是 max(今天, 锚点日):已经过去的那几次不回填,避免"上周的游泳突然冒出来"。
 *
 * ## 幂等
 * 补造前查该系列已有的 start(materializeRange)+ UNIQUE(series_id, start)(迁移 v3),
 * 所以反复读同一个窗口不会长出第二份。
 *
 * ## 权限纪律
 * 只续**说话人看得见**的重复系列(scope 与 list_events 同一套条件):
 * 一是读别人的个人日程不该顺手写他的库,二是降级话术里的"展开到哪一天"
 * 只由可见系列算出,不会顺带泄露不可见系列的存在(V1/V5)。
 */
function renewRepeatingSeries(
  db: Db,
  viewer: Viewer,
  timezone: string,
  horizonDay: string,
  scope: VisibilityScope | undefined,
): RenewalReport {
  const today = todayInTz(timezone);
  let degraded = false;
  let capped = false;
  let boundary: string | null = null;
  try {
    const series = visibleRepeatingSeries(db, viewer, scope);
    // 窗口整体在过去 → 没有缺口可补,不必试写(每次读都白试一次写也是负担)。
    if (series.length > 0 && horizonDay >= today) {
      for (const s of series) {
        if (s.repeat_until !== null && s.repeat_until < today) continue; // 已过截止,不再生成
        // 锚点 = 最早的那一次:系列没有时间字段(设计 §4 的模型),时刻形态与相位都在它身上。
        const anchorRow = loadSeriesInstance(db, s.id);
        if (!anchorRow) continue;
        const anchorDay = dayOf(anchorRow.start);
        if (anchorDay > horizonDay) continue; // 整条系列都还在窗口之后
        const current = materializedBoundaryDay(db, s.id);
        if (current !== null && current >= horizonDay) continue; // 窗口没越过已展开边界
        try {
          const res = materializeRange(
            db,
            timezone,
            s,
            { repeat: s.repeat, interval: s.repeat_interval, until: s.repeat_until },
            { start: anchorRow.start, end: anchorRow.end, allDay: anchorRow.all_day !== 0 },
            anchorDay > today ? anchorDay : today,
            horizonDay,
            MAX_RENEWAL_OCCURRENCES,
          );
          if (res.truncated) capped = true;
        } catch {
          // 单个系列补不动不影响其它系列:记下降级,继续。
          degraded = true;
        }
      }
    }
    // 降级话术里的"展开到哪一天":只由**可见**的重复系列算出,不泄露不可见系列(V1/V5)。
    for (const s of series) {
      const day = materializedBoundaryDay(db, s.id);
      if (day !== null && (boundary === null || day > boundary)) boundary = day;
    }
  } catch {
    // 连"挑出可见的重复系列"都失败(库结构异常、只读连接上的意外)也一样降级:
    // 读照常返回它本来要返回的东西,家人不会因为一次后台写失败就查不了日历。
    degraded = true;
  }
  return { boundary, degraded, capped };
}

/** 续期的话术尾巴:只在真降级 / 补到上限时出现,平时是空串(S2 的回执一个字都不变)。 */
function renewalNote(report: RenewalReport): string {
  if (!report.degraded && !report.capped) return "";
  const boundary = report.boundary ?? "今天";
  if (report.degraded) {
    return `日程只展开到 ${boundary},之后的重复日程需稍后重试。`;
  }
  return `日程只展开到 ${boundary}(单次展开的条数有上限),之后的重复日程请按更近的时间窗分次查看。`;
}

// ───────────────────────────── 重复规则的校验与话术 ─────────────────────────────

/** 重复规则参数(校验前的原始入参形态)。 */
interface RepeatInput {
  repeat?: RepeatKind;
  repeat_interval?: number;
  repeat_until?: string | null;
}

/**
 * 解析并校验重复规则。add 与 update 共用这一条路:先把传入值与现值合并,再校验合并后的结果。
 *
 * 五条拒绝条件,都排在落库之前,而且**一律不静默忽略**:
 * 1. repeat 取值不认识 → INVALID_PARAMS(domain 层不假设上游已校验)。
 * 2. repeat='none'(含缺省)却传了 repeat_interval / repeat_until → INVALID_PARAMS。
 *    静默忽略会把"记到年底"变成一条没有截止的日程,而模型和家人都以为截止生效了。
 * 3. repeat_interval 不是 1..MAX_REPEAT_INTERVAL 的整数 → INVALID_PARAMS。
 * 4. repeat_until 不是纯日期 → INVALID_PARAMS;早于 start(一次都不会发生)→ INVALID_PARAMS。
 * 5. 按合并后的规则算不出任何一次(截止日早于今天、或间隔长到窗口里一次都没有)→ INVALID_PARAMS。
 *    这一条保证"每个活着的系列至少有一次":否则系列会空成一个没有实例的壳,
 *    list_events 看不到它,update/delete 却一律 NOT_FOUND。
 */
function resolveRepeatRule(
  given: RepeatInput,
  base: RepeatRule,
  startDay: string,
  today: string,
): { rule: RepeatRule } | { envelope: FailEnvelope } {
  const repeat = given.repeat ?? base.repeat;
  const interval = given.repeat_interval ?? base.interval;
  const until = given.repeat_until === undefined ? base.until : given.repeat_until;
  const intervalGiven = given.repeat_interval !== undefined;
  const untilGiven = given.repeat_until !== undefined;

  if (repeat !== "none" && repeat !== "daily" && repeat !== "weekly" && repeat !== "monthly") {
    return {
      envelope: failEnvelope("INVALID_PARAMS", {
        message: `repeat 只支持 "none"、"daily"、"weekly"、"monthly"(收到 "${String(repeat)}")。`,
        hint: '不重复就传 repeat="none"(或不传);每天 / 每周 / 每月分别传 "daily" / "weekly" / "monthly"。',
        field: "repeat",
      }),
    };
  }
  if (repeat === "none" && (intervalGiven || untilGiven)) {
    return {
      envelope: failEnvelope("INVALID_PARAMS", {
        message: "非重复日程不接受 repeat_interval / repeat_until 这两个参数。",
        hint:
          "单次日程直接传 start 即可;要重复请同时传 repeat=\"daily\" / \"weekly\" / \"monthly\";" +
          "要截止请用 repeat_until(纯日期 YYYY-MM-DD,含当天为止不再新增)。",
        field: intervalGiven ? "repeat_interval" : "repeat_until",
      }),
    };
  }
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_REPEAT_INTERVAL) {
    return {
      envelope: failEnvelope("INVALID_PARAMS", {
        message: `repeat_interval 必须是 1-${MAX_REPEAT_INTERVAL} 的整数(收到 ${String(interval)})。`,
        hint: 'repeat="daily" + 2 = 每两天;repeat="weekly" + 2 = 每两周;repeat="monthly" + 1 = 每月。',
        field: "repeat_interval",
      }),
    };
  }
  if (until !== null && !isCalendarDate(until)) {
    return {
      envelope: failEnvelope("INVALID_PARAMS", {
        message: `repeat_until「${until}」格式应为纯日期 YYYY-MM-DD(如 2026-12-31)。`,
        hint: "repeat_until 含当天为止(那天仍然算一次);带时刻的时间串请传给 start / end。",
        field: "repeat_until",
      }),
    };
  }
  if (until !== null && until < startDay) {
    return {
      envelope: failEnvelope("INVALID_PARAMS", {
        message: `repeat_until(${until}) 早于 start 的日期(${startDay}),这样一次都不会发生。`,
        hint: "repeat_until 含当天为止,所以它至少要与 start 同一天;截止日之后不再生成新的日程。",
        field: "repeat_until",
      }),
    };
  }
  const rule: RepeatRule = { repeat, interval, until };
  const { fromDay, toDay } = materializeWindow(today, startDay);
  if (until !== null && until < fromDay) {
    return {
      envelope: failEnvelope("INVALID_PARAMS", {
        message: `repeat_until(${until}) 早于今天(${today}),按这个重复规则不会产生任何日程。`,
        hint: `现在只能展开 ${today} 起未来 ${MATERIALIZE_DAYS} 天的日程;截止日至少要晚于今天。`,
        field: "repeat_until",
      }),
    };
  }
  if (repeat !== "none") {
    const first = planOccurrences(rule, startDay, fromDay, toDay, MATERIALIZE_DAYS).days[0];
    if (first === undefined) {
      return {
        envelope: failEnvelope("INVALID_PARAMS", {
          message: `按 repeat="${repeat}" + repeat_interval=${interval},${toDay} 之前不会产生任何日程。`,
          hint:
            `现在能展开的区间是 ${fromDay} 至 ${toDay}(今天起未来 ${MATERIALIZE_DAYS} 天);` +
            "间隔太长时这段时间里一次都没有,请把 repeat_interval 调小。",
          field: intervalGiven ? "repeat_interval" : "repeat",
        }),
      };
    }
  }
  return { rule };
}

/** 话术里的重复形态:"每天" / "每 2 周" / "不重复"。 */
function repeatName(rule: RepeatRule): string {
  const n = rule.interval;
  switch (rule.repeat) {
    case "none":
      return "不重复";
    case "daily":
      return n === 1 ? "每天" : `每 ${n} 天`;
    case "weekly":
      return n === 1 ? "每周" : `每 ${n} 周`;
    case "monthly":
      return n === 1 ? "每月" : `每 ${n} 个月`;
  }
}

/** 话术里的重复前缀:"每周重复的" / "每 2 周重复的";不重复返回空串。 */
function repeatLabel(rule: RepeatRule): string {
  return rule.repeat === "none" ? "" : `${repeatName(rule)}重复的`;
}

/** 话术里"展开到哪"那半句(重复日程必须有,否则家人不知道这条日程排到什么时候)。 */
function expandedText(rule: RepeatRule, summary: { count: number; lastDay: string | null }): string {
  const last = summary.lastDay ?? "今天";
  if (rule.until !== null) return `已展开 ${summary.count} 次至 ${last}(到 ${rule.until} 为止不再自动新增)`;
  return `已展开 ${summary.count} 次至 ${last}`;
}

/**
 * 折叠(重复 → 单次)那半句。**三件事**都要让人看懂:
 * ① 保留了一次(带时间 —— 家人要知道接下来是哪一次);② 其余未来的展开已收起;
 * ③ 过去的记录没有改动(这个系列压根没有历史实例时提了也是废话,略过)。
 *
 * ④ 整个系列都在过去、没保留任何一次时,明说"没有更晚的一次了",绝不编一个过去的日期出来。
 */
function collapsedText(result: CollapseResult): string {
  const kept =
    result.keptId === null || result.keptStart === null
      ? "这个系列没有更晚的一次了,以后不再重复"
      : `保留 ${result.keptStart} 那一次,其余未来的展开已收起`;
  return `整个系列已改为单次日程(${kept}${result.hasHistory ? ";已经过去的记录没有改动" : ""})`;
}

export function addEvent(db: Db, viewer: Viewer, timezone: string, input: AddEventInput): Envelope {
  // 归属解析先行(与 addTodo 同一顺序):解析不到 → MISSING_PARAMS + 成员名单(X10)。
  let owner: MemberRow | null = null;
  if (input.owner !== undefined) {
    const resolved = resolveMemberOrEnvelope(db, input.owner);
    if (!resolved.ok) return resolved.envelope;
    owner = resolved.member;
  }

  const allDay = input.all_day === true;
  const end = input.end ?? null;
  // 时间与 all_day 的联合校验(§5.1 ④)。放在归属之后、落库之前。
  const invalid = validateTimes(input.start, end, allDay);
  if (invalid) return invalid;

  // 重复规则(缺省 = 不重复)。校验排在时间之后、落库之前,拒绝条件见 resolveRepeatRule。
  const today = todayInTz(timezone);
  const resolved = resolveRepeatRule(input, NO_REPEAT, dayOf(input.start), today);
  if ("envelope" in resolved) return resolved.envelope;
  const rule = resolved.rule;

  const now = new Date().toISOString();
  const seriesId = generateId(db, "e", "event_series", timezone);
  const ownerId = owner?.id ?? null;
  const series: RepeatingSeriesRow = {
    id: seriesId,
    owner_id: ownerId,
    title: input.title,
    location: input.location ?? null,
    notes: input.notes ?? null,
    created_by: viewer.memberId,
    repeat: rule.repeat,
    repeat_interval: rule.interval,
    repeat_until: rule.until,
  };
  // 系列与实例同生共死:一个事务(写时物化,设计 §4)。不重复的日程恰好物化 1 个实例,
  // 重复的日程物化未来 MATERIALIZE_DAYS 天的实例,并受 repeat_until 截断。
  db.transaction(() => {
    db.prepare(`
      INSERT INTO event_series (id, owner_id, title, location, notes, repeat, repeat_interval, repeat_until, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      seriesId,
      ownerId,
      input.title,
      input.location ?? null,
      input.notes ?? null,
      rule.repeat,
      rule.interval,
      rule.until,
      viewer.memberId,
      now,
    );
    materializeNewSeries(db, timezone, series, rule, { start: input.start, end, allDay }, today);
  })();

  // 回执里的日程取**最早的那一次**(锚点):重复日程一次会有很多次,家人关心的是"从哪天开始排"。
  const view = toView(loadSeriesInstance(db, seriesId)!);
  if (rule.repeat === "none") {
    const hl = headline(view);
    if (owner === null) {
      return okEnvelope(view, `已添加全家日程 ${hl}。全家成员都能看到。`);
    }
    if (owner.id === viewer.memberId) {
      return okEnvelope(view, `已添加日程 ${hl}。仅你自己可见。`);
    }
    // V4:代记回执由服务端写出**说话人**(Viewer.memberName 来自 token,不可伪造)。
    return okEnvelope(view, `已为 ${owner.name} 添加日程 ${hl}。仅 ${owner.name} 可见,由 ${viewer.memberName} 代记。`);
  }

  // 重复日程的回执必须多说两句:重复的形态 + 展开到哪天 + N4 的"改删只作用整系列"。
  const hl = `${headline(view)}(${expandedText(rule, materializedSummary(db, seriesId))})`;
  const label = repeatLabel(rule);
  if (owner === null) {
    return okEnvelope(
      view,
      `已添加${label}全家日程 ${hl}。全家成员都能看到;修改/删除会作用于整个系列。`,
    );
  }
  if (owner.id === viewer.memberId) {
    return okEnvelope(view, `已添加${label}日程 ${hl}。仅你自己可见;修改/删除会作用于整个系列。`);
  }
  return okEnvelope(
    view,
    `已为 ${owner.name} 添加${label}日程 ${hl}。仅 ${owner.name} 可见,由 ${viewer.memberName} 代记;修改/删除会作用于整个系列。`,
  );
}

// ─────────────────────────── list_events ───────────────────────────

/**
 * 可见性过滤(全部下推到 SQL,与 listTodos 同风格)。
 *
 * 返回的行已经被过滤成"说话人可见的日程实例",因此 V5 的两个方向同时成立:
 * 不可见的日程**根本不会进结果集**(不会因为漏过滤而泄露),而"显式要他人个人日程"
 * 走的是参数层(没有这个参数形态)而不是这里静默返回空表。
 *
 * 附带 `s.deleted_at IS NULL`:系列软删时实例一并软删,这里是读路径上的第二道保险,
 * 避免任何"只软删了系列"的残留实例漏出来。
 */
const LIST_INSTANCES = `
  WITH live AS (
    SELECT i.id, i.series_id, i.owner_id, i.title, i.location, i.notes, i.start, i.end, i.all_day,
           i.created_by, i.created_at,
           CASE WHEN i.all_day = 1 THEN i.start || ' 00:00' ELSE i.start END AS start_key,
           CASE WHEN i.all_day = 1 THEN COALESCE(i.end, i.start) || ' 23:59'
                ELSE COALESCE(i.end, i.start) END AS end_key
    FROM event_instance i
    JOIN event_series s ON s.id = i.series_id
    WHERE i.deleted_at IS NULL AND s.deleted_at IS NULL
  )
  SELECT l.id, l.series_id, l.owner_id, l.title, l.location, l.notes, l.start, l.end, l.all_day,
         l.created_by, l.created_at,
         om.name AS owner_name, cm.name AS created_by_name
  FROM live l
  LEFT JOIN member om ON om.id = l.owner_id
  JOIN member cm ON cm.id = l.created_by
`;

/**
 * 可见范围的内部口径。`EventScope`("family" / "mine")是 list_events 的**公开参数**取值;
 * `"family_or_mine"` 只供 get_today 在域内复用同一份实现(它不对应任何参数,
 * 所以模型没有任何途径用它去要"别人的个人日程")。
 */
export type VisibilityScope = EventScope | "family_or_mine";

/**
 * scope → SQL 条件。alias 让同一套可见性口径能用在三处:读实例(LIST_INSTANCES,别名 l)、
 * 读某一天的日程(listEventsOnDay)、续期时挑可见的重复系列(VISIBLE_REPEATING_SERIES,别名 s)。
 * 三处共用一份实现,是为了让"读到的"与"被续期写到的"永远是同一个可见集合。
 */
function visibilityWhere(alias: string, scope: VisibilityScope | undefined, viewer: Viewer): { where: string; params: unknown[] } {
  // "个人日程归我" 与 "我代记的个人日程"分开写。
  const mine = `${alias}.owner_id = ?`;
  const delegated = `(${alias}.created_by = ? AND ${alias}.owner_id IS NOT NULL AND ${alias}.owner_id != ?)`;
  if (scope === "family") return { where: `${alias}.owner_id IS NULL`, params: [] };
  if (scope === "mine") return { where: mine, params: [viewer.memberId] };
  // get_today 的口径:全家日程 + 本人的个人日程,不含"我代记的他人个人日程"。
  if (scope === "family_or_mine") {
    return { where: `(${alias}.owner_id IS NULL OR ${mine})`, params: [viewer.memberId] };
  }
  return {
    where: `(${alias}.owner_id IS NULL OR ${mine} OR ${delegated})`,
    params: [viewer.memberId, viewer.memberId, viewer.memberId],
  };
}

export interface ListEventsInput {
  start: string;
  end: string;
  scope?: EventScope;
}

export function listEvents(db: Db, viewer: Viewer, timezone: string, input: ListEventsInput): Envelope {
  const startKey = timeKey(input.start, false);
  const endKey = timeKey(input.end, true);
  if (endKey < startKey) return endBeforeStart(startKey, endKey);

  // 惰性续期(设计 §4):窗口越过已展开边界时先把缺口补齐,再返回查询结果。
  // 这是**写在读路径上的写**,所以续期内部整段 try/catch:失败降级返回
  // (照常返回已展开范围内的实例 + 话术说明),读绝不整体报错。
  const renewal = renewRepeatingSeries(db, viewer, timezone, dayOf(endKey), input.scope);

  const { where, params } = visibilityWhere("l", input.scope, viewer);
  // 时间窗按**重叠**判定、边界含端点:跨窗口但仍在进行的日程也要出现,
  // 否则"今天 8 点开的会"会从"昨天到今天"的窗口里漏掉。
  const rows = db
    .prepare(
      `${LIST_INSTANCES} WHERE ${where} AND l.start_key <= ? AND l.end_key >= ?
        ORDER BY l.start_key ASC, l.start ASC, l.id ASC`,
    )
    .all(...params, endKey, startKey) as InstanceJoinRow[];
  const views = rows.map(toView);

  // 分桶只影响回执形状;过滤已经在 SQL 里做完了。
  const family = views.filter((v) => v.owner_id === null);
  const mine = views.filter((v) => v.owner_id === viewer.memberId);
  const delegated = views.filter((v) => v.owner_id !== null && v.owner_id !== viewer.memberId);

  // "今天"按**配置时区**判定(todayInTz),不读系统本地时区(容器默认 UTC 会整体偏一天)。
  const today = todayInTz(timezone);
  const windowText = `${input.start.slice(0, DATE_LEN) === today ? `今天 ${input.start}` : input.start} 至 ${input.end}`;

  const line = (v: EventView, i: number, withOwner: boolean): string =>
    `${i}. [${v.id}] ${v.title}(${describeTime(v.start, v.end, v.all_day)})${withOwner ? `(归属:${v.owner_name})` : ""}`;

  const parts: string[] = [];
  if (family.length > 0) {
    parts.push(`全家日程 ${family.length} 条:${family.map((v, i) => line(v, i + 1, false)).join(";")}`);
  }
  if (mine.length > 0) {
    parts.push(`你的个人日程 ${mine.length} 条:${mine.map((v, i) => line(v, i + 1, false)).join(";")}`);
  }
  if (delegated.length > 0) {
    parts.push(
      `你代记的个人日程 ${delegated.length} 条(仅归属人可见,你不能替 TA 修改):` +
        delegated.map((v, i) => line(v, i + 1, true)).join(";"),
    );
  }

  const data = { family, mine, delegated };
  // 续期的话术尾巴(降级 / 补到上限时才出现;平时是空串,S2 的回执一个字都不变)。
  const note = renewalNote(renewal);
  if (parts.length === 0) {
    return okEnvelope({ family: [], mine: [], delegated: [] }, `${windowText} 没有日程。${note}`);
  }
  return okEnvelope(data, `${windowText}:${parts.join("。")}。${note}`);
}

// ─────────────────────────── 某一天的日程(get_today 的数据源) ───────────────────────────

export interface DayEvents {
  /** 全家日程(owner_id 为空,V2 全员可见)。 */
  family: EventView[];
  /** 本人的个人日程(owner_id = 说话人,V1)。 */
  mine: EventView[];
  /**
   * 续期降级的话术尾巴(平时是空串)。
   * get_today 同样会触发惰性续期 —— 「今天的日程」里少了一条每天/每周重复的日程,
   * 比多一句解释更糟,所以这里与 list_events 用同一套续期与降级说明。
   */
  note: string;
}

/**
 * 取**某一天**(日历日)的日程实例,按与这一天有重叠判定、边界含端点。
 *
 * ## 可见范围为什么是"全家 + 本人",而不是 list_events 的缺省口径
 * list_events 缺省还含"我代记的他人个人日程"(V8 的查看权);**get_today 不含**。
 * 理由:那一块回答的是"我今天有什么事",代记者看到的是别人家的私人安排,把它混进
 * "我的今天"既不合语义,也是 V1 明确要挡住的方向(绝不含他人的个人项)。
 * 它仍然是 list_events 的一列 —— 需要时用 list_events(scope 缺省)去看。
 *
 * 顺带:惰性续期也按同一套口径做,所以 get_today **不会**顺手续期别人的系列,
 * 更不会因为它读不到就静默少一条自己的日程。
 */
export function listEventsOnDay(db: Db, viewer: Viewer, timezone: string, day: string): DayEvents {
  // 惰性续期(设计 §4):今天也在 92 天物化窗口之内,但系列可能是更早创建的,
  // 所以仍走同一条续期路径(读绝不因续期失败而整体报错)。
  const renewal = renewRepeatingSeries(db, viewer, timezone, day, "family_or_mine");

  const { where, params } = visibilityWhere("l", "family_or_mine", viewer);
  // 重叠判定(复用 timeKey:纯日期的那一天 = 00:00–23:59,all_day 的纯日期日程天然落在里面),
  // 昨天开始、后天结束的进行中日程也会出现,明天的日程不会。
  const startKey = timeKey(day, false);
  const endKey = timeKey(day, true);
  const rows = db
    .prepare(
      `${LIST_INSTANCES} WHERE ${where} AND l.start_key <= ? AND l.end_key >= ?
        ORDER BY l.start_key ASC, l.start ASC, l.id ASC`,
    )
    .all(...params, endKey, startKey) as InstanceJoinRow[];
  const views = rows.map(toView);
  return {
    family: views.filter((v) => v.owner_id === null),
    mine: views.filter((v) => v.owner_id === viewer.memberId),
    note: renewalNote(renewal),
  };
}

// ─────────────────────────── update_event ───────────────────────────

export interface UpdateEventInput {
  id: string;
  /** 缺省 = 不改 */
  title?: string;
  /** 缺省 = 不改;null = 清空 */
  location?: string | null;
  /** 缺省 = 不改;null = 清空 */
  notes?: string | null;
  /** 缺省 = 不改(不传半截格式的串,时间粒度由 all_day 决定) */
  start?: string;
  /** 缺省 = 不改;null = 去掉结束时间 */
  end?: string | null;
  /** 缺省 = 不改;与 start/end 的格式联合校验 */
  all_day?: boolean;
  /**
   * V7 的不可变字段:schema 保留它是为了让模型做"读-改-写"时能原样回传,
   * 因此同值幂等放行、不同值 DENIED(immutable)。跨归属变更走删除后重建。
   */
  owner?: string;
  /** 缺省 = 不改;N4:重复日程不支持只改其中一次,改动作用于整个系列 */
  repeat?: RepeatKind;
  /** 缺省 = 不改;只在 repeat ≠ "none" 时可传 */
  repeat_interval?: number;
  /** 缺省 = 不改;null = 去掉截止日 */
  repeat_until?: string | null;
}

export function updateEvent(db: Db, viewer: Viewer, timezone: string, input: UpdateEventInput): Envelope {
  const loaded = loadWritableEvent(db, viewer, input.id, "修改");
  if ("envelope" in loaded) return loaded.envelope;
  const { handle, instance } = loaded;
  const before = toView(instance);

  // 权限先于一切行内信息与幂等分支(本阶段的硬要求)。
  const denied = denyIfNotWritable(handle, viewer);
  if (denied) return denied;

  // V7:同值幂等放行(成员名/别名/成员 id 命中同一成员也算同值);不同值一律拒绝。
  // 排在权限之后 —— 不可见的行连"归属是谁"都不该顺带泄露(V5/X4 的教训)。
  if (input.owner !== undefined) {
    const resolved = resolveMemberOrEnvelope(db, input.owner);
    if (!resolved.ok) return resolved.envelope;
    if (resolved.member.id !== handle.ownerId) return denyImmutable(handle, before, input.owner);
  }

  // 时间:把新值与现值合并后走**同一套** all_day 联合校验(§5.1 ④)。
  const allDay = input.all_day ?? instance.all_day !== 0;
  const start = input.start ?? instance.start;
  const end = input.end === undefined ? instance.end : input.end;
  const invalid = validateTimes(start, end, allDay);
  if (invalid) return invalid;

  // 重复规则:与现值合并后走**同一套**校验(add 的那几条拒绝条件一字不改)。
  // 校验排在任何写入之前:被拒的调用不得留下半个系列。
  const today = todayInTz(timezone);
  const resolved = resolveRepeatRule(
    input,
    { repeat: handle.repeat, interval: handle.repeatInterval, until: handle.repeatUntil },
    dayOf(start),
    today,
  );
  if ("envelope" in resolved) return resolved.envelope;
  const rule = resolved.rule;

  const wasRepeating = handle.repeat !== "none";
  const nowRepeating = rule.repeat !== "none";
  const ruleChanged =
    rule.repeat !== handle.repeat ||
    rule.interval !== handle.repeatInterval ||
    rule.until !== handle.repeatUntil;
  const allDayChanged = input.all_day !== undefined && input.all_day !== (instance.all_day !== 0);
  const startChanged = input.start !== undefined && input.start !== instance.start;
  const endChanged = input.end !== undefined && input.end !== instance.end;
  // 折叠(重复 → 单次):单独标出来,它与"重复 → 重复"的重建路径在**保留哪一次**上不同
  // (保留最早的未来一次、过去的历史一行不动,见 rebuildInstances 的 S2c 裁决)。
  const collapsing = wasRepeating && rule.repeat === "none";
  // N4:重复日程的改动只作用于**整系列** —— 改时间或改规则都走"重建未开始的实例"(见
  // rebuildInstances),历史实例原样保留。单次日程(repeat='none')仍然就地改那一个实例,
  // 实例 id 不变(S2 语义,既有测试钉的就是这一条)。
  const rebuild = (wasRepeating || nowRepeating) && (ruleChanged || allDayChanged || startChanged || endChanged);

  // §5.1③:缺省 = 不改;null = 清空。值与现值相同的不写库(顺带得到幂等语义)。
  // 标题/地点/备注在系列与实例上都有,两侧一起写,否则 list_events 会读出旧标题。
  const textSets: string[] = [];
  const textParams: unknown[] = [];
  const instanceSets: string[] = [];
  const instanceParams: unknown[] = [];
  const changes: string[] = [];

  const setText = (column: "title" | "location" | "notes", value: string | null): void => {
    textSets.push(`${column} = ?`);
    textParams.push(value);
  };
  const current = (column: "title" | "location" | "notes"): string | null =>
    instance[column] as string | null;

  if (input.title !== undefined && input.title !== current("title")) {
    setText("title", input.title);
    changes.push(`标题→「${input.title}」`);
  }
  if (input.location !== undefined && input.location !== current("location")) {
    setText("location", input.location);
    // 自由文本不进话术(与审计只记元数据同理),只说改没改。
    changes.push(input.location === null ? "地点已清空" : "地点已更新");
  }
  if (input.notes !== undefined && input.notes !== current("notes")) {
    setText("notes", input.notes);
    changes.push(input.notes === null ? "备注已清空" : "备注已更新");
  }
  if (ruleChanged) {
    if (rule.repeat !== handle.repeat) changes.push(`重复→「${repeatName(rule)}」`);
    if (rule.interval !== handle.repeatInterval) changes.push(`重复间隔→「${rule.interval}」`);
    if (rule.until !== handle.repeatUntil) {
      changes.push(rule.until === null ? "去掉重复截止日" : `重复截止→「${rule.until}」`);
    }
  }
  // 时间只在实例上(系列没有时间字段)。两条路径都要说清"时间改了",
  // 因为重建时实例是被重造的,但家人要知道时间确实变了。
  // 折叠路径是例外:保留下来的是"最早的未来那一次",它沿用**自己的**时间(S2c 裁决),
  // 所以这三条在折叠时不成立 —— 话术不能说"改了"而库里没改。
  if (!collapsing) {
    if (allDayChanged) {
      changes.push(allDay ? "改为全天日程" : "改为带时刻日程");
    }
    if (startChanged) {
      changes.push(`开始时间改为 ${input.start}`);
    }
    if (endChanged) {
      changes.push(input.end === null ? "已去掉结束时间" : `结束时间改为 ${input.end}`);
    }
  }
  // 幂等成功回执排在权限闸门**之后**(否则越权者能凭 id 读出标题与当前状态)。
  if (textSets.length === 0 && instanceSets.length === 0 && !ruleChanged && !allDayChanged && !startChanged && !endChanged) {
    return okEnvelope(before, `日程 ${headline(before)} 未做修改(没有字段发生变化)。`);
  }

  if (textSets.length > 0) {
    db.prepare(`UPDATE event_series SET ${textSets.join(", ")} WHERE id = ?`).run(...textParams, handle.seriesId);
    // 重复日程的标题/地点/备注要同步到**全部活着的实例**(含历史那几次):系列与实例两侧
    // 各存一份,不同步的话 list_events 会读出旧标题。单次日程下这就是那唯一一个实例,
    // 所以同一段代码覆盖 S2 与重复日程两种形态。
    db.prepare(`UPDATE event_instance SET ${textSets.join(", ")} WHERE series_id = ? AND deleted_at IS NULL`).run(
      ...textParams,
      handle.seriesId,
    );
  }

  let updated: EventView;
  if (rebuild) {
    if (ruleChanged) {
      db.prepare("UPDATE event_series SET repeat = ?, repeat_interval = ?, repeat_until = ? WHERE id = ?").run(
        rule.repeat,
        rule.interval,
        rule.until,
        handle.seriesId,
      );
    }
    // 重建要用**改完之后的**系列字段(标题刚被改过),所以重读一次系列行。
    const srow = loadSeries(db, handle.seriesId)!;
    const collapse = rebuildInstances(
      db,
      timezone,
      {
        id: srow.id,
        owner_id: srow.owner_id,
        title: srow.title,
        location: srow.location,
        notes: srow.notes,
        created_by: srow.created_by,
        repeat: rule.repeat,
        repeat_interval: rule.interval,
        repeat_until: rule.until,
      },
      rule,
      { start, end, allDay },
      today,
    );
    if (collapse !== null) {
      // 折叠:回执说清保留/收起/历史三件事,并指向"保留下来的那一次"。
      if (allDayChanged || startChanged || endChanged) {
        changes.push("折叠后保留下来的那一次沿用它原来的时间");
      }
      changes.push(collapsedText(collapse));
      // 折叠后系列里最早的那一次可能是**历史**那条(loadSeriesInstance 取 start 最小的),
      // 所以优先按 keptId 指向保留的那次;没保留(全在过去)才退回最早的那次 ——
      // 绝不编一个未来的日期出来给家人看。
      const shown =
        (collapse.keptId === null ? undefined : loadInstance(db, collapse.keptId)) ??
        loadSeriesInstance(db, handle.seriesId) ??
        instance;
      updated = toView(shown);
    } else {
      const summary = materializedSummary(db, handle.seriesId);
      changes.push(`未来日程已按新规则重建(该系列现有 ${summary.count} 次,展开至 ${summary.lastDay ?? "今天"})`);
      updated = toView(loadSeriesInstance(db, handle.seriesId)!);
    }
  } else {
    if (allDayChanged) {
      instanceSets.push("all_day = ?");
      instanceParams.push(allDay ? 1 : 0);
    }
    if (startChanged) {
      instanceSets.push("start = ?");
      instanceParams.push(input.start);
    }
    if (endChanged) {
      instanceSets.push("end = ?");
      instanceParams.push(input.end);
    }
    if (instanceSets.length > 0) {
      db.prepare(`UPDATE event_instance SET ${instanceSets.join(", ")} WHERE id = ?`).run(
        ...instanceParams,
        before.id,
      );
    }
    updated = toView(loadInstance(db, before.id)!);
  }

  const hl = headline(updated);
  const tail = `改动:${changes.join(";")}。`;
  // N4 的可见性:重复日程不支持"只改其中一次",回执把这一点说出来,免得家人以为只动了某天。
  const scopeNote = wasRepeating || nowRepeating ? `重复日程不支持只改其中一次:这条改动作用于整个系列。` : "";
  // V3:全家日程任何成员可改,回执标注**操作者**(X8);个人日程只有归属人本人能改。
  if (handle.ownerId === null) {
    return okEnvelope(updated, `已由 ${viewer.memberName} 更新全家日程 ${hl}。${tail}${scopeNote}`);
  }
  return okEnvelope(updated, `已更新日程 ${hl}。${tail}${scopeNote}`);
}

// ─────────────────────────── delete_event ───────────────────────────

/** 软删系列 + 其活着的实例(§4 联动语义),同一时间戳,一个事务。 */
function softDeleteSeries(db: Db, seriesId: string, now: string): void {
  db.transaction(() => {
    db.prepare("UPDATE event_series SET deleted_at = ? WHERE id = ?").run(now, seriesId);
    db.prepare("UPDATE event_instance SET deleted_at = ? WHERE series_id = ? AND deleted_at IS NULL").run(now, seriesId);
  })();
}

/** 恢复系列 + 其实例(软删可逆,§4),同一时间戳,一个事务。 */
function restoreSeries(db: Db, seriesId: string): void {
  db.transaction(() => {
    db.prepare("UPDATE event_series SET deleted_at = NULL WHERE id = ?").run(seriesId);
    db.prepare("UPDATE event_instance SET deleted_at = NULL WHERE series_id = ?").run(seriesId);
  })();
}

export function deleteEvent(db: Db, viewer: Viewer, id: string): Envelope {
  const loaded = loadWritableEvent(db, viewer, id, "删除");
  if ("envelope" in loaded) return loaded.envelope;
  const { handle, instance } = loaded;
  const view = toView(instance);

  // V3:全家日程任何成员可删;个人日程归属人本人;V8:代记者可撤回自己代记的条目。
  // 可见性闸门已在 loadWritableEvent 跑过,这里是纵深防御。
  if (handle.ownerId !== null && !canDeleteEvent(handle, viewer)) return denyNotVisible();

  const now = new Date().toISOString();
  softDeleteSeries(db, handle.seriesId, now);

  const hl = headline(view);
  const data: EventMutationView = { ...view, deleted_at: now };
  if (handle.ownerId === null) {
    return okEnvelope(
      data,
      `已由 ${viewer.memberName} 删除全家日程 ${hl}(系列 ${handle.seriesId})。` +
        `已删除,可用 restore_deleted(kind="event", id="${handle.seriesId}") 恢复。`,
    );
  }
  if (handle.ownerId === viewer.memberId) {
    return okEnvelope(
      data,
      `已删除日程 ${hl}(系列 ${handle.seriesId})。` +
        `已删除,可用 restore_deleted(kind="event", id="${handle.seriesId}") 恢复。`,
    );
  }
  // V8:撤回自己代记的条目。
  return okEnvelope(
    data,
    `已撤回你代记的日程 ${hl}(归属:${handle.ownerName},系列 ${handle.seriesId})。` +
      `${handle.ownerName} 的日程列表里不再有它;可用 restore_deleted(kind="event", id="${handle.seriesId}") 恢复。`,
  );
}

/**
 * 恢复一条被软删的日程(§4:软删可逆),连带恢复它的实例。
 * 权限复用 canDeleteEvent:**恢复权与删除权同源**(理由见其注释)。
 *
 * **判定顺序:权限先于幂等**(S1 的教训)。幂等回执带标题("…未被删除,无需恢复"),
 * 若它排在 canDeleteEvent 之前,第三人拿别人的系列 id 就能读出该日程的标题与
 * "它没被删"——违反 V1/V3/V5/X4。调序之后幂等分支只剩"本人/自己代记的日程本来
 * 就未删除"这一种情况,话术照旧。
 */
export function restoreEvent(db: Db, viewer: Viewer, id: string): Envelope {
  const row = loadSeriesByHandle(db, id);
  if (!row) return eventMissing(id, "恢复");
  const handle = seriesToHandle(row);
  // 权限先于幂等,也先于"已删/未删"这类行内状态(S1 的教训)。
  if (!canDeleteEvent(handle, viewer)) return denyNotVisible();
  const instance = loadSeriesInstance(db, row.id, true);
  if (!instance) return eventMissing(id, "恢复");
  const view = toView(instance);

  // 未删除 → 幂等:不动任何字段(P2:重复调用不产生副作用)。
  if (row.deleted_at === null) {
    return okEnvelope({ ...view, deleted_at: null }, `日程 ${headline(view)} 未被删除,无需恢复。`);
  }

  restoreSeries(db, row.id);
  const restored = toView(loadSeriesInstance(db, row.id, true)!);
  const data: EventMutationView = { ...restored, deleted_at: null };

  if (handle.ownerId === null) {
    return okEnvelope(
      data,
      `已恢复全家日程 ${headline(restored)}(系列 ${row.id})。恢复的是整个系列及其全部日程实例,它重新出现在全家的日程列表里。`,
    );
  }
  if (handle.ownerId === viewer.memberId) {
    return okEnvelope(
      data,
      `已恢复日程 ${headline(restored)}(系列 ${row.id})。恢复的是整个系列及其全部日程实例,` +
        `它重新出现在你的日程列表里(个人日程仅归属人本人可见)。`,
    );
  }
  return okEnvelope(
    data,
    `已恢复你代记的日程 ${headline(restored)}(归属:${handle.ownerName},系列 ${row.id})。` +
      `${handle.ownerName} 现在又能看到这条日程了。`,
  );
}