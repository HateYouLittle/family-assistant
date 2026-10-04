import type { Db } from "./db.js";

/**
 * 服务端键值设置(迁移 v4 的 `setting` 表)。
 *
 * 用途:存**服务端自己用、家人看不见**的键值 —— 目前只有查看页会话的签名密钥。
 * 它刻意不放业务数据(待办/日程/记账都在各自的域里),也不参与任何可见性判定。
 *
 * 为什么单独一层而不是让调用方直接写 SQL:调用方(web 层)因此**不需要碰 SQL**,
 * "web 层没有自己的查询"这条静态纪律才能一眼验证(见 src/web/ 全部文件)。
 */
export function readSetting(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** 写入(或覆盖)一个键。值是字符串;敏感值由调用方负责加密/哈希后再存。 */
export function writeSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO setting (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/**
 * 「有就返回,没有就生成并写入」。`ensureSetting` 是这里唯一比 get/set 组合更贴切的语义,
 * 所以给它一个独立名字而不是让每个调用方各写一遍"先查后写"。
 *
 * 用 `INSERT OR IGNORE` 而不是 UPSERT:两个进程同时首次启动时,谁先写进去谁说了算,
 * 后来的那个**不覆盖** —— 覆盖会让先启动进程手里的会话签名密钥失效(那些 cookie 全部作废),
 * 而"启动顺序影响会话"是一种很难查的故障。UPSERT 版在 sql.ts 里另有一处需要覆盖的场合。
 */
export function ensureSetting(db: Db, key: string, make: () => string): string {
  const existing = readSetting(db, key);
  if (existing !== null) return existing;
  db.prepare("INSERT OR IGNORE INTO setting (key, value) VALUES (?, ?)").run(key, make());
  return readSetting(db, key) ?? make();
}
