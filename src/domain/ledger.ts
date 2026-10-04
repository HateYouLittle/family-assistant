import type { Db } from "../db/db.js";
import { generateId, isCalendarDate, todayInTz } from "../db/id.js";
import { failEnvelope, okEnvelope, type Envelope, type FailEnvelope } from "./envelope.js";
import { resolveMemberOrEnvelope, type MemberRow } from "./members.js";
import type { Viewer } from "./viewer.js";

/**
 * 记账域(设计方案 §4「entry + category」、§5 记账工具)。
 * 可见性收敛在本层,工具层不可绕过。
 *
 * ## 模型
 * - `entry`:一笔流水。金额是**整数分**且必须 > 0;`ledger`(shared|personal)决定可见性,
 *   `member_id` 是这笔钱**算谁的**(共享账本里也必填,共享的是账本不是归属)。
 * - `category`:分类,可缺省 —— 允许记"未分类",汇总里单列(§4:降低对话摩擦)。
 *
 * ## 可见性不变量(逐条落点见各函数注释)
 * - V1 `ledger=personal` 的 entry **仅归属人本人可见**(member_id 即归属人);
 * - V2 `ledger=shared` 的 entry **全员可见**(汇总时按 member_id 分列,见 §8.1 走查 3);
 * - V3 个人账本仅本人可改删;共享账本任何成员可纠错(回执标注**操作者**);
 * - V4 **个人账本只能本人写**:`ledger=personal` 时 member_id 必须等于说话人,否则 DENIED(X6)。
 *   这是记账与待办/日程的**关键不对称**:待办/日程的代记语义是"我帮你记一下",而私账的语义是
 *   "这笔钱只有我认",代记会让"谁记的"与"谁花的"对不上,后续对账无法解释(设计 §12 评审结论②)。
 *   共享账本则可以代记并指定归属人(§8.1 走查 1/3)。
 * - V5 读一律在 **SQL 层**过滤;**显式**指向他人个人账本一律 DENIED,绝不静默空表(X2);
 * - V6 权限与读取同源:`entry.id` 只出现在本人可见的读取结果里,跨成员传 id 天然被 V3 挡住;
 * - V7 `ledger` 与 `member_id` 创建后不可变:同值幂等放行、异值 DENIED(immutable)(X12/X13);
 * - V8 **在记账域不适用**:V4 已经禁止"代记个人账本",所以不存在"我创建、归属他人"的个人 entry,
 *   创建者也就没有额外的查看/删除权。不给 V8 开口子,是刻意的。
 *
 * ## 判定顺序纪律(S1/S2 踩过的坑)
 * **权限判定先于任何返回行内信息的分支**:写路径统一走 `loadWritableEntry`,
 * 顺序是 行不存在 → NOT_FOUND;看不见 → DENIED(not_visible);已软删 → NOT_FOUND。
 * 拒绝信封里绝不出现他人流水的金额/备注 —— `denyNotVisible` / `denyImmutable` 的
 * message 与 hint 都是**不含行内信息**的固定话术。
 *
 * ## 金额(§4 v0.5.2 + P4)
 * - 入参是整数分(`amount_fen`),**话术里显示元**(`¥35.00`);格式换算是 Agent 的活(P1),程序不猜。
 * - 一切合计由 **SQL 的 SUM** 算出(P4):既不让模型心算,也不把明细丢给模型自己加。
 * - 单笔达到 `LARGE_AMOUNT_FEN` 时回执**追加**一句确认提示,**不硬拒**(家庭真有大额支出,
 *   硬拒会挡掉合法场景;但静默接受会让"35 元"误录成"35000 元"无从察觉)。
 *
 * 说话人来自连接(Viewer,见 ./viewer.ts),工具面没有身份参数(P7/D13)。
 */

// ─────────────────────────── 类型与常量 ───────────────────────────

export type EntryType = "expense" | "income";
/** 账本:共享账本 / 个人账本。决定可见性(V1/V2)。 */
export type LedgerKind = "shared" | "personal";
/** 分类的 kind 与流水的 type 是同一套枚举(§4:category.kind 必须与 type 一致)。 */
export type CategoryKind = EntryType;

/**
 * 单笔金额的**异常提示阈值**(分)。达到即在回执里追加一句确认提示,**不硬拒**(§4 v0.5.2)。
 *
 * ¥10,000.00 = 1_000_000 分。家庭日常开销远低于此,超过去多半是"少写了一个 0"
 * (3500 → 350000)。不硬拒的理由:家庭真有大额支出(学费、车贷、装修),硬拒会挡掉合法场景;
 * 但静默接受又让误录无从察觉,所以要出声而不是拦下来。
 * 抽成具名常量是为了让阈值可测:test/ledger.test.ts 直接断言这个值,也断言
 * "阈值本身算大额、阈值下一分不算"。
 */
export const LARGE_AMOUNT_FEN = 1_000_000;

/**
 * `add_category` 的 sort_order 步长 = **同类当前最大值 + 10**(分类表预置的是 10/20/30…)。
 * 选 10 而不是 1:留出手工插队的余地(管理页调整顺序时不必整表重排),
 * 且与预置数据的间隔一致,一眼能看出"新分类排在同类末尾"。
 */
export const CATEGORY_SORT_STEP = 10;

/** 汇总的统计口径与周期(period 的边界见 `resolveRange`)。 */
export type SummaryPeriod = "today" | "this_week" | "this_month" | "last_month" | "this_year";
/** 汇总的分组维度。`member` 必须显式给 ledger(见 summarizeEntries 的 MISSING_PARAMS)。 */
export type SummaryGroupBy = "category" | "member" | "ledger";

export interface CategoryView {
  id: string;
  name: string;
  kind: CategoryKind;
  sort_order: number;
}

/** list_entries / 写操作回执里的 data 形状:一条流水。 */
export interface EntryView {
  id: string;
  type: EntryType;
  /** 整数分。话术里用 formatYuan 显示成元。 */
  amount_fen: number;
  category_id: string | null;
  /** null = 未分类(§4 允许分类缺省)。 */
  category_name: string | null;
  ledger: LedgerKind;
  member_id: string;
  member_name: string;
  note: string | null;
  occurred_date: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
}

/** delete / restore 的回执 data:补上 deleted_at,让调用方一眼看出当前状态。 */
export type EntryMutationView = EntryView & { deleted_at: string | null };

// ─────────────────────────── 金额与日期的展示 ───────────────────────────

/**
 * 整数分 → 话术里的金额(`3500` → `¥35.00`,`1200000` → `¥12,000.00`)。
 *
 * 全程整数运算:先拆成"元"与"分"两段再拼,**不经过浮点**——
 * `(fen/100).toFixed(2)` 那种写法在 0.1+0.2 一类场景会带出误差,而钱的显示不该有误差。
 * 分段取模还顺带保证了"永远两位小数"(¥0.5 → ¥0.50),省掉一处 toFixed 的进位边界。
 *
 * 入参约定:**整数分**(entry.amount_fen 与所有 SQL SUM 的结果都是)。
 */
export function formatYuan(fen: number): string {
  const neg = fen < 0 ? "-" : "";
  const abs = Math.abs(fen);
  const yuan = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg}¥${yuan}.${String(abs % 100).padStart(2, "0")}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function pad4(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 日历日加减天数(一律按 UTC 构造,不读系统本地时区 —— 容器默认 UTC 会整体偏一天,§4)。
 * 与 events.ts 里那份是同一套算法;两个域各留一份是刻意的:域模块自包含、
 * 不必为了三行纯函数互相 import,改一处的日历语义也不会波及另一个域。
 */
function shiftDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${pad4(dt.getUTCFullYear())}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** 某年某月的天数(month1 = 1..12)。 */
function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** 某日的星期(0 = 周日 … 6 = 周六)。按 UTC 构造,同样不受系统本地时区影响。 */
function weekday(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// ─────────────────────────── 分类:add_category / list_categories ───────────────────────────

interface CategoryRow {
  id: string;
  name: string;
  kind: string;
  sort_order: number;
}

function toCategoryView(row: CategoryRow): CategoryView {
  return { id: row.id, name: row.name, kind: row.kind as CategoryKind, sort_order: row.sort_order };
}

const SELECT_CATEGORY = "SELECT id, name, kind, sort_order FROM category";

function loadCategory(db: Db, id: string): CategoryRow | undefined {
  return db.prepare(`${SELECT_CATEGORY} WHERE id = ?`).get(id) as CategoryRow | undefined;
}

export interface AddCategoryInput {
  name: string;
  kind: CategoryKind;
}

/**
 * 建一个分类。
 *
 * 两条拒绝条件,都排在落库之前:
 * 1. `(name, kind)` 重复 → INVALID_PARAMS。唯一性是 schema 层的 UNIQUE(name, kind)(迁移 v2),
 *    这里先查是为了把"重名"翻译成话术 —— 让 UNIQUE 抛出来只剩一句 SQLite 的
 *    "UNIQUE constraint failed",那样的错误没法直接转述给家人(P3)。
 *    按 kind 分开:支出与收入可以各有一个「其他」,所以同名的不同类**不是**重名。
 * 2. kind 非法 → INVALID_PARAMS(纵深防御:domain 层不假设上游已校验)。
 */
export function addCategory(db: Db, _viewer: Viewer, _timezone: string, input: AddCategoryInput): Envelope {
  const name = input.name.trim();
  if (name === "") {
    return failEnvelope("INVALID_PARAMS", {
      message: "分类名不能为空。",
      hint: '传一个短名字(如"宠物");支出与收入可以各有一个同名分类(如两个「其他」)。',
      field: "name",
    });
  }
  if (input.kind !== "expense" && input.kind !== "income") {
    return failEnvelope("INVALID_PARAMS", {
      message: `分类的 kind 只支持 "expense"(支出)或 "income"(收入)(收到 ${JSON.stringify(input.kind)})。`,
      hint: '记支出就传 kind="expense",记收入就传 kind="income";它必须与流水 type 一致。',
      field: "kind",
    });
  }
  const dup = db
    .prepare("SELECT id FROM category WHERE name = ? AND kind = ?")
    .get(name, input.kind) as { id: string } | undefined;
  if (dup) {
    return failEnvelope("INVALID_PARAMS", {
      message: `${input.kind === "expense" ? "支出" : "收入"}分类里已经有「${name}」了。`,
      hint:
        `已有的分类 id 是 ${dup.id};add_entry 直接传这个 category_id 即可,不必重建。` +
        `真的需要另一个同名的,换个说法(如「${name}·其他」)。`,
      field: "name",
    });
  }

  // 步长:CATEGORY_SORT_STEP。同类当前最大值之后(同类为空时从 0 + 步长开始)。
  const maxRow = db.prepare("SELECT MAX(sort_order) AS max_sort FROM category WHERE kind = ?").get(input.kind) as {
    max_sort: number | null;
  };
  const sortOrder = (maxRow.max_sort ?? 0) + CATEGORY_SORT_STEP;

  const id = generateId(db, "c", "category", _timezone);
  db.prepare("INSERT INTO category (id, name, kind, sort_order) VALUES (?, ?, ?, ?)").run(id, name, input.kind, sortOrder);
  const view = toCategoryView(loadCategory(db, id)!);
  return okEnvelope(
    view,
    `已${input.kind === "expense" ? "支出" : "收入"}分类 [${id}]:${view.name}(排序 ${sortOrder})。` +
      `记流水时用 add_entry(category_id="${id}") 挂到这一类。`,
  );
}

export interface ListCategoriesInput {
  kind?: CategoryKind;
}

/**
 * 列出分类。缺省 = 支出与收入全列;回执按支出/收入分两组 —— 家人问"有哪些分类"时,
 * 一屏看到两组比一个混排的清单好认。
 */
export function listCategories(db: Db, _viewer: Viewer, _timezone: string, input: ListCategoriesInput): Envelope {
  if (input.kind !== undefined && input.kind !== "expense" && input.kind !== "income") {
    return failEnvelope("INVALID_PARAMS", {
      message: `kind 只支持 "expense"(支出)或 "income"(收入)(收到 ${JSON.stringify(input.kind)})。`,
      hint: "不传就列出全部;add_entry 的 type 决定该挂哪一组。",
      field: "kind",
    });
  }
  const rows = (
    input.kind === undefined
      ? db.prepare(`${SELECT_CATEGORY} ORDER BY kind DESC, sort_order, name`).all()
      : db.prepare(`${SELECT_CATEGORY} WHERE kind = ? ORDER BY sort_order, name`).all(input.kind)
  ) as CategoryRow[];
  const views = rows.map(toCategoryView);

  if (views.length === 0) {
    return okEnvelope({ categories: [] }, `没有${input.kind === "income" ? "收入" : "支出"}分类(可用 add_category 新建)。`);
  }
  const groups: { kind: CategoryKind; label: string; items: CategoryView[] }[] = [];
  for (const kind of ["expense", "income"] as const) {
    if (input.kind !== undefined && input.kind !== kind) continue;
    const items = views.filter((v) => v.kind === kind);
    if (items.length > 0) groups.push({ kind, label: kind === "expense" ? "支出分类" : "收入分类", items });
  }
  const parts = groups.map((g) => `${g.label} ${g.items.length} 个:${g.items.map((c) => `${c.name}(${c.id})`).join("、")}`);
  return okEnvelope(
    { categories: views },
    `${parts.join(";")}。分类可缺省:不给 category_id 就是「未分类」,汇总里会单列。`,
  );
}

// ─────────────────────────── 可见性判定(V1/V2/V4 的唯一入口) ───────────────────────────

/**
 * 可见性(V1/V2),**独立于任何状态**。
 * 这是所有其它判定的前提:读路径(listEntries / summarizeEntries)按它做 SQL 过滤,
 * 写路径(loadWritableEntry)按它先拒绝。它只看 ledger 与归属,不看 deleted_at、不看参数。
 */
export function canSeeEntry(view: EntryView, viewer: Viewer): boolean {
  if (view.ledger === "shared") return true; // V2:共享账本全员可见
  return view.member_id === viewer.memberId; // V1:个人账本仅归属人
}

/**
 * 写权限(V3):个人账本仅归属人;共享账本任何成员可纠错(V3 家庭内互信,回执标注操作者)。
 * 与可见性同源,所以直接建立在 canSeeEntry 上 —— 记账域没有 V8 那条额外通道(见文件头注释)。
 *
 * **恢复权与删除权同源**(S1/S2 在 todo/event 域的裁决,记账域沿用):
 * `restore_deleted` 复用本判定。理由同样是"能删不能救回来"等于把笔误变成不可挽回。
 */
export function canWriteEntry(view: EntryView, viewer: Viewer): boolean {
  return canSeeEntry(view, viewer);
}

/** V3/V5:他人的个人账本 → 明确拒绝。固定话术,不含任何行内信息(金额/备注/日期)。 */
function denyNotVisible(): FailEnvelope {
  return failEnvelope("DENIED", {
    reason: "not_visible",
    message: "个人账本仅归属人本人可见,你无法查看或操作他人账本里的记账记录。",
    hint: "直接向用户转述:家人之间的个人账本互相不可见(共享账本人人都能看到)。要看对方记了什么,让 TA 自己说,或用 ledger=\"shared\" 看公共账。",
  });
}

/** V4/X6:个人账本只能本人写。共享账本可代记并指定归属人,所以这条只拦 personal。 */
function denyPersonalLedgerWrite(target: MemberRow, viewer: Viewer): FailEnvelope {
  return failEnvelope("DENIED", {
    // reason 用 not_visible(与"他人的个人项一律不可见/不可动"同源):
    // 对写者而言,别人的私账与他无关 —— 既看不见也写不了,一条理由比两条更好解释。
    reason: "not_visible",
    message: `个人账本只能本人记:这笔流水要记在 ${target.name} 名下,而 ${viewer.memberName} 不能替 TA 记。`,
    hint:
      `共享的花费就记到共享账本:add_entry(member_id="${target.name}", ledger="shared", …),全家成员都能看到;` +
      `只有"这笔钱只有我认"的才记 ledger="personal",那时 member_id 必须是说话人本人。`,
  });
}

/** V7:归属/账本不可变(X12 私账改共享、X13 公共支出挪进私账)。固定话术 + 给出路。 */
function denyImmutable(view: EntryView, given: { ledger?: LedgerKind; member_id?: string }): FailEnvelope {
  const ledgerChanged = given.ledger !== undefined && given.ledger !== view.ledger;
  const detail = ledgerChanged
    ? `流水 [${view.id}] 现在记在${ledgerLabel(view.ledger)}账本,不能把它改成${
        given.ledger === "shared" ? "共享" : "你的个人"
      }账本。`
    : `流水 [${view.id}] 记在 ${view.member_name} 名下,你不能把它改成「${given.member_id}」名下的。`;
  const hint = ledgerChanged
    ? `要换账本:先用 delete_entry 删除这条(软删,可恢复),再用 add_entry(ledger="${given.ledger}", …) 重新记一笔;不要试图用 update 改账本。`
    : `要换归属人:先用 delete_entry 删除这条(软删,可恢复),再用 add_entry(member_id="${given.member_id}", …) 重新记一笔;不要试图用 update 改归属。`;
  return failEnvelope("DENIED", {
    reason: "immutable",
    message: `归属/账本不可修改,如需变更请删除后重建。${detail}`,
    hint,
  });
}

// ─────────────────────────── 行级查询与共享过滤片段 ───────────────────────────

interface EntryJoinRow {
  id: string;
  type: string;
  amount_fen: number;
  category_id: string | null;
  ledger: string;
  member_id: string;
  note: string | null;
  occurred_date: string;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
  category_name: string | null;
  member_name: string;
  created_by_name: string;
}

const SELECT_ENTRY = `
  SELECT e.id, e.type, e.amount_fen, e.category_id, e.ledger, e.member_id, e.note,
         e.occurred_date, e.created_by, e.created_at, e.deleted_at,
         c.name AS category_name, om.name AS member_name, cm.name AS created_by_name
  FROM entry e
  LEFT JOIN category c ON c.id = e.category_id
  JOIN member om ON om.id = e.member_id
  JOIN member cm ON cm.id = e.created_by
`;

function toEntryView(row: EntryJoinRow): EntryView {
  return {
    id: row.id,
    type: row.type as EntryType,
    amount_fen: row.amount_fen,
    category_id: row.category_id,
    category_name: row.category_name,
    ledger: row.ledger as LedgerKind,
    member_id: row.member_id,
    member_name: row.member_name,
    note: row.note,
    occurred_date: row.occurred_date,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    created_at: row.created_at,
  };
}

/** 取行(含已删):只有 restore_entry 需要看到已删的行。 */
function loadEntry(db: Db, id: string): EntryJoinRow | undefined {
  return db.prepare(`${SELECT_ENTRY} WHERE e.id = ?`).get(id) as EntryJoinRow | undefined;
}

/** 读路径的可见性 SQL 片段(V1/V2)。三个分支的形状固定,缺省分支是前两者的并集。 */
function visibilityClause(ledger: LedgerKind | undefined, viewer: Viewer): { where: string; params: unknown[] } {
  if (ledger === "shared") return { where: "e.ledger = 'shared'", params: [] };
  if (ledger === "personal") {
    return { where: "e.ledger = 'personal' AND e.member_id = ?", params: [viewer.memberId] };
  }
  return {
    where: "(e.ledger = 'shared' OR (e.ledger = 'personal' AND e.member_id = ?))",
    params: [viewer.memberId],
  };
}

/**
 * X2/V5:**显式**要他人的个人账本 → DENIED,绝不静默空表。
 *
 * 三种组合的判定:
 * - `ledger` 不是 personal(共享账本 / 缺省)→ 不拦。共享账本全员可见,
 *   `member_id` 在这里是**归属人筛选**("我们家这个月妈妈花了多少"是正常用法)。
 * - `ledger="personal"` 且不传 member_id → 隐含"本人的私账",放行(与缺省 ledger 同义)。
 * - `ledger="personal"` + member_id=本人 → **必须放行**(X7:假阴性同样致命,
 *   做成"恒拒"会让家人自己都看不到自己的账本)。
 * - `ledger="personal"` + member_id=他人 → DENIED(X2)。
 */
function denyOthersPersonalLedger(
  ledger: LedgerKind | undefined,
  resolved: MemberRow | null,
  viewer: Viewer,
): FailEnvelope | null {
  if (ledger !== "personal") return null;
  if (resolved === null || resolved.id === viewer.memberId) return null;
  return denyNotVisible();
}

/** 解析记账相关的归属参数:名字/别名/id 都收;失败 → MISSING_PARAMS(附名单)/ AMBIGUOUS(附候选)。 */
function resolveEntryMember(
  db: Db,
  ref: string | undefined,
): { ok: true; member: MemberRow | null } | { ok: false; envelope: FailEnvelope } {
  if (ref === undefined) return { ok: true, member: null };
  const r = resolveMemberOrEnvelope(db, ref);
  if (r.ok) return { ok: true, member: r.member };
  // 复用 resolveMemberOrEnvelope 的翻译(名单/候选),只把 missing 里的字段名换成记账域的字段名:
  // 待办/日程域是 owner,记账域是 member_id,回给模型的字段名必须与它填的参数一致。
  const env = r.envelope;
  return {
    ok: false,
    envelope: env.missing ? { ...env, missing: ["member_id"] } : env,
  };
}

/** category_id 的存在性与 kind 一致性(§4 校验规则)。type 传入是"合并后"的 type。 */
function checkCategory(
  db: Db,
  categoryId: string,
  type: EntryType,
  field = "category_id",
): { ok: true; category: CategoryRow } | { ok: false; envelope: FailEnvelope } {
  const row = loadCategory(db, categoryId);
  if (!row) {
    return {
      ok: false,
      envelope: failEnvelope("NOT_FOUND", {
        message: `没有这个分类(${categoryId})。`,
        hint: "先调 list_categories 看现有分类的 id;不给 category_id 也可以(记成未分类,汇总里单列)。",
        id: categoryId,
        field,
      }),
    };
  }
  if (row.kind !== type) {
    return {
      ok: false,
      envelope: failEnvelope("INVALID_PARAMS", {
        message: `分类「${row.name}」是${row.kind === "expense" ? "支出" : "收入"}分类,与这笔流水的 type="${type}" 不一致。`,
        hint:
          `分类的 kind 必须与 type 一致:支出分类只能挂支出、收入分类只能挂收入。` +
          `要么把 type 改成 "${row.kind}",要么换一个该类下的分类(id 见 list_categories)。`,
        field,
      }),
    };
  }
  return { ok: true, category: row };
}

/** 金额校验(P1:整数分,程序不换算也不四舍五入)。> 0 的整数分,0/负数/小数一律 INVALID_PARAMS。 */
function checkAmount(fen: unknown, field = "amount_fen"): FailEnvelope | null {
  const got = typeof fen === "number" ? fen : JSON.stringify(fen);
  if (typeof fen !== "number" || !Number.isFinite(fen) || !Number.isInteger(fen)) {
    return failEnvelope("INVALID_PARAMS", {
      message: `amount_fen 必须是整数(单位:分),收到 ${got}。`,
      hint: '35 元 = 3500 分。程序不解析"35 块"这类自由文本(P1),请自行换算后传整数;字符串 "35" 同样会被拒绝。',
      field,
    });
  }
  if (fen <= 0) {
    return failEnvelope("INVALID_PARAMS", {
      message: `amount_fen 必须大于 0 分,收到 ${fen}。`,
      hint: "记账流水必须有金额(表结构的约束就是 amount_fen > 0);退款/冲销请用一条 income 流水表达。",
      field,
    });
  }
  return null;
}

/** occurred_date 的日期校验(纵深防御:schema 已经查过形状与日历日,直调 domain 的调用方也该被拦)。 */
function checkDate(value: string, field: string): FailEnvelope | null {
  if (!isCalendarDate(value)) {
    return failEnvelope("INVALID_PARAMS", {
      message: `${field}「${value}」不是合法日期,应为真实存在的 YYYY-MM-DD。`,
      hint: "occurred_date 只到日(家庭记账的时间粒度);相对日期(上周五)先自行换算再传。",
      field,
    });
  }
  return null;
}

// ─────────────────────────── add_entry ───────────────────────────

export interface AddEntryInput {
  /** 归属人(算谁的)。必填(OQ2:必须明确)。名字/别名/id 都接受。 */
  member_id: string;
  /** 缺省 = "shared"(共享账本)。personal = 本人的私账,此时 member_id 必须等于说话人(V4)。 */
  ledger?: LedgerKind;
  type: EntryType;
  amount_fen: number;
  category_id?: string | null;
  note?: string | null;
  /** 缺省 = 今天(配置时区),不读系统本地时区。 */
  occurred_date?: string;
}

/** 话术里的账本名(个人账本对外一律说"你的",因为 V4 已保证它就是说话人自己的)。 */
function ledgerLabel(ledger: LedgerKind): string {
  return ledger === "shared" ? "共享" : "你的个人";
}

/** 金额异常提示(§4 v0.5.2):达到阈值就追加一句,**不硬拒**。 */
function largeAmountNote(fen: number): string {
  return fen >= LARGE_AMOUNT_FEN ? `金额较大(${formatYuan(fen)}),确认无误请忽略本条。` : "";
}

/** 话术里的分类片段:未分类是**显式**的一段,不是留空 —— 家人要能一眼看出这笔没归类(§4)。 */
function categoryText(view: EntryView): string {
  return view.category_name === null ? "未分类" : `分类:${view.category_name}`;
}

/** 话术里的半句:`日期 类型 金额 · 分类`。add / list / update 共用同一形状。 */
function entryHeadline(view: EntryView): string {
  const typeText = view.type === "expense" ? "支出" : "收入";
  return `${view.occurred_date} ${typeText} ${formatYuan(view.amount_fen)} · ${categoryText(view)}`;
}

/**
 * 记一笔流水。判定顺序(每一步都在落库之前):
 * 1. 解析 member_id → MISSING_PARAMS(附成员名单)/ AMBIGUOUS(附候选),复用 resolveMemberOrEnvelope;
 * 2. **V4 权限闸门**:`ledger=personal` 而 member_id ≠ 说话人 → DENIED(X6);
 * 3. amount_fen 校验 → INVALID_PARAMS;
 * 4. occurred_date 校验 → INVALID_PARAMS;
 * 5. category_id:不存在 → NOT_FOUND;kind 与 type 不一致 → INVALID_PARAMS;
 * 6. 落库 + 回执(标注落在哪个账本、是否代记、金额偏大时追加确认提示)。
 *
 * **权限排在参数校验之前**:V4 这条一旦不满足,换任何金额都还是 DENIED,
 * 先报它能让模型一次就知道这条路不通(否则它会一次次改金额重试)。
 * 前两步都不涉及任何已有流行的信息,所以这个次序不泄露 V1/V2 的任何东西。
 */
export function addEntry(db: Db, viewer: Viewer, timezone: string, input: AddEntryInput): Envelope {
  const resolved = resolveEntryMember(db, input.member_id);
  if (!resolved.ok) return resolved.envelope;
  const member = resolved.member!;

  const ledger: LedgerKind = input.ledger ?? "shared";
  if (ledger !== "shared" && ledger !== "personal") {
    return failEnvelope("INVALID_PARAMS", {
      message: `ledger 只支持 "shared"(共享账本)或 "personal"(个人账本),收到 ${JSON.stringify(input.ledger)}。`,
      hint: '共享的花销记 ledger="shared"(缺省也是它,全员可见);只有"这笔钱只有我认"的才记 "personal"。',
      field: "ledger",
    });
  }
  if (input.type !== "expense" && input.type !== "income") {
    return failEnvelope("INVALID_PARAMS", {
      message: `type 只支持 "expense"(支出)或 "income"(收入),收到 ${JSON.stringify(input.type)}。`,
      hint: '花了钱传 type="expense";进账(工资、红包、退款)传 type="income"。',
      field: "type",
    });
  }

  // V4/X6:个人账本只能本人写。
  if (ledger === "personal" && member.id !== viewer.memberId) return denyPersonalLedgerWrite(member, viewer);

  const amountError = checkAmount(input.amount_fen);
  if (amountError) return amountError;

  const occurred = input.occurred_date ?? todayInTz(timezone);
  const dateError = checkDate(occurred, "occurred_date");
  if (dateError) return dateError;

  // category 可缺省(§4):不给就是未分类,汇总里单列。
  if (input.category_id !== undefined && input.category_id !== null) {
    const check = checkCategory(db, input.category_id, input.type);
    if (!check.ok) return check.envelope;
  }

  const id = generateId(db, "en", "entry", timezone);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO entry (id, type, amount_fen, category_id, ledger, member_id, note, occurred_date, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.type,
    input.amount_fen,
    input.category_id ?? null,
    ledger,
    member.id,
    input.note ?? null,
    occurred,
    viewer.memberId,
    now,
  );

  const view = toEntryView(loadEntry(db, id)!);
  const note = largeAmountNote(view.amount_fen);
  if (ledger === "personal") {
    return okEnvelope(view, `已记入你的个人账本 [${view.id}]:${entryHeadline(view)}。仅你自己可见。${note}`);
  }
  const tail =
    member.id === viewer.memberId
      ? "全家成员都能看到。"
      : `全家成员都能看到;由 ${viewer.memberName} 代记。`;
  return okEnvelope(view, `已记入共享账本 [${view.id}]:${entryHeadline(view)} · 归属:${view.member_name}。${tail}${note}`);
}

// ─────────────────────────── list_entries ───────────────────────────

export interface ListEntriesInput {
  /** 下界(含边界),occurred_date >= start。缺省 = 不限。 */
  start?: string;
  /** 上界(含边界),occurred_date <= end。缺省 = 不限。 */
  end?: string;
  /** 归属人筛选(算谁的)。ledger 缺省时它只筛可见范围内的行(X2 只拦"他人的个人账本")。 */
  member_id?: string;
  category_id?: string;
  type?: EntryType;
  /** 缺省 = 共享账本 + 本人的个人账本。 */
  ledger?: LedgerKind;
  /** 按备注模糊过滤(LIKE)。 */
  q?: string;
}

/** 读路径共用的过滤片段(不含可见性,可见性由调用方按自己的口径追加)。 */
interface ReadFilters {
  where: string;
  params: unknown[];
}

/**
 * 解析读路径的过滤参数。member_id / category_id 都要解析(而不是原样塞进 SQL):
 * 前者决定"筛谁的"(也决定 X2 能不能成立),后者要校验存在性 ——
 * **拼错分类 id 静默返回空表,和"这个月没有支出"是同一种误导**(V5 的同一条纪律)。
 *
 * **分两步是为了让权限闸门能插在中间**:归属解析与 X2 拒绝排在 category_id 的
 * NOT_FOUND 之前(权限先于一切),而这两步都不返回任何行内信息(见 §5 的判定顺序纪律)。
 */
function resolveReadMember(
  db: Db,
  ref: string | undefined,
): { ok: true; member: MemberRow | null } | { ok: false; envelope: FailEnvelope } {
  return resolveEntryMember(db, ref);
}

/** 第二步:过滤片段(caller 已完成归属解析与 X2 闸门)。 */
function buildReadFilters(
  db: Db,
  member: MemberRow | null,
  input: { category_id?: string; type?: EntryType; q?: string },
): { ok: true; filters: ReadFilters } | { ok: false; envelope: FailEnvelope } {
  if (input.category_id !== undefined) {
    const row = loadCategory(db, input.category_id);
    if (!row) {
      return {
        ok: false,
        envelope: failEnvelope("NOT_FOUND", {
          message: `没有这个分类(${input.category_id})。`,
          hint: "先调 list_categories 看现有分类的 id;拼错 id 只会让结果为空,那样分不清是「没有记录」还是「分类写错了」。",
          id: input.category_id,
          field: "category_id",
        }),
      };
    }
  }
  if (input.type !== undefined && input.type !== "expense" && input.type !== "income") {
    return {
      ok: false,
      envelope: failEnvelope("INVALID_PARAMS", {
        message: `type 只支持 "expense"(支出)或 "income"(收入),收到 ${JSON.stringify(input.type)}。`,
        hint: "不传就支出与收入都列;汇总时建议用 type 收窄,别把收入和支出加在一起。",
        field: "type",
      }),
    };
  }

  const where: string[] = [];
  const params: unknown[] = [];
  if (member !== null) {
    where.push("e.member_id = ?");
    params.push(member.id);
  }
  if (input.category_id !== undefined) {
    where.push("e.category_id = ?");
    params.push(input.category_id);
  }
  if (input.type !== undefined) {
    where.push("e.type = ?");
    params.push(input.type);
  }
  if (input.q !== undefined && input.q !== "") {
    const escaped = input.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    where.push("(e.note LIKE ? ESCAPE '\\')");
    params.push(`%${escaped}%`);
  }
  return { ok: true, filters: { where: where.join(" AND "), params } };
}

/** 流水列表的一行:`[id] 日期 类型 金额 · 分类 · 归属`。备注不进话术(自由文本,与审计同理)。 */
function entryLine(view: EntryView, index: number): string {
  return `${index}. [${view.id}] ${entryHeadline(view)} · 归属:${view.member_name}`;
}

/**
 * 列出流水(V1/V2/V5)。
 *
 * - 可见性过滤全部下推到 SQL;`ledger` 缺省 = 共享账本 + 本人的个人账本;
 * - **显式**要他人的个人账本 → DENIED(X2),不是空表;
 * - `member_id` 是归属人筛选,**在可见范围内生效**(共享账本里按人筛是正常用法);
 * - 排序按流水日期倒序:家人问"最近记了啥"时最新的一笔要排在最前面。
 */
export function listEntries(db: Db, viewer: Viewer, _timezone: string, input: ListEntriesInput): Envelope {
  if (input.ledger !== undefined && input.ledger !== "shared" && input.ledger !== "personal") {
    return failEnvelope("INVALID_PARAMS", {
      message: `ledger 只支持 "shared" 或 "personal",收到 ${JSON.stringify(input.ledger)}。`,
      hint: '不传就是共享账本 + 你自己的个人账本;想只看公共账传 ledger="shared"。',
      field: "ledger",
    });
  }
  for (const [field, value] of [
    ["start", input.start],
    ["end", input.end],
  ] as const) {
    if (value !== undefined) {
      const err = checkDate(value, field);
      if (err) return err;
    }
  }

  // 判定顺序:归属解析 → **X2 权限闸门** → 其它过滤校验 → SQL 过滤。
  // 权限排在 category_id 的 NOT_FOUND 之前:越权请求不该先拿到"这个分类不存在"这种
  // 与权限无关的旁证(判定顺序纪律,见文件头)。
  const resolvedMember = resolveReadMember(db, input.member_id);
  if (!resolvedMember.ok) return resolvedMember.envelope;
  const denied = denyOthersPersonalLedger(input.ledger, resolvedMember.member, viewer);
  if (denied) return denied;

  const built = buildReadFilters(db, resolvedMember.member, input);
  if (!built.ok) return built.envelope;

  const visibility = visibilityClause(input.ledger, viewer);
  // 可见性 + 各过滤条件全部下推 SQL(片段都来自本文件的常量,值一律走占位符)。
  const whereParts = ["e.deleted_at IS NULL", visibility.where];
  const params: unknown[] = [...visibility.params];
  if (built.filters.where !== "") {
    whereParts.push(built.filters.where);
    params.push(...built.filters.params);
  }
  if (input.start !== undefined) {
    whereParts.push("e.occurred_date >= ?");
    params.push(input.start);
  }
  if (input.end !== undefined) {
    whereParts.push("e.occurred_date <= ?");
    params.push(input.end);
  }
  const where = whereParts.join(" AND ");

  const rows = db
    .prepare(`${SELECT_ENTRY} WHERE ${where} ORDER BY e.occurred_date DESC, e.created_at DESC, e.id DESC`)
    .all(...params) as EntryJoinRow[];
  const views = rows.map(toEntryView);

  // 分桶只影响回执形状;过滤已经在 SQL 里做完。
  const shared = views.filter((v) => v.ledger === "shared");
  const personal = views.filter((v) => v.ledger === "personal");

  const rangeText =
    input.start !== undefined && input.end !== undefined
      ? ` ${input.start} 至 ${input.end}`
      : input.start !== undefined
        ? ` ${input.start} 起`
        : input.end !== undefined
          ? ` 截至 ${input.end}`
          : "";

  const parts: string[] = [];
  if (shared.length > 0) parts.push(`共享账本 ${shared.length} 条:${shared.map((v, i) => entryLine(v, i + 1)).join(";")}`);
  if (personal.length > 0) {
    parts.push(
      `你的个人账本 ${personal.length} 条(仅本人可见):${personal.map((v, i) => entryLine(v, i + 1)).join(";")}`,
    );
  }
  if (parts.length === 0) {
    return okEnvelope({ entries: [], shared: [], personal: [] }, `${rangeText.trim() ? `${rangeText.trim()}:` : ""}没有符合条件的记账记录。`);
  }
  const lead = input.start !== undefined || input.end !== undefined ? `${rangeText.trim()}:` : "";
  return okEnvelope({ entries: views, shared, personal }, `${lead}${parts.join("。")}。`);
}

// ─────────────────────────── update_entry ───────────────────────────

export interface UpdateEntryInput {
  id: string;
  /** 缺省 = 不改。必须是正整数分。 */
  amount_fen?: number;
  /** 缺省 = 不改;null = 置为未分类。 */
  category_id?: string | null;
  /** 缺省 = 不改;null = 清空备注。 */
  note?: string | null;
  /** 缺省 = 不改。 */
  occurred_date?: string;
  /** 缺省 = 不改;改了会让现有分类的 kind 与它不一致(见 updateEntry 里的显式拒绝)。 */
  type?: EntryType;
  /** V7 不可变字段:同值幂等放行,异值 DENIED(immutable)。 */
  ledger?: LedgerKind;
  /** V7 不可变字段:同值幂等放行,异值 DENIED(immutable)。**不是定位符** —— 定位靠 id。 */
  member_id?: string;
}

/** 行根本不存在 → NOT_FOUND(P5:修改/删除必须带精确 id,先 list 拿)。 */
function entryMissing(id: string, action: string): FailEnvelope {
  return failEnvelope("NOT_FOUND", {
    message: `没有找到这条记账记录(${id}),无法${action}。`,
    id,
    hint: "先调 list_entries 拿到当前有效的精确 id 再操作(不要凭记忆转述 id)。",
  });
}

/** 行存在但已软删 → 同样按 NOT_FOUND(§4:已删即不在可见范围),但要给出恢复出路。 */
function entryAlreadyDeleted(id: string, action: string): FailEnvelope {
  return failEnvelope("NOT_FOUND", {
    message: `记账记录 [${id}] 已被删除,无法${action}。`,
    id,
    hint: `已删除的记录不再出现在 list_entries 里;若要找回,用 restore_deleted(kind="entry", id="${id}")。`,
  });
}

/**
 * update / delete 的统一取行。**判定顺序本身是可见性纪律的一部分**:
 * 行不存在 → NOT_FOUND;看不见 → DENIED(not_visible);已软删 → NOT_FOUND。
 * 反过来就等于先给信息、后判权限:第三人拿别人的 id 试探,会读到"这条已被删除"外加一条现成的
 * restore_deleted 命令,而同一条记录在未删状态下回的是 DENIED —— 判定口径随 deleted_at 漂移,
 * 这本身就是泄露(V5)。
 */
function loadWritableEntry(
  db: Db,
  viewer: Viewer,
  id: string,
  action: string,
): { view: EntryView } | { envelope: FailEnvelope } {
  const row = loadEntry(db, id);
  if (!row) return { envelope: entryMissing(id, action) };
  const view = toEntryView(row);
  // 可见性先于行内信息:能不能看这条,与它删没删过无关(V1/V2)。
  if (!canSeeEntry(view, viewer)) return { envelope: denyNotVisible() };
  if (row.deleted_at !== null) return { envelope: entryAlreadyDeleted(id, action) };
  return { view };
}

/**
 * 改一笔流水。
 *
 * 判定顺序(与既有域同纪律):
 * 1. 取行 → NOT_FOUND / DENIED(not_visible) / NOT_FOUND(已删);
 * 2. **权限**:个人账本仅归属人、共享账本任何成员(V3;记账域无 V8 的 not_writable 分支);
 * 3. **V7**:`ledger` / `member_id` 与现值不同 → DENIED(immutable) + "删除后重建";
 * 4. 参数校验(金额、日期、分类存在性与 kind 一致性)→ INVALID_PARAMS / NOT_FOUND;
 * 5. §5.1③ 置空语义:缺省 = 不改,`null` = 清空(`note=null` 清备注、`category_id=null` 置未分类);
 * 6. 幂等:没有任何字段变化就不写库,回执说明"未做修改"。
 *
 * **`type` 可改,但不会连带改分类**:改了 type 而保留一个 kind 不匹配的分类会被显式拒绝
 * (INVALID_PARAMS),并告诉模型"同时传 category_id=null 置为未分类"。不静默替用户清掉分类 ——
 * 悄悄把分类弄丢比吵一架更难被发现。
 */
export function updateEntry(db: Db, viewer: Viewer, _timezone: string, input: UpdateEntryInput): Envelope {
  const loaded = loadWritableEntry(db, viewer, input.id, "修改");
  if ("envelope" in loaded) return loaded.envelope;
  const before = loaded.view;

  // 权限先于不可变:不可见的行连"归属是谁 / 记在哪"都不该顺带泄露(V5)。
  if (!canWriteEntry(before, viewer)) return denyNotVisible();

  // V7:同值幂等放行(成员名/别名/成员 id 命中同一成员也算同值);不同值一律拒绝。
  if (input.ledger !== undefined && input.ledger !== before.ledger) return denyImmutable(before, { ledger: input.ledger });
  if (input.member_id !== undefined) {
    const resolved = resolveEntryMember(db, input.member_id);
    if (!resolved.ok) return resolved.envelope;
    if (resolved.member!.id !== before.member_id) return denyImmutable(before, { member_id: input.member_id });
  }

  const amountError = input.amount_fen === undefined ? null : checkAmount(input.amount_fen);
  if (amountError) return amountError;
  if (input.occurred_date !== undefined) {
    const err = checkDate(input.occurred_date, "occurred_date");
    if (err) return err;
  }
  if (input.type !== undefined && input.type !== "expense" && input.type !== "income") {
    return failEnvelope("INVALID_PARAMS", {
      message: `type 只支持 "expense"(支出)或 "income"(收入),收到 ${JSON.stringify(input.type)}。`,
      hint: "不传 = 不改;支出与收入的互转要同时处理分类(见 hint 里的一致性说明)。",
      field: "type",
    });
  }
  if (input.ledger !== undefined && input.ledger !== "shared" && input.ledger !== "personal") {
    return failEnvelope("INVALID_PARAMS", {
      message: `ledger 只支持 "shared" 或 "personal",收到 ${JSON.stringify(input.ledger)}。`,
      hint: "ledger 只能原样回传(同值幂等放行);换账本请删除后重建。",
      field: "ledger",
    });
  }

  // §5.1③:缺省 = 不改;null = 清空。与现值相同的不写库(顺带得到幂等语义)。
  const type = input.type ?? before.type;
  const categoryId = input.category_id === undefined ? before.category_id : input.category_id;
  if (categoryId !== null) {
    const check = checkCategory(db, categoryId, type);
    if (!check.ok) {
      // 改 type 却保留旧分类时,给一条"顺带把分类置空"的出路(否则模型只能靠猜来重试)。
      const base = check.envelope;
      const hint =
        input.type !== undefined && before.category_id !== null
          ? `${base.hint ?? ""}要把这笔改成${type === "expense" ? "支出" : "收入"}又不想留原分类,请同时传 category_id=null(置为未分类)。`
          : base.hint;
      return { ...base, hint };
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const changes: string[] = [];
  if (input.amount_fen !== undefined && input.amount_fen !== before.amount_fen) {
    sets.push("amount_fen = ?");
    params.push(input.amount_fen);
    changes.push(`金额改为 ${formatYuan(input.amount_fen)}`);
  }
  if (input.type !== undefined && input.type !== before.type) {
    sets.push("type = ?");
    params.push(input.type);
    changes.push(`类型改为${input.type === "expense" ? "支出" : "收入"}`);
  }
  if (categoryId !== before.category_id) {
    sets.push("category_id = ?");
    params.push(categoryId);
    changes.push(categoryId === null ? "已置为未分类" : "分类已更新");
  }
  if (input.note !== undefined && input.note !== before.note) {
    sets.push("note = ?");
    params.push(input.note);
    // 自由文本不进话术(与审计只记元数据同理),只说改没改。
    changes.push(input.note === null ? "备注已清空" : "备注已更新");
  }
  if (input.occurred_date !== undefined && input.occurred_date !== before.occurred_date) {
    sets.push("occurred_date = ?");
    params.push(input.occurred_date);
    changes.push(`日期改为 ${input.occurred_date}`);
  }

  if (sets.length === 0) {
    return okEnvelope(before, `记账记录 [${before.id}]:${entryHeadline(before)} 未做修改(没有字段发生变化)。`);
  }
  db.prepare(`UPDATE entry SET ${sets.join(", ")} WHERE id = ?`).run(...params, input.id);
  const updated = toEntryView(loadEntry(db, input.id)!);
  const note = largeAmountNote(updated.amount_fen);
  // V3:共享账本任何成员可纠错,回执标注**操作者**(X8 的记账版);个人账本只有本人能改。
  const head =
    before.ledger === "shared"
      ? `已由 ${viewer.memberName} 更新共享账本流水 [${updated.id}]:${entryHeadline(updated)}`
      : `已更新你的个人账本流水 [${updated.id}]:${entryHeadline(updated)}`;
  return okEnvelope(updated, `${head}。改动:${changes.join(";")}。${note}`);
}

// ─────────────────────────── delete_entry / restore_entry ───────────────────────────

/**
 * 软删一笔流水(P5:一律软删、可恢复)。
 * V3:共享账本任何成员可删(回执标注操作者);个人账本仅归属人;他人的个人账本 → DENIED(not_visible)(X5)。
 */
export function deleteEntry(db: Db, viewer: Viewer, _timezone: string, id: string): Envelope {
  const loaded = loadWritableEntry(db, viewer, id, "删除");
  if ("envelope" in loaded) return loaded.envelope;
  const view = loaded.view;

  // 可见性闸门已在 loadWritableEntry 跑过;这里是纵深防御,防止日后调序时静默放行。
  if (!canWriteEntry(view, viewer)) return denyNotVisible();

  const now = new Date().toISOString();
  db.prepare("UPDATE entry SET deleted_at = ? WHERE id = ?").run(now, id);
  const data: EntryMutationView = { ...view, deleted_at: now };
  const tail = `可用 restore_deleted(kind="entry", id="${id}") 恢复。`;
  if (view.ledger === "shared") {
    return okEnvelope(
      data,
      `已由 ${viewer.memberName} 删除共享账本流水 [${view.id}]:${entryHeadline(view)} · 归属:${view.member_name}。已删除,${tail}`,
    );
  }
  return okEnvelope(data, `已删除你的个人账本流水 [${view.id}]:${entryHeadline(view)}。已删除,${tail}`);
}

/**
 * 恢复一笔被软删的流水(§4:软删可逆)。权限复用 canWriteEntry:**恢复权与删除权同源**。
 *
 * **判定顺序:权限先于幂等**(S1 的教训)。幂等回执带金额与分类,若它排在权限之前,
 * 第三人拿别人的 id 就能读出这笔钱多少、记在什么分类上——违反 V1/V3/V5。
 */
export function restoreEntry(db: Db, viewer: Viewer, id: string): Envelope {
  const row = loadEntry(db, id);
  if (!row) return entryMissing(id, "恢复");
  const view = toEntryView(row);
  // 权限先于幂等,也先于"已删/未删"这类行内状态。
  if (!canWriteEntry(view, viewer)) return denyNotVisible();
  // 未删除 → 幂等:不动任何字段(P2:重复调用不产生副作用)。
  if (row.deleted_at === null) {
    return okEnvelope(
      { ...view, deleted_at: null },
      `记账记录 [${id}]:${entryHeadline(view)} 未被删除,无需恢复。`,
    );
  }

  db.prepare("UPDATE entry SET deleted_at = NULL WHERE id = ?").run(id);
  const restored = toEntryView(loadEntry(db, id)!);
  const data: EntryMutationView = { ...restored, deleted_at: null };
  if (restored.ledger === "shared") {
    return okEnvelope(
      data,
      `已恢复共享账本流水 [${restored.id}]:${entryHeadline(restored)} · 归属:${restored.member_name}。它重新出现在共享账本里(共享账本全员可见)。`,
    );
  }
  return okEnvelope(
    data,
    `已恢复你的个人账本流水 [${restored.id}]:${entryHeadline(restored)}。它重新出现在你的账本里(个人账本仅本人可见)。`,
  );
}

// ─────────────────────────── summarize_entries ───────────────────────────

export interface SummarizeEntriesInput {
  /** 与 start/end **二选一**;都不给 = 本月。 */
  period?: SummaryPeriod;
  start?: string;
  end?: string;
  /** 必填:category / member / ledger。member 必须同时显式给 ledger(见下)。 */
  group_by: SummaryGroupBy;
  type?: EntryType;
  category_id?: string;
  member_id?: string;
  /** 缺省 = 共享账本 + 本人的个人账本(分列输出,不混算)。group_by="member" 时必填。 */
  ledger?: LedgerKind;
}

export interface SummaryTotals {
  total_fen: number;
  expense_fen: number;
  income_fen: number;
  count: number;
}

export interface SummaryGroup extends SummaryTotals {
  /** 分组键:分类 id / 空串(未分类)/ 成员 id / 账本名。 */
  key: string;
  label: string;
}

/** 一个账本的分块。默认范围下有 shared 与 personal 两块,**不混算**。 */
export interface SummaryBlock extends SummaryTotals {
  ledger: LedgerKind;
  groups: SummaryGroup[];
}

export interface SummaryResult {
  start: string;
  end: string;
  /** 显式给了 period 时记下它;用 start/end 时为 null。 */
  period: SummaryPeriod | null;
  type: EntryType | null;
  group_by: SummaryGroupBy;
  ledgers: SummaryBlock[];
}

/** period → 话术里的中文名。 */
const PERIOD_LABELS: Record<SummaryPeriod, string> = {
  today: "今天",
  this_week: "本周",
  this_month: "本月",
  last_month: "上月",
  this_year: "今年",
};

/**
 * 统计区间的边界(配置时区口径,`today` = todayInTz)。
 *
 * **口径裁决:一律取"自然闭区间"** —— 本周 = 本周一至本周日,本月 = 本月初一至月末,
 * 上月 = 上月月初一至上月月末,今年 = 本年 1 月 1 日至 12 月 31 日。
 * 周一是一周之首(ISO 8601 / 中国的日历习惯)。
 * 为什么不用"月初至今天":那样同一句话的答案会随查询时刻漂移,而记账金额里还可能出现
 * 预支的将来日期 —— 闭区间把它算进去更符合"这个月一共花了多少"的字面意思。
 */
function periodRange(period: SummaryPeriod, today: string): { start: string; end: string } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  switch (period) {
    case "today":
      return { start: today, end: today };
    case "this_week": {
      // 周一是一周之首(ISO 8601 / 中国的日历习惯)。weekday() 给 0=周日,所以
      // 周日要往前退 6 天(而不是 0),周一退 0 天。
      const wd = weekday(today);
      const backToMonday = wd === 0 ? 6 : wd - 1;
      const monday = shiftDays(today, -backToMonday);
      return { start: monday, end: shiftDays(monday, 6) };
    }
    case "this_month":
      return { start: `${pad4(y)}-${pad2(m)}-01`, end: `${pad4(y)}-${pad2(m)}-${pad2(daysInMonth(y, m))}` };
    case "last_month": {
      const total = y * 12 + (m - 1) - 1;
      const ny = Math.floor(total / 12);
      const nm = (total % 12) + 1;
      return { start: `${pad4(ny)}-${pad2(nm)}-01`, end: `${pad4(ny)}-${pad2(nm)}-${pad2(daysInMonth(ny, nm))}` };
    }
    case "this_year":
      return { start: `${pad4(y)}-01-01`, end: `${pad4(y)}-12-31` };
  }
}

/**
 * 解析统计区间。三条规则,都响亮失败、不猜(P2):
 * 1. `period` 与 `start`/`end` 同时给 → INVALID_PARAMS(两个口径,听谁的?);
 * 2. 只给 `start` 或只给 `end` → INVALID_PARAMS:开放式区间在汇总里语义不明
 *    ("这个月之后呢"),宁可要求用 period 或补齐两端;
 * 3. 都不给 → 本月(设计 §5 的缺省口径)。
 */
function resolveRange(
  today: string,
  input: { period?: SummaryPeriod; start?: string; end?: string },
): { ok: true; start: string; end: string; period: SummaryPeriod | null } | { ok: false; envelope: FailEnvelope } {
  const hasRange = input.start !== undefined || input.end !== undefined;
  if (input.period !== undefined) {
    if (input.period !== "today" && input.period !== "this_week" && input.period !== "this_month" && input.period !== "last_month" && input.period !== "this_year") {
      return {
        ok: false,
        envelope: failEnvelope("INVALID_PARAMS", {
          message: `period 只支持 today / this_week / this_month / last_month / this_year,收到 ${JSON.stringify(input.period)}。`,
          hint: '要说具体区间就用 start + end(YYYY-MM-DD),它与 period 二选一。',
          field: "period",
        }),
      };
    }
    if (hasRange) {
      return {
        ok: false,
        envelope: failEnvelope("INVALID_PARAMS", {
          message: "period 与 start/end 二选一,不能同时给。",
          hint:
            '要说"最近这段时间"就传 start + end(如 start="2026-10-01", end="2026-10-31");' +
            '要说"这个月"就只传 period="this_month"。日期按家庭配置时区算。',
          field: "period",
        }),
      };
    }
    const range = periodRange(input.period, today);
    return { ok: true, start: range.start, end: range.end, period: input.period };
  }
  if (input.start === undefined && input.end === undefined) {
    const range = periodRange("this_month", today);
    return { ok: true, start: range.start, end: range.end, period: "this_month" };
  }
  const badField = input.start !== undefined ? "start" : "end";
  const badValue = (input.start ?? input.end)!;
  if (!isCalendarDate(badValue)) {
    return {
      ok: false,
      envelope: failEnvelope("INVALID_PARAMS", {
        message: `${badField}「${badValue}」不是合法日期,应为真实存在的 YYYY-MM-DD。`,
        hint: "区间用 YYYY-MM-DD(含两端);相对日期(上周五)先自行换算再传。",
        field: badField,
      }),
    };
  }
  if (input.start === undefined || input.end === undefined) {
    return {
      ok: false,
      envelope: failEnvelope("INVALID_PARAMS", {
        message: `start 与 end 必须同时给(现在只给了 ${badField})。`,
        hint: '要说"这个月"传 period="this_month";要说具体区间就 start 与 end 一起传(两端都含)。',
        field: badField,
      }),
    };
  }
  if (input.end < input.start) {
    return {
      ok: false,
      envelope: failEnvelope("INVALID_PARAMS", {
        message: `end(${input.end}) 早于 start(${input.start}),这个区间里没有任何一天。`,
      hint: "两端都含,写成 start ≤ end;跨月区间直接传上月末与下月初即可。",
      field: "end",
      }),
    };
  }
  return { ok: true, start: input.start, end: input.end, period: null };
}

/**
 * 一个账本内的合计与分组明细,**全部由 SQL 算**(P4)。
 *
 * 合计单独一条 `SELECT SUM(...)`(不带 GROUP BY),分组另一条 `GROUP BY ... SUM(...)`:
 * 两条都读库,所以"总额"不需要由分组结果再拼一次 —— 也就不存在任何一处让模型心算的机会。
 * 支出/收入分列的原因:支出与收入相加没有意义(会把"花了 100、进了 5000"说成"共 5100"),
 * 所以未指定 type 时总额同时给三个数,指定 type 时只有一个非零。
 */
function summarizeBlock(
  db: Db,
  where: string,
  params: unknown[],
  groupBy: SummaryGroupBy,
): { totals: SummaryTotals; groups: SummaryGroup[] } {
  const totalsRow = db
    .prepare(`
      SELECT COALESCE(SUM(e.amount_fen), 0) AS total_fen,
             COALESCE(SUM(CASE WHEN e.type = 'expense' THEN e.amount_fen ELSE 0 END), 0) AS expense_fen,
             COALESCE(SUM(CASE WHEN e.type = 'income' THEN e.amount_fen ELSE 0 END), 0) AS income_fen,
             COUNT(*) AS count
      FROM entry e WHERE ${where}
    `)
    .get(...params) as SummaryTotals;

  const TOTAL = `COALESCE(SUM(e.amount_fen), 0) AS total_fen,
             COALESCE(SUM(CASE WHEN e.type = 'expense' THEN e.amount_fen ELSE 0 END), 0) AS expense_fen,
             COALESCE(SUM(CASE WHEN e.type = 'income' THEN e.amount_fen ELSE 0 END), 0) AS income_fen,
             COUNT(*) AS count`;
  interface GroupRow extends SummaryTotals {
    key: string;
    label: string;
  }

  let rows: GroupRow[];
  if (groupBy === "category") {
    // 未分类(category_id 为空)与"名为空的分类"是两回事:前者单列成「未分类」,
    // ORDER BY 用 sort_order 让分类沿用建类时的顺序,未分类永远排在最后。
    rows = db
      .prepare(
        `SELECT COALESCE(e.category_id, '') AS key, ${TOTAL},
                CASE WHEN e.category_id IS NULL THEN '未分类' ELSE c.name END AS label
         FROM entry e LEFT JOIN category c ON c.id = e.category_id
         WHERE ${where}
         GROUP BY COALESCE(e.category_id, '')
         ORDER BY COALESCE(c.sort_order, 2147483647) ASC, label ASC`,
      )
      .all(...params) as GroupRow[];
  } else if (groupBy === "member") {
    rows = db
      .prepare(
        `SELECT e.member_id AS key, ${TOTAL}, m.name AS label
         FROM entry e JOIN member m ON m.id = e.member_id
         WHERE ${where}
         GROUP BY e.member_id
         ORDER BY m.created_at ASC, m.rowid ASC, m.name ASC`,
      )
      .all(...params) as GroupRow[];
  } else {
    rows = db
      .prepare(
        `SELECT e.ledger AS key, ${TOTAL},
                CASE WHEN e.ledger = 'shared' THEN '共享账本' ELSE '个人账本' END AS label
         FROM entry e WHERE ${where}
         GROUP BY e.ledger ORDER BY e.ledger ASC`,
      )
      .all(...params) as GroupRow[];
  }
  return { totals: totalsRow, groups: rows };
}

const GROUP_BY_LABELS: Record<SummaryGroupBy, string> = {
  category: "按分类",
  member: "按归属人",
  ledger: "按账本",
};

/** 区间的人话:`2026-10-01 至 2026-10-31(本月)` / `今天(2026-10-05)`。 */
function rangeText(start: string, end: string, period: SummaryPeriod | null, today: string): string {
  if (period === "today") return `今天(${today})`;
  const span = start === end ? start : `${start} 至 ${end}`;
  return period === null ? span : `${span}(${PERIOD_LABELS[period]})`;
}

/** 合计的人话。指定了 type 就只给一个数,没指定则支出/收入分列。 */
function totalsText(totals: SummaryTotals, typed: EntryType | null): string {
  if (typed !== null) return `合计 ${formatYuan(totals.total_fen)},共 ${totals.count} 笔`;
  return `合计 ${formatYuan(totals.total_fen)}(支出 ${formatYuan(totals.expense_fen)} / 收入 ${formatYuan(totals.income_fen)}),共 ${totals.count} 笔`;
}

/** 分组一行:`1. 餐饮 ¥100.00(4 笔)`;支出与收入都非零时把两者都点出来。 */
function groupLine(group: SummaryGroup, index: number, typed: EntryType | null): string {
  if (typed !== null || group.expense_fen === 0 || group.income_fen === 0) {
    return `${index}. ${group.label} ${formatYuan(group.total_fen)}(${group.count} 笔)`;
  }
  return `${index}. ${group.label} ${formatYuan(group.total_fen)}(支出 ${formatYuan(group.expense_fen)} / 收入 ${formatYuan(group.income_fen)},${group.count} 笔)`;
}

/**
 * 汇总(§5 走查 2/3、P4)。
 *
 * 判定顺序:
 * 1. 解析 member_id → MISSING_PARAMS / AMBIGUOUS;
 * 2. X2:`ledger="personal"` + member_id=他人 → DENIED;
 * 3. category_id 存在性 → NOT_FOUND;
 * 4. **`group_by="member"` 而 `ledger` 缺省 → MISSING_PARAMS**(设计 §5 明确的歧义消除:
 *    默认范围跨共享与个人两个账本,"按人分组"要么混算、要么拆成两张表,语义不唯一,
 *    模型极易自由发挥 → 要求显式指定账本。只有 `group_by="ledger"` 时 ledger 才可缺省);
 * 5. 区间解析 → INVALID_PARAMS;
 * 6. 分账本跑 SQL 聚合,输出**共享 / 个人(本人)分列**,不混算。
 */
export function summarizeEntries(db: Db, viewer: Viewer, timezone: string, input: SummarizeEntriesInput): Envelope {
  if (input.ledger !== undefined && input.ledger !== "shared" && input.ledger !== "personal") {
    return failEnvelope("INVALID_PARAMS", {
      message: `ledger 只支持 "shared" 或 "personal",收到 ${JSON.stringify(input.ledger)}。`,
      hint: '不传就是共享账本 + 你自己的个人账本(回执会分成两栏)。',
      field: "ledger",
    });
  }
  if (input.group_by !== "category" && input.group_by !== "member" && input.group_by !== "ledger") {
    return failEnvelope("MISSING_PARAMS", {
      message: `group_by 必填,只支持 "category"(按分类)、"member"(按归属人)、"ledger"(按账本)。`,
      hint: '问"花在哪儿了"用 group_by="category";问"谁花的"用 group_by="member"(此时 ledger 必填)。',
      missing: ["group_by"],
    });
  }

  // 判定顺序与 list_entries 同一套:归属解析 → X2 权限闸门 → 其它校验。
  const resolvedMember = resolveReadMember(db, input.member_id);
  if (!resolvedMember.ok) return resolvedMember.envelope;
  const denied = denyOthersPersonalLedger(input.ledger, resolvedMember.member, viewer);
  if (denied) return denied;

  if (input.group_by === "member" && input.ledger === undefined) {
    return failEnvelope("MISSING_PARAMS", {
      message: "group_by=\"member\" 时必须显式指定 ledger:默认范围跨共享与个人两个账本,按人分组会混算。",
      hint:
        '缺省 ledger 时"按人分组"要么把公共支出和私账混进一个人名(混算),要么得拆成两张表 —— 语义不唯一,所以这里不猜。' +
        '要"我们家这个月按人分"用 ledger="shared", group_by="member";' +
        '要"我自己私账按人分"用 ledger="personal", group_by="member"。',
      missing: ["ledger"],
    });
  }

  const today = todayInTz(timezone);
  const range = resolveRange(today, input);
  if (!range.ok) return range.envelope;

  const built = buildReadFilters(db, resolvedMember.member, input);
  if (!built.ok) return built.envelope;
  const typeFilter = input.type ?? null;

  // 默认范围 = 两个账本分列;显式指定 ledger = 只出那一块。
  const blocks: LedgerKind[] = input.ledger === undefined ? ["shared", "personal"] : [input.ledger];

  const result: SummaryBlock[] = [];
  for (const ledger of blocks) {
    const visibility = visibilityClause(ledger, viewer);
    const where = ["e.deleted_at IS NULL", visibility.where, built.filters.where]
      .filter((s) => s !== "")
      .join(" AND ");
    const params = [...visibility.params, ...built.filters.params, range.start, range.end];
    const whereWithRange = `${where} AND e.occurred_date >= ? AND e.occurred_date <= ?`;
    const agg = summarizeBlock(db, whereWithRange, params, input.group_by);
    result.push({ ledger, ...agg.totals, groups: agg.groups });
  }

  const data: SummaryResult = {
    start: range.start,
    end: range.end,
    period: range.period,
    type: typeFilter,
    group_by: input.group_by,
    ledgers: result,
  };

  const head = `${rangeText(range.start, range.end, range.period, today)} · ${GROUP_BY_LABELS[input.group_by]}`;
  const hasAny = result.some((b) => b.count > 0);
  if (!hasAny) {
    return okEnvelope(data, `${head}:这个区间内没有符合条件的记账记录。`);
  }
  const parts = result.map((block) => {
    const label = block.ledger === "shared" ? "共享账本" : "你的个人账本";
    const totals = totalsText(block, typeFilter);
    if (block.count === 0) return `${label} ${totals}`;
    return `${label} ${totals} —— ${groupByLine(block, typeFilter)}`;
  });
  return okEnvelope(data, `${head}:${parts.join(";")}。`);
}

/** 一个账本内的分组明细话术(逐笔带序号,与其他 list 回执同风格)。 */
function groupByLine(block: SummaryBlock, typed: EntryType | null): string {
  return block.groups.map((g, i) => groupLine(g, i + 1, typed)).join(";");
}