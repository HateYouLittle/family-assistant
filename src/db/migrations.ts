import type { Db } from "./db.js";

/**
 * 迁移按序号递增、只追加。正式 schema 的 member / api_token / todo 部分
 * (设计方案 §4)在 v1;event / entry / category / audit_log 在 v2 一次建全,
 * 不回填改写 v1——既有库上跑 migrate() 即叠加。
 * v3(S2b)只**追加约束**:event_instance 的 UNIQUE(series_id, start),
 * 给重复日程的惰性续期兜底幂等(表结构本身不变,既有库叠加即可)。
 * v4(S6)加 setting 表:查看页会话 cookie 的签名密钥存库(不写死在代码里)。
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
  {
    id: 2,
    name: "full schema: category / entry / event_series / event_instance / audit_log",
    sql: `
      -- 记账分类(§4)。category 必须先于 entry 建表:entry.category_id 外键指向它。
      CREATE TABLE category (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL CHECK(kind IN ('expense','income')),
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      -- 支出与收入可以各有一个「其他」,所以唯一性是 (name, kind) 而不是 name
      CREATE UNIQUE INDEX idx_category_name_kind ON category(name, kind);

      -- 预置分类(§4):支出 9 类、收入 4 类,id 固定可读 → 迁移幂等且便于排查。
      INSERT INTO category (id, name, kind, sort_order) VALUES
        ('cat-expense-food',          '餐饮', 'expense', 10),
        ('cat-expense-transit',       '交通', 'expense', 20),
        ('cat-expense-shopping',      '购物', 'expense', 30),
        ('cat-expense-housing',       '居住', 'expense', 40),
        ('cat-expense-entertainment', '娱乐', 'expense', 50),
        ('cat-expense-medical',       '医疗', 'expense', 60),
        ('cat-expense-education',     '教育', 'expense', 70),
        ('cat-expense-social',        '人情', 'expense', 80),
        ('cat-expense-other',         '其他', 'expense', 90),
        ('cat-income-salary',         '工资', 'income', 10),
        ('cat-income-investment',     '理财', 'income', 20),
        ('cat-income-redpacket',      '红包', 'income', 30),
        ('cat-income-other',          '其他', 'income', 40);

      -- 记账流水(§4):金额为整数分且必须 > 0;归属与账本创建后不可变(V7,由 domain 保证)。
      CREATE TABLE entry (
        id            TEXT PRIMARY KEY,
        type          TEXT NOT NULL CHECK(type IN ('expense','income')),
        amount_fen    INTEGER NOT NULL CHECK(amount_fen > 0),
        category_id   TEXT REFERENCES category(id),
        ledger        TEXT NOT NULL CHECK(ledger IN ('shared','personal')),
        member_id     TEXT NOT NULL REFERENCES member(id),
        note          TEXT,
        occurred_date TEXT NOT NULL,
        created_by    TEXT NOT NULL REFERENCES member(id),
        created_at    TEXT NOT NULL,
        deleted_at    TEXT
      );
      CREATE INDEX idx_entry_occurred ON entry(occurred_date, deleted_at);
      CREATE INDEX idx_entry_member_ledger ON entry(member_id, ledger, deleted_at);

      -- 日程 = 系列 + 实例(§4)。owner_id 为空 = 全家共享(V2);指定 = 个人日程(V1)。
      CREATE TABLE event_series (
        id              TEXT PRIMARY KEY,
        owner_id        TEXT REFERENCES member(id),
        title           TEXT NOT NULL,
        location        TEXT,
        notes           TEXT,
        repeat          TEXT NOT NULL DEFAULT 'none' CHECK(repeat IN ('none','daily','weekly','monthly')),
        repeat_interval INTEGER NOT NULL DEFAULT 1,
        repeat_until    TEXT,
        created_by      TEXT NOT NULL REFERENCES member(id),
        created_at      TEXT NOT NULL,
        deleted_at      TEXT
      );
      CREATE INDEX idx_event_series_owner ON event_series(owner_id, deleted_at);

      -- repeat ≠ none 的系列在写时物化成实例(未来 92 天),读取越界时惰性续期。
      CREATE TABLE event_instance (
        id         TEXT PRIMARY KEY,
        series_id  TEXT REFERENCES event_series(id),
        owner_id   TEXT REFERENCES member(id),
        title      TEXT NOT NULL,
        location   TEXT,
        notes      TEXT,
        start      TEXT NOT NULL,
        end        TEXT,
        all_day    INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL REFERENCES member(id),
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX idx_event_instance_start ON event_instance(start);
      CREATE INDEX idx_event_instance_owner_start ON event_instance(owner_id, start, deleted_at);

      -- 审计日志(§6):append-only,只记写操作。
      -- 刻意**不建**外键与更新/删除入口:审计记录必须活得比成员/数据更久
      -- (成员被软删、条目被删,审计仍要能追溯当时是谁写的)。
      CREATE TABLE audit_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        at           TEXT NOT NULL,
        member_id    TEXT NOT NULL,
        member_name  TEXT NOT NULL,
        tool         TEXT NOT NULL,
        args_summary TEXT NOT NULL,
        result_code  TEXT NOT NULL,
        ok           INTEGER NOT NULL
      );
    `,
  },
  {
    id: 3,
    name: "event_instance: UNIQUE(series_id, start)(重复日程续期幂等)",
    sql: `
      -- 同一系列里的"同一次"只允许有一条:这是重复日程续期幂等的**结构性**保证。
      --
      -- 为什么 v2 的表结构不够(S2b 裁决):
      -- v2 只给了 idx_event_instance_start / idx_event_instance_owner_start 两个普通索引,
      -- 两者都不约束重复。续期是**写在读路径上的写**(设计 §4),会被重试(失败后再读同一
      -- 窗口)、也可能被两个进程同时触发;若只靠"生成前查重"这种代码约定,将来任何一个
      -- 续期入口忘了查重(或两次续期交错),重复的行会**静默**落进库 —— 家人的日历上出现
      -- 两条一模一样的日程,而没有任何约束会拦下它,事后也查不出是哪一步写重了。
      -- 把幂等从"代码约定"提到 schema 才算真的兜住。
      -- 配合 INSERT OR IGNORE:重名是**跳过**而不是抛错 —— 读路径上的写一旦抛错就变成
      -- 降级返回,不该由一条内部约束去触发它。
      CREATE UNIQUE INDEX idx_event_instance_series_start ON event_instance(series_id, start);
    `,
  },
  {
    id: 4,
    name: "setting(key, value): 服务端键值设置(查看页会话签名密钥)",
    sql: `
      -- 服务端键值设置(设计方案 §6)。
      --
      -- 用途只有一个:查看页会话 cookie 的**签名密钥**。密钥必须**存库**而不是写死在代码里,
      -- 原因有三,按重要性排:
      --   ① 写死 = 所有部署共用同一个密钥,一份代码泄露即全家会话都可伪造;
      --   ② 写死 = 重启后会话全部失效(除非密钥恰好不变),而"重启要重新登录"对家人是无声的故障;
      --   ③ 存库 = 可以随时轮换(删掉这一行,下次启动重新生成)。
      -- 首次启动随机生成写入(见 src/web/auth.ts 的 sessionSecret)。
      --
      -- 通用键值表而不是专用表:这类"服务端自己用、家人看不见"的键值还会有,
      -- 一张 setting 表比每来一个就建一张表省事,也不进业务 schema 的讨论范围。
      CREATE TABLE setting (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
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
