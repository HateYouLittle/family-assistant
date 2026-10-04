import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createMember,
  listMembersEnvelope,
  resolveMemberRef,
} from "../src/domain/members.js";
import { newFixture, TZ, type Fixture } from "./helpers.js";

let f: Fixture;
afterEach(() => f?.db.close());

describe("成员域:归属目标解析(供 owner 参数;不是身份)", () => {
  it("精确 id → 精确名 → 精确别名,三级解析", () => {
    f = newFixture();
    assert.equal(resolveMemberRef(f.db, f.members.mama.id).ok, true);
    const byName = resolveMemberRef(f.db, "妈妈");
    assert.ok(byName.ok && byName.member.id === f.members.mama.id);
    const byAlias = resolveMemberRef(f.db, "老妈");
    assert.ok(byAlias.ok && byAlias.member.id === f.members.mama.id);
  });

  it("匹配不到 → not_found(X10 前置)", () => {
    f = newFixture();
    const r = resolveMemberRef(f.db, "妈");
    assert.deepEqual(r, { ok: false, kind: "not_found" });
  });

  it("别名命中多个成员 → ambiguous 附候选(X10)", () => {
    f = newFixture();
    // 绕过 createMember 的防歧义校验,直接造出"两个成员共用别名"的脏数据
    // (不能用"老妈":那是妈妈自己的别名)
    for (const id of [f.members.baba.id, f.members.kid.id]) {
      f.db.prepare("UPDATE member SET aliases = ? WHERE id = ?").run(JSON.stringify(["二叔"]), id);
    }
    const r = resolveMemberRef(f.db, "二叔");
    assert.ok(!r.ok && r.kind === "ambiguous");
    if (r.kind === "ambiguous") {
      assert.equal(r.members.length, 2);
      assert.deepEqual(r.members.map((m) => m.name).sort(), ["小明", "爸爸"]);
    }
  });

  it("已软删成员不参与解析", () => {
    f = newFixture();
    softDeleteMama(f);
    assert.deepEqual(resolveMemberRef(f.db, "妈妈"), { ok: false, kind: "not_found" });
    assert.deepEqual(resolveMemberRef(f.db, "老妈"), { ok: false, kind: "not_found" });
  });
});

describe("成员管理入口(CLI 用)", () => {
  it("createMember:重名/别名冲突响亮报错", () => {
    f = newFixture();
    assert.ok(!createMember(f.db, TZ, { name: "妈妈" }).ok);
    const clash = createMember(f.db, TZ, { name: "小王", aliases: ["老妈"] });
    assert.ok(!clash.ok);
    if (!clash.ok) assert.equal(clash.envelope.code, "INVALID_PARAMS");
  });

  it("createMember:别名与现有成员名冲突也会报错", () => {
    f = newFixture();
    assert.ok(!createMember(f.db, TZ, { name: "老王", aliases: ["爸爸"] }).ok);
  });

  it("软删后允许再次创建同名成员(部分唯一索引)", () => {
    f = newFixture();
    softDeleteMama(f);
    const again = createMember(f.db, TZ, { name: "妈妈" });
    assert.ok(again.ok);
  });

  it("listMembersEnvelope:含别名,排除已删成员", () => {
    f = newFixture();
    softDeleteMama(f);
    const env = listMembersEnvelope(f.db, f.callers.kid);
    assert.ok(env.ok);
    if (env.ok) {
      const data = env.data as { members: { name: string }[] };
      assert.deepEqual(data.members.map((m) => m.name), ["爸爸", "小明"]);
      assert.match(env.message, /家庭成员:爸爸\(别名:老爸\)、小明\(别名:儿子\)/);
    }
  });
});

function softDeleteMama(f: Fixture): void {
  const r = resolveMemberRef(f.db, f.members.mama.id);
  assert.ok(r.ok);
  f.db.prepare("UPDATE member SET deleted_at = ? WHERE id = ?").run("2026-10-04T00:00:00Z", f.members.mama.id);
}
