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

/**
 * 最近一次 `/mcp` 请求到达的时刻(进程内内存,S6b 管理页健康状态只读展示)。
 *
 * **为什么需要它**:管理页健康状态里有"cron 最近一次投递结果"这一项,而
 * **投递由 Hermes cron 承担**(设计 D7 / 非目标 N3)——本程序零推送代码、也从不调用
 * Hermes,所以它**没有任何投递记录**可查(真去读 Hermes 的 cron 目录就是跨组件耦合,
 * 设计 OQ7 已明确顺延)。能诚实给出的只有一个**间接信号**:这个端点最近有没有被调用过。
 * cron 任务的 prompt 会调 `get_today()`(设计 §3.3),它必然经过 `/mcp` ——
 * 于是"最后一次 /mcp 请求"是"定时任务还在不在跑"最便宜的可观测点。
 *
 * 它**不是**投递结果:页面上必须这么标注(见 src/web/health.ts),否则就成了谎报。
 * 只在内存里:丢了最坏结果是健康页少一个时间戳,不值得为它建表。
 */
let lastMcpRequestAt: number | null = null;

/** 记一次 /mcp 请求到达(由下面的路由调用;管理页只读它)。 */
function markMcpRequest(now: number = Date.now()): void {
  lastMcpRequestAt = now;
}

/** 最近一次 /mcp 请求时刻(epoch ms);本进程还没收到过任何请求则为 null。测试可重置。 */
export function lastMcpRequestTime(): number | null {
  return lastMcpRequestAt;
}

/** 测试用:清掉"最近一次 /mcp 请求"这个进程内状态(生产路径没有任何入口会调它)。 */
export function resetLastMcpRequestTime(): void {
  lastMcpRequestAt = null;
}

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
    // 只读的自检时间戳(健康状态展示"cron 还在不在跑"的间接信号),不参与任何判定。
    markMcpRequest();
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
