import { statSync } from "node:fs";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import { readSetting } from "../db/settings.js";
import { listAudit } from "../audit/audit.js";
import { lastMcpRequestTime } from "../mcp/http.js";

/**
 * 健康状态(S6b / 设计 §6「健康状态」):MCP 端点、DB、最近备份时间、cron 最近一次投递。
 *
 * ## 四项的**数据来源**,以及哪些是"只能诚实地说暂无"
 * 1. **MCP 端点**:**本进程内自检**。`/mcp` 与管理页在同一个进程(设计 §2),
 *    所以"端点在不在"就是"这个门面在本进程里注册了没有" —— 用 `lastMcpRequestTime()`
 *    这个进程内标记判断:**收到过请求 = 端点在服务**。
 *    **刻意不去外网/不回环 socket 探活**:那既多余(D2 说它只绑回环,进程内自检已足够),
 *    又会让健康页在网络栈出问题时给出误导性的"端点不可达"。
 *    没收到过任何请求时如实说"暂无请求",而不是说"不可达"—— 刚启动没人调用是正常状态。
 * 2. **DB 是否可读**:`SELECT 1`(能查即活着),与查看页 `/healthz` 同一口径。
 *    **刻意不 COUNT 任何业务表**—— 那已经是读成员数据,健康页不该顺手带出去。
 * 3. **数据库文件大小**:`statSync` 主库文件。注意 WAL 模式下**主库文件不含最新数据**,
 *    所以同时给出 `-wal` 文件大小,否则这个数字会骗人(页面注释里也写明)。
 * 4. **最近一次备份时间**:来自 `setting` 表的 `last_backup_at`。
 *    数据源是**本程序自己**:备份只能从管理页下载,所以"下载过一次"就是"备份过一次";
 *    没有任何自动/定时备份(设计 R5:定期备份靠 Hermes cron 或系统 cron,不是程序内的定时器)。
 * 5. **cron 最近一次投递**:**本程序没有任何投递记录,所以永远是"暂无"**。
 *    投递由 **Hermes cron** 承担(设计 D7 / 非目标 N3),程序零推送代码、也从不调用 Hermes。
 *    要显示真实投递结果就得去读 Hermes 的 cron 状态 —— 那是跨组件耦合,
 *    设计 OQ7 已明确"顺延至 v0.7 再评估"。这里给的是**可诚实给出的间接信号**:
 *    最近一次 `/mcp` 请求的时刻(cron 任务的 prompt 会调 `get_today()`,必然经过 `/mcp`),
 *    并在字段里**明说这不是投递结果**。没有数据时按任务书要求显示"暂无"。
 */

/** 备份时间在 `setting` 表里的键名(下载备份时写一次)。 */
export const LAST_BACKUP_KEY = "last_backup_at";

/** 记一次"备份已被下载"(只存时刻;备份文件本身**不落库**)。 */
export function recordBackupAt(db: Db, now: Date = new Date()): void {
  db.prepare(
    `INSERT INTO setting (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(LAST_BACKUP_KEY, now.toISOString());
}

/** 上一次备份下载的时刻;从未下载过则 null。 */
export function lastBackupAt(db: Db): string | null {
  return readSetting(db, LAST_BACKUP_KEY);
}

/** 一次 `stat`;文件不存在(刚删/内存库)时返回 null 而不是抛错。 */
function fileSizeOrNull(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export interface McpHealth {
  /** 端点 URL(回环,构造自配置)。 */
  url: string;
  /** 本进程自检结果:收到过请求 = 在服务;没收到过 = "暂无请求"(不是"不可达")。 */
  status: "serving" | "no_request_yet";
  /** 最近一次 `/mcp` 请求时刻(ISO);从未收到过为 null。 */
  last_request_at: string | null;
  /** 复核时间。 */
  checked_at: string;
}

export interface DbHealth {
  status: "readable" | "unreadable";
  /** 库文件路径(配置里的 dbPath)。 */
  path: string;
  /** 主库文件字节数;`:memory:` 或读不到时为 null。 */
  size_bytes: number | null;
  /** `-wal` 文件字节数(WAL 模式下最新数据在这里,不给它主库大小会骗人)。 */
  wal_size_bytes: number | null;
  checked_at: string;
}

export interface BackupHealth {
  /** 上一次下载备份的时刻;从未下载过为 null。 */
  last_backup_at: string | null;
  /** 人话说明,含"暂无"字样(任务书要求:没有数据时如实显示暂无)。 */
  note: string;
}

export interface CronHealth {
  /**
   * **恒为 null**:本程序零推送代码、也从不调用 Hermes(设计 D7/N3),
   * 因此**不存在**"程序记录的投递结果"。真去读 Hermes 的 cron 状态是跨组件耦合(OQ7 顺延)。
   */
  last_delivery_at: string | null;
  /**
   * 间接信号:cron 任务的 prompt 调 `get_today()`,必然经过 `/mcp`,
   * 所以这里给"最近一次 `/mcp` 请求时刻"。**这不是投递结果**,字段里写明了。
   */
  last_mcp_request_at: string | null;
  /** 人话说明。 */
  note: string;
}

export interface AuditHealth {
  /** 审计表行数(纯计数,不含任何内容)。 */
  total: number;
  /** 最近一条审计的时刻;从未有过写操作为 null。 */
  last_write_at: string | null;
  /** 最近一条审计的说话人(管理员动作会显示「管理员」)。 */
  last_write_by: string | null;
}

export interface AdminHealth {
  ok: boolean;
  service: "family-assistant";
  facade: "web-admin";
  timezone: string;
  mcp: McpHealth;
  db: DbHealth;
  backup: BackupHealth;
  cron: CronHealth;
  audit: AuditHealth;
  /** 管理口令是否已设置(**只报状态,不报任何内容**)。 */
  admin_password_set: boolean;
}

/**
 * 采集健康状态。
 *
 * **纪律:这个返回值里绝不能出现成员数据与任何 token。**
 * 它是 JSON(可能被 curl、被代理、被手机截图带出去),所以只给状态、计数与路径:
 * 没有成员名单、没有待办标题、没有 token(连哈希都没有)。测试对此有否定断言。
 */
export function adminHealth(db: Db, config: AppConfig, now: Date = new Date()): AdminHealth {
  const at = now.toISOString();

  const lastMcp = lastMcpRequestTime();
  const mcp: McpHealth = {
    url: `http://${config.mcpHost}:${config.mcpPort}/mcp`,
    status: lastMcp === null ? "no_request_yet" : "serving",
    last_request_at: lastMcp === null ? null : new Date(lastMcp).toISOString(),
    checked_at: at,
  };

  let dbReadable = false;
  try {
    db.prepare("SELECT 1 AS ok").get();
    dbReadable = true;
  } catch {
    dbReadable = false;
  }
  const dbPath = config.dbPath;
  const dbHealth: DbHealth = {
    status: dbReadable ? "readable" : "unreadable",
    path: dbPath,
    size_bytes: fileSizeOrNull(dbPath),
    wal_size_bytes: fileSizeOrNull(`${dbPath}-wal`),
    checked_at: at,
  };

  const backupAt = lastBackupAt(db);
  const backup: BackupHealth = {
    last_backup_at: backupAt,
    note:
      backupAt === null
        ? "暂无(从未在本页下载过备份;定期备份靠 Hermes cron 或系统 cron,程序内没有定时器)"
        : "上一次在本管理页下载备份的时刻;程序不保留备份文件本身",
  };

  const cron: CronHealth = {
    last_delivery_at: null,
    last_mcp_request_at: lastMcp === null ? null : new Date(lastMcp).toISOString(),
    note:
      "程序自身不推送、也不调用 Hermes(设计 D7/N3),因此没有投递记录;此处只读展示" +
      "最近一次 /mcp 请求作为间接信号(定时任务会调 get_today)。真实投递结果请看 Hermes 侧。",
  };

  // 审计:只取计数与最近一条的时间/说话人,不取 args_summary(那可能含成员名与参数)。
  const auditRow = dbReadable ? listAudit(db, 1)[0] : undefined;
  const auditTotal = dbReadable
    ? ((db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number } | undefined)?.n ?? 0)
    : 0;
  const audit: AuditHealth = {
    total: auditTotal,
    last_write_at: auditRow?.at ?? null,
    last_write_by: auditRow?.member_name ?? null,
  };

  return {
    ok: dbReadable,
    service: "family-assistant",
    facade: "web-admin",
    timezone: config.timezone,
    mcp,
    db: dbHealth,
    backup,
    cron,
    audit,
    admin_password_set: readSetting(db, "admin_password_hash") !== null,
  };
}