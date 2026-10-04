import type { Db } from "../db/db.js";
import { generateId } from "../db/id.js";
import {
  failEnvelope,
  okEnvelope,
  type Envelope,
  type FailEnvelope,
  type MemberCandidate,
} from "./envelope.js";

/**
 * 说话人上下文统一在 ./viewer.ts 定义(可见性 V1–V9 的唯一判定入口)。
 * 这里只做转出以兼容既有导入方,不再保留第二份定义。
 */
import type { Caller, Viewer } from "./viewer.js";
export type { Caller, Viewer };

export interface MemberRow {
  id: string;
  name: string;
  aliases: string[];
  created_at: string;
  deleted_at: string | null;
}

interface MemberDbRow {
  id: string;
  name: string;
  aliases: string;
  created_at: string;
  deleted_at: string | null;
}

function rowToMember(row: MemberDbRow): MemberRow {
  let aliases: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.aliases);
    if (Array.isArray(parsed)) aliases = parsed.filter((a): a is string => typeof a === "string");
  } catch {
    aliases = [];
  }
  return { id: row.id, name: row.name, aliases, created_at: row.created_at, deleted_at: row.deleted_at };
}

export function listActiveMembers(db: Db): MemberRow[] {
  const rows = db
    .prepare("SELECT id, name, aliases, created_at, deleted_at FROM member WHERE deleted_at IS NULL ORDER BY created_at, rowid")
    .all() as MemberDbRow[];
  return rows.map(rowToMember);
}

/** 供话术使用的成员名单文本:"妈妈、爸爸、小明"。 */
export function memberListText(db: Db): string {
  return listActiveMembers(db).map((m) => m.name).join("、") || "(尚无成员)";
}

export function candidatesOf(members: MemberRow[]): MemberCandidate[] {
  return members.map((m) => ({ name: m.name, aliases: m.aliases }));
}

export type MemberResolveResult =
  | { ok: true; member: MemberRow }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "ambiguous"; members: MemberRow[] };

/**
 * 归属目标解析(X10):精确 id → 精确成员名 → 精确别名。
 * 匹配不到 → not_found;别名命中多个成员 → ambiguous(附候选)。
 * 已软删成员视为不存在(不参与解析)。
 */
export function resolveMemberRef(db: Db, ref: string): MemberResolveResult {
  const refTrim = ref.trim();
  if (refTrim === "") return { ok: false, kind: "not_found" };
  const byId = db
    .prepare("SELECT id, name, aliases, created_at, deleted_at FROM member WHERE id = ? AND deleted_at IS NULL")
    .get(refTrim) as MemberDbRow | undefined;
  if (byId) return { ok: true, member: rowToMember(byId) };
  const byName = db
    .prepare("SELECT id, name, aliases, created_at, deleted_at FROM member WHERE name = ? AND deleted_at IS NULL")
    .get(refTrim) as MemberDbRow | undefined;
  if (byName) return { ok: true, member: rowToMember(byName) };
  // 别名可能撞车(两条记录都登记了同一个别名)→ AMBIGUOUS
  const rows = db
    .prepare("SELECT id, name, aliases, created_at, deleted_at FROM member WHERE deleted_at IS NULL")
    .all() as MemberDbRow[];
  const hits = rows.map(rowToMember).filter((m) => m.aliases.includes(refTrim));
  if (hits.length === 1) return { ok: true, member: hits[0]! };
  if (hits.length > 1) return { ok: false, kind: "ambiguous", members: hits };
  return { ok: false, kind: "not_found" };
}

/** 把 resolveMemberRef 的失败翻译成协议信封(X10:MISSING_PARAMS + 成员名单 / AMBIGUOUS + 候选)。 */
export function resolveMemberOrEnvelope(db: Db, ref: string):
  | { ok: true; member: MemberRow }
  | { ok: false; envelope: FailEnvelope } {
  const r = resolveMemberRef(db, ref);
  if (r.ok) return { ok: true, member: r.member };
  if (r.kind === "not_found") {
    return {
      ok: false,
      envelope: failEnvelope("MISSING_PARAMS", {
        message: `没有找到成员「${ref}」。家庭成员有:${memberListText(db)}。`,
        hint: "先调 list_members 获取成员名单与别名,再传准确的成员名或 id。",
        missing: ["owner"],
      }),
    };
  }
  return {
    ok: false,
    envelope: failEnvelope("AMBIGUOUS", {
      message: `「${ref}」匹配到多位成员,请指明具体是谁:${r.members.map((m) => m.name).join("、")}。`,
      hint: "列出候选成员让用户确认,确认后重试。",
      candidates: candidatesOf(r.members),
    }),
  };
}

export interface CreateMemberInput {
  name: string;
  aliases?: string[];
}

/** 管理入口(不走 MCP):建成员。别名与现有成员的名称/别名冲突会响亮报错,避免日后归属解析歧义。 */
export function createMember(db: Db, timezone: string, input: CreateMemberInput):
  | { ok: true; member: MemberRow }
  | { ok: false; envelope: FailEnvelope } {
  const name = input.name.trim();
  const aliases = [...new Set((input.aliases ?? []).map((a) => a.trim()).filter((a) => a !== ""))];
  if (name === "") {
    return { ok: false, envelope: failEnvelope("MISSING_PARAMS", { message: "成员名不能为空。", missing: ["name"] }) };
  }
  const existing = listActiveMembers(db);
  if (existing.some((m) => m.name === name)) {
    return { ok: false, envelope: failEnvelope("INVALID_PARAMS", { message: `成员「${name}」已存在。`, field: "name" }) };
  }
  for (const alias of aliases) {
    if (existing.some((m) => m.name === alias || m.aliases.includes(alias))) {
      return {
        ok: false,
        envelope: failEnvelope("INVALID_PARAMS", {
          message: `别名「${alias}」与现有成员的名称或别名冲突,请换一个。`,
          field: "aliases",
        }),
      };
    }
  }
  const id = generateId(db, "m", "member", timezone);
  db.prepare("INSERT INTO member (id, name, aliases, created_at) VALUES (?, ?, ?, ?)")
    .run(id, name, JSON.stringify(aliases), new Date().toISOString());
  return { ok: true, member: { id, name, aliases, created_at: new Date().toISOString(), deleted_at: null } };
}

/** 成员一律软删(§4);软删后其 token 一并失效(authenticate 里按 deleted_at 判定)。 */
export function softDeleteMember(db: Db, ref: string):
  | { ok: true; member: MemberRow }
  | { ok: false; envelope: FailEnvelope } {
  const r = resolveMemberRef(db, ref);
  if (!r.ok) {
    return {
      ok: false,
      envelope: failEnvelope("NOT_FOUND", { message: `没有找到成员「${ref}」。`, id: ref }),
    };
  }
  db.prepare("UPDATE member SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), r.member.id);
  return { ok: true, member: { ...r.member, deleted_at: new Date().toISOString() } };
}

export function setAliases(db: Db, memberId: string, aliases: string[]): void {
  db.prepare("UPDATE member SET aliases = ? WHERE id = ?").run(JSON.stringify(aliases), memberId);
}

export function listMembersEnvelope(_db: Db, _viewer: Viewer): Envelope {
  const members = listActiveMembers(_db);
  const text = members
    .map((m) => (m.aliases.length > 0 ? `${m.name}(别名:${m.aliases.join("、")})` : m.name))
    .join("、");
  return okEnvelope(
    { members: members.map((m) => ({ id: m.id, name: m.name, aliases: m.aliases })) },
    `家庭成员:${text || "(尚无成员)"}。`,
  );
}
