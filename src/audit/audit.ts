import type { Db } from "../db/db.js";
import type { Envelope } from "../domain/envelope.js";
import type { Viewer } from "../domain/viewer.js";

/**
 * 审计日志(设计方案 §6):**append-only**,只记写操作。
 *
 * 存在理由是 R1(身份配错)与 R6(脏数据)的兜底:回执只能让当事人当场发现,
 * 审计让事后追溯成为可能(谁、什么时候、用哪个工具、改了什么、结果如何)。
 *
 * 三条纪律:
 * 1. **只追加**:本文件只提供 INSERT;全仓库不提供任何 UPDATE / DELETE audit_log
 *    的入口(删除审计等于没有审计)。
 * 2. **只记关键字段的元数据**:调用方(工具层)负责挑字段,自由文本(notes 等)不进表——
 *    不把私账内容再复制一份(§6 原话)。
 * 3. **member_id 记连接身份**:取自 Viewer(服务端从 token 解析),
 *    不是任何参数,因此审计记录无法被调用方伪造。
 *
 * 记录点统一在工具层入口(src/mcp/tools.ts 的调用封装),不散进各 domain 函数;
 * 读操作不记。
 */

/** args_summary 的最大长度:超长截断,避免审计表被长文本撑大。 */
export const AUDIT_ARGS_MAX = 200;

/** 成功时的 result_code:与信封 code 区分开,便于管理页按码筛。 */
export const AUDIT_OK_CODE = "OK";

export interface AuditRow {
  id: number;
  at: string;
  member_id: string;
  member_name: string;
  tool: string;
  args_summary: string;
  result_code: string;
  ok: boolean;
}

/** 记录一条写操作审计。审计失败不得影响业务结果,故不向上抛错。 */
export function recordAudit(
  db: Db,
  viewer: Viewer,
  tool: string,
  argsSummary: string,
  envelope: Envelope,
): void {
  const ok = envelope.ok;
  db.prepare(`
    INSERT INTO audit_log (at, member_id, member_name, tool, args_summary, result_code, ok)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    viewer.memberId,
    viewer.memberName,
    tool,
    argsSummary.length > AUDIT_ARGS_MAX ? `${argsSummary.slice(0, AUDIT_ARGS_MAX - 1)}…` : argsSummary,
    ok ? AUDIT_OK_CODE : envelope.code,
    ok ? 1 : 0,
  );
}

/** 管理页/CLI 用:按时间倒序读最近 N 条。 */
export function listAudit(db: Db, limit = 50): AuditRow[] {
  const rows = db
    .prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
    .all(limit) as (Omit<AuditRow, "ok"> & { ok: number })[];
  return rows.map((r) => ({ ...r, ok: r.ok !== 0 }));
}