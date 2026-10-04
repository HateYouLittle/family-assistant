import type { Db } from "../db/db.js";
import { generateId, isCalendarDate, todayInTz } from "../db/id.js";
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
 * - 一次 `add_event` = 1 个系列 + 1 个实例(见 `createInstanceForSeries` 的 S2b 接缝注释)。
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
}

interface SeriesJoinRow {
  id: string;
  owner_id: string | null;
  title: string;
  location: string | null;
  notes: string | null;
  repeat: string;
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
  SELECT s.id, s.owner_id, s.title, s.location, s.notes, s.repeat, s.created_by, s.created_at, s.deleted_at,
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
function describeTime(start: string, end: string | null, allDay: boolean): string {
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

/** 系列下的当前实例(含/不含已删)。repeat='none' 时恰有一个(S2b 见 createInstanceForSeries)。 */
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
}

/** 造实例所需的系列字段(刚 INSERT 完的系列行)。 */
interface NewSeries {
  id: string;
  owner_id: string | null;
  title: string;
  location: string | null;
  notes: string | null;
  created_by: string;
}

export interface NewInstanceTime {
  start: string;
  end: string | null;
  allDay: boolean;
}

/**
 * 按系列造实例 —— **S2b 的接缝**(本阶段刻意不做重复日程)。
 *
 * 本阶段 `add_event` 一律以 `repeat='none'` 建系列,所以这里只造 1 个实例
 * (系列自身的那一次),调用方不需要知道"实例是造出来的"这件事。
 *
 * S2b 会把本函数扩展成:repeat ≠ none 时按重复规则物化未来 92 天的实例,并在
 * list_events 读到边界之外时惰性续期(设计 §4);届时的接口形状(系列 + 起止时刻
 * → 一批实例)不必改,只需改函数体。
 *
 * 另有一处 S2b 要一并收口:`update_event` 改时间时,本阶段"改唯一实例"等价于
 * "改整系列"(设计 §4 对重复日程的修改只作用于整系列);S2b 需要重新裁决
 * "改时间是整体平移还是改重复规则",届时的联动也落在这层。
 */
export function createInstanceForSeries(
  db: Db,
  timezone: string,
  series: NewSeries,
  time: NewInstanceTime,
): string {
  const instanceId = generateId(db, "ei", "event_instance", timezone);
  db.prepare(`
    INSERT INTO event_instance (id, series_id, owner_id, title, location, notes, start, end, all_day, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
  return instanceId;
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

  const now = new Date().toISOString();
  const seriesId = generateId(db, "e", "event_series", timezone);
  const ownerId = owner?.id ?? null;
  db.prepare(`
    INSERT INTO event_series (id, owner_id, title, location, notes, repeat, repeat_interval, repeat_until, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, 'none', 1, NULL, ?, ?)
  `).run(seriesId, ownerId, input.title, input.location ?? null, input.notes ?? null, viewer.memberId, now);

  const instanceId = createInstanceForSeries(
    db,
    timezone,
    {
      id: seriesId,
      owner_id: ownerId,
      title: input.title,
      location: input.location ?? null,
      notes: input.notes ?? null,
      created_by: viewer.memberId,
    },
    { start: input.start, end, allDay },
  );

  const view = toView(loadInstance(db, instanceId)!);
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

function visibilityWhere(scope: EventScope | undefined, viewer: Viewer): { where: string; params: unknown[] } {
  // "个人日程归我" 与 "我代记的个人日程"分开写,S2b 也不必动这一层。
  const mine = "l.owner_id = ?";
  const delegated = "(l.created_by = ? AND l.owner_id IS NOT NULL AND l.owner_id != ?)";
  if (scope === "family") return { where: "l.owner_id IS NULL", params: [] };
  if (scope === "mine") return { where: mine, params: [viewer.memberId] };
  return {
    where: `(l.owner_id IS NULL OR ${mine} OR ${delegated})`,
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

  const { where, params } = visibilityWhere(input.scope, viewer);
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
  if (parts.length === 0) {
    return okEnvelope({ family: [], mine: [], delegated: [] }, `${windowText} 没有日程。`);
  }
  return okEnvelope(data, `${windowText}:${parts.join("。")}。`);
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
}

export function updateEvent(db: Db, viewer: Viewer, _timezone: string, input: UpdateEventInput): Envelope {
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

  // §5.1③:缺省 = 不改;null = 清空。值与现值相同的不写库(顺带得到幂等语义)。
  // 标题/地点/备注在系列与实例上都有,两侧一起写,否则 list_events 会读出旧标题。
  const seriesSets: string[] = [];
  const seriesParams: unknown[] = [];
  const instanceSets: string[] = [];
  const instanceParams: unknown[] = [];
  const changes: string[] = [];

  const setBoth = (column: "title" | "location" | "notes", value: string | null): void => {
    seriesSets.push(`${column} = ?`);
    seriesParams.push(value);
    instanceSets.push(`${column} = ?`);
    instanceParams.push(value);
  };
  const current = (column: "title" | "location" | "notes"): string | null =>
    instance[column] as string | null;

  if (input.title !== undefined && input.title !== current("title")) {
    setBoth("title", input.title);
    changes.push(`标题→「${input.title}」`);
  }
  if (input.location !== undefined && input.location !== current("location")) {
    setBoth("location", input.location);
    // 自由文本不进话术(与审计只记元数据同理),只说改没改。
    changes.push(input.location === null ? "地点已清空" : "地点已更新");
  }
  if (input.notes !== undefined && input.notes !== current("notes")) {
    setBoth("notes", input.notes);
    changes.push(input.notes === null ? "备注已清空" : "备注已更新");
  }
  // 时间只在实例上(系列没有时间字段)。
  if (input.all_day !== undefined && input.all_day !== (instance.all_day !== 0)) {
    instanceSets.push("all_day = ?");
    instanceParams.push(allDay ? 1 : 0);
    changes.push(allDay ? "改为全天日程" : "改为带时刻日程");
  }
  if (input.start !== undefined && input.start !== instance.start) {
    instanceSets.push("start = ?");
    instanceParams.push(input.start);
    changes.push(`开始时间改为 ${input.start}`);
  }
  if (input.end !== undefined && input.end !== instance.end) {
    instanceSets.push("end = ?");
    instanceParams.push(input.end);
    changes.push(input.end === null ? "已去掉结束时间" : `结束时间改为 ${input.end}`);
  }

  // 幂等成功回执排在权限闸门**之后**(否则越权者能凭 id 读出标题与当前状态)。
  if (seriesSets.length === 0 && instanceSets.length === 0) {
    return okEnvelope(before, `日程 ${headline(before)} 未做修改(没有字段发生变化)。`);
  }

  if (seriesSets.length > 0) {
    db.prepare(`UPDATE event_series SET ${seriesSets.join(", ")} WHERE id = ?`).run(...seriesParams, handle.seriesId);
  }
  if (instanceSets.length > 0) {
    db.prepare(`UPDATE event_instance SET ${instanceSets.join(", ")} WHERE id = ?`).run(...instanceParams, before.id);
  }

  const updated = toView(loadInstance(db, before.id)!);
  const hl = headline(updated);
  const tail = `改动:${changes.join(";")}。`;
  // V3:全家日程任何成员可改,回执标注**操作者**(X8);个人日程只有归属人本人能改。
  if (handle.ownerId === null) {
    return okEnvelope(updated, `已由 ${viewer.memberName} 更新全家日程 ${hl}。${tail}`);
  }
  return okEnvelope(updated, `已更新日程 ${hl}。${tail}`);
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