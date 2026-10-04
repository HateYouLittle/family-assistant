import { createHash } from "node:crypto";
import { headerDisplayName, type AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { failEnvelope, type FailEnvelope } from "./envelope.js";
import { resolveMemberRef } from "./members.js";
import type { Viewer } from "./viewer.js";

/**
 * 身份解析(D13 / §3.2):说话人 = token 所属成员,与请求体里的任何字段无关。
 * 解析在领域层入口统一做一次,工具层不再重复实现;下游域模块只从 Viewer 取身份
 * (见 ./viewer.ts 的约定)。
 *
 * - 未知 / 已吊销 token、token 持有成员已软删 → DENIED(unknown_profile),不回落任何默认成员(V9 / X9)。
 * - 连接级身份声明头(如 X-Family-Member)**缺省即拒**(requireIdentityHeader,默认 true):
 *   声明头必填是 BUG B1 的处置——它原先"有则校验、无则跳过",于是"把爸爸的 token 装进
 *   妈妈的 profile 且漏写声明头"会 0 报错地以爸爸身份运行(§0.1 / S7)。
 * - 声明头与 token 所属成员不一致、或声明头值解析不出成员 → DENIED(identity_mismatch)。
 * - token 本体只存哈希:token 是高熵随机串,SHA-256 足够;scrypt/argon2 留给查看页口令。
 */
export type AuthResult =
  | { ok: true; caller: Viewer }
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

/** 声明头缺失(且配置为必填)时的拒绝:话术必须能直接转述给配置的人看。 */
function denyMissingIdentityHeader(headerName: string): AuthResult {
  return {
    ok: false,
    envelope: failEnvelope("DENIED", {
      reason: "identity_mismatch",
      message: "身份配置不完整:连接未声明身份。",
      hint:
        `该 profile 的 mcp_servers.family.headers 需要同时配置 token 与 ${headerName}: <成员 id>` +
        "(两个头缺一不可;只配 token 会让服务端无法确认这个连接是谁)。",
    }),
  };
}

/**
 * 声明头值解析不出成员 / 与 token 归属不一致时的统一拒绝。
 * `declaredName` 为 null 表示值本身解析不出成员——那种情况最常见的原因是填了中文
 * 成员名(HTTP 头只允许 ASCII,客户端会先报错),话术必须点明这一点。
 */
function denyIdentityMismatch(
  row: { member_name: string },
  declaredName: string | null,
  rawValue: string,
  headerName: string,
): AuthResult {
  const idHint = `声明头值应是成员 id(形如 m-261004-6bw9):${headerName} 只能放 ASCII,填中文成员名会在客户端先报错;`;
  if (declaredName === null) {
    return {
      ok: false,
      envelope: failEnvelope("DENIED", {
        reason: "identity_mismatch",
        message: `身份配置不一致:令牌属于 ${row.member_name},但连接声明为无法识别的标识「${rawValue}」。`,
        hint: `${idHint}该 id 必须在库里真实存在,可先用 list_members / 管理端 member list 核对;修正配置后重试。`,
      }),
    };
  }
  return {
    ok: false,
    envelope: failEnvelope("DENIED", {
      reason: "identity_mismatch",
      message: `身份配置不一致:令牌属于 ${row.member_name},但连接声明为 ${declaredName}。`,
      hint: `${idHint}token 与声明头必须属于同一位成员(当前是 ${row.member_name} 与 ${declaredName});修正配置后重试。`,
    }),
  };
}

export function authenticate(
  db: Db,
  config: Pick<AppConfig, "identityHeader" | "requireIdentityHeader">,
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

  const headerName = headerDisplayName(config.identityHeader);
  const declaredRaw = (identityHeaderValue ?? "").trim();

  // 连接级身份声明(默认必填):配错必须响亮失败,而不是静默串号(BUG B1)。
  if (declaredRaw === "") {
    if (config.requireIdentityHeader) return denyMissingIdentityHeader(headerName);
    // 不推荐:过渡期部署才用这个分支——退回"无声明头则跳过校验"的旧语义,
    // 等于把 B1 重新打开(妈妈的 profile 可能 0 报错地以爸爸身份运行)。
  } else {
    const declared = resolveMemberRef(db, declaredRaw);
    const declaredId = declared.ok ? declared.member.id : null;
    if (declaredId !== row.member_id) {
      return denyIdentityMismatch(row, declared.ok ? declared.member.name : null, declaredRaw, headerName);
    }
  }

  return { ok: true, caller: { memberId: row.member_id, memberName: row.member_name, source: "mcp" } };
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
