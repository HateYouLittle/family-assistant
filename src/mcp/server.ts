import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import type { AuthResult } from "../domain/auth.js";
import type { Envelope } from "../domain/envelope.js";
import { TOOL_DEFINITIONS } from "./tools.js";

/**
 * 低级 MCP Server:完全掌控 tools/list 与 tools/call,
 * 使所有校验与错误都以 P2/P3 的中文信封返回,不依赖 SDK 的隐式报错。
 *
 * 无状态(D2/P7):每个 HTTP 请求新建一个实例,身份(或拒绝原因)按请求注入,
 * 服务端不保存任何跨请求状态。
 */

export const SERVER_INFO = { name: "family-assistant", version: "0.1.0-spike.1" } as const;

export function buildMcpServer(db: Db, config: Pick<AppConfig, "timezone">, auth: AuthResult): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions:
      "家庭助手:待办/日程/记账的家庭事务工具(三个域均已接入)。" +
      "说话人身份由连接(token)确定,所有工具都不接受身份参数;" +
      "涉及归属的参数(owner / member_id)先用 list_members 对齐称呼。" +
      "记账域注意三点:金额一律整数分(话术里显示为元);ledger=personal 时 member_id 必须是说话人本人;" +
      "ledger 与 member_id 创建后不可改(要改请删除后重建)。",
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === request.params.name);
    if (!tool) {
      throw new McpError(ErrorCode.InvalidParams, `未知工具:${request.params.name}`);
    }
    const envelope: Envelope = !auth.ok
      ? auth.envelope
      : runTool(db, config.timezone, auth, tool, request.params.arguments);
    return {
      content: [{ type: "text", text: JSON.stringify(envelope) }],
      isError: !envelope.ok,
    };
  });

  return server;
}

function runTool(
  db: Db,
  timezone: string,
  auth: AuthResult & { ok: true },
  tool: (typeof TOOL_DEFINITIONS)[number],
  rawArgs: unknown,
): Envelope {
  const parsed = tool.parse(rawArgs);
  if (!parsed.ok) return parsed.envelope;
  return tool.run(db, auth.caller, timezone, parsed.args);
}
