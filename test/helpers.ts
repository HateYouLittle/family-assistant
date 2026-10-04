import type { Db } from "../src/db/db.js";
import { openDb } from "../src/db/db.js";
import { migrate } from "../src/db/migrations.js";
import { issueToken, type AuthResult } from "../src/domain/auth.js";
import { createMember, type Caller, type MemberRow } from "../src/domain/members.js";

export const TZ = "Asia/Shanghai";

export interface Fixture {
  db: Db;
  members: Record<"mama" | "baba" | "kid", MemberRow>;
  tokens: Record<"mama" | "baba" | "kid", string>;
  callers: Record<"mama" | "baba" | "kid", Caller>;
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
  return {
    db,
    members: m,
    tokens,
    callers: {
      mama: { memberId: m.mama.id, memberName: m.mama.name },
      baba: { memberId: m.baba.id, memberName: m.baba.name },
      kid: { memberId: m.kid.id, memberName: m.kid.name },
    },
  };
}

export function assertAuthOk(r: AuthResult): Caller {
  if (!r.ok) throw new Error(`期望认证成功,实际:${JSON.stringify(r.envelope)}`);
  return r.caller;
}
