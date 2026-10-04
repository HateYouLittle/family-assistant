import { recordAudit } from "../audit/audit.js";
import type { Db } from "../db/db.js";
import type { Envelope } from "../domain/envelope.js";
import { ADMIN_AUDIT_MEMBER_ID, ADMIN_AUDIT_MEMBER_NAME } from "../web/admin-auth.js";

/**
 * 管理端写操作的审计(设计方案 §6「审计日志」)。
 *
 * ## 身份:固定保留字 `__admin__` / `管理员`
 * 审计表 `audit_log.member_id` 是 `TEXT NOT NULL`,而管理端**没有家庭成员身份**
 * ——运维不是爸爸也不是妈妈。S6b 的裁决是**用固定标识**,绝不挑一个成员来背锅:
 * 伪造身份会把 R1(配置写错)唯一的追溯机制变成谎话("妈妈软删了爸爸"其实是运维点的按钮)。
 * 见 `ADMIN_AUDIT_MEMBER_ID` 的注释。
 *
 * ## 这一层**只追加**,与 `../audit/audit.ts` 同一条纪律
 * 全仓库不存在任何 audit_log 的 UPDATE/DELETE 入口(test/audit.test.ts 会 grep 断言),
 * 这里也只包 `recordAudit`。
 *
 * ## 记什么、不记什么
 * 记:操作名 + **非自由文本的关键标识**(成员名/id、token id、分类 kind) + 结果码。
 * 不记:**token 明文**、**任何口令(包括哈希)**、备注类自由文本(§6 原话:
 * "只记元数据与关键字段,不记全文")。这条由构造调用方保证:`argsSummary` 是
 * 每个路由显式拼的字符串,里面只允许出现标识,不允许出现凭据。
 * `ADMIN_ARG_VALUE_MAX` 与 `recordAudit` 自己的 `AUDIT_ARGS_MAX` 双重截断。
 */

/** 单个标识值在审计摘要里的最大长度(整体长度另有 `AUDIT_ARGS_MAX` 兜底)。 */
export const ADMIN_ARG_VALUE_MAX = 40;

/** 管理端审计用的固定身份。 */
export const ADMIN_AUDIT_IDENTITY = {
  memberId: ADMIN_AUDIT_MEMBER_ID,
  memberName: ADMIN_AUDIT_MEMBER_NAME,
} as const;

/** 把一个标识值写进审计摘要:超长截断加省略号。 */
export function auditValue(value: string): string {
  return value.length > ADMIN_ARG_VALUE_MAX ? `${value.slice(0, ADMIN_ARG_VALUE_MAX - 1)}…` : value;
}

/**
 * 记一条管理端操作审计。
 *
 * `tool` 用 `admin.<动作>` 前缀:审计页上一眼能把它与 MCP 工具调用分开,
 * 排查"这条数据是谁动的"时不必逐行辨认。
 *
 * 入参是**信封**:成功失败都记(配错导致的失败正是最该被追溯的,与工具层同一条纪律)。
 * 少数没有信封的管理动作(吊销 token、重置口令)由调用方用 `okEnvelope` 包一个成功信封。
 */
export function recordAdminAudit(db: Db, tool: string, argsSummary: string, envelope: Envelope): void {
  // recordAudit 要的是 Viewer;管理端固定身份用最小形状构造(source 只是审计/排查用,
  // 不参与任何可见性判定,见 src/domain/viewer.ts 约定 4)。
  recordAudit(
    db,
    { memberId: ADMIN_AUDIT_IDENTITY.memberId, memberName: ADMIN_AUDIT_IDENTITY.memberName, source: "web" },
    `admin.${tool}`,
    argsSummary,
    envelope,
  );
}