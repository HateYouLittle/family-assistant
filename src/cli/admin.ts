#!/usr/bin/env node
import { parseArgs } from "node:util";
import { headerDisplayName, loadConfig } from "../config.js";
import { openDb } from "../db/db.js";
import { migrate } from "../db/migrations.js";
import { issueToken, listTokens, revokeToken } from "../domain/auth.js";
import {
  createMember,
  listActiveMembers,
  resolveMemberRef,
  softDeleteMember,
} from "../domain/members.js";
import {
  clearMemberWebPassword,
  generateWebPassword,
  hasWebPassword,
  setMemberWebPassword,
} from "../web/auth.js";

/**
 * Spike 01 的管理入口(管理页属 S6b):成员管理 + 按成员生成/吊销 family token
 * + **设置/清除查看页口令**(S6:管理页还没做,先给 CLI 这一条路,部署与测试都要用)。
 *
 * token 明文只在生成这一次显示,需要立即写进该成员 Hermes profile 的
 * mcp_servers.family.headers(D13)。查看页口令同理:**库里只存 scrypt 哈希,明文只显示一次**。
 */

const USAGE = `用法:npm run admin -- <命令>

命令:
  member add <name> [--alias <别名>]…   新增成员(名称与别名不能与现有成员冲突)
  member list                           列出成员
  member remove <name|id>               软删成员(名下数据保留,其 token 一并失效)
  member set-password <name|id> [--password <明文>]
                                        设置查看页口令(scrypt 哈希存库)。
                                        不给 --password 时生成随机口令,明文**只显示一次**
  member clear-password <name|id>       清除查看页口令(该成员此后无法登录查看页)
  token generate <name|id> [--label L]  为成员生成 family token(明文只显示一次)
  token list [--member <name|id>]       列出 token(只显示哈希后元数据)
  token revoke <tokenId>                吊销 token

查看页口令说明:
  * 查看页**没有默认口令**:没设过口令的成员无法登录(登录页会提示先设置)。
  * 库里只存 scrypt 哈希(member.web_password_hash),明文不落库、不进日志。
  * 清除口令会让该成员**已有的查看页会话一并失效**(会话校验时要求口令仍存在)。
  * 局域网内没有 HTTPS,口令以明文经过 Wi-Fi(设计 §10 R9)——这是已知代价。`;

function fail(msg: string): never {
  console.error(`错误:${msg}`);
  process.exit(1);
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }

  const config = loadConfig();
  const db = openDb(config.dbPath);
  migrate(db);

  try {
    if (cmd === "member") {
      const sub = rest[0];
      if (sub === "add") {
        const { values, positionals } = parseArgs({
          args: rest.slice(1),
          options: { alias: { type: "string", multiple: true, default: [] } },
          allowPositionals: true,
        });
        const name = positionals[0];
        if (typeof name !== "string" || name === "") fail("member add 需要 <name>");
        const r = createMember(db, config.timezone, { name, aliases: values.alias });
        if (!r.ok) fail(r.envelope.message);
        console.log(`已创建成员:${r.member.name}(id: ${r.member.id},别名:[${r.member.aliases.join(", ")}])`);
        return;
      }
      if (sub === "list") {
        for (const m of listActiveMembers(db)) {
          const web = hasWebPassword(db, m.id) ? "查看页口令已设置" : "未设置查看页口令";
          console.log(`${m.id}  ${m.name}${m.aliases.length ? `(别名:${m.aliases.join("、")})` : ""}  [${web}]`);
        }
        return;
      }
      // 查看页口令(S6):部署时用这一条给每个成员设口令;测试也走它(保持与真实路径一致)。
      if (sub === "set-password") {
        const { values, positionals } = parseArgs({
          args: rest.slice(1),
          options: { password: { type: "string" } },
          allowPositionals: true,
        });
        const ref = positionals[0];
        if (typeof ref !== "string" || ref === "") fail("member set-password 需要 <name|id>");
        const r = resolveMemberRef(db, ref);
        if (!r.ok) fail(`没有找到成员「${ref}」;先 member list 查看。`);
        const member = r.ok ? r.member : undefined;
        if (!member) fail("unreachable");
        // 不给 --password 就随机生成:明文**只在这里打印一次**,之后无法从库里取回。
        const generated = values.password === undefined;
        const plain = values.password ?? generateWebPassword();
        if (plain === "") fail("口令不能为空。");
        setMemberWebPassword(db, member.id, plain);
        console.log(`成员:${member.name}(id: ${member.id})`);
        if (generated) {
          console.log("查看页口令(随机生成,**只显示这一次**,请立刻抄下来):");
          console.log(`  ${plain}`);
          console.log();
          console.log(`# 登录地址(需先显式配置 FA_WEB_HOST=<局域网网卡地址> 才能从手机访问):`);
          console.log(`#   http://${config.webHost}:${config.webPort}/login`);
        } else {
          console.log("查看页口令已设置(明文由你自己指定,不回显、不落库)。");
        }
        console.log("# 库里只存 scrypt 哈希;局域网内没有 HTTPS,口令会以明文经过 Wi-Fi(设计 §10 R9)。");
        return;
      }
      if (sub === "clear-password") {
        const ref = rest[1];
        if (!ref) fail("member clear-password 需要 <name|id>");
        const r = resolveMemberRef(db, ref);
        if (!r.ok) fail(`没有找到成员「${ref}」;先 member list 查看。`);
        const member = r.ok ? r.member : undefined;
        if (!member) fail("unreachable");
        if (!hasWebPassword(db, member.id)) {
          console.log(`成员 ${member.name} 本来就没有查看页口令,无需清除。`);
          return;
        }
        clearMemberWebPassword(db, member.id);
        console.log(`已清除 ${member.name} 的查看页口令:该成员此后无法登录查看页,已有会话一并失效。`);
        return;
      }
      if (sub === "remove") {
        const ref = rest[1];
        if (!ref) fail("member remove 需要 <name|id>");
        const r = softDeleteMember(db, ref);
        if (!r.ok) fail(r.envelope.message);
        console.log(`已软删成员:${r.member.name}(名下数据保留;该成员的 token 已一并失效)`);
        return;
      }
      fail(`未知子命令:member ${sub ?? ""}`);
    }

    if (cmd === "token") {
      const sub = rest[0];
      if (sub === "generate") {
        const { values, positionals } = parseArgs({
          args: rest.slice(1),
          options: { label: { type: "string", default: "hermes profile" } },
          allowPositionals: true,
        });
        const ref = positionals[0];
        if (typeof ref !== "string" || ref === "") fail("token generate 需要 <name|id>");
        const r = resolveMemberRef(db, ref);
        if (!r.ok) fail(`没有找到成员「${ref}」;先 member list 查看。`);
        const member = r.ok ? r.member : undefined;
        if (!member) fail("unreachable");
        const issued = issueToken(db, member.id, values.label ?? "hermes profile");
        console.log(`成员:${member.name}(id: ${member.id})`);
        console.log(`token(id: ${issued.id},明文只显示这一次,请立即写入 Hermes 配置):`);
        console.log(`  ${issued.token}`);
        console.log();
        console.log(`# 写入该成员 profile 的 ~/.hermes/profiles/${member.name}/config.yaml`);
        console.log(`mcp_servers:`);
        console.log(`  family:`);
        console.log(`    url: "http://127.0.0.1:${config.mcpPort}/mcp"`);
        console.log(`    headers:`);
        console.log(`      Authorization: "Bearer ${issued.token}"`);
        console.log(`      # 身份声明头(必填):值必须是本成员的 id(HTTP 头只允许 ASCII,不能填中文名)。`);
        console.log(`      # 缺失或与 token 归属不一致,一律 DENIED(identity_mismatch)——S7 的响亮失败通道。`);
        console.log(`      ${headerDisplayName(config.identityHeader)}: "${member.id}"`);
        return;
      }
      if (sub === "list") {
        const { values } = parseArgs({
          args: rest.slice(1),
          options: { member: { type: "string" } },
          allowPositionals: true,
        });
        let memberId: string | undefined;
        if (typeof values.member === "string") {
          const r = resolveMemberRef(db, values.member);
          if (!r.ok) fail(`没有找到成员「${values.member}」`);
          memberId = r.ok ? r.member.id : undefined;
        }
        for (const t of listTokens(db, memberId)) {
          const state = t.revoked_at ? `已吊销(${t.revoked_at})` : "有效";
          console.log(`${t.id}  ${t.member_name}  ${t.label}  ${state}`);
        }
        return;
      }
      if (sub === "revoke") {
        const id = rest[1];
        if (!id) fail("token revoke 需要 <tokenId>(token list 里查)");
        if (revokeToken(db, id)) {
          console.log(`已吊销 token:${id}`);
        } else {
          fail(`没有找到可吊销的 token:${id}`);
        }
        return;
      }
      fail(`未知子命令:token ${sub ?? ""}`);
    }

    fail(`未知命令:${cmd}`);
  } finally {
    db.close();
  }
}

main();
