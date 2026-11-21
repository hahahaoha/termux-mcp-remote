#!/usr/bin/env node
// Agent 守护进程入口：tmcp start 会在后台拉起它。
import { Agent, VERSION } from "./agent.js";
import { loadConfig, isConfigured, writePid, clearPid, ensureDirs, STATE_DIR, LOG_DIR } from "./config.js";
import path from "node:path";

const cfg = loadConfig();
if (!isConfigured(cfg)) {
  console.error("尚未配置。请先运行：tmcp setup");
  process.exit(2);
}

ensureDirs();
writePid(process.pid);

const agent = new Agent({ ...cfg, jobsDir: path.join(STATE_DIR, "jobs"), logDir: LOG_DIR });

console.log(`[${new Date().toISOString()}] termux-mcp-remote agent v${VERSION} 启动`);
console.log(`[${new Date().toISOString()}] worker=${cfg.workerUrl} name=${cfg.name}`);

agent.start();

let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`[${new Date().toISOString()}] 收到 ${sig}，正在退出`);
  try { agent.stop(); } catch { }
  clearPid();
  setTimeout(() => process.exit(0), 300).unref();
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => shutdown(sig));
// Termux 环境里这些信号常见，忽略以免误退出
for (const sig of ["SIGUSR1", "SIGUSR2"]) process.on(sig, () => { });
process.on("exit", () => clearPid());
process.on("uncaughtException", (e) => console.error("uncaughtException:", e?.stack || e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e?.stack || e));
