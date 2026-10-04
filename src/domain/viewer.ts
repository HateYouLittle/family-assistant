/**
 * 统一的"观看者"上下文(V1–V9 的唯一判定入口)。
 *
 * 设计依据(设计方案 §9):
 * - **token → 成员 的解析在 domain 层入口统一做一次**(src/domain/auth.ts 的
 *   `authenticate`),下游模块不再各自解析身份。
 * - 查看页(§6)与 MCP 侧必须**共用同一个过滤层**,不得在 web 层重写一遍 V1–V9;
 *   两侧的差别只有 `source`(按成员登录 vs 连接 token)。
 *
 * ## 约定(S0 定死,后续域一律遵守)
 *
 * 1. **所有域模块的可见性判定只从 `Viewer` 取值**:函数签名里的第一个身份参数
 *    永远是 `Viewer`,不得从 `args` / `input` / 任何业务参数里取说话人
 *    (`as_member` / `bind_key` 之类的形态在 schema 层就是 INVALID_PARAMS,X15)。
 * 2. **归属 ≠ 说话人**:`owner` / `member_id` 是合法的业务参数(爸爸可以给妈妈代记),
 *    它决定"这条数据归谁",不决定"谁在说话";`Viewer` 决定后者。
 * 3. 判定结果只有三种形态:过滤掉(读)、`DENIED`(显式越权,V5)、放行。
 *    读路径绝不返回"看起来成功的空表"(X1/X2/X3 的教训)。
 * 4. 需要"代记回执"里出现说话人名字时,取 `viewer.memberName`——它是服务端从 token
 *    解析出来的,不是模型自述的(§3.2)。
 *
 * 字段约定:`memberId` 是判定用的唯一依据(V1/V2/V3/V6);`memberName` 只用于话术;
 * `source` 只用于审计与排查("这条记录是 Agent 写的还是家人在页面上写的"),
 * **不得**用它改变可见性判定。
 */
export interface Viewer {
  /** 说话人成员 id:判定 V1–V9 的唯一依据 */
  memberId: string;
  /** 说话人成员名:仅用于话术与审计(服务端从 token 解析,不可伪造) */
  memberName: string;
  /** 入口来源:MCP 工具调用 / 查看页登录 */
  source: "mcp" | "web";
}

/**
 * @deprecated 历史别名(Spike 01 期间域函数签名用的就是这个名字)。
 * 与 `Viewer` 是同一个类型,不是第二份定义;新代码一律写 `Viewer`。
 */
export type Caller = Viewer;