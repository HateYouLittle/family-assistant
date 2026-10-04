import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { authenticate, extractBearerToken, hashToken, issueToken, revokeToken } from "../src/domain/auth.js";
import { loadConfig } from "../src/config.js";
import { IDENTITY_HEADER, newFixture, type Fixture } from "./helpers.js";

let f: Fixture;
afterEach(() => f?.db.close());

/** 默认语义:身份声明头必填(requireIdentityHeader=true)。 */
function auth(authHeader?: string, identity?: string) {
  return authenticate(f.db, { identityHeader: IDENTITY_HEADER, requireIdentityHeader: true }, authHeader, identity);
}

describe("authenticate:token → 成员(D13/V9)", () => {
  it("有效 token + 匹配的声明头 → 解析出正确成员", () => {
    f = newFixture();
    const r = auth(`Bearer ${f.tokens.mama}`, f.identity.mama);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.caller.memberId, f.members.mama.id);
      assert.equal(r.caller.memberName, "妈妈");
      assert.equal(r.caller.source, "mcp");
    }
  });

  it("缺失 / 非 Bearer / 未知 token → DENIED(unknown_profile),不回落默认成员(X9/V9)", () => {
    f = newFixture();
    for (const header of [undefined, "", "Token abc", "Bearer", "Bearer ", "Bearer fam_nosuchtoken"]) {
      const r = auth(header, f.identity.mama);
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
    const r = auth(`Bearer ${issued.token}`, f.identity.mama);
    assert.ok(!r.ok);
    assert.ok(!r.ok && r.envelope.reason === "unknown_profile");
    // 吊销不影响他人 token
    assert.ok(auth(`Bearer ${f.tokens.mama}`, f.identity.mama).ok);
  });

  it("token 持有成员被软删 → token 一并失效(§4)", () => {
    f = newFixture();
    f.db.prepare("UPDATE member SET deleted_at = ? WHERE id = ?").run("2026-10-04T00:00:00Z", f.members.mama.id);
    const r = auth(`Bearer ${f.tokens.mama}`, f.identity.mama);
    assert.ok(!r.ok && r.envelope.reason === "unknown_profile");
  });

  it("身份声明头与 token 一致 → 放行", () => {
    f = newFixture();
    // 成员名、别名、id 都能解析(X10 的解析顺序);HTTP 头只能用 id,值语义一致。
    for (const declared of [f.members.mama.id, "妈妈", "老妈", "王丽"]) {
      assert.ok(auth(`Bearer ${f.tokens.mama}`, declared).ok, `声明值「${declared}」应当放行`);
    }
  });

  it("身份声明头与 token 不一致 → DENIED(identity_mismatch)(S7:配错必须响亮失败)", () => {
    f = newFixture();
    const r = auth(`Bearer ${f.tokens.baba}`, f.identity.mama);
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
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.equal(r.envelope.reason, "identity_mismatch");
      assert.match(r.envelope.message, /无法识别的标识「陌生人」/);
    }
  });
});

describe("BUG B1:身份声明头必填(缺声明头不再静默串号)", () => {
  it("缺声明头 → DENIED(identity_mismatch),而不是静默以 token 身份运行", () => {
    f = newFixture();
    const r = auth(`Bearer ${f.tokens.mama}`, undefined);
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.equal(r.envelope.code, "DENIED");
      assert.equal(r.envelope.reason, "identity_mismatch");
      assert.match(r.envelope.message, /身份配置不完整:连接未声明身份/);
      assert.match(r.envelope.hint ?? "", /mcp_servers\.family\.headers/);
      assert.match(r.envelope.hint ?? "", /X-Family-Member: <成员 id>/);
    }
  });

  it("声明头为空串 / 纯空白 → 同样按缺声明头拒绝", () => {
    f = newFixture();
    for (const declared of ["", "   "]) {
      const r = auth(`Bearer ${f.tokens.mama}`, declared);
      assert.ok(!r.ok && r.envelope.reason === "identity_mismatch", `声明值「${declared}」应当被拒`);
    }
  });

  it("B1 原始场景:爸爸的 token 装进妈妈的 profile 且不写声明头 → 响亮失败", () => {
    f = newFixture();
    // 先记一条妈妈的待办,证明"爸爸的 token + 妈妈的 profile"确实认成了爸爸
    f.db
      .prepare("INSERT INTO todo (id, owner_id, title, created_by, created_at) VALUES ('t-x', ?, '爸爸的待办', ?, '')")
      .run(f.members.baba.id, f.members.baba.id);
    const r = auth(`Bearer ${f.tokens.baba}`, undefined);
    assert.ok(!r.ok, "妈妈的 profile 未声明身份时必须拒绝,不能静默以爸爸身份运行");
  });

  it("声明头值无法解析时,话术点明'应是成员 id'+ HTTP 头只能放 ASCII", () => {
    f = newFixture();
    const r = auth(`Bearer ${f.tokens.mama}`, "不存在的人");
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.equal(r.envelope.reason, "identity_mismatch");
      const hint = r.envelope.hint ?? "";
      assert.match(hint, /成员 id\(形如 m-\d{6}-[a-z2-9]{4}\)/);
      assert.match(hint, /ASCII/);
    }
  });

  it("requireIdentityHeader=false(过渡配置,不推荐)+ 无声明头 → 放行", () => {
    f = newFixture();
    const r = authenticate(
      f.db,
      { identityHeader: IDENTITY_HEADER, requireIdentityHeader: false },
      `Bearer ${f.tokens.mama}`,
      undefined,
    );
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.caller.memberId, f.members.mama.id);
      assert.equal(r.caller.source, "mcp");
    }
  });

  it("requireIdentityHeader=false 但声明头存在时仍然校验(过渡配置不是免检)", () => {
    f = newFixture();
    const r = authenticate(
      f.db,
      { identityHeader: IDENTITY_HEADER, requireIdentityHeader: false },
      `Bearer ${f.tokens.baba}`,
      f.identity.mama,
    );
    assert.ok(!r.ok && r.envelope.reason === "identity_mismatch");
  });

  it("自定义头名照样必填(FA_IDENTITY_HEADER 改了名字也生效)", () => {
    f = newFixture();
    const config = { identityHeader: "x-who", requireIdentityHeader: true };
    assert.ok(authenticate(f.db, config, `Bearer ${f.tokens.mama}`, f.identity.mama).ok);
    const missing = authenticate(f.db, config, `Bearer ${f.tokens.mama}`, undefined);
    assert.ok(!missing.ok);
    if (!missing.ok) assert.match(missing.envelope.hint ?? "", /X-Who: <成员 id>/);
  });
});

describe("loadConfig:FA_REQUIRE_IDENTITY_HEADER", () => {
  it("缺省为 true(B1 的修复默认打开)", () => {
    assert.equal(loadConfig({}).requireIdentityHeader, true);
  });

  it("可用 0/false 关闭过渡;非法值响亮报错", () => {
    for (const raw of ["0", "false", "no", "off"]) {
      const c = loadConfig({ FA_REQUIRE_IDENTITY_HEADER: raw } as NodeJS.ProcessEnv);
      assert.equal(c.requireIdentityHeader, false, raw);
    }
    assert.equal(loadConfig({ FA_REQUIRE_IDENTITY_HEADER: "1" } as NodeJS.ProcessEnv).requireIdentityHeader, true);
    assert.throws(
      () => loadConfig({ FA_REQUIRE_IDENTITY_HEADER: "偶尔" } as NodeJS.ProcessEnv),
      /环境变量配置有误/,
    );
  });
});

describe("token 存储与提取", () => {
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