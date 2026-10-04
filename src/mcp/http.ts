import Fastify, { type FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { authenticate } from "../domain/auth.js";
import { buildMcpServer } from "./server.js";

/**
 * HTTP 门面:同一进程只开一个口,绑定 127.0.0.1(D2)。
 * /mcp 走 Streamable HTTP;无状态模式(sessionIdGenerator=undefined)
 * 且 enableJsonResponse:每个请求独立解析身份,响应以普通 JSON 返回。
 */
export function buildHttpServer(db: Db, config: AppConfig): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.FA_LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization"],
    },
  });

  app.get("/", async () => ({
    name: "family-assistant",
    mcp: `http://${config.mcpHost}:${config.mcpPort}/mcp`,
    note: "MCP 端点仅监听回环地址;请用 MCP 客户端(如 Hermes)访问 /mcp。",
  }));

  app.all("/mcp", async (req, reply) => {
    reply.hijack();
    const identityHeader = req.headers[config.identityHeader];
    const auth = authenticate(
      db,
      config,
      req.headers.authorization,
      Array.isArray(identityHeader) ? identityHeader[0] : identityHeader,
    );
    const server = buildMcpServer(db, config, auth);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  return app;
}

export async function startServer(db: Db, config: AppConfig): Promise<FastifyInstance> {
  const app = buildHttpServer(db, config);
  await app.listen({ port: config.mcpPort, host: config.mcpHost });
  return app;
}
