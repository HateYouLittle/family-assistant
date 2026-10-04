import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Db = Database.Database;

function applyPragmas(db: Db): Db {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

/** 打开数据库并施加本程序赖以正确工作的 PRAGMA。 */
export function openDb(dbPath: string): Db {
  if (dbPath === ":memory:") {
    return applyPragmas(new Database(":memory:"));
  }
  const abs = resolve(dbPath);
  mkdirSync(dirname(abs), { recursive: true });
  return applyPragmas(new Database(abs));
}
