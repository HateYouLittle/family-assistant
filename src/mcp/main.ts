import { loadConfig } from "../config.js";
import { openDb } from "../db/db.js";
import { migrate } from "../db/migrations.js";
import { startServer } from "./http.js";

const config = loadConfig();
const db = openDb(config.dbPath);
migrate(db);

const app = await startServer(db, config);
console.log(`[family-assistant] MCP 端点:http://${config.mcpHost}:${config.mcpPort}/mcp`);
console.log(`[family-assistant] 时区:${config.timezone} · 数据库:${config.dbPath}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n[family-assistant] 收到 ${signal},正在关闭…`);
    void app.close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}
