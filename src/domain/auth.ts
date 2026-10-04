import { createHash } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { failEnvelope, type FailEnvelope } from "./envelope.js";
import { resolveMemberRef, type Caller } from "./members.js";

/**
 * 身份解析(D13 / §3.2):说话人 = token 所属成员,与请求体里的任何字段无关。
 * 解析在领域层入口统一做一次,工具层不再重复实现。
 *
 * - 未知 / 已吊销 token、token 持有成员已软删 → DENIED(unknown_profile),不回落任何默认成员(V9 / X9)。
 * - 连接级身份声明头(如 X-Family-Member)与 token 所属成员不一致 → DENIED(identity_mismatch)(§0.1 / S7):
 *   这是"把爸爸的 token 装进妈妈的 profile"时唯一的响亮失败通道。
 * - token 本体只存哈希:token 是高熵随机串,SHA-256 足够;scrypt/argon2 留给查看页口令。
 */
export type AuthResult =
  | { ok: true; caller: Caller }
  | { ok: false; envelope: FailEnvelope };

function denyUnknownProfile(): AuthResult {
  return {
    ok: false,
    envelope: failEnvelope("DENIED", {
      reason: "unknown_profile",
      message: "无法确认调用身份:令牌缺失、未注册或已吊销。",
      hint: "检查该 Hermes profile 的 mcp_servers.family.headers.Authorization 是否为本成员的有效 token;必要时在管理端重新生成并更新配置。",
    }),
  };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!m) return null;
  const token = m[1]!.trim();
  return token === "" ? null : token;
}

export function authenticate(
  db: Db,
  config: Pick<AppConfig, "identityHeader">,
  authHeader: string | undefined,
  identityHeaderValue: string | undefined,
): AuthResult {
  const token = extractBearerToken(authHeader);
  if (!token) return denyUnknownProfile();

  const row = db
    .prepare(`
      SELECT t.revoked_at, m.id AS member_id, m.name AS member_name, m.deleted_at AS member_deleted_at
      FROM api_token t JOIN member m ON m.id = t.member_id
      WHERE t.token_hash = ?
    `)
    .get(hashToken(token)) as
    | { revoked_at: string | null; member_id: string; member_name: string; member_deleted_at: string | null }
    | undefined;

  if (!row || row.revoked_at !== null || row.member_deleted_at !== null) {
    return denyUnknownProfile();
  }

  // 连接级身份声明(可选):配置了就必须一致,把配错变成响亮失败而不是静默串号。
  if (identityHeaderValue !== undefined && identityHeaderValue.trim() !== "") {
    const declared = resolveMemberRef(db, identityHeaderValue.trim());
    const declaredId = declared.ok ? declared.member.id : null;
    if (declaredId !== row.member_id) {
      const declaredName = declared.ok
        ? declared.member.name
        : `无法识别的标识「${identityHeaderValue.trim()}」`;
      return {
        ok: false,
        envelope: failEnvelope("DENIED", {
          reason: "identity_mismatch",
          message: `身份配置不一致:令牌属于 ${row.member_name},但连接声明为 ${declaredName}。`,
          hint: "检查该 Hermes profile 的 token 与身份声明头是否属于同一位成员;修正配置后重试。",
        }),
      };
    }
  }

  return { ok: true, caller: { memberId: row.member_id, memberName: row.member_name } };
}

export interface IssuedToken {
  id: string;
  token: string; // 明文只在生成这一次返回
  member_id: string;
  label: string;
  created_at: string;
}

/** 管理入口(不走 MCP):为成员生成 family token,明文只显示一次,库中只存哈希。 */
export function issueToken(db: Db, memberId: string, label: string): IssuedToken {
  const token = `fam_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`;
  const now = new Date().toISOString();
  const id = `tok_${Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("base64url")}`;
  db.prepare("INSERT INTO api_token (id, member_id, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, memberId, label, hashToken(token), now);
  return { id, token, member_id: memberId, label, created_at: now };
}

export function revokeToken(db: Db, tokenId: string): boolean {
  const r = db.prepare("UPDATE api_token SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), tokenId);
  return r.changes > 0;
}

export interface TokenRow {
  id: string;
  member_id: string;
  member_name: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
}

export function listTokens(db: Db, memberId?: string): TokenRow[] {
  const sql = `
    SELECT t.id, t.member_id, m.name AS member_name, t.label, t.created_at, t.revoked_at
    FROM api_token t JOIN member m ON m.id = t.member_id
    ${memberId ? "WHERE t.member_id = ?" : ""}
    ORDER BY t.created_at, t.id
  `;
  return (memberId ? db.prepare(sql).all(memberId) : db.prepare(sql).all()) as TokenRow[];
}
