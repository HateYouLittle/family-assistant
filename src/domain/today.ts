import type { Db } from "../db/db.js";
import { daysBetween, todayInTz } from "../db/id.js";
import { describeTime, listEventsOnDay, type EventView } from "./events.js";
import { okEnvelope, type Envelope } from "./envelope.js";
import { describeDue, listOwnOpenTodosDueBy } from "./todos.js";
import type { Viewer } from "./viewer.js";

/**
 * 通用域:今日概览(设计方案 §5「通用(2)」的 get_today)。
 *
 * ## 它是什么
 * **无参数**的读工具,回答「**我**今天有什么事」,返回**分列**的三块(不混成一个数组,
 * Agent 要能分别转述):
 * 1. `due_today` —— 本人**今日到期**的未完成待办;
 * 2. `overdue`  —— 本人**逾期未完成**的待办;
 * 3. `events`   —— **今天**的日程,分 `family`(全家)与 `mine`(我的个人)两列。
 *
 * 两个用途(设计 §5):① Agent 每轮对话开场拉一次;② Hermes cron 的个人每日摘要数据源
 * (§3.3 / D7 —— 程序本身不推送,也没有任何身份参数可用)。
 *
 * ## 可见性(V1/V2)
 * **绝不包含他人的个人项**:待办只取 `owner_id = 说话人`(不含 V8 的"我代记的他人待办"),
 * 日程只取全家日程 + 本人个人日程(不含"我代记的他人个人日程")。
 * 那些条目仍然能在 list_todos / list_events 里按 V8 看到 —— 可见性没有因此被削弱,
 * 只是「我的今天」这个语义不该把它们算进来。
 *
 * ## 「今天」的口径
 * 一律按**配置时区**(`todayInTz(timezone)`)算,不读系统本地时区(设计 §4:
 * 容器默认 UTC 会让「今天」「逾期」整体偏一天)。
 * 日程的「今天」按**与这一天有重叠**判定(含端点),所以跨天的进行中日程会出现在今天,
 * 明天的不会(判定的实现见 events.listEventsOnDay,与 list_events 同一套)。
 *
 * ## 读工具
 * 不记审计(工具层没有 audit 摘要器即视为读,与 list_todos / list_events 同一纪律)。
 */

/** 今日概览里的一条待办(分列后带相对截止说法,Agent 直接转述即可)。 */
export interface TodayTodoItem {
  id: string;
  title: string;
  due_date: string;
  /** 相对截止说法:「今天截止」/「截止 10-01,已逾期 4 天」(复用 describeDue,话术只有一处实现)。 */
  due_text: string;
  /** 距今天的天数:0 = 今天到期,负数 = 已逾期几天;**没有截止日期的待办不会出现在这里**。 */
  days_from_today: number;
}

/** 今日概览里的一条日程。`column` 是归属列,话术与 data 都用它标明全家/我的。 */
export interface TodayEventItem {
  id: string;
  /** 系列 id:update_event / restore_deleted 的句柄(与 list_events 一致,两个 id 都给)。 */
  series_id: string;
  title: string;
  start: string;
  end: string | null;
  all_day: boolean;
  location: string | null;
  /** 归属列:"family" = 全家日程(V2),"mine" = 我的个人日程(V1)。 */
  column: "family" | "mine";
  /** 话术里的时间(全天 / 带时刻 / 跨天三种形状,与 events 域同一套描述)。 */
  time_text: string;
}

export interface TodayData {
  /** 判定用的「今天」,按配置时区算;Agent 可用它把话术里的"今天"落到具体日期。 */
  today: string;
  /** ① 本人今日到期的未完成待办。 */
  due_today: TodayTodoItem[];
  /** ② 本人逾期未完成的待办。 */
  overdue: TodayTodoItem[];
  /** ③ 今天的日程,全家 / 我的个人两列(**不含**他人的个人日程)。 */
  events: { family: TodayEventItem[]; mine: TodayEventItem[] };
}

function toTodoItem(v: { id: string; title: string; due_date: string | null }, today: string): TodayTodoItem {
  // 调用方已保证 due_date 非空(listOwnOpenTodosDueBy 过滤掉无截止日期的),
  // 这里仍然给一个兜底值,免得 type 收窄被绕过时静默产出 "undefined 天"。
  const due = v.due_date ?? today;
  return {
    id: v.id,
    title: v.title,
    due_date: due,
    due_text: describeDue(due, today),
    days_from_today: daysBetween(today, due),
  };
}

function toEventItem(v: EventView, column: "family" | "mine"): TodayEventItem {
  return {
    id: v.id,
    series_id: v.series_id,
    title: v.title,
    start: v.start,
    end: v.end,
    all_day: v.all_day,
    location: v.location,
    column,
    time_text: describeTime(v.start, v.end, v.all_day),
  };
}

/** 待办块的话术:`1. [t-…] 交电费(今天截止)`;逾期块自带"已逾期 N 天"(describeDue)。 */
function todoBlock(items: TodayTodoItem[], label: string): string {
  return `${label} ${items.length} 条:${items.map((t, i) => `${i + 1}. [${t.id}] ${t.title}(${t.due_text})`).join(";")}`;
}

/** 日程块的话术:`1. [ei-…] 牙医(15:00–16:00)(全家日程)`。 */
function eventBlock(items: TodayEventItem[], label: string): string {
  return `${label} ${items.length} 条:${items.map((e, i) => `${i + 1}. [${e.id}] ${e.title}(${e.time_text})(${e.column === "family" ? "全家日程" : "我的个人日程"})`).join(";")}`;
}

/**
 * 今日概览的三块拼装。
 *
 * 三块**各自成段**(分列,Agent 可分别转述),空块不进话术 —— 回执里只说有的那几块,
 * 免得"逾期待办 0 条"这种噪声占掉家人注意力。
 */
function composeMessage(data: TodayData, note: string): string {
  const parts: string[] = [];
  if (data.due_today.length > 0) parts.push(todoBlock(data.due_today, "今日到期"));
  if (data.overdue.length > 0) parts.push(todoBlock(data.overdue, "已逾期"));
  if (data.events.family.length > 0) parts.push(eventBlock(data.events.family, "全家日程"));
  if (data.events.mine.length > 0) parts.push(eventBlock(data.events.mine, "我的个人日程"));

  // 空状态也要说人话(P3):三块都空时给一句明确的"今天没事",而不是丢一个空壳回去。
  if (parts.length === 0) {
    return `今天(${data.today})没有你的日程,也没有到期或逾期的待办 —— 今天没有需要你处理的事。${note}`;
  }
  return `今天(${data.today}):${parts.join("。")}。${note}`;
}

/**
 * get_today:**无参数**的读工具。
 *
 * 判定与口径(都在这一层,工具层薄壳):
 * - 「今天」按配置时区(FA_TIMEZONE)算,不读系统本地时区;
 * - 待办只取本人未完成且**有截止日期**的:due_date = 今天 → 第一块,due_date < 今天 → 第二块;
 * - 日程按与今天有重叠判定,分全家 / 我的个人两列;
 * - **绝不包含他人的个人待办 / 个人日程**(V1/V2)。
 *
 * note 是日程域的续期降级说明(正常情况为空串)。它与 list_events 用同一套续期:
 * 「今天的日程」少一条每周重复的日程,比多一句解释更糟。
 */
export function getToday(db: Db, viewer: Viewer, timezone: string): Envelope {
  const today = todayInTz(timezone);

  // 待办:一次查询拿回「今日到期 + 逾期」,再按 due_date 与 today 的关系分列。
  const open = listOwnOpenTodosDueBy(db, viewer, today);
  const data: TodayData = {
    today,
    due_today: open.filter((t) => t.due_date === today).map((t) => toTodoItem(t, today)),
    overdue: open.filter((t) => t.due_date !== null && t.due_date < today).map((t) => toTodoItem(t, today)),
    events: { family: [], mine: [] },
  };
  const events = listEventsOnDay(db, viewer, timezone, today);
  data.events.family = events.family.map((v) => toEventItem(v, "family"));
  data.events.mine = events.mine.map((v) => toEventItem(v, "mine"));

  return okEnvelope(data, composeMessage(data, events.note));
}