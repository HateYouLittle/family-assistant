import type { Db } from "../src/db/db.js";
import { openDb } from "../src/db/db.js";
import { migrate } from "../src/db/migrations.js";
import { issueToken, type AuthResult } from "../src/domain/auth.js";
import { createMember, type MemberRow } from "../src/domain/members.js";
import type { Viewer } from "../src/domain/viewer.js";

export const TZ = "Asia/Shanghai";

/** 身份声明头的默认头名(与 config.ts 的 FA_IDENTITY_HEADER 默认值一致)。 */
export const IDENTITY_HEADER = "x-family-member";

export type FixtureKey = "mama" | "baba" | "kid";

export interface Fixture {
  db: Db;
  members: Record<FixtureKey, MemberRow>;
  tokens: Record<FixtureKey, string>;
  callers: Record<FixtureKey, Viewer>;
  /** 身份声明头的**正确值**(成员 id):HTTP 头只允许 ASCII,所以用 id 而不是中文名。 */
  identity: Record<FixtureKey, string>;
  /** 直连 /mcp 用的完整头:token + 身份声明头。 */
  headers: Record<FixtureKey, Record<string, string>>;
}

/** 每个测试一块独立的内存库:三名成员 + 各自的有效 token。 */
export function newFixture(): Fixture {
  const db = openDb(":memory:");
  migrate(db);
  const members = {
    mama: createMember(db, TZ, { name: "妈妈", aliases: ["老妈", "王丽"] }),
    baba: createMember(db, TZ, { name: "爸爸", aliases: ["老爸"] }),
    kid: createMember(db, TZ, { name: "小明", aliases: ["儿子"] }),
  };
  for (const r of Object.values(members)) {
    if (!r.ok) throw new Error("fixture 成员创建失败");
  }
  const m = {
    mama: members.mama.ok ? members.mama.member : null!,
    baba: members.baba.ok ? members.baba.member : null!,
    kid: members.kid.ok ? members.kid.member : null!,
  };
  const tokens = {
    mama: issueToken(db, m.mama.id, "test").token,
    baba: issueToken(db, m.baba.id, "test").token,
    kid: issueToken(db, m.kid.id, "test").token,
  };
  const callers = {
    mama: { memberId: m.mama.id, memberName: m.mama.name, source: "mcp" as const },
    baba: { memberId: m.baba.id, memberName: m.baba.name, source: "mcp" as const },
    kid: { memberId: m.kid.id, memberName: m.kid.name, source: "mcp" as const },
  };
  const identity = { mama: m.mama.id, baba: m.baba.id, kid: m.kid.id };
  return {
    db,
    members: m,
    tokens,
    callers,
    identity,
    headers: {
      mama: { Authorization: `Bearer ${tokens.mama}`, [IDENTITY_HEADER]: identity.mama },
      baba: { Authorization: `Bearer ${tokens.baba}`, [IDENTITY_HEADER]: identity.baba },
      kid: { Authorization: `Bearer ${tokens.kid}`, [IDENTITY_HEADER]: identity.kid },
    },
  };
}

export function assertAuthOk(r: AuthResult): Viewer {
  if (!r.ok) throw new Error(`期望认证成功,实际:${JSON.stringify(r.envelope)}`);
  return r.caller;
}
