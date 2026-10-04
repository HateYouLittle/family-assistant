import type { Db } from "./db.js";

/**
 * id 形如 `<域前缀>-<yymmdd>-<4位随机>`(设计方案 §4):
 * 时间序前缀防跨域混淆、便于人工排查;随机段只用不易混淆的字符
 * (排除 0/o/1/l/i),降低 Agent 转录错误率。
 * 唯一性由 DB UNIQUE 约束兜底:同域同日冲突时重新生成,不靠概率。
 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function randomSegment(length: number): string {
  let out = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (const b of bytes) {
    out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

/** 家庭固定时区下的今天,YYYY-MM-DD。不依赖系统本地时区。 */
export function todayInTz(timezone: string, now: Date = new Date()): string {
  // en-CA 的 ISO 写法恰好输出 YYYY-MM-DD
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts;
}

/** yymmdd 段(id 前缀用)。 */
export function compactDateInTz(timezone: string, now: Date = new Date()): string {
  return todayInTz(timezone, now).slice(2).replaceAll("-", "");
}

function idExists(db: Db, table: string, id: string): boolean {
  const row = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
  return row !== undefined;
}

/**
 * 生成一个未占用的主键。table 只接受本程序内部的常量表名。
 * 调用方随后 INSERT;单进程同步 SQLite 下该检查不存在竞态。
 */
export function generateId(db: Db, prefix: string, table: string, timezone: string, now: Date = new Date()): string {
  const dateSeg = compactDateInTz(timezone, now);
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = `${prefix}-${dateSeg}-${randomSegment(4)}`;
    if (!idExists(db, table, id)) return id;
  }
  throw new Error(`无法为 ${table} 生成唯一 id(重试 10 次仍冲突)`);
}

/** 按时区计算两个 YYYY-MM-DD 之间相差的天数(b - a)。 */
export function daysBetween(a: string, b: string): number {
  const toUtc = (s: string) => {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/** 校验 YYYY-MM-DD 且是真实存在的日历日(2 月 30 日会拒绝)。 */
export function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
