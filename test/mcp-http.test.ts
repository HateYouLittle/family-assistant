import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db/db.js";
import { migrate } from "../src/db/migrations.js";
import { issueToken } from "../src/domain/auth.js";
import { createMember, type MemberRow } from "../src/domain/members.js";
import { buildHttpServer } from "../src/mcp/http.js";
import type { AppConfig } from "../src/config.js";

/**
 * Spike 01 端到端:真实 Streamable HTTP(无状态 + JSON 响应)上的
 * 身份闭环 —— S1/S2 的服务端部分、X9、S7(identity_mismatch)、X15。
 */

const config: AppConfig = {
  mcpHost: "127.0.0.1",
  mcpPort: 0, // listen 时用 0 = 随机端口
  dbPath: ":memory:",
  timezone: "Asia/Shanghai",
  identityHeader: "x-family-member",
};

let db: ReturnType<typeof openDb>;
let app: FastifyInstance;
let base: string;
let mama: MemberRow;
let baba: MemberRow;
let tokenMama: string;
let tokenBaba: string;

beforeEach(async () => {
  db = openDb(":memory:");
  migrate(db);
  const m = createMember(db, config.timezone, { name: "妈妈", aliases: ["老妈"] });
  const b = createMember(db, config.timezone, { name: "爸爸" });
  if (!m.ok || !b.ok) throw new Error("fixture 失败");
  mama = m.ok ? m.member : null!;
  baba = b.ok ? b.member : null!;
  tokenMama = issueToken(db, mama.id, "e2e").token;
  tokenBaba = issueToken(db, baba.id, "e2e").token;

  app = buildHttpServer(db, config);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("无法取得监听端口");
  base = `http://127.0.0.1:${addr.port}/mcp`;
});

afterEach(async () => {
  await app.close();
  db.close();
});

async function connect(headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers } }));
  return client;
}

function envelopeOf(result: unknown): { envelope: Record<string, unknown>; isError: boolean } {
  const r = result as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = r.content?.find((c) => c.type === "text")?.text ?? "";
  return { envelope: JSON.parse(text) as Record<string, unknown>, isError: r.isError === true };
}

describe("MCP HTTP 端到端", () => {
  it("有效 token:tools/list 暴露 4 个工具;list_members 走通", async () => {
    const client = await connect({ Authorization: `Bearer ${tokenMama}` });
    try {
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((t) => t.name).sort(),
        ["add_todo", "complete_todo", "list_members", "list_todos"],
      );
      const res = await client.callTool({ name: "list_members", arguments: {} });
      const { envelope, isError } = envelopeOf(res);
      assert.equal(isError, false);
      assert.equal(envelope.ok, true);
      assert.match(envelope.message as string, /家庭成员:妈妈\(别名:老妈\)、爸爸/);
    } finally {
      await client.close();
    }
  });

  it("S1/S2 服务端部分:两个 token 各记各的,互不串", async () => {
    const mamaClient = await connect({ Authorization: `Bearer ${tokenMama}` });
    const babaClient = await connect({ Authorization: `Bearer ${tokenBaba}` });
    try {
      await mamaClient.callTool({ name: "add_todo", arguments: { title: "妈妈的待办" } });
      await babaClient.callTool({ name: "add_todo", arguments: { title: "爸爸的待办" } });

      const mamaList = envelopeOf(await mamaClient.callTool({ name: "list_todos", arguments: {} }));
      const babaList = envelopeOf(await babaClient.callTool({ name: "list_todos", arguments: {} }));
      assert.match(mamaList.envelope.message as string, /妈妈的待办/);
      assert.doesNotMatch(mamaList.envelope.message as string, /爸爸的待办/);
      assert.match(babaList.envelope.message as string, /爸爸的待办/);
      assert.doesNotMatch(babaList.envelope.message as string, /妈妈的待办/);
    } finally {
      await mamaClient.close();
      await babaClient.close();
    }
  });

  it("S6 服务端部分:代记回执由服务端写出说话人", async () => {
    const babaClient = await connect({ Authorization: `Bearer ${tokenBaba}` });
    try {
      const add = envelopeOf(
        await babaClient.callTool({
          name: "add_todo",
          arguments: { owner: "妈妈", title: "交物业费", due_date: "2026-10-05" },
        }),
      );
      assert.equal(add.isError, false);
      assert.match(add.envelope.message as string, /仅 妈妈 可见,由 爸爸 代记/);
    } finally {
      await babaClient.close();
    }
  });

  it("X9:未知 token 调用 → DENIED(unknown_profile)", async () => {
    const client = await connect({ Authorization: "Bearer fam_not_a_token" });
    try {
      const res = await client.callTool({ name: "list_members", arguments: {} });
      const { envelope, isError } = envelopeOf(res);
      assert.equal(isError, true);
      assert.equal(envelope.code, "DENIED");
      assert.equal(envelope.reason, "unknown_profile");
    } finally {
      await client.close();
    }
  });

  it("S7:token 与身份声明头不一致 → DENIED(identity_mismatch)", async () => {
    // HTTP 头只允许 ASCII,声明头用成员 id
    const client = await connect({
      Authorization: `Bearer ${tokenBaba}`,
      "x-family-member": mama.id,
    });
    try {
      const res = await client.callTool({ name: "list_todos", arguments: {} });
      const { envelope, isError } = envelopeOf(res);
      assert.equal(isError, true);
      assert.equal(envelope.code, "DENIED");
      assert.equal(envelope.reason, "identity_mismatch");
    } finally {
      await client.close();
    }
  });

  it("X15 e2e:被诱导传 as_member → INVALID_PARAMS(未知字段)", async () => {
    const client = await connect({ Authorization: `Bearer ${tokenBaba}` });
    try {
      const res = await client.callTool({ name: "list_todos", arguments: { as_member: "妈妈" } });
      const { envelope, isError } = envelopeOf(res);
      assert.equal(isError, true);
      assert.equal(envelope.code, "INVALID_PARAMS");
      assert.equal(envelope.field, "as_member");
      assert.match(envelope.message as string, /说话人由连接确定/);
    } finally {
      await client.close();
    }
  });

  it("缺少必填参数 → MISSING_PARAMS;参数错误不抛协议异常", async () => {
    const client = await connect({ Authorization: `Bearer ${tokenMama}` });
    try {
      const res = await client.callTool({ name: "add_todo", arguments: {} });
      const { envelope, isError } = envelopeOf(res);
      assert.equal(isError, true);
      assert.equal(envelope.code, "MISSING_PARAMS");
      assert.deepEqual(envelope.missing, ["title"]);
    } finally {
      await client.close();
    }
  });
});
