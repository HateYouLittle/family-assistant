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

/** 别名归一化:去空白、去重(同一次输入里写两遍同一个别名不算冲突)。 */
export function normalizeAliases(input: readonly string[]): string[] {
  return [...new Set(input.map((a) => a.trim()).filter((a) => a !== ""))];
}

/**
 * **别名冲突的唯一判定**(建成员与改别名共用,S6b 管理页复用它)。
 *
 * 冲突 = 别名撞上**别人**的成员名或别名(`exceptId` 是本成员自己:改自己的别名时,
 * 自己名字相同不算冲突)。
 * 返回第一个冲突的别名,没有则 null。
 *
 * 为什么冲突必须响亮报错而不是先存着:别名是归属解析的一级(`resolveMemberRef`),
 * 两条记录共用一个别名会让日常说话直接变成 `AMBIGUOUS`,而**等发现时数据已经写错了**。
 * 所以"写进去之前"就要拦。
 */
function findAliasConflict(existing: MemberRow[], aliases: string[], exceptId: string | null): string | null {
  for (const alias of aliases) {
    const hit = existing.find((m) => m.id !== exceptId && (m.name === alias || m.aliases.includes(alias)));
    if (hit !== undefined) return alias;
  }
  return null;
}

/** 管理入口(不走 MCP):建成员。别名与现有成员的名称/别名冲突会响亮报错,避免日后归属解析歧义。 */
export function createMember(db: Db, timezone: string, input: CreateMemberInput):
  | { ok: true; member: MemberRow }
  | { ok: false; envelope: FailEnvelope } {
  const name = input.name.trim();
  const aliases = normalizeAliases(input.aliases ?? []);
  if (name === "") {
    return { ok: false, envelope: failEnvelope("MISSING_PARAMS", { message: "成员名不能为空。", missing: ["name"] }) };
  }
  const existing = listActiveMembers(db);
  if (existing.some((m) => m.name === name)) {
    return { ok: false, envelope: failEnvelope("INVALID_PARAMS", { message: `成员「${name}」已存在。`, field: "name" }) };
  }
  const clash = findAliasConflict(existing, aliases, null);
  if (clash !== null) {
    return {
      ok: false,
      envelope: failEnvelope("INVALID_PARAMS", {
        message: `别名「${clash}」与现有成员的名称或别名冲突,请换一个。`,
        field: "aliases",
      }),
    };
  }
  const id = generateId(db, "m", "member", timezone);
  db.prepare("INSERT INTO member (id, name, aliases, created_at) VALUES (?, ?, ?, ?)")
    .run(id, name, JSON.stringify(aliases), new Date().toISOString());
  return { ok: true, member: { id, name, aliases, created_at: new Date().toISOString(), deleted_at: null } };
}

/**
 * 管理入口(S6b 管理页用):**改别名**(整体替换该成员的别名列表)。
 *
 * 冲突判定复用 `findAliasConflict`(与建成员同一份规则),排除本成员自己 ——
 * 也就是说"把已软删成员的别名收回来"是允许的,而"抢别人的别名"响亮报错。
 *
 * 为什么放在 domain 而不是管理页:别名是**归属解析**的一部分(§4 的 X10),
 * 它的合法性属于业务规则。管理页与 CLI 都只是入口,谁在页面上另写一份
 * "看起来像冲突检查"的东西,下一次有人改别名就会绕过它。
 */
export function updateMemberAliases(db: Db, ref: string, inputAliases: readonly string[]):
  | { ok: true; member: MemberRow }
  | { ok: false; envelope: FailEnvelope } {
  const r = resolveMemberRef(db, ref);
  if (!r.ok) {
    return {
      ok: false,
      envelope: failEnvelope("NOT_FOUND", { message: `没有找到成员「${ref}」。`, id: ref }),
    };
  }
  const aliases = normalizeAliases(inputAliases);
  const clash = findAliasConflict(listActiveMembers(db), aliases, r.member.id);
  if (clash !== null) {
    return {
      ok: false,
      envelope: failEnvelope("INVALID_PARAMS", {
        message: `别名「${clash}」与现有成员的名称或别名冲突,请换一个。`,
        field: "aliases",
      }),
    };
  }
  setAliases(db, r.member.id, aliases);
  return { ok: true, member: { ...r.member, aliases } };
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
