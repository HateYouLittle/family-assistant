import { headerDisplayName, type AppConfig } from "../config.js";

/**
 * Hermes profile 的 `mcp_servers.family` 配置片段(设计 §3.2 / §6)。
 *
 * ## 为什么抽成一份(而不是 CLI 打一份、管理页再打一份)
 * 这段片段是**运维唯一的动作**:token 是高熵随机串、只显示一次,而"贴在配置里"
 * 要贴的不止一个 token —— 还有 `url` 与**身份声明头**。漏了声明头的后果不是报错,
 * 而是**静默串号**(§0.1 / BUG B1:只校验"写了的那一个"时,爸爸的 token 装进妈妈的 profile
 * 会 0 报错地以爸爸的身份运行)。所以这段文本必须**只有一处**,CLI 与管理页共用,
 * 否则将来改一处、另一处悄悄漏掉声明头,就是一个新的 B1。
 *
 * **两个头都在片段里**:`Authorization: Bearer <token>` 与 `<X-Family-Member>: <成员 id>`。
 * 声明头的值**必须是成员 id**(HTTP 头只允许 ASCII,填中文名会在客户端先报错)。
 */
export function hermesProfileSnippet(args: {
  config: Pick<AppConfig, "mcpHost" | "mcpPort" | "identityHeader">;
  memberName: string;
  memberId: string;
  /** 明文 token。**只在这一处出现**(调用方负责只显示一次)。 */
  token: string;
}): string {
  const { config, memberName, memberId, token } = args;
  return [
    "mcp_servers:",
    "  family:",
    `    url: "http://${config.mcpHost}:${config.mcpPort}/mcp"`,
    "    headers:",
    `      Authorization: "Bearer ${token}"`,
    "      # 身份声明头(必填):值必须是本成员的 id(HTTP 头只允许 ASCII,不能填中文名)。",
    "      # 缺失或与 token 归属不一致,一律 DENIED(identity_mismatch)——S7 的响亮失败通道。",
    `      ${headerDisplayName(config.identityHeader)}: "${memberId}"`,
    "",
    `# 写进 ${memberName} 的 profile:~/.hermes/profiles/${memberName}/config.yaml`,
  ].join("\n");
}