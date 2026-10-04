import type { Db } from "./db.js";

/**
 * 迁移按序号递增、只追加。正式 schema 的 member / api_token / todo 部分
 * (设计方案 §4);event / entry 等域在其后的版本追加,不回填改写。
 */
const MIGRATIONS: readonly { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "core: member / api_token / todo (Spike 01)",
    sql: `
      CREATE TABLE member (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        aliases          TEXT NOT NULL DEFAULT '[]',   -- JSON 数组
        web_password_hash TEXT,
        created_at       TEXT NOT NULL,
        deleted_at       TEXT
      );
      -- 成员名只在"未删除"范围内唯一(软删后允许再用同一个名字)
      CREATE UNIQUE INDEX idx_member_name_active ON member(name) WHERE deleted_at IS NULL;

      CREATE TABLE api_token (
        id         TEXT PRIMARY KEY,
        member_id  TEXT NOT NULL REFERENCES member(id),
        label      TEXT NOT NULL DEFAULT '',
        token_hash TEXT NOT NULL UNIQUE,             -- SHA-256(token);token 本体高熵,只存哈希
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX idx_api_token_member ON api_token(member_id);

      CREATE TABLE todo (
        id         TEXT PRIMARY KEY,
        owner_id   TEXT NOT NULL REFERENCES member(id),
        title      TEXT NOT NULL,
        notes      TEXT,
        due_date   TEXT,                             -- YYYY-MM-DD,可空
        done       INTEGER NOT NULL DEFAULT 0,
        done_at    TEXT,
        created_by TEXT NOT NULL REFERENCES member(id),
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX idx_todo_owner ON todo(owner_id, deleted_at, done);
      CREATE INDEX idx_todo_creator ON todo(created_by);
    `,
  },
];

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const appliedRows = db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[];
  const applied = new Set(appliedRows.map((r) => r.id));
  const insert = db.prepare(
    "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.id, m.name, new Date().toISOString());
    })();
  }
}
