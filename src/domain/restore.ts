import type { Db } from "../db/db.js";
import { failEnvelope, type Envelope } from "./envelope.js";
import { restoreEvent } from "./events.js";
import { restoreTodo } from "./todos.js";
import type { Viewer } from "./viewer.js";

/**
 * restore_deleted:软删的逆操作(设计方案 §4/§5 的 P6 唯一例外——
 * 恢复在三个域上语义完全同构且极低频,拆成 restore_todo/event/entry 只会膨胀工具面)。
 *
 * ## 1. kind 枚举的推进(S2 裁决)
 * - S1:只有 `kind="todo"`。日程(S2)、记账(S3)接入时,在下面的分派里各加一行即可。
 * - S2:加上 `"event"` —— 恢复**整个系列及其全部实例**(日程是系列+实例两层,
 *   只恢复实例会留下一条看不见的系列,所以软删与恢复都按系列联动)。
 * - 未接入的 `kind="entry"` 一律 INVALID_PARAMS:
 *   **宁可显式拒绝,也不实现半套语义**——工具面是模型唯一读到的契约,
 *   放行一个"看起来能用、其实什么都不做"的 kind 比拒绝危险得多。
 *
 * ## 2. 恢复权与删除权同源(S1 裁决)
 * 口径直接复用各域的 `canDelete*`(归属人本人 + 代记者对自己代记的条目),
 * 而不是照抄真值表的 "delete / restore 同列"。
 * 理由:V8 给代记者删除权的目的就是让他纠正自己的笔误;"能删不能恢复"等于把笔误
 * 变成不可挽回,那半条权利就白给了。详见 src/domain/todos.ts 的 canDeleteTodo 注释。
 */
const SUPPORTED_KINDS = ["todo", "event"] as const;
export type RestoreKind = (typeof SUPPORTED_KINDS)[number];

export function restoreDeleted(db: Db, viewer: Viewer, kind: string, id: string): Envelope {
  switch (kind) {
    case "todo":
      return restoreTodo(db, viewer, id);
    case "event":
      return restoreEvent(db, viewer, id);
    default:
      // schema 已用 z.enum 挡住未接入的 kind;这里是纵深防御(domain 层不假设上游已校验)。
      return failEnvelope("INVALID_PARAMS", {
        message: `restore_deleted 暂不支持 kind="${kind}"。`,
        hint: `本阶段可用:${SUPPORTED_KINDS.map((k) => `kind="${k}"`).join("、")};记账域接入后再扩展该枚举。`,
        field: "kind",
      });
  }
}
