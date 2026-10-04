import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { daysBetween, generateId, isCalendarDate, todayInTz } from "../src/db/id.js";
import { openDb } from "../src/db/db.js";
import { migrate } from "../src/db/migrations.js";
import { TZ } from "./helpers.js";

describe("时间与时区(§4:不依赖系统本地时区)", () => {
  // 2026-10-04 16:00 UTC:上海已是 10-05 凌晨 0 点,UTC 还是 10-04
  const instant = new Date("2026-10-04T16:00:00Z");

  it("todayInTz 按 IANA 时区取日期", () => {
    assert.equal(todayInTz("Asia/Shanghai", instant), "2026-10-05");
    assert.equal(todayInTz("UTC", instant), "2026-10-04");
    assert.equal(todayInTz("America/New_York", instant), "2026-10-04"); // 当地 12:00
  });

  it("generateId 的日期段跟随配置时区", () => {
    const db = openDb(":memory:");
    migrate(db);
    const id = generateId(db, "t", "todo", TZ, instant);
    assert.match(id, /^t-261005-[a-z2-9]{4}$/);
    db.close();
  });

  it("generateId 不与已有 id 冲突", () => {
    const db = openDb(":memory:");
    migrate(db);
    const member = db
      .prepare("INSERT INTO member (id, name, aliases, created_at) VALUES ('m-x', '甲', '[]', '2026-01-01T00:00:00Z') RETURNING id")
      .get() as { id: string };
    const first = generateId(db, "t", "todo", TZ, instant);
    db.prepare("INSERT INTO todo (id, owner_id, title, created_by, created_at) VALUES (?, ?, 't', ?, '')")
      .run(first, member.id, member.id);
    const second = generateId(db, "t", "todo", TZ, instant);
    assert.match(second, /^t-261005-/);
    assert.notEqual(second, first);
    db.close();
  });

  it("daysBetween 计算自然日差", () => {
    assert.equal(daysBetween("2026-10-04", "2026-10-05"), 1);
    assert.equal(daysBetween("2026-10-05", "2026-10-04"), -1);
    assert.equal(daysBetween("2026-10-04", "2026-10-04"), 0);
    assert.equal(daysBetween("2026-09-30", "2026-10-02"), 2);
  });

  it("isCalendarDate 拒绝格式错与不存在的日历日", () => {
    assert.equal(isCalendarDate("2026-10-05"), true);
    assert.equal(isCalendarDate("2026-02-30"), false);
    assert.equal(isCalendarDate("2026-13-01"), false);
    assert.equal(isCalendarDate("2026-2-5"), false);
    assert.equal(isCalendarDate("20261005"), false);
    assert.equal(isCalendarDate("明天"), false);
  });

  it("loadConfig 拒绝无效时区", async () => {
    const { loadConfig } = await import("../src/config.js");
    assert.throws(() => loadConfig({ FA_TIMEZONE: "Mars/Olympus" } as NodeJS.ProcessEnv));
  });
});
