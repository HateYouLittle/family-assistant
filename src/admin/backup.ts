import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/db.js";

/**
 * 数据备份(S6b / 设计 §6「数据备份」):用 SQLite 的 **`VACUUM INTO`** 生成一个在线快照,
 * 读完字节后**立刻删掉临时文件**。
 *
 * ## 为什么不能直接拷库文件(WAL 模式下那样拷出来是坏的)
 * `openDb` 施加了 `journal_mode = WAL`(见 src/db/db.ts):已提交的数据此刻可能**只存在于
 * `-wal` 文件**里,主库文件还是旧的。直接 `cp family-assistant.db backup.db` 拷到的是
 * "少了一截 WAL"的库 —— 它能打开(所以坏得很有欺骗性),但**最近的数据不在里面**,
 * 而备份的意义恰恰是那部分数据。
 *
 * `VACUUM INTO 'file'` 是 SQLite 官方给的在线备份原语:它在一个**读事务**里把所有页
 * (含 WAL 里已提交的页)写成一个新的、**不含 WAL 的、已整理压缩的**单文件库。
 * 等价于"边跑边拷",不需要停服务。顺带把库文件整理过一遍 —— 备份体积更小,
 * 这是 `VACUUM INTO` 相对 `.backup` API 的额外好处(两者都可用,这里取更短的一条)。
 *
 * ## 落点:系统临时目录,**不落共享目录**
 * 临时目录固定是 `os.tmpdir()`(可用 `FA_BACKUP_TMPDIR` 覆盖,给测试一个可断言的落点)。
 * **刻意不是 `data/`**:那里是库的所在目录,备份文件若落在旁边而运维忘了拷走,
 * 它就变成一个"谁都能读到、还可能跟着备份一起被备份"的整库副本 ——
 * 正好是设计 §10 R9 点名要避免的形态("备份文件不落在共享目录")。
 *
 * ## 清理时机:**读完立刻删**(finally)
 * 下发的是内存里的字节(家庭库量级,直接 send Buffer 就够),所以"下发后清理"的落点
 * 就是 readFileSync 之后的 finally —— 没有"下载流还没读完就删"的竞态。
 * 失败路径(库坏了、磁盘满了、快照打不开)同样清理,不留半截文件。
 */

/** 备份临时目录前缀(测试据此断言"临时目录里没有残留 .db")。 */
export const BACKUP_TMP_PREFIX = "fa-backup-";

/** 系统临时目录;`FA_BACKUP_TMPDIR` 可覆盖(测试用,给一个自己清空的落点)。 */
export function backupTmpRoot(): string {
  const override = process.env.FA_BACKUP_TMPDIR;
  return override !== undefined && override !== "" ? override : tmpdir();
}

export interface BackupPayload {
  /** 下载文件名(响应头 `Content-Disposition` 用它)。 */
  fileName: string;
  /** 文件字节。 */
  bytes: Buffer;
  /** 快照里 `member` 表的行数:证明"拷出来的确实是这一份数据"。 */
  memberRows: number;
  /** 字节数:页面上要显示,运维得知道备份有多大。 */
  sizeBytes: number;
}

/** 备份文件名:带时间戳,便于运维从下载记录认出是哪一次。不含任何路径成分。 */
export function backupFileName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  return `family-assistant-backup-${stamp}.db`;
}

/**
 * 生成一次在线备份并返回字节。**函数返回前临时文件一定已被删除**(成功或抛错都一样)。
 *
 * `VACUUM INTO` 的目标文件**必须不存在**(已存在会报错)—— 所以每次用 `mkdtempSync`
 * 现开一个子目录,不做"复用同一个路径"的优化。
 */
export function createBackup(db: Db, now: Date = new Date()): BackupPayload {
  const dir = mkdtempSync(join(backupTmpRoot(), BACKUP_TMP_PREFIX));
  const fileName = backupFileName(now);
  const file = join(dir, fileName);
  try {
    // 目标文件名由程序生成(不含用户输入、不含路径分隔符),可以安全地作为参数绑定。
    db.prepare("VACUUM INTO ?").run(file);
    // 在**删掉之前**打开快照数一下 member 行数:让"下发的字节确实是一个能打开的库"
    // 成为服务端自己验证过的事实。万一 VACUUM INTO 写出了坏文件,这里是最后一道闸 ——
    // 宁可在下发前报错,也不要让运维把一个打不开的文件当备份存起来。
    const memberRows = countMembersIn(file);
    const bytes = readFileSync(file);
    return { fileName, bytes, memberRows, sizeBytes: bytes.length };
  } finally {
    // 无论成功、失败还是抛错,临时文件都不留在磁盘上(§10 R9)。
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 打开刚生成的快照文件,数 `member` 表行数;用完立刻 close,不留文件句柄。 */
function countMembersIn(file: string): number {
  const snap = new Database(file, { readonly: true });
  try {
    const row = snap.prepare("SELECT COUNT(*) AS n FROM member").get() as { n: number } | undefined;
    return row?.n ?? 0;
  } finally {
    snap.close();
  }
}