import { z } from "zod";

/**
 * 服务端配置。来源:环境变量(均带默认值)。
 * 时区必须显式配置(设计方案 §4):实现不得依赖系统本地时区,
 * 否则容器默认 UTC 会让"今天""本周"整体偏移一天。
 */
export interface AppConfig {
  /** MCP 端点绑定地址:只绑回环(D2) */
  mcpHost: string;
  mcpPort: number;
  /** SQLite 数据库文件路径 */
  dbPath: string;
  /** 家庭固定单时区(IANA 名称) */
  timezone: string;
  /**
   * 连接级身份声明头(§0.1 / Spike S7):
   * 每个 Hermes profile 的 mcp_servers.headers 里声明本 profile 属于谁,
   * 服务端比对它与 token 所属成员,不一致 → DENIED(identity_mismatch)。
   * 缺省不校验(token 仍是唯一身份来源)。
   */
  identityHeader: string;
}

const envSchema = z.object({
  FA_MCP_HOST: z.string().min(1).default("127.0.0.1"),
  FA_MCP_PORT: z.coerce.number().int().positive().default(8347),
  FA_DB_PATH: z.string().min(1).default("data/family-assistant.db"),
  FA_TIMEZONE: z.string().min(1).default("Asia/Shanghai"),
  FA_IDENTITY_HEADER: z.string().min(1).default("x-family-member"),
});

function assertValidTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    throw new Error(`FA_TIMEZONE 不是有效的 IANA 时区名称: ${tz}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`环境变量配置有误: ${detail}`);
  }
  const e = parsed.data;
  assertValidTimezone(e.FA_TIMEZONE);
  return {
    mcpHost: e.FA_MCP_HOST,
    mcpPort: e.FA_MCP_PORT,
    dbPath: e.FA_DB_PATH,
    timezone: e.FA_TIMEZONE,
    identityHeader: e.FA_IDENTITY_HEADER.toLowerCase(),
  };
}
