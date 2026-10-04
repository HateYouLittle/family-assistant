import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { listAudit } from "../src/audit/audit.js";
import type { Envelope, FailEnvelope, OkEnvelope } from "../src/domain/envelope.js";
import {
  addCategory,
  addEntry,
  deleteEntry,
  listCategories,
  listEntries,
  restoreEntry,
  summarizeEntries,
  updateEntry,
  type EntryView,
  type SummarizeEntriesInput,
  type SummaryResult,
} from "../src/domain/ledger.js";
import { restoreDeleted } from "../src/domain/restore.js";
import { TOOL_DEFINITIONS } from "../src/mcp/tools.js";
import { newFixture, TZ, type Fixture, type FixtureKey } from "./helpers.js";

/**
 * 记账域(S3)。对照:设计方案 §4 entry+category、§5 记账工具与 §5.1 契约冻结、
 * 记账真值表 + V1/V3/V4/V5/V6/V7,反例 X2/X5/X6/X7/X12/X13,以及 §8.1 走查 1–3、6、7。
 *
 * 三条纪律(沿用 S1/S2):
 * 1. 每条用例都直查**原始行**(rawEntry),不只看信封 —— "被拒的调用不得留下任何写入"
 *    与"幂等不得改写字段"都只能靠读库证明。
 * 2. 金额断言一律**逐分相等**(整数分比较),期望值在本文件里用独立的整数加法写出来,
 *    **不复用实现里的 formatYuan / 任何 domain 函数**(否则测试与实现会一起错)。
 * 3. 期望值里的日期**动态构造**(按 TZ 算今天),不写死具体日期,免得哪天成为定时炸弹。
 *
 * 可见性相关的用例一律从**拒绝信封的形状**下手:信封里不得出现他人流水的金额/备注(V5)。
 */

let f: Fixture;
afterEach(() => f?.db.close());

/** 断言成功信封(可带一句说明,便于定位是哪一步该成功却失败了)。 */
function ok(env: { ok: boolean; message?: string }, why?: string): asserts env is OkEnvelope {
  assert.equal(env.ok, true, `${why ? `${why}:` : "期望成功信封"}实际:${JSON.stringify(env)}`);
}
function fail(env: { ok: boolean; message?: string }): asserts env is FailEnvelope {
  assert.equal(env.ok, false, `期望失败信封,实际:${JSON.stringify(env)}`);
}

interface RawEntryRow {
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
}

function rawEntry(id: string): RawEntryRow {
  const row = f.db.prepare("SELECT * FROM entry WHERE id = ?").get(id) as RawEntryRow | undefined;
  assert.ok(row, `库里没有这条记账记录:${id}`);
  return row!;
}

function entryCount(): number {
  return (f.db.prepare("SELECT COUNT(*) AS n FROM entry").get() as { n: number }).n;
}

/** 建一笔流水并返回完整视图(写路径用例都要先有 id)。 */
function newEntry(key: FixtureKey, input: Parameters<typeof addEntry>[3]): EntryView {
  const env = addEntry(f.db, f.callers[key], TZ, input);
  ok(env);
  return env.data as EntryView;
}

/** 走工具层(参数校验 + 审计留痕),参数不合规时直接返回 parse 的失败信封。 */
function callTool(key: FixtureKey, name: string, args: unknown): Envelope {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
  assert.ok(tool, `未知工具 ${name}`);
  const parsed = tool!.parse(args);
  return parsed.ok ? tool!.run(f.db, f.callers[key], TZ, parsed.args) : parsed.envelope;
}

// ─────────────────────────── 测试里的日期与金额(不复用实现) ───────────────────────────

/** 按 TZ 取今天(与程序的时区纪律一致:不读系统本地时区)。 */
function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const p2 = (v: number) => String(v).padStart(2, "0");
  return `${String(dt.getUTCFullYear()).padStart(4, "0")}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}
function monthEnd(day: string): string {
  const [y, m] = day.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${day.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}
function daysAgo(n: number): string {
  return shiftDay(today(), -n);
}

/**
 * 期望金额的字面文本(测试自己写死的换算,故意不复用 formatYuan)。
 * 带千分位:¥10,000.00 —— 与实现无关的独立换算,两边不一致时就是 bug。
 */
function yuan(fen: number): string {
  const whole = String(Math.floor(fen / 100));
  const withSep = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = String(fen % 100).padStart(2, "0");
  return `¥${withSep}.${cents}`;
}

interface SummaryBlockLite {
  ledger: string;
  total_fen: number;
  expense_fen: number;
  income_fen: number;
  count: number;
  groups: { key: string; label: string; total_fen: number; expense_fen: number; income_fen: number; count: number }[];
}

/**
 * 调 summarize_entries。返回 env(信封)与 data(成功时的结构)。
 * args 走 domain 层(参数形状校验在工具层那部分由 callTool 与 golden/schema 测试覆盖),
 * 这里刻意**直调 domain**,以便断言 data 里的整数分而不受 tool 层信封包装影响。
 */
function summarize(
  key: FixtureKey,
  args: Record<string, unknown>,
): { env: Envelope; data: SummaryResult } {
  const env = summarizeEntries(
    f.db,
    f.callers[key],
    TZ,
    args as unknown as SummarizeEntriesInput,
  );
  return { env, data: (env.ok ? env.data : null) as SummaryResult };
}

function blockOf(data: SummaryResult, ledger: string): SummaryBlockLite {
  const b = data.ledgers.find((x) => x.ledger === ledger);
  assert.ok(b, `汇总结果里没有 ${ledger} 这一栏`);
  return b as SummaryBlockLite;
}

function groupOf(block: SummaryBlockLite, label: string): SummaryBlockLite["groups"][number] {
  const g = block.groups.find((x) => x.label === label);
  assert.ok(g, `分组里没有「${label}」,实际:${JSON.stringify(block.groups)}`);
  return g;
}

// ─────────────────────────── §8.1 走查 1:「午饭花了 35」 ───────────────────────────

describe("§8.1 走查 1:妈妈 add_entry → 回执含账本/金额/归属/未分类", () => {
  it("共享账本缺省:回执含「共享账本」「¥35.00」「归属:妈妈」「未分类」", () => {
    f = newFixture();
    const env = callTool("mama", "add_entry", {
      member_id: "妈妈",
      type: "expense",
      amount_fen: 3500,
    });
    ok(env);
    const m = env.message;
    assert.match(m, /共享账本/, "回执必须说清落在共享账本");
    assert.match(m, /¥35\.00/, "话术里金额显示为元(入参是整数分)");
    assert.match(m, /归属:妈妈/, "共享账本也要说清这笔算谁的");
    assert.match(m, /未分类/, "不给分类要说清是未分类,而不是留空");
    // 落库的必须是整数分 + 共享账本 + 归属人 + 今天
    const row = rawEntry((env.data as EntryView).id);
    assert.equal(row.amount_fen, 3500);
    assert.equal(row.ledger, "shared");
    assert.equal(row.member_id, f.members.mama.id);
    assert.equal(row.occurred_date, today());
    assert.equal(row.created_by, f.members.mama.id, "created_by 是连接身份,不是参数");
    assert.equal(row.deleted_at, null);
  });

  it("说「记我私账」→ ledger=\"personal\",回执标注「你的个人账本」且仅本人可见", () => {
    f = newFixture();
    const env = callTool("mama", "add_entry", {
      member_id: "妈妈",
      ledger: "personal",
      type: "expense",
      amount_fen: 3500,
    });
    ok(env);
    assert.match(env.message, /你的个人账本/);
    assert.doesNotMatch(env.message, /共享账本/, "私账的回执不能说共享账本");
    assert.match(env.message, /仅你自己可见/);
    assert.equal(rawEntry((env.data as EntryView).id).ledger, "personal");

    // 爸爸看不到这笔(列表里没有,汇总里也没有)
    const babaList = listEntries(f.db, f.callers.baba, TZ, {});
    ok(babaList);
    const ids = (babaList.data as { entries: EntryView[] }).entries.map((e) => e.id);
    assert.equal(ids.includes((env.data as EntryView).id), false, "他人的个人账本不得出现在别人的列表里");
  });

  it("occurred_date 缺省 = 今天(配置时区);显式给出则照写", () => {
    f = newFixture();
    const def = newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 100 });
    assert.equal(rawEntry(def.id).occurred_date, today());
    const explicit = newEntry("mama", {
      member_id: "妈妈",
      type: "expense",
      amount_fen: 100,
      occurred_date: daysAgo(3),
    });
    assert.equal(rawEntry(explicit.id).occurred_date, daysAgo(3));
  });

  it("member_id 缺失 → MISSING_PARAMS;解析不到 → MISSING_PARAMS + 名单;重名 → AMBIGUOUS + 候选", () => {
    f = newFixture();
    const missing = callTool("mama", "add_entry", { type: "expense", amount_fen: 3500 });
    fail(missing);
    assert.equal(missing.code, "MISSING_PARAMS");
    assert.deepEqual(missing.missing, ["member_id"]);

    const unknown = callTool("mama", "add_entry", { member_id: "查无此人", type: "expense", amount_fen: 3500 });
    fail(unknown);
    assert.equal(unknown.code, "MISSING_PARAMS");
    assert.deepEqual(unknown.missing, ["member_id"], "missing 必须指向记账域的字段名");
    assert.match(unknown.message, /家庭成员有:妈妈、爸爸、小明/);
    assert.equal(entryCount(), 0, "被拒的调用不得留下任何写入");

    // 造一个重名别名:爸爸登记别名「儿子」(小明已有此别名)
    f.db.prepare("UPDATE member SET aliases = ? WHERE id = ?").run(JSON.stringify(["老子"]), f.members.baba.id);
    const ambiguous = callTool("mama", "add_entry", {
      member_id: "老妈",
      type: "expense",
      amount_fen: 3500,
    });
    // 「老妈」只匹配妈妈,不是歧义;真正的歧义用共享别名来造
    ok(ambiguous);
    f.db.prepare("UPDATE member SET aliases = ? WHERE id = ?").run(JSON.stringify(["老妈", "当家的"]), f.members.baba.id);
    const amb = callTool("mama", "add_entry", { member_id: "老妈", type: "expense", amount_fen: 100 });
    fail(amb);
    assert.equal(amb.code, "AMBIGUOUS");
    assert.equal(amb.candidates?.length, 2, "候选要列出两位");
    assert.deepEqual(
      amb.candidates!.map((c) => c.name).sort(),
      ["妈妈", "爸爸"],
    );
  });
});

// ─────────────────────────── 金额(P1:整数分;§4 v0.5.2 大额提示) ───────────────────────────

describe("金额:整数分、大额只提示不硬拒", () => {
  it("amount_fen = 0 / 负数 / 小数 → INVALID_PARAMS,库中无写入", () => {
    f = newFixture();
    for (const bad of [0, -1, -3500, 35.5, 0.1]) {
      const env = callTool("mama", "add_entry", { member_id: "妈妈", type: "expense", amount_fen: bad });
      fail(env);
      assert.equal(env.code, "INVALID_PARAMS", `应拒绝:${bad}`);
      assert.equal(env.field, "amount_fen");
      assert.equal(entryCount(), 0, `被拒的调用不得留下写入:${bad}`);
    }
  });

  it("amount_fen = \"35\"(字符串)→ INVALID_PARAMS,并说清要传整数分", () => {
    f = newFixture();
    const env = callTool("mama", "add_entry", { member_id: "妈妈", type: "expense", amount_fen: "35" });
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "amount_fen");
    assert.match(env.message, /整数/, "话术要指明单位是整数分");
    assert.match(env.message, /3500/, "最好直接给出 35 元 = 3500 分的换算例子");
    assert.equal(entryCount(), 0);
  });

  it("大额 1200000 分(¥12,000.00)→ **成功**,且回执多一句确认提示", () => {
    f = newFixture();
    const env = callTool("mama", "add_entry", { member_id: "妈妈", type: "expense", amount_fen: 1200000 });
    ok(env);
    assert.match(env.message, /¥12,000\.00/);
    assert.match(env.message, /金额较大/, "达到阈值必须追加确认提示");
    assert.match(env.message, /确认无误/);
    // 阈值本身(¥10,000.00)也算"较大"
    const at = callTool("mama", "add_entry", { member_id: "妈妈", type: "expense", amount_fen: 1000000 });
    ok(at);
    assert.match(at.message, /金额较大/);
    // 阈值下一分不算
    const below = callTool("mama", "add_entry", { member_id: "妈妈", type: "expense", amount_fen: 999999 });
    ok(below);
    assert.doesNotMatch(below.message, /金额较大/, "未达阈值不追加提示");
  });

  it("update_entry 改金额同样校验整数分(0 / 负数 / 小数被拒,且不改库)", () => {
    f = newFixture();
    const e = newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 3500 });
    for (const bad of [0, -100, 10.5]) {
      const env = updateEntry(f.db, f.callers.mama, TZ, { id: e.id, amount_fen: bad });
      fail(env);
      assert.equal(env.code, "INVALID_PARAMS");
      assert.equal(rawEntry(e.id).amount_fen, 3500, "被拒的修改不得落库");
    }
  });
});

// ─────────────────────────── 分类 ───────────────────────────

describe("分类:kind 一致性 / 存在性 / 可缺省 / 重名", () => {
  it("category.kind 与 type 不符 → INVALID_PARAMS 并指明字段", () => {
    f = newFixture();
    const env = callTool("mama", "add_entry", {
      member_id: "妈妈",
      type: "income",
      amount_fen: 500000,
      category_id: "cat-expense-food", // 支出分类
    });
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "category_id");
    assert.match(env.message, /支出分类/, "话术要说清这个分类是支出分类");
    assert.match(env.message, /不一致/);
    assert.equal(entryCount(), 0);

    // 反方向同样被拒
    const other = callTool("mama", "add_entry", {
      member_id: "妈妈",
      type: "expense",
      amount_fen: 100,
      category_id: "cat-income-salary",
    });
    fail(other);
    assert.equal(other.code, "INVALID_PARAMS");
    assert.match(other.message, /收入分类/);
  });

  it("category_id 不存在 → NOT_FOUND", () => {
    f = newFixture();
    const env = callTool("mama", "add_entry", {
      member_id: "妈妈",
      type: "expense",
      amount_fen: 100,
      category_id: "cat-nonexistent",
    });
    fail(env);
    assert.equal(env.code, "NOT_FOUND");
    assert.equal(env.id, "cat-nonexistent");
    assert.equal(entryCount(), 0);
  });

  it("不给分类 → 成功,且汇总里单列「未分类」", () => {
    f = newFixture();
    const withCat = newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 3000, category_id: "cat-expense-food" });
    const noCat = newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 500 });
    assert.equal(rawEntry(noCat.id).category_id, null);

    const { env, data } = summarize("mama", { period: "this_month", group_by: "category", ledger: "shared" });
    ok(env);
    const block = blockOf(data, "shared");
    assert.equal(groupOf(block, "餐饮").total_fen, 3000);
    assert.equal(groupOf(block, "未分类").total_fen, 500);
    // 未分类单列,且不与任何分类混算
    assert.equal(block.total_fen, 3500);
    assert.ok(withCat.id !== noCat.id);
  });

  it("add_category 重名(同类)→ INVALID_PARAMS 并给出已有分类的 id;不同类同名放行", () => {
    f = newFixture();
    const made = addCategory(f.db, f.callers.mama, TZ, { name: "宠物", kind: "expense" });
    ok(made);
    const view = made.data as { id: string; sort_order: number };
    assert.match(made.message, /已支出分类/);
    // 同类重名
    const dup = addCategory(f.db, f.callers.mama, TZ, { name: "宠物", kind: "expense" });
    fail(dup);
    assert.equal(dup.code, "INVALID_PARAMS");
    assert.match(dup.message, /已经有「宠物」了/);
    assert.match(dup.hint ?? "", new RegExp(view.id), "要告诉模型已有分类的 id,让它直接用");
    // 不同类同名:支出有「其他」、收入也有「其他」,这是设计允许的
    const incomeOther = addCategory(f.db, f.callers.mama, TZ, { name: "其他", kind: "income" });
    fail(incomeOther);
    assert.equal(incomeOther.code, "INVALID_PARAMS", "预置的收入「其他」已存在");
    const incomePet = addCategory(f.db, f.callers.mama, TZ, { name: "宠物", kind: "income" });
    ok(incomePet, "同名但不同类 → 不是重名");
  });

  it("add_category 的 sort_order = 同类最大值 + 步长 10", () => {
    f = newFixture();
    const expenseMax = (
      f.db.prepare("SELECT MAX(sort_order) AS m FROM category WHERE kind = 'expense'").get() as { m: number }
    ).m;
    const made = addCategory(f.db, f.callers.mama, TZ, { name: "宠物", kind: "expense" });
    ok(made);
    assert.equal((made.data as { sort_order: number }).sort_order, expenseMax + 10);
    const second = addCategory(f.db, f.callers.mama, TZ, { name: "医疗补充", kind: "expense" });
    ok(second);
    assert.equal((second.data as { sort_order: number }).sort_order, expenseMax + 20, "步长固定 10,连续新建不会撞值");
  });

  it("list_categories:缺省列全部并按支出/收入分组;kind 过滤只出一类", () => {
    f = newFixture();
    const all = listCategories(f.db, f.callers.mama, TZ, {});
    ok(all);
    const cats = (all.data as { categories: { kind: string }[] }).categories;
    assert.equal(cats.length, 13, "预置支出 9 + 收入 4");
    assert.match(all.message, /支出分类 9 个/);
    assert.match(all.message, /收入分类 4 个/);
    const only = listCategories(f.db, f.callers.mama, TZ, { kind: "income" });
    ok(only);
    assert.equal((only.data as { categories: unknown[] }).categories.length, 4);
    assert.doesNotMatch(only.message, /支出分类/, "只要了一类就不该出现另一组");
  });

  it("新分类可立即用于 add_entry(新建 → 挂上 → 汇总按新分类分列)", () => {
    f = newFixture();
    const made = addCategory(f.db, f.callers.mama, TZ, { name: "宠物", kind: "expense" });
    ok(made);
    const id = (made.data as { id: string }).id;
    newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 25000, category_id: id });
    const { data } = summarize("mama", { period: "this_month", group_by: "category", ledger: "shared" });
    assert.equal(groupOf(blockOf(data, "shared"), "宠物").total_fen, 25000);
  });
});

// ─────────────────────────── 可见性与反例 X2 / X5 / X6 / X7 ───────────────────────────

describe("可见性:反例 X2 / X5 / X6 / X7 各一条独立用例", () => {
  it("X2:爸爸 list_entries(ledger=\"personal\", member_id=妈妈)→ DENIED,不是空表", () => {
    f = newFixture();
    const secret = newEntry("mama", {
      member_id: "妈妈",
      ledger: "personal",
      type: "expense",
      amount_fen: 888888,
      note: "给妈妈自己看的私房钱",
    });
    const env = listEntries(f.db, f.callers.baba, TZ, { ledger: "personal", member_id: "妈妈" });
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assert.match(env.message, /个人账本仅归属人本人可见/);
    // 信封里绝不能出现他人流水的金额或备注(V5)
    const dumped = JSON.stringify(env);
    assert.doesNotMatch(dumped, /888888/, "拒绝信封不得泄露他人金额");
    assert.doesNotMatch(dumped, /私房钱/, "拒绝信封不得泄露他人备注");
    assert.doesNotMatch(dumped, new RegExp(secret.id), "拒绝信封不得泄露他人记录 id");
  });

  it("X5:爸爸 delete_entry(妈妈的个人账本 id)→ DENIED(not_visible),且那笔还在", () => {
    f = newFixture();
    const secret = newEntry("mama", { member_id: "妈妈", ledger: "personal", type: "expense", amount_fen: 666666 });
    const env = deleteEntry(f.db, f.callers.baba, TZ, secret.id);
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assert.equal(rawEntry(secret.id).deleted_at, null, "被拒的删除不得生效");
    assert.doesNotMatch(JSON.stringify(env), /666666/);
  });

  it("X6:爸爸 add_entry(ledger=\"personal\", member_id=妈妈)→ DENIED(V4 个人账本只能本人写)", () => {
    f = newFixture();
    const env = addEntry(f.db, f.callers.baba, TZ, {
      member_id: "妈妈",
      ledger: "personal",
      type: "expense",
      amount_fen: 3500,
    });
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.match(env.message, /个人账本只能本人记/);
    assert.match(env.hint ?? "", /shared/, "要给出路:共享的花销记到共享账本");
    assert.equal(entryCount(), 0, "被拒的写入不得落库");

    // 同样的组合换成妈妈自己 → 放行(V4 的另一半)
    const self = addEntry(f.db, f.callers.mama, TZ, {
      member_id: "妈妈",
      ledger: "personal",
      type: "expense",
      amount_fen: 3500,
    });
    ok(self, "本人记自己的私账必须放行");
  });

  it("X7:妈妈 list_entries(ledger=\"personal\", member_id=自己)→ **必须放行**(假阴性同样致命)", () => {
    f = newFixture();
    const mine = newEntry("mama", {
      member_id: "妈妈",
      ledger: "personal",
      type: "expense",
      amount_fen: 123400,
      note: "自己的私账",
    });
    const byName = listEntries(f.db, f.callers.mama, TZ, { ledger: "personal", member_id: "妈妈" });
    ok(byName, "本人按成员名查自己的私账必须放行");
    const byId = listEntries(f.db, f.callers.mama, TZ, { ledger: "personal", member_id: f.members.mama.id });
    ok(byId, "本人按成员 id 查自己的私账必须放行");
    assert.equal(byName.message, byId.message, "成员名与 id 命中同一人,结果必须一致");
    const ids = (byName.data as { entries: EntryView[] }).entries.map((e) => e.id);
    assert.deepEqual(ids, [mine.id]);
    // 不传 member_id 的 ledger="personal" = 隐含本人私账,同样放行
    const implicit = listEntries(f.db, f.callers.mama, TZ, { ledger: "personal" });
    ok(implicit);
    assert.deepEqual(
      (implicit.data as { entries: EntryView[] }).entries.map((e) => e.id),
      [mine.id],
    );
  });

  it("第三人看不到他人的个人账本:列表不含、汇总不含、拒绝信封里不含金额", () => {
    f = newFixture();
    const a = newEntry("mama", { member_id: "妈妈", ledger: "personal", type: "expense", amount_fen: 111111 });
    newEntry("mama", { member_id: "妈妈", ledger: "shared", type: "expense", amount_fen: 2222 });

    // 列表:小明的默认范围里只有共享那笔
    const kidList = listEntries(f.db, f.callers.kid, TZ, {});
    ok(kidList);
    const kidIds = (kidList.data as { entries: EntryView[] }).entries.map((e) => e.id);
    assert.equal(kidIds.includes(a.id), false, "小明不得看到妈妈的私账");
    assert.equal(kidIds.length, 1, "小明只该看到共享账本那笔");

    // 汇总:默认范围两栏,个人栏只算本人的(小明自己没有 → 0 笔),不含妈妈的私账
    const { env, data } = summarize("kid", { period: "this_month", group_by: "ledger" });
    ok(env);
    assert.equal(blockOf(data, "shared").total_fen, 2222);
    assert.equal(blockOf(data, "personal").total_fen, 0);
    assert.doesNotMatch(JSON.stringify(data), /111111/, "汇总不得包含不可见的金额");

    // 汇总显式要他人私账 → DENIED,信封不含金额
    const denied = summarize("kid", { period: "this_month", group_by: "category", ledger: "personal", member_id: "妈妈" });
    fail(denied.env);
    assert.equal(denied.env.code, "DENIED");
    assert.equal(denied.env.reason, "not_visible");
    assert.doesNotMatch(JSON.stringify(denied.env), /111111/);
  });

  it("共享账本全员可见:爸爸能给妈妈代记一笔共享支出(回执标注代记者)", () => {
    f = newFixture();
    const env = addEntry(f.db, f.callers.baba, TZ, {
      member_id: "妈妈",
      type: "expense",
      amount_fen: 5000,
      note: "爸爸付的",
    });
    ok(env);
    assert.match(env.message, /由 爸爸 代记/);
    assert.match(env.message, /归属:妈妈/);
    assert.equal(rawEntry((env.data as EntryView).id).created_by, f.members.baba.id);
    // 小明也能在共享账本里看到它
    const kidList = listEntries(f.db, f.callers.kid, TZ, { ledger: "shared" });
    ok(kidList);
    assert.equal((kidList.data as { entries: EntryView[] }).entries.length, 1);
  });
});

// ─────────────────────────── V7:ledger 与 member_id 不可变 ───────────────────────────

describe("V7:ledger / member_id 不可变(X12 / X13)", () => {
  it("X12:把个人流水改成共享 → DENIED(immutable) + 「删除后重建」", () => {
    f = newFixture();
    const priv = newEntry("mama", { member_id: "妈妈", ledger: "personal", type: "expense", amount_fen: 3500 });
    const env = updateEntry(f.db, f.callers.mama, TZ, { id: priv.id, ledger: "shared" });
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "immutable");
    assert.match(env.message, /归属\/账本不可修改,如需变更请删除后重建/);
    assert.equal(rawEntry(priv.id).ledger, "personal", "不可变字段不得被改写");
  });

  it("X13:把公共支出挪进个人账本 → DENIED(immutable),无论只改 ledger 还是同时改 member_id", () => {
    f = newFixture();
    const shared = newEntry("baba", { member_id: "妈妈", type: "expense", amount_fen: 8000 });
    const onlyLedger = updateEntry(f.db, f.callers.baba, TZ, { id: shared.id, ledger: "personal" });
    fail(onlyLedger);
    assert.equal(onlyLedger.code, "DENIED");
    assert.equal(onlyLedger.reason, "immutable");

    const both = updateEntry(f.db, f.callers.baba, TZ, {
      id: shared.id,
      ledger: "personal",
      member_id: "爸爸",
    });
    fail(both);
    assert.equal(both.code, "DENIED");
    assert.equal(both.reason, "immutable");
    assert.match(both.message, /删除后重建/);

    const row = rawEntry(shared.id);
    assert.equal(row.ledger, "shared");
    assert.equal(row.member_id, f.members.mama.id, "归属也不可改");
  });

  it("改 member_id 为他人 → DENIED(immutable)", () => {
    f = newFixture();
    const shared = newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 1000 });
    const env = updateEntry(f.db, f.callers.baba, TZ, { id: shared.id, member_id: "爸爸" });
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "immutable");
    assert.match(env.message, /记在 妈妈 名下/);
    assert.equal(rawEntry(shared.id).member_id, f.members.mama.id);
  });

  it("同值幂等放行:ledger 同值、member_id 用成员名/别名/成员 id 都算同值", () => {
    f = newFixture();
    const shared = newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 1000 });
    // ledger 同值 + member_id 用别名「王丽」
    const alias = updateEntry(f.db, f.callers.baba, TZ, {
      id: shared.id,
      ledger: "shared",
      member_id: "王丽",
      amount_fen: 1100,
    });
    ok(alias, "别名命中同一成员 = 同值,应幂等放行");
    assert.match(alias.message, /金额改为 ¥11\.00/);
    // 只回传不可变字段、没有任何其它变化 → 未做修改
    const noop = updateEntry(f.db, f.callers.baba, TZ, { id: shared.id, ledger: "shared", member_id: "妈妈" });
    ok(noop);
    assert.match(noop.message, /未做修改/);
    assert.equal(rawEntry(shared.id).amount_fen, 1100, "幂等不得改写其它字段");

    // 个人账本 + 成员 id 同值也放行
    const priv = newEntry("mama", { member_id: "妈妈", ledger: "personal", type: "expense", amount_fen: 1000 });
    const privOk = updateEntry(f.db, f.callers.mama, TZ, {
      id: priv.id,
      ledger: "personal",
      member_id: f.members.mama.id,
    });
    ok(privOk);
  });

  it("置空语义:note=null 清空、缺省不改;category_id=null 置为未分类", () => {
    f = newFixture();
    const e = newEntry("mama", {
      member_id: "妈妈",
      type: "expense",
      amount_fen: 3500,
      category_id: "cat-expense-food",
      note: "公司楼下那家",
    });
    // 只改金额:note 与 category 都不得被动到
    const amountOnly = updateEntry(f.db, f.callers.mama, TZ, { id: e.id, amount_fen: 3800 });
    ok(amountOnly);
    let row = rawEntry(e.id);
    assert.equal(row.note, "公司楼下那家", "缺省字段不得被改动");
    assert.equal(row.category_id, "cat-expense-food");

    // note=null → 清空
    ok(updateEntry(f.db, f.callers.mama, TZ, { id: e.id, note: null }));
    row = rawEntry(e.id);
    assert.equal(row.note, null);

    // category_id=null → 未分类
    ok(updateEntry(f.db, f.callers.mama, TZ, { id: e.id, category_id: null }));
    row = rawEntry(e.id);
    assert.equal(row.category_id, null);
    const view = (updateEntry(f.db, f.callers.mama, TZ, { id: e.id }) as OkEnvelope).data as EntryView;
    assert.equal(view.category_name, null);
  });

  it("改 type 而原分类 kind 不一致 → INVALID_PARAMS,并给出「同时传 category_id=null」的出路", () => {
    f = newFixture();
    const e = newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 1000, category_id: "cat-expense-food" });
    const bad = updateEntry(f.db, f.callers.mama, TZ, { id: e.id, type: "income" });
    fail(bad);
    assert.equal(bad.code, "INVALID_PARAMS");
    assert.match(bad.hint ?? "", /category_id=null/);
    assert.equal(rawEntry(e.id).type, "expense", "被拒的修改不得落库");
    // 同时置空分类 → 放行
    ok(updateEntry(f.db, f.callers.mama, TZ, { id: e.id, type: "income", category_id: null }));
    assert.equal(rawEntry(e.id).type, "income");
    assert.equal(rawEntry(e.id).category_id, null);
  });

  it("id 不存在 → NOT_FOUND;已软删的 id → NOT_FOUND + 恢复出路", () => {
    f = newFixture();
    const missing = updateEntry(f.db, f.callers.mama, TZ, { id: "en-000000-zzzz", amount_fen: 100 });
    fail(missing);
    assert.equal(missing.code, "NOT_FOUND");
    assert.match(missing.hint ?? "", /list_entries/);

    const e = newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 100 });
    ok(deleteEntry(f.db, f.callers.mama, TZ, e.id));
    const afterDelete = updateEntry(f.db, f.callers.mama, TZ, { id: e.id, amount_fen: 200 });
    fail(afterDelete);
    assert.equal(afterDelete.code, "NOT_FOUND");
    assert.match(afterDelete.message, /已被删除/);
    assert.match(afterDelete.hint ?? "", /restore_deleted\(kind="entry"/);
  });

  it("V3:共享账本任何成员可改(回执标注操作者);个人账本他人改 → DENIED", () => {
    f = newFixture();
    const shared = newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 5000 });
    const byBaba = updateEntry(f.db, f.callers.baba, TZ, { id: shared.id, amount_fen: 4500 });
    ok(byBaba, "共享账本家庭内互信(V3)");
    assert.match(byBaba.message, /已由 爸爸 更新共享账本流水/);

    const priv = newEntry("mama", { member_id: "妈妈", ledger: "personal", type: "expense", amount_fen: 5000 });
    const denied = updateEntry(f.db, f.callers.baba, TZ, { id: priv.id, amount_fen: 4500 });
    fail(denied);
    assert.equal(denied.code, "DENIED");
    assert.equal(denied.reason, "not_visible");
    assert.equal(rawEntry(priv.id).amount_fen, 5000);
    assert.doesNotMatch(JSON.stringify(denied), /5000/, "拒绝信封不得泄露他人金额");
  });
});

// ─────────────────────────── 汇总算得对(P4:合计由 SQL 算) ───────────────────────────

describe("汇总:总额与分组逐分相等(P4)", () => {
  /** 造一批已知流水,期望值在这里用独立的整数加法写死。 */
  function seed(): void {
    // 共享账本(全员可见)
    newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 3500, category_id: "cat-expense-food" });
    newEntry("baba", { member_id: "爸爸", type: "expense", amount_fen: 2500, category_id: "cat-expense-transit" });
    newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 1000 }); // 未分类
    newEntry("baba", { member_id: "爸爸", type: "income", amount_fen: 900000, category_id: "cat-income-salary" });
    // 妈妈的个人账本(爸爸看不见)
    newEntry("mama", { member_id: "妈妈", ledger: "personal", type: "expense", amount_fen: 777 });
    newEntry("baba", { member_id: "爸爸", ledger: "personal", type: "expense", amount_fen: 888 });
  }

  it("group_by=category:共享栏总额 907000 分,各分类逐分相等;个人栏只算本人", () => {
    f = newFixture();
    seed();
    const { env, data } = summarize("mama", { period: "this_month", group_by: "category" });
    ok(env);

    // 期望值(测试自己算的整数加法):共享支出 3500+2500+1000=7000,收入 900000 → 合计 907000
    const shared = blockOf(data, "shared");
    assert.equal(shared.expense_fen, 3500 + 2500 + 1000);
    assert.equal(shared.income_fen, 900000);
    assert.equal(shared.total_fen, 907000);
    assert.equal(shared.count, 4);

    // 默认范围必须**分列**,不混算:个人栏只有妈妈自己的 777,不含爸爸的 888
    const personal = blockOf(data, "personal");
    assert.equal(personal.total_fen, 777, "个人栏只含本人的私账");
    assert.equal(personal.count, 1);
    // 分列不等于相加:两栏之和才是全部可见总额
    assert.equal(shared.total_fen + personal.total_fen, 907000 + 777);
    // 回执里两栏都在,且写着「不混算」的口径
    assert.match(env.message, /共享账本/);
    assert.match(env.message, /你的个人账本/);
  });

  it("group_by=category:每个分组金额与总额之和逐分相等(SQL 内部自洽)", () => {
    f = newFixture();
    seed();
    const { data } = summarize("mama", { period: "this_month", group_by: "category", ledger: "shared" });
    const block = blockOf(data, "shared");
    const sumOfGroups = block.groups.reduce((acc, g) => acc + g.total_fen, 0);
    assert.equal(sumOfGroups, block.total_fen, "各分组之和必须等于总额");
    const sumOfCounts = block.groups.reduce((acc, g) => acc + g.count, 0);
    assert.equal(sumOfCounts, block.count);
    assert.equal(groupOf(block, "餐饮").total_fen, 3500);
    assert.equal(groupOf(block, "交通").total_fen, 2500);
    assert.equal(groupOf(block, "工资").total_fen, 900000);
    assert.equal(groupOf(block, "未分类").total_fen, 1000);
    // 未分类单列成一组,不与任何分类混算
    const uncategorized = groupOf(block, "未分类");
    assert.equal(uncategorized.total_fen + groupOf(block, "餐饮").total_fen, 3500 + 1000);
  });

  it("group_by=member:共享账本按归属人分列(§8.1 走查 3),金额逐分相等", () => {
    f = newFixture();
    seed();
    const { env, data } = summarize("mama", {
      period: "this_month",
      ledger: "shared",
      group_by: "member",
    });
    ok(env);
    const block = blockOf(data, "shared");
    // 妈妈的共享支出 3500+1000=4500;爸爸 2500 支出 + 900000 收入
    assert.equal(groupOf(block, "妈妈").expense_fen, 4500);
    assert.equal(groupOf(block, "爸爸").expense_fen, 2500);
    assert.equal(groupOf(block, "爸爸").income_fen, 900000);
    assert.equal(groupOf(block, "爸爸").total_fen, 2500 + 900000);
    assert.equal(block.total_fen, 907000);
    // V2:共享栏绝不含任何人的个人账本(爸爸的 888 不在这里)
    assert.equal(block.total_fen, 907000, "共享栏不得混入个人账本");
  });

  it("group_by=\"ledger\":ledger 可缺省,两块分列返回", () => {
    f = newFixture();
    seed();
    const { env, data } = summarize("mama", { period: "this_month", group_by: "ledger" });
    ok(env);
    assert.equal(data.ledgers.length, 2, "缺省 ledger = 两个账本各一块");
    assert.equal(blockOf(data, "shared").total_fen, 907000);
    assert.equal(blockOf(data, "personal").total_fen, 777);
    // 每块内的分组正好一块(它本身就只含一个账本)
    assert.equal(blockOf(data, "shared").groups.length, 1);
    assert.equal(blockOf(data, "shared").groups[0]!.total_fen, 907000);
  });

  it("group_by=\"member\" 而 ledger 缺省 → MISSING_PARAMS(二维分组语义不唯一)", () => {
    f = newFixture();
    seed();
    const { env } = summarize("mama", { period: "this_month", group_by: "member" });
    fail(env);
    assert.equal(env.code, "MISSING_PARAMS");
    assert.deepEqual(env.missing, ["ledger"]);
    assert.match(env.message, /必须显式指定 ledger/);
    assert.match(env.hint ?? "", /混算/);
  });

  it("group_by 缺省 → MISSING_PARAMS", () => {
    f = newFixture();
    const env = callTool("mama", "summarize_entries", { period: "this_month" });
    fail(env);
    assert.equal(env.code, "MISSING_PARAMS");
    assert.deepEqual(env.missing, ["group_by"]);
  });

  it("type 收窄:只统计支出时收入不计入,分组与总额仍逐分相等", () => {
    f = newFixture();
    seed();
    const { env, data } = summarize("mama", { period: "this_month", group_by: "category", ledger: "shared", type: "expense" });
    ok(env);
    const block = blockOf(data, "shared");
    assert.equal(block.total_fen, 7000, "只算支出 = 3500+2500+1000");
    assert.equal(block.expense_fen, 7000);
    assert.equal(block.income_fen, 0);
    assert.equal(
      block.groups.some((g) => g.label === "工资"),
      false,
      "收入分类在 type=expense 下不应出现在分组里",
    );
    assert.equal(block.groups.reduce((a, g) => a + g.total_fen, 0), 7000);
    // 回执里 type 收窄时不显示收入 0
    assert.doesNotMatch(env.message, /收入 ¥0\.00/);
  });

  it("支出与收入不相加:不给 type 时总额分列给出两个数", () => {
    f = newFixture();
    seed();
    const { env, data } = summarize("mama", { period: "this_month", group_by: "category", ledger: "shared" });
    ok(env);
    assert.match(env.message, /支出 ¥70\.00/, "3500+2500+1000 = ¥70.00");
    assert.match(env.message, /收入 ¥9,000\.00/);
    assert.match(env.message, /合计 ¥9,070\.00/);
  });

  it("空区间 → 成功且总额 0(不是错误,也不是空表报错)", () => {
    f = newFixture();
    const { env, data } = summarize("mama", {
      start: "1999-01-01",
      end: "1999-01-31",
      group_by: "category",
      ledger: "shared",
    });
    ok(env);
    assert.equal(blockOf(data, "shared").total_fen, 0);
    assert.equal(blockOf(data, "shared").count, 0);
    assert.match(env.message, /没有符合条件的记账记录/);
  });
});

// ─────────────────────────── period 边界(配置时区,动态构造) ───────────────────────────

describe("period 与 start/end 的边界(动态构造,不写死日期)", () => {
  it("period=\"this_month\" = 本月 1 日至月末;上月那笔不计入", () => {
    f = newFixture();
    const now = today();
    const thisMonth = monthStart(now);
    // 上个月的一笔(取上月末,动态算)
    const prevEnd = shiftDay(thisMonth, -1);
    const inThisMonth = newEntry("mama", {
      member_id: "妈妈",
      type: "expense",
      amount_fen: 100,
      occurred_date: thisMonth,
    });
    const lastMonth = newEntry("mama", {
      member_id: "妈妈",
      type: "expense",
      amount_fen: 900,
      occurred_date: prevEnd,
    });

    const { env, data } = summarize("mama", { period: "this_month", group_by: "category", ledger: "shared" });
    ok(env);
    assert.equal(data.start, thisMonth);
    assert.equal(data.end, monthEnd(now));
    assert.equal(data.period, "this_month");
    const block = blockOf(data, "shared");
    assert.equal(block.total_fen, 100, "本月那笔计入");
    assert.equal(block.count, 1);
    // 同一区间用 list_entries 查一遍:两边口径必须一致(汇总与列表都含边界)
    const ranged = listEntries(f.db, f.callers.mama, TZ, { start: data.start, end: data.end, ledger: "shared" });
    ok(ranged);
    const ids = (ranged.data as { entries: EntryView[] }).entries;
    assert.deepEqual(
      ids.map((e) => e.id),
      [inThisMonth.id],
    );
    assert.equal(rawEntry(lastMonth.id).occurred_date, prevEnd);
  });

  it("period=\"last_month\" = 上月月初一至上月月末;本月那笔不计入", () => {
    f = newFixture();
    const now = today();
    const thisMonth = monthStart(now);
    const prevEnd = shiftDay(thisMonth, -1);
    const prevStart = monthStart(prevEnd);
    newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 900, occurred_date: prevEnd });
    newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 100, occurred_date: thisMonth });

    const { env, data } = summarize("mama", { period: "last_month", group_by: "category", ledger: "shared" });
    ok(env);
    assert.equal(data.start, prevStart);
    assert.equal(data.end, prevEnd);
    assert.equal(blockOf(data, "shared").total_fen, 900, "只算上月那笔");
    assert.equal(blockOf(data, "shared").count, 1);
  });

  it("period=\"today\" 只含今天;\"this_week\" 从周一开始(ISO)", () => {
    f = newFixture();
    const now = today();
    const wd = new Date(`${now}T00:00:00Z`).getUTCDay();
    const backToMonday = wd === 0 ? 6 : wd - 1;
    const monday = shiftDay(now, -backToMonday);
    newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 100, occurred_date: now });
    newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 700, occurred_date: shiftDay(now, -1) });

    const t = summarize("mama", { period: "today", group_by: "category", ledger: "shared" });
    ok(t.env);
    assert.equal(t.data.start, now);
    assert.equal(t.data.end, now);
    assert.equal(blockOf(t.data, "shared").total_fen, 100, "today 只含今天");

    const w = summarize("mama", { period: "this_week", group_by: "category", ledger: "shared" });
    ok(w.env);
    assert.equal(w.data.start, monday, "一周从周一开始");
    assert.equal(w.data.end, shiftDay(monday, 6), "周日是本周最后一天");
    // 昨天若在本周内就计入,否则不计(取决于今天是周几,所以只断言边界,不写死金额)
    const expected = shiftDay(now, -1) >= monday ? 800 : 100;
    assert.equal(blockOf(w.data, "shared").total_fen, expected);
  });

  it("period 与 start/end 同时给 → INVALID_PARAMS", () => {
    f = newFixture();
    const env = summarize("mama", {
      period: "this_month",
      start: "2026-10-01",
      end: "2026-10-31",
      group_by: "category",
    }).env;
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "period");
    assert.match(env.message, /二选一/);
  });

  it("都不给 → 本月(缺省口径)", () => {
    f = newFixture();
    const now = today();
    const { env, data } = summarize("mama", { group_by: "category", ledger: "shared" });
    ok(env);
    assert.equal(data.period, "this_month");
    assert.equal(data.start, monthStart(now));
    assert.equal(data.end, monthEnd(now));
  });

  it("只给 start 或只给 end → INVALID_PARAMS(开放式区间不猜)", () => {
    f = newFixture();
    const onlyStart = summarize("mama", { start: "2026-10-01", group_by: "category" }).env;
    fail(onlyStart);
    assert.equal(onlyStart.code, "INVALID_PARAMS");
    assert.match(onlyStart.message, /start 与 end 必须同时给/);
    const onlyEnd = summarize("mama", { end: "2026-10-31", group_by: "category" }).env;
    fail(onlyEnd);
    assert.equal(onlyEnd.code, "INVALID_PARAMS");
  });

  it("end 早于 start → INVALID_PARAMS", () => {
    f = newFixture();
    const env = summarize("mama", { start: "2026-10-31", end: "2026-10-01", group_by: "category" }).env;
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "end");
  });
});

// ─────────────────────────── list_entries 过滤 ───────────────────────────

describe("list_entries:过滤与可见性在 SQL 层", () => {
  it("member_id 是归属人筛选:共享账本里可筛他人(V2)", () => {
    f = newFixture();
    newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 100 });
    newEntry("baba", { member_id: "爸爸", type: "expense", amount_fen: 200 });
    const env = listEntries(f.db, f.callers.kid, TZ, { ledger: "shared", member_id: "妈妈" });
    ok(env);
    const data = env.data as { entries: EntryView[] };
    assert.equal(data.entries.length, 1);
    assert.equal(data.entries[0]!.amount_fen, 100);
    assert.equal(data.entries[0]!.member_name, "妈妈");
  });

  it("start / end 含边界;type / category_id / q 各自生效", () => {
    f = newFixture();
    const d0 = daysAgo(5);
    const d1 = daysAgo(1);
    newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 111, occurred_date: d0, note: "买菜" });
    newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 222, occurred_date: d1, note: "看病" });
    newEntry("mama", {
      member_id: "妈妈",
      type: "income",
      amount_fen: 333,
      occurred_date: d0,
      category_id: "cat-income-salary",
      note: "买菜补贴",
    });

    const ranged = listEntries(f.db, f.callers.mama, TZ, { start: d0, end: d0, ledger: "shared" });
    ok(ranged);
    assert.equal((ranged.data as { entries: EntryView[] }).entries.length, 2, "边界含端点");

    const typed = listEntries(f.db, f.callers.mama, TZ, { type: "income", ledger: "shared" });
    ok(typed);
    assert.equal((typed.data as { entries: EntryView[] }).entries.length, 1);

    const byCat = listEntries(f.db, f.callers.mama, TZ, { category_id: "cat-income-salary", ledger: "shared" });
    ok(byCat);
    assert.equal((byCat.data as { entries: EntryView[] }).entries.length, 1);

    const byQ = listEntries(f.db, f.callers.mama, TZ, { q: "买菜", ledger: "shared" });
    ok(byQ);
    assert.equal((byQ.data as { entries: EntryView[] }).entries.length, 2, "q 按备注模糊匹配(两笔都含「买菜」)");

    const noHit = listEntries(f.db, f.callers.mama, TZ, { q: "不存在的关键词", ledger: "shared" });
    ok(noHit);
    assert.equal((noHit.data as { entries: EntryView[] }).entries.length, 0);
  });

  it("默认范围 = 共享 + 本人个人;回执分两栏", () => {
    f = newFixture();
    newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 100 });
    newEntry("mama", { member_id: "妈妈", ledger: "personal", type: "expense", amount_fen: 200 });
    const env = listEntries(f.db, f.callers.mama, TZ, {});
    ok(env);
    assert.match(env.message, /共享账本 1 条/);
    assert.match(env.message, /你的个人账本 1 条/);
    const data = env.data as { shared: EntryView[]; personal: EntryView[] };
    assert.equal(data.shared.length, 1);
    assert.equal(data.personal.length, 1);
  });

  it("category_id 拼错 → NOT_FOUND(不让它静默返回空表)", () => {
    f = newFixture();
    newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 100 });
    const env = listEntries(f.db, f.callers.mama, TZ, { category_id: "cat-expense-foo" });
    fail(env);
    assert.equal(env.code, "NOT_FOUND");
    assert.equal(env.field, "category_id");
  });

  it("member_id 解析不到 → MISSING_PARAMS + 名单(missing 指向 member_id)", () => {
    f = newFixture();
    const env = listEntries(f.db, f.callers.mama, TZ, { member_id: "查无此人" });
    fail(env);
    assert.equal(env.code, "MISSING_PARAMS");
    assert.deepEqual(env.missing, ["member_id"]);
    assert.match(env.message, /家庭成员有/);
  });

  it("判定顺序:X2 权限闸门排在 category_id 的 NOT_FOUND 之前(越权者拿不到旁证)", () => {
    f = newFixture();
    const secret = newEntry("mama", { member_id: "妈妈", ledger: "personal", type: "expense", amount_fen: 888888 });
    // 同时要他人的私账 + 一个不存在的分类:必须回 DENIED,而不是 NOT_FOUND
    const both = listEntries(f.db, f.callers.baba, TZ, {
      ledger: "personal",
      member_id: "妈妈",
      category_id: "cat-nonexistent",
    });
    fail(both);
    assert.equal(both.code, "DENIED", "权限判定必须先于一切非权限校验");
    assert.equal(both.reason, "not_visible");
    assert.doesNotMatch(JSON.stringify(both), /888888/);
    assert.ok(secret.id);

    // summarize 同一口径:也要先 DENIED
    const sum = summarize("baba", {
      period: "this_month",
      group_by: "category",
      ledger: "personal",
      member_id: "妈妈",
      category_id: "cat-nonexistent",
    });
    fail(sum.env);
    assert.equal(sum.env.code, "DENIED");
  });

  it("add_entry:V4 权限闸门排在金额校验之前(换金额重试也没用)", () => {
    f = newFixture();
    // 个人账本 + 他人归属 + 金额也不合法:回 DENIED(V4),不是 INVALID_PARAMS
    const env = addEntry(f.db, f.callers.baba, TZ, {
      member_id: "妈妈",
      ledger: "personal",
      type: "expense",
      amount_fen: -1,
    });
    fail(env);
    assert.equal(env.code, "DENIED", "权限先于参数校验:换任何金额都还是 DENIED");
    assert.match(env.message, /个人账本只能本人记/);
    assert.equal(entryCount(), 0);
  });

  it("update_entry:V3/V7 权限闸门排在一切校验之前", () => {
    f = newFixture();
    const priv = newEntry("mama", { member_id: "妈妈", ledger: "personal", type: "expense", amount_fen: 5000 });
    // 爸爸改妈妈的私账,同时金额非法、ledger 也要改:只回一条 DENIED(not_visible),
    // 不泄露这条记在哪个账本、也不给"改 ledger"这条出路(那条只对有权限的人有意义)
    const env = updateEntry(f.db, f.callers.baba, TZ, { id: priv.id, ledger: "shared", amount_fen: -1 });
    fail(env);
    assert.equal(env.code, "DENIED");
    assert.equal(env.reason, "not_visible");
    assert.doesNotMatch(env.message, /immutable|删除后重建/, "不可见行的不可变提示也是行内信息");
    assert.equal(rawEntry(priv.id).amount_fen, 5000);
    assert.equal(rawEntry(priv.id).ledger, "personal");
  });
});

// ─────────────────────────── 软删与恢复 ───────────────────────────

describe("软删与恢复(P5 / restore_deleted)", () => {
  it("delete_entry:列表与汇总都不再包含,原始行 deleted_at 非空;restore 后回来且字段未变", () => {
    f = newFixture();
    const e = newEntry("mama", {
      member_id: "妈妈",
      type: "expense",
      amount_fen: 4567,
      category_id: "cat-expense-food",
      note: "上周五那笔奶茶",
      // 用**本月内**的日期(动态构造):否则月初跑这条用例时 daysAgo(5) 会落到上个月,
      // 与下面 period="this_month" 的断言对不上。日期本身仍不写死。
      occurred_date: today(),
    });
    const before = { ...rawEntry(e.id) };

    const del = deleteEntry(f.db, f.callers.mama, TZ, e.id);
    ok(del);
    assert.match(del.message, /已删除/);
    assert.match(del.message, /restore_deleted\(kind="entry", id="/, "回执要给出恢复出路");
    assert.equal((del.data as { deleted_at: string | null }).deleted_at !== null, true);

    const row = rawEntry(e.id);
    assert.notEqual(row.deleted_at, null, "软删必须写 deleted_at(不是物理删)");
    assert.equal(row.amount_fen, before.amount_fen);
    assert.equal(row.note, before.note);

    const list = listEntries(f.db, f.callers.mama, TZ, {});
    ok(list);
    assert.equal((list.data as { entries: EntryView[] }).entries.length, 0, "列表里不再有它");
    const { data } = summarize("mama", { period: "this_month", group_by: "category", ledger: "shared" });
    assert.equal(blockOf(data, "shared").total_fen, 0, "汇总里也不再包含它");

    // 走 restore_deleted(kind="entry") 这条真实路径
    const restored = restoreDeleted(f.db, f.callers.mama, "entry", e.id);
    ok(restored);
    assert.match(restored.message, /已恢复共享账本流水/);
    const after = rawEntry(e.id);
    assert.equal(after.deleted_at, null);
    // 字段逐字未变
    assert.equal(after.amount_fen, before.amount_fen);
    assert.equal(after.category_id, before.category_id);
    assert.equal(after.note, before.note);
    assert.equal(after.occurred_date, before.occurred_date);
    assert.equal(after.ledger, before.ledger);
    assert.equal(after.member_id, before.member_id);
    // 恢复后重新出现在列表与汇总里
    const list2 = listEntries(f.db, f.callers.mama, TZ, {});
    ok(list2);
    assert.equal((list2.data as { entries: EntryView[] }).entries.length, 1);
    const { data: data2 } = summarize("mama", { period: "this_month", group_by: "category", ledger: "shared" });
    assert.equal(blockOf(data2, "shared").total_fen, 4567);
  });

  it("restore 他人的个人账本记录 → DENIED(not_visible),且不得复活", () => {
    f = newFixture();
    const priv = newEntry("mama", { member_id: "妈妈", ledger: "personal", type: "expense", amount_fen: 9999 });
    ok(deleteEntry(f.db, f.callers.mama, TZ, priv.id));

    const denied = restoreDeleted(f.db, f.callers.baba, "entry", priv.id);
    fail(denied);
    assert.equal(denied.code, "DENIED");
    assert.equal(denied.reason, "not_visible");
    assert.notEqual(rawEntry(priv.id).deleted_at, null, "被拒的恢复不得生效");
    assert.doesNotMatch(JSON.stringify(denied), /9999/, "拒绝信封不得泄露他人金额");

    // 本人恢复 → 放行
    const okSelf = restoreEntry(f.db, f.callers.mama, priv.id);
    ok(okSelf);
    assert.match(okSelf.message, /已恢复你的个人账本流水/);
    assert.equal(rawEntry(priv.id).deleted_at, null);
  });

  it("重复删除 / 重复恢复都幂等,且判定顺序:权限先于幂等", () => {
    f = newFixture();

    // ① 他人的**个人**账本:拿已删 id 来恢复必须是 DENIED,不能是"未被删除,无需恢复"
    //    (那条幂等话术带金额与分类,排在权限之前就是泄露 —— S1/S2 的教训)
    const priv = newEntry("mama", { member_id: "妈妈", ledger: "personal", type: "expense", amount_fen: 100 });
    ok(deleteEntry(f.db, f.callers.mama, TZ, priv.id));
    const denied = restoreEntry(f.db, f.callers.baba, priv.id);
    fail(denied);
    assert.equal(denied.code, "DENIED");
    assert.equal(denied.reason, "not_visible");
    assert.doesNotMatch(denied.message, /未被删除/, "幂等分支不得排在权限之前");
    assert.notEqual(rawEntry(priv.id).deleted_at, null, "被拒的恢复不得生效");

    // ② 共享账本:第三人能删也能恢复(V3 家庭内互信)
    const shared = newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 200 });
    ok(deleteEntry(f.db, f.callers.kid, TZ, shared.id));
    assert.notEqual(rawEntry(shared.id).deleted_at, null);
    const back = restoreEntry(f.db, f.callers.kid, shared.id);
    ok(back);
    assert.match(back.message, /已恢复共享账本流水/);
    assert.equal(rawEntry(shared.id).deleted_at, null);

    // ③ 恢复一个没删过的 → 幂等:回执说明无需恢复,且**不写** deleted_at
    const noop = restoreEntry(f.db, f.callers.mama, shared.id);
    ok(noop);
    assert.match(noop.message, /未被删除,无需恢复/);
    assert.equal(rawEntry(shared.id).deleted_at, null, "本来就未删,不得写入 deleted_at");
  });

  it("delete_entry:不存在的 id → NOT_FOUND;已删的 id → NOT_FOUND", () => {
    f = newFixture();
    const missing = deleteEntry(f.db, f.callers.mama, TZ, "en-000000-zzzz");
    fail(missing);
    assert.equal(missing.code, "NOT_FOUND");
    const e = newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 100 });
    ok(deleteEntry(f.db, f.callers.mama, TZ, e.id));
    const again = deleteEntry(f.db, f.callers.mama, TZ, e.id);
    fail(again);
    assert.equal(again.code, "NOT_FOUND");
    assert.match(again.message, /已被删除/);
  });
});

// ─────────────────────────── 审计(写留痕、读不留、note 不进) ───────────────────────────

describe("审计:4 个写工具留痕,3 个读工具不留,note 不进摘要", () => {
  it("add_entry / update_entry / delete_entry / add_category 各留一行", () => {
    f = newFixture();
    const e = newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 3500 });
    assert.equal(listAudit(f.db).length, 0, "直调 domain 不经工具层,不记审计(记录点在工具层入口)");

    ok(callTool("mama", "add_entry", { member_id: "妈妈", type: "expense", amount_fen: 3500, category_id: "cat-expense-food" }));
    ok(callTool("mama", "update_entry", { id: e.id, amount_fen: 3600 }));
    ok(callTool("mama", "delete_entry", { id: e.id }));
    ok(callTool("mama", "add_category", { name: "宠物", kind: "expense" }));

    const rows = listAudit(f.db);
    assert.deepEqual(
      rows.map((r) => r.tool).reverse(),
      ["add_entry", "update_entry", "delete_entry", "add_category"],
      "4 个写工具各留一行",
    );
    const added = rows.find((r) => r.tool === "add_entry")!;
    assert.equal(added.member_id, f.members.mama.id, "member_id 是连接身份");
    assert.equal(added.member_name, "妈妈");
    assert.equal(added.result_code, "OK");
    assert.match(added.args_summary, /member_id=妈妈/);
    assert.match(added.args_summary, /amount_fen=3500/, "金额进审计");
    assert.match(added.args_summary, /type=expense/, "类型进审计");
    assert.match(added.args_summary, /category_id=cat-expense-food/);
    const upd = rows.find((r) => r.tool === "update_entry")!;
    assert.match(upd.args_summary, new RegExp(`id=${e.id}`));
    assert.match(upd.args_summary, /amount_fen=3600/);
    const del = rows.find((r) => r.tool === "delete_entry")!;
    assert.equal(del.args_summary, `id=${e.id}`);
    const cat = rows.find((r) => r.tool === "add_category")!;
    assert.match(cat.args_summary, /name=宠物/);
    assert.match(cat.args_summary, /kind=expense/);
  });

  it("3 个读工具不留痕;被拒的读也不留", () => {
    f = newFixture();
    newEntry("mama", { member_id: "妈妈", ledger: "personal", type: "expense", amount_fen: 3500 });
    // 三个读工具各调一次(成功的读)
    ok(callTool("mama", "list_entries", {}));
    ok(callTool("mama", "summarize_entries", { period: "this_month", group_by: "category" }));
    ok(callTool("mama", "list_categories", {}));
    // 被拒的读(X2 与 group_by=member 缺省 ledger)同样不记:读不是写
    fail(callTool("baba", "list_entries", { ledger: "personal", member_id: "妈妈" }));
    fail(callTool("baba", "summarize_entries", { period: "this_month", group_by: "member" }));
    assert.equal(listAudit(f.db).length, 0, "读操作一律不记审计");
  });

  it("note 是自由文本,不进审计摘要", () => {
    f = newFixture();
    const secret = "奶茶三杯 27 元,别跟爸爸说";
    const added = callTool("mama", "add_entry", { member_id: "妈妈", type: "expense", amount_fen: 2700, note: secret });
    ok(added);
    const id = (added.data as EntryView).id;
    // 带 note 的 update 也要留痕(改备注本身是写),但摘要里同样不能出现 note
    ok(callTool("mama", "update_entry", { id, note: "改成另一句私房话" }));
    const rows = listAudit(f.db);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.doesNotMatch(r.args_summary, /note/, `工具 ${r.tool} 的摘要里出现了 note`);
      assert.doesNotMatch(r.args_summary, /奶茶/, "私账备注不得被复制进审计");
      assert.doesNotMatch(r.args_summary, /别跟爸爸说/);
      assert.doesNotMatch(r.args_summary, /私房话/);
    }
    // 确认 note 确实落到了库里(否则上面的"不出现"就没有说服力)
    assert.equal(rawEntry(id).note, "改成另一句私房话");
  });

  it("写失败的调用也留痕(result_code = 信封码,ok = 0)", () => {
    f = newFixture();
    const env = callTool("baba", "add_entry", {
      member_id: "妈妈",
      ledger: "personal",
      type: "expense",
      amount_fen: 3500,
    });
    fail(env);
    const r = listAudit(f.db)[0]!;
    assert.equal(r.tool, "add_entry");
    assert.equal(r.ok, false);
    assert.equal(r.result_code, "DENIED", "配错正是最该被追溯的");
    assert.equal(r.member_id, f.members.baba.id);
  });
});

// ─────────────────────────── 契约面(golden 之外的额外硬要求) ───────────────────────────

describe("记账域工具面:拒绝条件写进 description(P8)", () => {
  function desc(name: string): string {
    const t = TOOL_DEFINITIONS.find((x) => x.name === name);
    assert.ok(t, `缺少 ${name}`);
    return t!.description;
  }

  it("add_entry 的 description 写明 V4(个人账本只能本人写)", () => {
    const d = desc("add_entry");
    assert.match(d, /个人账本只能本人写/);
    assert.match(d, /DENIED/);
    assert.match(d, /member_id 必须等于说话人/);
  });

  it("update_entry 的 description 写明 V7 固定话术与 immutable", () => {
    const d = desc("update_entry");
    assert.match(d, /归属\/账本不可修改,如需变更请删除后重建/);
    assert.match(d, /immutable/);
    assert.match(d, /删除后重建/, "要给出路,否则模型会换参数反复重试");
    assert.match(d, /member_id 不是定位符/);
  });

  it("summarize_entries 的 description 写明 group_by=member 需显式 ledger", () => {
    const d = desc("summarize_entries");
    assert.match(d, /group_by="member" 时 ledger 必填/);
    assert.match(d, /MISSING_PARAMS/);
    assert.match(d, /不混算/);
  });

  it("list_entries 的 description 写明 X2(显式要他人私账 → DENIED,不是空表)", () => {
    const d = desc("list_entries");
    assert.match(d, /DENIED/);
    assert.match(d, /不是空表/);
    assert.match(d, /仅归属人本人可见/);
  });

  it("delete_entry 与 restore_deleted 的 description 都写出拒绝条件与 \"entry\"", () => {
    assert.match(desc("delete_entry"), /DENIED/);
    const r = desc("restore_deleted");
    assert.match(r, /DENIED/);
    assert.match(r, /"entry"/);
  });

  it("全部 7 个工具:中文、含示例、声明说话人不是参数", () => {
    for (const name of [
      "add_category",
      "list_categories",
      "add_entry",
      "list_entries",
      "summarize_entries",
      "update_entry",
      "delete_entry",
    ]) {
      const d = desc(name);
      assert.match(d, /示例:/, `${name} 缺少示例(P8 ③)`);
      assert.match(d, /说话人由连接确定/, `${name} 未声明说话人不是参数(P7)`);
      assert.match(d, /[一-龥]/, `${name} 的 description 必须是中文(P8 ①)`);
    }
  });

  it("记账域工具的 schema 一律 strict,且没有身份参数形态", () => {
    for (const name of [
      "add_category",
      "list_categories",
      "add_entry",
      "list_entries",
      "summarize_entries",
      "update_entry",
      "delete_entry",
    ]) {
      const t = TOOL_DEFINITIONS.find((x) => x.name === name)!;
      assert.equal(t.inputSchema.additionalProperties, false, `${name} 的 schema 不是 strict`);
      const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
      for (const banned of ["as_member", "asMember", "bind_key", "bindKey", "speaker", "caller", "as", "whoami"]) {
        assert.equal(banned in props, false, `${name} 出现了身份参数 ${banned}`);
      }
    }
  });

  it("X15/X1 的形态:记账工具被诱导传身份参数 → INVALID_PARAMS(未知字段)", () => {
    f = newFixture();
    const env = callTool("mama", "list_entries", { as_member: "爸爸" });
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "as_member");
    assert.match(env.message, /说话人由连接确定/);
  });

  it("update_entry 传不存在的字段(如 budget)→ INVALID_PARAMS", () => {
    f = newFixture();
    const e = newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 100 });
    const env = callTool("mama", "update_entry", { id: e.id, budget: 1000 });
    fail(env);
    assert.equal(env.code, "INVALID_PARAMS");
    assert.equal(env.field, "budget");
  });
});

// ─────────────────────────── 钱不许交给模型算(P4 的结构性保证) ───────────────────────────

describe("P4:合计由 SQL 算,不把明细丢给模型", () => {
  it("summarize_entries 只返回合计与分组,不带流水明细", () => {
    f = newFixture();
    newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 1234, note: "别给我妈看" });
    newEntry("mama", { member_id: "妈妈", type: "expense", amount_fen: 2345 });
    const { env, data } = summarize("mama", { period: "this_month", group_by: "category", ledger: "shared" });
    ok(env);
    // 结构里没有"明细数组"这一层:只有总额与分组
    const keys = Object.keys(data).sort();
    assert.deepEqual(keys, ["end", "group_by", "ledgers", "period", "start", "type"]);
    for (const b of data.ledgers) {
      assert.ok(typeof b.total_fen === "number", "合计是程序算好的整数分");
      for (const g of b.groups) assert.equal(typeof g.total_fen, "number");
    }
    assert.equal(blockOf(data, "shared").total_fen, 1234 + 2345, "1234+2345 = 3579");
    // 备注不该出现在汇总里(汇总是数字,不是流水)
    assert.doesNotMatch(JSON.stringify(data), /别给我妈看/);
  });

  it("formatYuan 是整数运算:0 分、1 分、99 分、100 分都显示成两位小数", async () => {
    const { formatYuan } = await import("../src/domain/ledger.js");
    assert.equal(formatYuan(0), "¥0.00");
    assert.equal(formatYuan(1), "¥0.01");
    assert.equal(formatYuan(99), "¥0.99");
    assert.equal(formatYuan(100), "¥1.00");
    assert.equal(formatYuan(999), "¥9.99");
    assert.equal(formatYuan(100000), "¥1,000.00");
    assert.equal(formatYuan(123456789), "¥1,234,567.89");
    // 回执里用的就是这个:35 元 = 3500 分 → ¥35.00
    assert.equal(formatYuan(3500), yuan(3500));
  });

  it("大额阈值常量 = ¥10,000.00(1_000_000 分),且导出于 domain", async () => {
    const { LARGE_AMOUNT_FEN, CATEGORY_SORT_STEP } = await import("../src/domain/ledger.js");
    assert.equal(LARGE_AMOUNT_FEN, 1_000_000);
    assert.equal(yuan(LARGE_AMOUNT_FEN), "¥10,000.00");
    assert.equal(CATEGORY_SORT_STEP, 10);
  });
});