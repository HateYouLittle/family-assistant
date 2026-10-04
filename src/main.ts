import { loadConfig } from "./config.js";
import { openDb } from "./db/db.js";
import { migrate } from "./db/migrations.js";
import { startServer } from "./mcp/http.js";
import { startWebServer } from "./web/http.js";

/**
 * 服务端进程入口:**同一进程两个 HTTP 门面**(设计方案 §2 的架构图)。
 *
 * - `/mcp` 绑 `FA_MCP_HOST`(缺省 127.0.0.1):D2 要求的"外部无法触及",这条不因为加了查看页而放松。
 * - 查看页绑 `FA_WEB_HOST`(缺省**也是** 127.0.0.1):需要家人手机访问时**显式**设成
 *   局域网网卡地址,例如 `FA_WEB_HOST=192.168.1.23 npm start`。
 *
 * 缺省即回环的含义:**"忘了配"的后果是打不开,而不是把家庭数据挂到整个局域网。**
 * 需要"这条机器的哪个网卡"时用 0.0.0.0(会连所有网卡一起暴露),一般不需要。
 *
 * 注意:**局域网内没有 HTTPS**,查看页口令以明文经过 Wi-Fi —— 家庭自托管的已知代价
 * (设计方案 §10 的 R9),README 与页脚都写着,不假装不存在。
 */
const config = loadConfig();
const db = openDb(config.dbPath);
migrate(db);

const mcpApp = await startServer(db, config);
const webApp = await startWebServer(db, config);

console.log(`[family-assistant] MCP 端点:http://${config.mcpHost}:${config.mcpPort}/mcp(仅回环)`);
console.log(`[family-assistant] 查看页:http://${config.webHost}:${config.webPort}/login`);
if (config.webHost === "127.0.0.1" || config.webHost === "localhost") {
  console.log(
    "[family-assistant] 查看页当前只绑回环,家人手机还打不开。" +
      "需要局域网访问时显式设置 FA_WEB_HOST=<局域网网卡地址>(例如 192.168.1.23)。",
  );
}
console.log(`[family-assistant] 时区:${config.timezone} · 数据库:${config.dbPath}`);
console.log("[family-assistant] 提醒:局域网内没有 HTTPS,口令以明文经过 Wi-Fi(设计 §10 R9)。");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n[family-assistant] 收到 ${signal},正在关闭…`);
    void Promise.all([webApp.close(), mcpApp.close()]).finally(() => {
      db.close();
      process.exit(0);
    });
  });
}
