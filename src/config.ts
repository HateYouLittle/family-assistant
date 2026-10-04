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
   * 连接级身份声明头(§0.1 / Spike S7 / BUG B1):
   * 每个 Hermes profile 的 mcp_servers.headers 里声明本 profile 属于谁,
   * 服务端比对它与 token 所属成员,不一致 → DENIED(identity_mismatch)。
   * 值应当是**成员 id**(HTTP 头只能放 ASCII,中文成员名会在客户端先报错)。
   */
  identityHeader: string;
  /**
   * 身份声明头是否**必填**(默认 true)。
   *
   * 为什么必填(BUG B1 的实测):声明头只"有则校验"时,把爸爸的 token 装进妈妈的
   * profile 且漏写声明头,请求会**静默以爸爸的身份运行**——妈妈的 profile 原样
   * 返回爸爸的待办、0 报错。这正是 Spike 01 里 S7 要求"响亮失败"的那一条,
   * 因此缺声明头一律 DENIED(identity_mismatch)。
   *
   * 置 false 可退回"有则校验、无则跳过"的过渡语义,**不推荐**:它把配置写错
   * 从"响亮失败"变回"静默串号",仅供升级中的旧部署临时过渡。
   */
  requireIdentityHeader: boolean;
}

const boolEnv = z
  .string()
  .transform((v, ctx) => {
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `布尔值只接受 1/0/true/false/yes/no/on/off,收到「${v}」`,
    });
    return z.NEVER;
  });

const envSchema = z.object({
  FA_MCP_HOST: z.string().min(1).default("127.0.0.1"),
  FA_MCP_PORT: z.coerce.number().int().positive().default(8347),
  FA_DB_PATH: z.string().min(1).default("data/family-assistant.db"),
  FA_TIMEZONE: z.string().min(1).default("Asia/Shanghai"),
  FA_IDENTITY_HEADER: z.string().min(1).default("x-family-member"),
  FA_REQUIRE_IDENTITY_HEADER: boolEnv.default("true"),
});

/** 把配置里的小写头名还原成话术/配置片段里的展示形式:x-family-member → X-Family-Member。 */
export function headerDisplayName(lower: string): string {
  return lower
    .split("-")
    .map((p) => (p === "" ? "" : p[0]!.toUpperCase() + p.slice(1)))
    .join("-");
}

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
    requireIdentityHeader: e.FA_REQUIRE_IDENTITY_HEADER,
  };
}
