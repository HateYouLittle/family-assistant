import { z } from "zod";
import { isCalendarDate } from "../db/id.js";
import { failEnvelope, type Envelope } from "../domain/envelope.js";
import { isRealMoment as isRealEventMoment } from "../domain/events.js";

/**
 * 工具参数 schema(P1/P2/P8)。
 * 一律 strictObject:未知字段直接报 INVALID_PARAMS(未知字段)——
 * 这是 X1(传 owner 查他人待办)与 X15(被诱导传 as_member)的落点,
 * 说话人不是参数,模型没有可填的位置。
 */

function dateString(label: string) {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: `${label} 格式应为 YYYY-MM-DD(如 2026-10-05)` })
    .refine((v) => isCalendarDate(v), { message: `${label} 不是真实存在的日历日期` });
}

export const listMembersSchema = z.strictObject({});

export const addTodoSchema = z.strictObject({
  owner: z
    .string()
    .min(1, "owner 不能为空")
    .max(100)
    .optional()
    .describe("归属人:成员名、别名或成员 id;缺省 = 说话人本人。指定他人 = 代记,条目仅对方可见。"),
  title: z.string().trim().min(1, "title 不能为空").max(200, "title 过长(上限 200 字)").describe("待办标题,一句话。"),
  due_date: dateString("due_date")
    .optional()
    .describe("截止日期,YYYY-MM-DD,可缺省。相对日期(明天/下周三)先自行换算再传。"),
  notes: z.string().max(2000, "notes 过长(上限 2000 字)").optional().describe("补充备注,可缺省。"),
});

export const listTodosSchema = z.strictObject({
  done: z.boolean().optional().describe("true=只看已完成,false=只看未完成;缺省=全部。"),
  due_before: dateString("due_before").optional().describe("截止日期上界(含边界),YYYY-MM-DD。"),
  due_after: dateString("due_after").optional().describe("截止日期下界(含边界),YYYY-MM-DD。"),
  q: z.string().min(1).max(100).optional().describe("按标题/备注模糊过滤的关键词。"),
});

export const completeTodoSchema = z.strictObject({
  id: z.string().min(1).max(40).describe("待办 id,从 list_todos 的结果里原样复制,不要凭记忆转述。"),
});

export const updateTodoSchema = z.strictObject({
  id: z.string().min(1).max(40).describe("待办 id,从 list_todos 的结果里原样复制。"),
  title: z
    .string()
    .trim()
    .min(1, "title 不能为空")
    .max(200, "title 过长(上限 200 字)")
    .optional()
    .describe("新标题。缺省 = 不改动。"),
  notes: z
    .string()
    .max(2000, "notes 过长(上限 2000 字)")
    .nullable()
    .optional()
    .describe("新备注。缺省 = 不改动;传 null = 清空备注。"),
  due_date: dateString("due_date")
    .nullable()
    .optional()
    .describe("新截止日期 YYYY-MM-DD。缺省 = 不改动;传 null = 去掉截止日期。"),
  owner: z
    .string()
    .min(1, "owner 不能为空")
    .max(100)
    .optional()
    .describe(
      "归属人:仅供读-改-写时原样回传。缺省 = 不传;" +
        "与现值相同(含别名/成员 id)幂等放行,与现值不同 → DENIED(immutable):归属不可修改,如需变更请删除后重建。" +
        "本工具不接受 done(完成用 complete_todo、取消完成用 reopen_todo)。",
    ),
});

export const reopenTodoSchema = z.strictObject({
  id: z.string().min(1).max(40).describe("待办 id,从 list_todos 的结果里原样复制。"),
});

export const deleteTodoSchema = z.strictObject({
  id: z.string().min(1).max(40).describe("待办 id,从 list_todos 的结果里原样复制。软删,可恢复。"),
});

// ─────────────────────────── 日程域(S2) ───────────────────────────

/**
 * 日程的时刻串:**形状**校验(格式错、假日历日、时刻越界)在这一层,
 * **语义**校验(按 all_day 判定该传哪种格式、end ≥ start)在 domain 层
 * (src/domain/events.ts 的 validateTimes)。
 *
 * 所以这里的正则同时接受两种形状:`YYYY-MM-DD` 与 `YYYY-MM-DD HH:MM`。
 * 为什么不按 all_day 在 schema 里收紧:all_day 与 start/end 是"联合"约束,
 * 而 zod 的字段级 refine 看不到兄弟字段;真要在 schema 里表达就得 superRefine,
 * 那样同一个规则会有两份实现。本阶段选择"形状一份、语义一份",语义那份对
 * 直接调 domain 的调用方同样生效(domain 层不假设上游已校验)。
 */
function eventTimeString(label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} 不能为空`)
    .max(40, `${label} 过长(上限 40 字)`)
    .regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/, {
      message: `${label} 格式应为 YYYY-MM-DD(全天日程)或 "YYYY-MM-DD HH:MM"(带时刻,例如 2026-10-05 09:00)`,
    })
    .refine((v) => isRealEventMoment(v), {
      message: `${label} 不是合法的时间(日期须真实存在,时刻须在 00:00-23:59)`,
    });
}

/**
 * 重复规则三个参数(S2b)。**形状校验**在这里,**语义校验**(none 不收这两个参数、
 * repeat_until 早于 start、间隔大到窗口里一次都没有)在 domain 层
 * (src/domain/events.ts 的 resolveRepeatRule),与时间参数同一套分工。
 */
const repeatEnum = z.enum(["none", "daily", "weekly", "monthly"], {
  errorMap: () => ({
    message: 'repeat 只支持 "none"(不重复,缺省)、"daily"(每天)、"weekly"(每周)、"monthly"(每月);收到的是其它值',
  }),
});

const repeatInterval = z
  .number()
  .int("repeat_interval 必须是整数")
  .min(1, "repeat_interval 至少为 1")
  .max(366, "repeat_interval 至多 366(约一年)");

const REPEAT_RULE_NOTE =
  "重复日程在创建时就按规则把**未来 92 天**展开成多条日程(list_events 返回的就是其中一条);" +
  "读到已展开范围之外时程序会自动续期,所以不必(也无法)手工补齐。" +
  "重复日程不支持只改其中一次:修改与删除都作用于**整个系列**。";

export const addEventSchema = z.strictObject({
  owner: z
    .string()
    .min(1, "owner 不能为空")
    .max(100)
    .optional()
    .describe(
      "归属人:成员名、别名或成员 id。缺省 = 全家日程(全员可见);" +
        "指定某人 = TA 的个人日程(仅 TA 可见),指定他人即代记,回执会注明「由你代记」。",
    ),
  title: z.string().trim().min(1, "title 不能为空").max(200, "title 过长(上限 200 字)").describe("日程标题,一句话。"),
  start: eventTimeString("start").describe(
    "开始时间:all_day=true 传纯日期 YYYY-MM-DD,否则传 \"YYYY-MM-DD HH:MM\"。相对日期(明天/下周三)先自行换算再传。" +
      "重复日程里它是**首次**发生的时间,后续按 repeat 推。",
  ),
  end: eventTimeString("end").optional().describe(
    "结束时间,格式必须与 all_day 一致(同样的两种格式);缺省 = 未定结束时间。end 不得早于 start。",
  ),
  all_day: z
    .boolean()
    .optional()
    .describe(
      "true = 全天日程(start/end 只能是纯日期 YYYY-MM-DD);缺省或 false = 带时刻" +
        '(start/end 必须为 "YYYY-MM-DD HH:MM")。格式与 all_day 不符返回 INVALID_PARAMS 并指明字段。',
    ),
  location: z.string().max(200, "location 过长(上限 200 字)").optional().describe("地点,可缺省。"),
  notes: z.string().max(2000, "notes 过长(上限 2000 字)").optional().describe("补充备注,可缺省。"),
  repeat: repeatEnum.optional().describe(
    '重复规则:缺省或 "none" = 单次日程;"daily" / "weekly" / "monthly" = 每天 / 每周 / 每月重复。' + REPEAT_RULE_NOTE,
  ),
  repeat_interval: repeatInterval.optional().describe(
    '每隔几个单位重复一次,正整数,缺省 1。repeat="weekly" + 2 = 每两周,repeat="daily" + 2 = 每两天。' +
      'repeat="none" 时传它返回 INVALID_PARAMS(非重复日程不接受这个参数)。',
  ),
  repeat_until: dateString("repeat_until")
    .optional()
    .describe(
      "重复截止日,纯日期 YYYY-MM-DD,**含当天为止**不再生成新日程;缺省 = 一直重复。" +
        "必须不早于 start,否则返回 INVALID_PARAMS(那样一次都不会发生)。" +
        'repeat="none" 时传它返回 INVALID_PARAMS(非重复日程不接受这个参数)。',
    ),
});

export const listEventsSchema = z.strictObject({
  start: eventTimeString("start").describe(
    '时间窗下界(含边界):纯日期 YYYY-MM-DD 或 "YYYY-MM-DD HH:MM"。按与日程时间的**重叠**判定(跨窗口仍在进行的日程也会出现)。',
  ),
  end: eventTimeString("end").describe(
    '时间窗上界(含边界):纯日期按当天 23:59 算,所以 start=end=某天 就是"那一天"。end 不得早于 start。',
  ),
  scope: z
    .enum(["family", "mine"])
    .optional()
    .describe(
      '"family" = 只看全家日程;"mine" = 只看你自己的个人日程;缺省 = 全家日程 + 你的个人日程 + 你代记给他人的个人日程(V8 查看权)。' +
        "没有查询他人个人日程的参数形态(V1):传 owner 之类未知字段会返回 INVALID_PARAMS。",
    ),
});

export const updateEventSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(40)
    .describe("日程 id,从 list_events 的结果里原样复制(实例 id 形如 ei-…;系列 id 形如 e-… 也接受)。"),
  title: z
    .string()
    .trim()
    .min(1, "title 不能为空")
    .max(200, "title 过长(上限 200 字)")
    .optional()
    .describe("新标题。缺省 = 不改动。"),
  location: z.string().max(200, "location 过长(上限 200 字)").nullable().optional().describe("新地点。缺省 = 不改动;传 null = 清空地点。"),
  notes: z.string().max(2000, "notes 过长(上限 2000 字)").nullable().optional().describe("新备注。缺省 = 不改动;传 null = 清空备注。"),
  start: eventTimeString("start").optional().describe(
    '新开始时间,格式必须与 all_day 一致。缺省 = 不改动;要改时间粒度(全天 ↔ 带时刻)必须同时显式传 all_day。' +
      "重复日程里它是新的首次时间,**整个系列**按新时间重建。",
  ),
  end: eventTimeString("end").nullable().optional().describe("新结束时间。缺省 = 不改动;传 null = 去掉结束时间。"),
  all_day: z.boolean().optional().describe("true = 全天、false = 带时刻。缺省 = 不改动;与 start/end 的格式做联合校验。"),
  repeat: repeatEnum.optional().describe(
    '重复规则:缺省 = 不改动。传 "none" = 改成单次日程(折叠):保留接下来最早的那一次,其余未来的展开收起;' +
      "整个系列都在过去时不再新建(回执会说明这个系列没有更晚的一次)。" +
      "重复日程**不支持只改其中一次**:改时间或改规则都作用于整个系列,尚未发生的日程按新规则重建," +
      "已经过去的那几次原样保留(历史不被改写)。",
  ),
  repeat_interval: repeatInterval.optional().describe(
    "新的重复间隔,正整数,缺省 = 不改动。" +
      'repeat="none" 时传它返回 INVALID_PARAMS(非重复日程不接受这个参数)。',
  ),
  repeat_until: dateString("repeat_until")
    .nullable()
    .optional()
    .describe(
      "新的重复截止日 YYYY-MM-DD(含当天为止);缺省 = 不改动;传 null = 去掉截止日。" +
        'repeat="none" 时传它返回 INVALID_PARAMS。',
    ),
  owner: z
    .string()
    .min(1, "owner 不能为空")
    .max(100)
    .optional()
    .describe(
      "归属人:仅供读-改-写时原样回传。缺省 = 不传;" +
        "与现值相同(含别名/成员 id)幂等放行,与现值不同 → DENIED(immutable):归属/账本不可修改,如需变更请删除后重建。" +
        "把全家日程改成个人日程同样被这条拒绝。",
    ),
});

export const deleteEventSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(40)
    .describe("日程 id,从 list_events 的结果里原样复制(实例 id 或系列 id 都接受)。软删,可恢复;按整个系列删。"),
});

// ─────────────────────────── 记账域(S3) ───────────────────────────

/**
 * 金额(§4 v0.5.2 / P1):**整数分**,> 0。
 *
 * 形状校验在这一层,**语义校验**(正整数)也在这一层;但"大额只提示不硬拒"那条在 domain 层
 * (src/domain/ledger.ts 的 LARGE_AMOUNT_FEN),因为它是回执的一部分而不是校验。
 * invalid_type_error 写死成中文:模型经常把金额当字符串传("35"),默认的英文报错
 * 很容易让它换个参数继续试,而不是意识到要传 3500 分。
 */
const amountFen = z
  .number({
    invalid_type_error:
      'amount_fen 必须是整数(单位:分)。35 元 = 3500 分;字符串 "35"、小数 35.5 都会被拒绝。',
  })
  .int("amount_fen 必须是整数分,不能带小数(35.5 元请传 3550)")
  .positive("amount_fen 必须大于 0 分(表结构的约束就是 amount_fen > 0)")
  .describe(
    "金额,整数**分**(P1:程序不解析「35 块」这类自由文本,请自行换算:35 元 = 3500 分)。必须 > 0。" +
      "单笔达到 ¥10,000.00 时回执会追加一句确认提示(不拒绝)。",
  );

const ledgerEnum = z.enum(["shared", "personal"], {
  errorMap: () => ({
    message: 'ledger 只支持 "shared"(共享账本,全家可见)或 "personal"(个人账本,仅本人可见)',
  }),
});

const entryTypeEnum = z.enum(["expense", "income"], {
  errorMap: () => ({ message: 'type 只支持 "expense"(支出)或 "income"(收入)' }),
});

/**
 * 归属人/账本不可变(V7)的固定话术。三条 update_* 的 description 必须写这一句(P8 ④)。
 *
 * 这条常量目前只是把契约文字固定在**一处**、供人工核对 description 时对照使用;
 * domain 层(ledger.ts / events.ts / todos.ts)的 DENIED(immutable) message 前缀
 * 逐字是同一句,但**没有**从这里 import —— domain 不依赖 mcp 层(分层纪律)。
 * 两边措辞走偏时,golden.test.ts 的断言会先红(它直接断言 description 里的这句话)。
 */
export const IMMUTABLE_NOTE = "归属/账本不可修改,如需变更请删除后重建";

export const addEntrySchema = z.strictObject({
  member_id: z
    .string()
    .min(1, "member_id 不能为空")
    .max(100)
    .describe(
      "归属人(这笔算谁的),**必填**(名字/别名/成员 id 都接受)。" +
        'ledger="shared" 时可为他人(代记,共享账本全员可见);ledger="personal" 时必须是说话人本人,否则 DENIED。' +
        "先调 list_members 对齐称呼:匹配不到返回 MISSING_PARAMS(附成员名单),重名返回 AMBIGUOUS(附候选)。",
    ),
  ledger: ledgerEnum.optional().describe(
    '账本:缺省 = "shared"(共享账本,全家成员都能看到);"personal" = 本人的个人账本,仅本人可见。' +
      "个人账本只能本人写(V4):ledger=personal 时 member_id 必须等于说话人,否则返回 DENIED。",
  ),
  type: entryTypeEnum.describe('"expense" = 支出(花了钱);"income" = 收入(工资、红包、退款)。分类的 kind 必须与它一致。'),
  amount_fen: amountFen,
  category_id: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(
      "分类 id,从 list_categories 的结果里原样复制。**可缺省**:不给就是「未分类」(汇总里单列)。" +
        "分类不存在返回 NOT_FOUND;分类的 kind 与 type 不一致返回 INVALID_PARAMS。",
    ),
  note: z.string().max(2000, "note 过长(上限 2000 字)").optional().describe("备注,可缺省。自由文本,不进审计。"),
  occurred_date: dateString("occurred_date")
    .optional()
    .describe(
      "发生日期,YYYY-MM-DD,只到日(家庭记账的时间粒度);缺省 = 今天(按家庭配置时区算)。" +
        "相对日期(上周五)先自行换算再传。",
    ),
});

export const listEntriesSchema = z.strictObject({
  start: dateString("start").optional().describe("发生日期下界(含边界),YYYY-MM-DD;缺省 = 不限。"),
  end: dateString("end").optional().describe("发生日期上界(含边界),YYYY-MM-DD;缺省 = 不限。"),
  member_id: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "按**归属人**筛选(这笔算谁的)。它只在可见范围内生效:共享账本里可以按人筛" +
        "(问「我们家这个月妈妈花了多少」就是它)。" +
        '但 ledger="personal" 且 member_id 指向他人时返回 DENIED(not_visible),不是空表。',
    ),
  category_id: z.string().min(1).max(40).optional().describe("按分类筛选;分类 id 不存在返回 NOT_FOUND(拼错 id 只会静默空表)。"),
  type: entryTypeEnum.optional().describe('"expense" 只看支出、"income" 只看收入;缺省 = 都列。'),
  ledger: ledgerEnum.optional().describe(
    '账本:缺省 = 共享账本 + 本人的个人账本(回执分两栏);"shared" 只看共享;"personal" 只看本人个人账本。' +
      '显式要他人的个人账本(ledger="personal" + 他人的 member_id)返回 DENIED(not_visible)。',
  ),
  q: z.string().min(1).max(100).optional().describe("按备注(note)模糊过滤的关键词。"),
});

export const summarizeEntriesSchema = z.strictObject({
  period: z
    .enum(["today", "this_week", "this_month", "last_month", "this_year"], {
      errorMap: () => ({
        message: 'period 只支持 "today" / "this_week" / "this_month" / "last_month" / "this_year"',
      }),
    })
    .optional()
    .describe(
      '统计周期,与 start/end **二选一**:同时给返回 INVALID_PARAMS;都不给 = 本月。' +
        '一周从周一开始;边界按家庭配置时区算(如 this_month = 本月 1 日至月末)。',
    ),
  start: dateString("start").optional().describe(
    '区间下界(含边界)YYYY-MM-DD。start 与 end 必须同时给(只给一个返回 INVALID_PARAMS);要与 period 二选一。',
  ),
  end: dateString("end").optional().describe("区间上界(含边界)YYYY-MM-DD;start 与 end 必须同时给。"),
  group_by: z
    .enum(["category", "member", "ledger"], {
      errorMap: () => ({ message: 'group_by 必填,只支持 "category" / "member" / "ledger"' }),
    })
    .describe(
      '分组维度(**必填**):"category" = 按分类(未分类单列)、"member" = 按归属人、"ledger" = 按账本。' +
        'group_by="member" 时 ledger **必填**(否则 MISSING_PARAMS:默认范围跨两个账本,按人分组会混算);' +
        '只有 group_by="ledger" 时 ledger 才可缺省。',
    ),
  type: entryTypeEnum.optional().describe(
    '"expense" 只统计支出、"income" 只统计收入。缺省 = 支出与收入都算,回执里两者分列(相加没有意义)。',
  ),
  category_id: z.string().min(1).max(40).optional().describe("只统计某个分类;分类不存在返回 NOT_FOUND。"),
  member_id: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "只统计某个归属人。共享账本里可筛他人;但 ledger=\"personal\" 且指向他人时返回 DENIED(not_visible)。",
    ),
  ledger: ledgerEnum.optional().describe(
    '账本:缺省 = 共享账本 + 本人的个人账本,回执**分成两栏不混算**。' +
      'group_by="member" 时必填;group_by="ledger" 时可缺省(本就是按账本分组)。',
  ),
});

export const updateEntrySchema = z.strictObject({
  id: z.string().min(1).max(40).describe("记账记录 id,从 list_entries 的结果里原样复制。程序不接受模糊指定。"),
  amount_fen: amountFen.optional().describe("新金额,整数分,必须 > 0。缺省 = 不改动。"),
  category_id: z
    .string()
    .min(1)
    .max(40)
    .nullable()
    .optional()
    .describe(
      "新分类 id。缺省 = 不改动;传 null = 置为**未分类**。分类不存在返回 NOT_FOUND;" +
        "分类的 kind 与 type 不一致返回 INVALID_PARAMS。",
    ),
  note: z
    .string()
    .max(2000, "note 过长(上限 2000 字)")
    .nullable()
    .optional()
    .describe("新备注。缺省 = 不改动;传 null = 清空备注。"),
  occurred_date: dateString("occurred_date").optional().describe("新发生日期 YYYY-MM-DD。缺省 = 不改动。"),
  type: entryTypeEnum.optional().describe(
    '新类型。缺省 = 不改动。改了 type 而原分类的 kind 与它不一致时返回 INVALID_PARAMS —— 请同时传 category_id=null 置为未分类。',
  ),
  ledger: ledgerEnum.optional().describe(
    "账本:**不可修改**(V7)。仅供读-改-写时原样回传;与现值相同幂等放行,与现值不同返回 DENIED(immutable)。",
  ),
  member_id: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "归属人:**不可修改**(V7),而且**它不是定位符**(定位靠 id)。仅供读-改-写时原样回传;" +
        "与现值相同(含别名/成员 id)幂等放行,与现值不同返回 DENIED(immutable)。",
    ),
});

export const deleteEntrySchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(40)
    .describe("记账记录 id,从 list_entries 的结果里原样复制。软删,可恢复;程序永远不接受模糊删除。"),
});

export const addCategorySchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "name 不能为空")
    .max(30, "name 过长(上限 30 字)")
    .describe('分类名,短名字(如"宠物")。支出与收入可以各有一个同名分类(如两个「其他」)。'),
  kind: entryTypeEnum.describe(
    '分类所属类型:"expense" = 支出分类(只能挂 type="expense" 的流水)、"income" = 收入分类。',
  ),
});

export const listCategoriesSchema = z.strictObject({
  kind: entryTypeEnum.optional().describe('只看某一类:"expense" 或 "income";缺省 = 两类都列(回执按支出/收入分组)。'),
});

export const restoreDeletedSchema = z.strictObject({
  kind: z.enum(["todo", "event", "entry"], {
    errorMap: () => ({
      message: `kind 只支持 "todo"(待办)、"event"(日程,整个系列及其实例)、"entry"(记账流水);收到的是其它值`,
    }),
  }).describe('要恢复的记录类型:"todo" = 待办,"event" = 日程(整个系列及其实例),"entry" = 记账流水。'),
  id: z
    .string()
    .min(1)
    .max(40)
    .describe('记录 id,原样使用 delete 回执里的 id(日程用系列 id,形如 e-…;实例 id 也接受)。'),
});

export type ListMembersArgs = z.infer<typeof listMembersSchema>;
export type AddTodoArgs = z.infer<typeof addTodoSchema>;
export type ListTodosArgs = z.infer<typeof listTodosSchema>;
export type CompleteTodoArgs = z.infer<typeof completeTodoSchema>;
export type UpdateTodoArgs = z.infer<typeof updateTodoSchema>;
export type ReopenTodoArgs = z.infer<typeof reopenTodoSchema>;
export type DeleteTodoArgs = z.infer<typeof deleteTodoSchema>;
export type AddEventArgs = z.infer<typeof addEventSchema>;
export type ListEventsArgs = z.infer<typeof listEventsSchema>;
export type UpdateEventArgs = z.infer<typeof updateEventSchema>;
export type DeleteEventArgs = z.infer<typeof deleteEventSchema>;
export type AddEntryArgs = z.infer<typeof addEntrySchema>;
export type ListEntriesArgs = z.infer<typeof listEntriesSchema>;
export type SummarizeEntriesArgs = z.infer<typeof summarizeEntriesSchema>;
export type UpdateEntryArgs = z.infer<typeof updateEntrySchema>;
export type DeleteEntryArgs = z.infer<typeof deleteEntrySchema>;
export type AddCategoryArgs = z.infer<typeof addCategorySchema>;
export type ListCategoriesArgs = z.infer<typeof listCategoriesSchema>;
export type RestoreDeletedArgs = z.infer<typeof restoreDeletedSchema>;

const IDENTITY_PARAM_HINT = "说话人由连接确定,本工具没有、也不接受任何身份参数。";

/** 把 zod 校验失败映射到 P2 协议:缺参 → MISSING_PARAMS,结构问题 → INVALID_PARAMS。 */
export function parseToolArgs<S extends z.ZodTypeAny>(
  schema: S,
  toolName: string,
  raw: unknown,
): { ok: true; args: z.output<S> } | { ok: false; envelope: Envelope } {
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return { ok: true, args: parsed.data };
  const issue = parsed.error.issues[0]!;
  const path = issue.path.join(".");
  const accepted = schema instanceof z.ZodObject ? Object.keys(schema.shape).join("、") : "";

  if (issue.code === "unrecognized_keys") {
    const unknownKeys = issue.keys;
    const looksLikeIdentity = unknownKeys.some((k) =>
      ["as_member", "asMember", "bind_key", "bindKey", "speaker", "caller", "whoami"].includes(k),
    );
    return {
      ok: false,
      envelope: failEnvelope("INVALID_PARAMS", {
        message: `工具 ${toolName} 不接受未知参数:${unknownKeys.join("、")}。${looksLikeIdentity ? IDENTITY_PARAM_HINT : ""}`,
        hint: accepted ? `可用参数:${accepted}。` : "本工具不接收任何参数。",
        field: unknownKeys[0],
      }),
    };
  }
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return {
      ok: false,
      envelope: failEnvelope("MISSING_PARAMS", {
        message: `缺少必填参数 ${path || "(参数)"}:${issue.message}`,
        hint: accepted ? `可用参数:${accepted}。` : undefined,
        missing: path ? [path] : [],
      }),
    };
  }
  return {
    ok: false,
    envelope: failEnvelope("INVALID_PARAMS", {
      message: `参数 ${path || "(参数)"} 有误:${issue.message}`,
      hint: accepted ? `可用参数:${accepted}。` : undefined,
      field: path || undefined,
    }),
  };
}
