import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrations.js";

/**
 * 迁移 v2(设计方案 §4):event_series / event_instance / entry / category / audit_log
 * 一次建全,并在既有 v1 库上可叠加(不改 v1)。
 * v3(S2b):给 event_instance 追加 UNIQUE(series_id, start) —— 重复日程惰性续期的幂等保证。
 */

function tableNames(db: Db): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name);
}

function withTempDb(fn: (db: Db) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "fa-migrate-"));
  const db = openDb(join(dir, "test.db"));
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("迁移 v2:全量 schema", () => {
  it("建库后 schema_migrations 有 v1、v2、v3 三条,各表都在", () => {
    const db = openDb(":memory:");
    migrate(db);
    const applied = db.prepare("SELECT id, name FROM schema_migrations ORDER BY id").all() as {
      id: number;
      name: string;
    }[];
    assert.deepEqual(applied.map((r) => r.id), [1, 2, 3]);
    for (const t of ["member", "api_token", "todo", "category", "entry", "event_series", "event_instance", "audit_log"]) {
      assert.ok(tableNames(db).includes(t), `缺表 ${t}`);
    }
    db.close();
  });

  it("预置分类:支出 9 条 + 收入 4 条,sort_order 按列出顺序递增", () => {
    const db = openDb(":memory:");
    migrate(db);
    const all = db.prepare("SELECT id, name, kind, sort_order FROM category ORDER BY kind, sort_order").all() as {
      id: string;
      name: string;
      kind: string;
      sort_order: number;
    }[];
    const expense = all.filter((c) => c.kind === "expense");
    const income = all.filter((c) => c.kind === "income");
    assert.equal(expense.length, 9);
    assert.equal(income.length, 4);
    assert.deepEqual(expense.map((c) => c.name), ["餐饮", "交通", "购物", "居住", "娱乐", "医疗", "教育", "人情", "其他"]);
    assert.deepEqual(income.map((c) => c.name), ["工资", "理财", "红包", "其他"]);
    assert.deepEqual(expense.map((c) => c.sort_order), [10, 20, 30, 40, 50, 60, 70, 80, 90]);
    assert.deepEqual(income.map((c) => c.sort_order), [10, 20, 30, 40]);
    // 固定可读 id(幂等可读)
    assert.ok(expense.every((c) => c.id.startsWith("cat-expense-")));
    assert.ok(income.every((c) => c.id.startsWith("cat-income-")));
    db.close();
  });

  it("entry 外键成立:category 先建表,分类/成员都能引用", () => {
    const db = openDb(":memory:");
    migrate(db);
    db.prepare("INSERT INTO member (id, name, aliases, created_at) VALUES ('m-1', '妈妈', '[]', '2026-10-04T00:00:00Z')").run();
    db.prepare(`
      INSERT INTO entry (id, type, amount_fen, category_id, ledger, member_id, occurred_date, created_by, created_at)
      VALUES ('n-261004-aaaa', 'expense', 3500, 'cat-expense-food', 'shared', 'm-1', '2026-10-04', 'm-1', '2026-10-04T00:00:00Z')
    `).run();
    const row = db.prepare("SELECT amount_fen, category_id FROM entry WHERE id = ?").get("n-261004-aaaa") as {
      amount_fen: number;
      category_id: string;
    };
    assert.equal(row.amount_fen, 3500);
    assert.equal(row.category_id, "cat-expense-food");
    // 外键真的生效(PRAGMA foreign_keys = ON)
    assert.throws(
      () =>
        db
          .prepare(`
            INSERT INTO entry (id, type, amount_fen, category_id, ledger, member_id, occurred_date, created_by, created_at)
            VALUES ('n-bad', 'expense', 100, 'cat-nonexistent', 'shared', 'm-1', '2026-10-04', 'm-1', '2026-10-04T00:00:00Z')
          `)
          .run(),
      /FOREIGN KEY/,
    );
    db.close();
  });

  it("CHECK 约束按设计 §4 生效(amount_fen > 0 / type / ledger / repeat)", () => {
    const db = openDb(":memory:");
    migrate(db);
    db.prepare("INSERT INTO member (id, name, aliases, created_at) VALUES ('m-1', '妈妈', '[]', '2026-10-04T00:00:00Z')").run();
    db
      .prepare(`
        INSERT INTO entry (id, type, amount_fen, ledger, member_id, occurred_date, created_by, created_at)
        VALUES ('n-1', 'expense', 100, 'shared', 'm-1', '2026-10-04', 'm-1', '2026-10-04T00:00:00Z')
      `)
      .run();
    assert.throws(() => db.prepare("UPDATE entry SET amount_fen = 0 WHERE id = 'n-1'").run(), /CHECK/);
    assert.throws(() => db.prepare("UPDATE entry SET type = 'transfer' WHERE id = 'n-1'").run(), /CHECK/);
    assert.throws(() => db.prepare("UPDATE entry SET ledger = 'joint' WHERE id = 'n-1'").run(), /CHECK/);
    assert.throws(
      () =>
        db
          .prepare(`
            INSERT INTO event_series (id, title, repeat, created_by, created_at)
            VALUES ('e-1', '游泳', 'yearly', 'm-1', '2026-10-04T00:00:00Z')
          `)
          .run(),
      /CHECK/,
    );
    // event_series 的 owner_id 可空(= 全家共享,V2);event_instance 的 start 必填
    db
      .prepare(`
        INSERT INTO event_series (id, title, created_by, created_at)
        VALUES ('e-2', '全家晚饭', 'm-1', '2026-10-04T00:00:00Z')
      `)
      .run();
    assert.throws(
      () =>
        db
          .prepare(`
            INSERT INTO event_instance (id, title, created_by, created_at)
            VALUES ('ev-1', '晚饭', 'm-1', '2026-10-04T00:00:00Z')
          `)
          .run(),
      /NOT NULL/,
    );
    db.close();
  });

  it("event_instance 的 start / (owner_id, start, deleted_at) 索引都在", () => {
    const db = openDb(":memory:");
    migrate(db);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event_instance'").all() as {
      name: string;
    }[]).map((r) => r.name);
    assert.ok(idx.includes("idx_event_instance_start"), `实际索引:${idx.join("、")}`);
    assert.ok(idx.includes("idx_event_instance_owner_start"), `实际索引:${idx.join("、")}`);
    const entryIdx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entry'").all() as {
      name: string;
    }[]).map((r) => r.name);
    assert.ok(entryIdx.includes("idx_entry_occurred"));
    assert.ok(entryIdx.includes("idx_entry_member_ledger"));
    db.close();
  });

  it("v3:event_instance 有 UNIQUE(series_id, start),同一次不允许落两行", () => {
    const db = openDb(":memory:");
    migrate(db);
    db.prepare("INSERT INTO member (id, name, aliases, created_at) VALUES ('m-1', '妈妈', '[]', '2026-10-04T00:00:00Z')").run();
    db
      .prepare("INSERT INTO event_series (id, title, repeat, created_by, created_at) VALUES ('e-1', '游泳', 'weekly', 'm-1', '2026-10-04T00:00:00Z')")
      .run();
    const ins = `INSERT INTO event_instance (id, series_id, owner_id, title, created_by, created_at, start, all_day)
                 VALUES (?, 'e-1', NULL, '游泳', 'm-1', '2026-10-04T00:00:00Z', ?, 0)`;
    db.prepare(ins).run("ei-1", "2026-10-07 19:00");
    // 续期重试(同一系列的同一次)必须被 UNIQUE 挡下 —— 这正是幂等的结构性保证
    assert.throws(() => db.prepare(ins).run("ei-2", "2026-10-07 19:00"), /UNIQUE/);
    // 另一个系列的同一天不受影响
    db
      .prepare("INSERT INTO event_series (id, title, repeat, created_by, created_at) VALUES ('e-2', '晚饭', 'daily', 'm-1', '2026-10-04T00:00:00Z')")
      .run();
    db.prepare(ins.replace("'e-1'", "'e-2'")).run("ei-3", "2026-10-07 19:00");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM event_instance").get() as { n: number }).n, 2);
    db.close();
  });

  it("audit_log 结构符合契约,id 自增,无外键(成员软删后仍留痕)", () => {
    const db = openDb(":memory:");
    migrate(db);
    const cols = db.prepare("PRAGMA table_info(audit_log)").all() as { name: string; type: string; notnull: number }[];
    assert.deepEqual(
      cols.map((c) => c.name),
      ["id", "at", "member_id", "member_name", "tool", "args_summary", "result_code", "ok"],
    );
    // 除 INTEGER PRIMARY KEY(id,SQLite 的 notnull 报 0)外全部 NOT NULL
    for (const c of cols.slice(1)) {
      assert.equal(c.notnull, 1, `${c.name} 应为 NOT NULL`);
    }
    assert.equal((db.prepare("PRAGMA foreign_key_list(audit_log)").all() as unknown[]).length, 0);
    db.close();
  });
});

describe("迁移:既有库上可叠加(不改 v1)", () => {
  it("重复执行 migrate() 幂等", () => {
    withTempDb((db) => {
      migrate(db);
      migrate(db);
      const applied = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
      assert.equal(applied.n, 3);
      const cats = db.prepare("SELECT COUNT(*) AS n FROM category").get() as { n: number };
      assert.equal(cats.n, 13);
    });
  });

  it("v1 已应用的库再跑 migrate() → 只叠加 v2 + v3", () => {
    withTempDb((db) => {
      // 造一个"只有 v1"的库:跑一次迁移后把 v2/v3 的痕迹撤掉
      // (DROP TABLE 会连带删掉 v3 建在 event_instance 上的索引,所以两条痕迹都要撤)
      migrate(db);
      db.exec(`
        DROP TABLE audit_log;
        DROP TABLE event_instance;
        DROP TABLE event_series;
        DROP TABLE entry;
        DROP TABLE category;
        DELETE FROM schema_migrations WHERE id IN (2, 3);
      `);
      // v1 的数据必须完好
      db.prepare("INSERT INTO member (id, name, aliases, created_at) VALUES ('m-1', '妈妈', '[]', '2026-10-04T00:00:00Z')").run();
      db.prepare("INSERT INTO todo (id, owner_id, title, created_by, created_at) VALUES ('t-1', 'm-1', '交电费', 'm-1', '2026-10-04T00:00:00Z')").run();

      migrate(db);

      const applied = db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[];
      assert.deepEqual(applied.map((r) => r.id), [1, 2, 3]);
      const todo = db.prepare("SELECT title FROM todo WHERE id = 't-1'").get() as { title: string };
      assert.equal(todo.title, "交电费", "v1 的数据不能在迁移中被动到");
      const cats = db.prepare("SELECT COUNT(*) AS n FROM category").get() as { n: number };
      assert.equal(cats.n, 13, "v2 重新叠加后预置分类应齐");
      const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event_instance'").all() as {
        name: string;
      }[]).map((r) => r.name);
      assert.ok(idx.includes("idx_event_instance_series_start"), `v3 的唯一索引应重新建出:${idx.join("、")}`);
    });
  });
});