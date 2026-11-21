#!/usr/bin/env node
// 守护进程：把 Agent 作为子进程运行，异常退出时自动重启。
// Android 上进程可能被系统回收，靠这个 + Termux:Boot 保证长期可用。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { STATE_DIR, LOG_DIR, ensureDirs, clearPid } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(__dirname, "daemon.js");
const SUP_PID = path.join(STATE_DIR, "supervisor.pid");
const OUT = path.join(LOG_DIR, "agent.log");
const ERR = path.join(LOG_DIR, "agent.err.log");
const SUP_LOG = path.join(LOG_DIR, "supervisor.log");

ensureDirs();

// stdout 已被 tmcp start 重定向到 supervisor.log，这里只写控制台，避免重复
function log(msg) {
  console.log(`[${new Date().toISOString()}] [supervisor] ${msg}`);
}

fs.writeFileSync(SUP_PID, String(process.pid), { mode: 0o600 });

let child = null;
let stopping = false;
let restarts = 0;
let lastStart = 0;

function startChild() {
  if (stopping) return;
  lastStart = Date.now();
  const out = fs.openSync(OUT, "a");
  const err = fs.openSync(ERR, "a");
  child = spawn(process.execPath, [DAEMON], {
    stdio: ["ignore", out, err],
    cwd: path.dirname(__dirname),
    env: { ...process.env },
  });
  log(`启动 Agent pid=${child.pid}（第 ${restarts + 1} 次）`);

  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) {
      log("Agent 已停止，守护进程退出");
      cleanupAndExit(0);
      return;
    }
    const ranMs = Date.now() - lastStart;
    // 运行超过 30 秒才恢复正常计数，避免崩溃循环把电池耗光
    if (ranMs > 30_000) restarts = 0;
    else restarts++;

    if (restarts >= 10) {
      log(`Agent 连续 ${restarts} 次快速退出，暂停 5 分钟后重试（最近退出 code=${code} signal=${signal}）`);
      setTimeout(() => { restarts = 0; startChild(); }, 5 * 60_000);
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** restarts);
    log(`Agent 退出 code=${code} signal=${signal}，${Math.round(delay / 1000)}s 后重启`);
    setTimeout(startChild, delay);
  });
}

function cleanupAndExit(code) {
  try { fs.unlinkSync(SUP_PID); } catch { }
  try { clearPid(); } catch { }
  process.exit(code);
}

function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log(`收到 ${sig}，停止 Agent`);
  // 先让 daemon 优雅退出，3 秒后强杀
  if (child) {
    try { child.kill("SIGTERM"); } catch { }
    setTimeout(() => {
      try { child && !child.killed && child.kill("SIGKILL"); } catch { }
      cleanupAndExit(0);
    }, 3000).unref();
  } else {
    cleanupAndExit(0);
  }
}

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => shutdown(sig));
for (const sig of ["SIGUSR1", "SIGUSR2"]) process.on(sig, () => { });
process.on("exit", () => { try { fs.unlinkSync(SUP_PID); } catch { } });
process.on("uncaughtException", (e) => log("uncaughtException: " + (e?.stack || e)));
process.on("unhandledRejection", (e) => log("unhandledRejection: " + (e?.stack || e)));

// 定期检查子进程是否卡死（pid 存活就交给 WebSocket 心跳处理）
setInterval(() => {
  if (!stopping && !child) {
    log("检测到 Agent 不在运行，重启");
    startChild();
  }
}, 60_000);

log(`守护进程启动 pid=${process.pid}`);
startChild();
