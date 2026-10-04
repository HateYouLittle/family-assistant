# 家庭助手(family-assistant)

一个给 AI Agent 当后端的家庭事务程序:**待办 / 日程 / 记账**做成 MCP 工具,供 Hermes Agent 调用。程序本身没有对话能力,也不解析自然语言——家人在 QQ/微信里和 Hermes 说话,Hermes 负责理解意图,本程序负责事实:数据、校验、统计与回执话术。

设计方案见 `docs/设计方案.md`(v0.6)。**身份最小闭环(Spike 01)已通过**,三个域全部接入:待办 6 个 + 日程 4 个 + 记账 7 个 + `list_members` + `restore_deleted` = **19 个工具**,说话人以按成员的 token 绑定(`docs/spike-01-identity-binding.md`)。

## 当前范围

| 工具 | 说明 |
|---|---|
| `list_members()` | 成员名单(name + aliases),供归属参数(owner / member_id)解析 |
| `add_todo(owner?, title, due_date?, notes?)` | 添加待办;owner 指定他人即"代记"(V4) |
| `list_todos(done?, due_before?, due_after?, q?)` | 只返回本人待办 + 本人代记的待办(V1/V8) |
| `update_todo(id, …)` / `complete_todo(id)` / `reopen_todo(id)` / `delete_todo(id)` | 仅限本人待办(V3/V6);owner 不可改(V7) |
| `add_event(owner?, title, start, …)` | owner 缺省 = 全家日程;重复日程写时物化 92 天 + 惰性续期 |
| `list_events(start, end, scope?)` / `update_event(id, …)` / `delete_event(id)` | 全家日程人人可见;个人日程仅本人(V1/V3/V8) |
| `add_entry(member_id, ledger?, type, amount_fen, …)` | 金额一律整数分;`ledger=personal` 只能本人写(V4) |
| `list_entries(start?, end?, member_id?, …)` / `summarize_entries(period?, group_by, …)` | 共享账本全员可见;显式要他人私账返回 `DENIED`(X2) |
| `update_entry(id, …)` / `delete_entry(id)` | `ledger` 与 `member_id` 不可改(V7) |
| `add_category(name, kind)` / `list_categories(kind?)` | 分类可缺省(「未分类」在汇总里单列) |
| `restore_deleted(kind, id)` | `kind ∈ {todo, event, entry}`,软删可逆 |

**核心身份模型(D13)**:说话人不是参数。每位成员一个 Hermes profile + 一个 family token,服务端由 token 反查成员,工具面没有任何身份参数(`as_member` / `bind_key` 会被 `INVALID_PARAMS` 拒绝,即反例 X15)。

## 运行

要求 Node ≥ 22.5。

```bash
npm install
npm run admin -- member add 妈妈 --alias 老妈 --alias 王丽
npm run admin -- member add 爸爸
npm run admin -- token generate 妈妈 --label "hermes profile"
npm run dev            # 开发模式;生产:npm run build && npm start
```

`token generate` 会**只显示一次**明文 token,并直接输出该成员 Hermes profile 需要的配置片段,粘贴到 `~/.hermes/profiles/<成员>/config.yaml`:

```yaml
mcp_servers:
  family:
    url: "http://127.0.0.1:8347/mcp"
    headers:
      Authorization: "Bearer fam_…"
      X-Family-Member: "m-261004-w9jn"   # 该成员的 id
```

`X-Family-Member` 是连接级**身份声明头**,**必填**:服务端比对它与 token 的归属,不一致立即返回 `DENIED(identity_mismatch)`——这是"把爸爸的 token 装进妈妈的 profile"时唯一的响亮失败通道(§0.1 / S7)。**漏写同样拒绝**:只校验"写了的那一个"时,把爸爸的 token 装进妈妈的 profile 又不写这个头,就会静默以爸爸的身份运行(0 报错地返回爸爸的待办);所以缺头一律 `DENIED(identity_mismatch)`。HTTP 头只允许 ASCII,所以值必须填**成员 id**,不要填中文名。

### 配置(环境变量,均有默认值)

| 变量 | 默认 | 说明 |
|---|---|---|
| `FA_MCP_HOST` | `127.0.0.1` | MCP 端点绑定地址(必须保持回环,D2) |
| `FA_MCP_PORT` | `8347` | MCP 端点端口 |
| `FA_DB_PATH` | `data/family-assistant.db` | SQLite 文件(WAL 模式) |
| `FA_TIMEZONE` | `Asia/Shanghai` | 家庭固定单时区;"今天/逾期"全部由此计算 |
| `FA_IDENTITY_HEADER` | `x-family-member` | 身份声明头的头名 |
| `FA_REQUIRE_IDENTITY_HEADER` | `true` | 身份声明头是否必填。**保持 true**;置 `0/false` 只为过渡期旧部署,会把 B1(漏写声明头 → 静默串号)重新打开 |

### 管理(CLI,管理页属后续版本)

```bash
npm run admin -- member list                 # 成员列表
npm run admin -- member remove 妈妈          # 软删(名下数据保留,其 token 一并失效)
npm run admin -- token list                  # token 元数据(只显示哈希后状态)
npm run admin -- token revoke tok_xxx        # 吊销
```

## 测试

```bash
npm test          # 89 个用例:领域集成 + X1/X9/X15/X16 反例 + golden + 身份声明头(B1) + 审计 + 迁移 + MCP HTTP e2e
```

- **golden 契约测试**(`test/golden/tools.json`):工具名、description、inputSchema 逐字冻结(P8)。有意变更时运行 `npx tsx scripts/dump-golden.ts` 重新生成,并按 diff 审查。
- **审计测试**(`test/audit.test.ts`):写操作留痕、读操作不留痕、摘要不含 `notes` 等自由文本、`member_id` 取连接身份。
- **迁移测试**(`test/migrations.test.ts`):v2 全量表 + 预置分类(支出 9 / 收入 4),并验证在 v1 既有库上可叠加。
- **e2e** 用 MCP SDK 客户端走真实 Streamable HTTP(无状态、JSON 响应),覆盖 S1/S2 的服务端部分、X9、S7、B1、X15。

## Spike 01 剩余步骤(代码之外,须人工完成)

1. **先验证部署形态(R10,可能推翻方案)**:每位成员各建一个 Hermes profile、各自接入自己的 bot 凭据,确认每人能和"自己的"bot 私聊。
2. 为每位成员生成 token,写进**该成员 profile** 的 `mcp_servers.family.headers`。
3. 把 `docs/hermes-skill.md` 装进每个 profile 的 skill store(内容相同,不含身份)。
4. 跑 `docs/spike-01-identity-binding.md` 的实测用例 S1–S12,重点:**S1/S2 互不串、S7 配错必须响亮失败**。
5. Hermes 侧访问控制是上线阻断项:DM allowlist/pairing 显式配置(微信 `dm_policy` 平台默认是 `open`,不要依赖默认值)、bot 不进群、家人通道收窄工具面。

## 结构

```
src/
  config.ts        环境变量配置(时区显式化,不依赖系统本地时区;身份声明头默认必填)
  db/              openDb(WAL)/ 迁移(v1 成员·token·todo;v2 category·entry·event·audit_log)/ id 生成(时间序前缀)
  domain/          领域层:信封与错误码、authenticate(token→成员)、viewer(可见性判定入口)、
                   members、todos、events、ledger(分类与流水)、restore ——
                   V1–V9 全部收敛在这一层,可脱离 MCP 直接测试
  audit/           写操作审计(append-only,记录点在工具层入口;只记关键字段元数据)
  mcp/             zod 严格 schema、工具定义(P8 中文描述)、低级 MCP Server、
                   Fastify Streamable HTTP(127.0.0.1,每请求独立、无状态)
  cli/admin.ts     成员与 token 管理入口(打印含身份声明头的 profile 配置片段)
test/              领域 / schema / golden / 迁移 / 审计 / e2e
```

分层纪律:工具层薄(参数转换 + 话术拼装),业务规则与可见性不变量全在 domain 层;token→成员的解析在领域层入口统一做一次(`authenticate`),下游域模块只从 `Viewer`(`src/domain/viewer.ts`)取身份,工具层不感知身份。
