import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { authenticate, extractBearerToken, hashToken, issueToken, revokeToken } from "../src/domain/auth.js";
import { newFixture, type Fixture } from "./helpers.js";

const IDENTITY_HEADER = "x-family-member";

let f: Fixture;
afterEach(() => f?.db.close());

function auth(authHeader?: string, identity?: string) {
  return authenticate(f.db, { identityHeader: IDENTITY_HEADER }, authHeader, identity);
}

describe("authenticate:token → 成员(D13/V9)", () => {
  it("有效 token 解析出正确成员", () => {
    f = newFixture();
    const r = auth(`Bearer ${f.tokens.mama}`);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.caller.memberId, f.members.mama.id);
      assert.equal(r.caller.memberName, "妈妈");
    }
  });

  it("缺失 / 非 Bearer / 未知 token → DENIED(unknown_profile),不回落默认成员(X9/V9)", () => {
    f = newFixture();
    for (const header of [undefined, "", "Token abc", "Bearer", "Bearer ", "Bearer fam_nosuchtoken"]) {
      const r = auth(header);
      assert.ok(!r.ok);
      if (!r.ok) {
        assert.equal(r.envelope.code, "DENIED");
        assert.equal(r.envelope.reason, "unknown_profile");
      }
    }
  });

  it("已吊销 token → unknown_profile", () => {
    f = newFixture();
    const issued = issueToken(f.db, f.members.mama.id, "rotate");
    assert.ok(revokeToken(f.db, issued.id));
    const r = auth(`Bearer ${issued.token}`);
    assert.ok(!r.ok);
    assert.ok(!r.ok && r.envelope.reason === "unknown_profile");
    // 吊销不影响他人 token
    assert.ok(auth(`Bearer ${f.tokens.mama}`).ok);
  });

  it("token 持有成员被软删 → token 一并失效(§4)", () => {
    f = newFixture();
    f.db.prepare("UPDATE member SET deleted_at = ? WHERE id = ?").run("2026-10-04T00:00:00Z", f.members.mama.id);
    const r = auth(`Bearer ${f.tokens.mama}`);
    assert.ok(!r.ok && r.envelope.reason === "unknown_profile");
  });

  it("身份声明头与 token 一致 → 放行", () => {
    f = newFixture();
    const r = auth(`Bearer ${f.tokens.mama}`, "妈妈");
    assert.ok(r.ok);
  });

  it("身份声明头与 token 不一致 → DENIED(identity_mismatch)(S7:配错必须响亮失败)", () => {
    f = newFixture();
    const r = auth(`Bearer ${f.tokens.baba}`, "妈妈");
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.equal(r.envelope.code, "DENIED");
      assert.equal(r.envelope.reason, "identity_mismatch");
      assert.match(r.envelope.message, /令牌属于 爸爸/);
      assert.match(r.envelope.message, /连接声明为 妈妈/);
    }
  });

  it("身份声明头是无法识别的成员 → identity_mismatch", () => {
    f = newFixture();
    const r = auth(`Bearer ${f.tokens.mama}`, "陌生人");
    assert.ok(!r.ok && r.envelope.reason === "identity_mismatch");
  });

  it("token 只存哈希;提取器解析 Bearer", () => {
    f = newFixture();
    const row = f.db.prepare("SELECT token_hash FROM api_token WHERE member_id = ?").get(f.members.mama.id) as {
      token_hash: string;
    };
    assert.equal(row.token_hash, hashToken(f.tokens.mama));
    assert.notEqual(row.token_hash, f.tokens.mama);
    assert.equal(extractBearerToken("Bearer  fam_x y "), "fam_x y");
  });
});
