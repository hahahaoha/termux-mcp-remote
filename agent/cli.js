#!/usr/bin/env node
// tmcp —— termux-mcp-remote 的命令行工具
// 用法: tmcp [setup|deploy|start|stop|restart|status|logs|token|url|test|doctor|menu]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectPlatform, deviceName } from "./platform.js";
import {
  loadConfig, saveConfig, isConfigured, normalizeUrl, randomToken,
  readPid, pidAlive, clearPid, ensureDirs, CONFIG_PATH, LOG_DIR, STATE_DIR,
  SUP_PID_PATH,
} from "../agent/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DAEMON = path.join(ROOT, "agent", "daemon.js");
const SUPERVISOR = path.join(ROOT, "agent", "supervisor.js");
const WORKER_DIR = path.join(ROOT, "worker");
const OUT_LOG = path.join(LOG_DIR, "agent.log");
const ERR_LOG = path.join(LOG_DIR, "agent.err.log");

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? {
    b: "\x1b[1m", dim: "\x1b[2m", r: "\x1b[0m",
    g: "\x1b[32m", y: "\x1b[33m", red: "\x1b[31m", c: "\x1b[36m", m: "\x1b[35m",
  }
  : Object.fromEntries(["b", "dim", "r", "g", "y", "red", "c", "m"].map((k) => [k, ""]));

let rl = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IS_TTY = !!process.stdin.isTTY;
let piped = null;
function pipedNext() {
  if (!piped) piped = { lines: readPiped(), i: 0 };
  return piped.i < piped.lines.length ? piped.lines[piped.i++] : "";
}

const args = process.argv.slice(2);
const cmd = args[0] || "menu";
const flags = new Set(args.slice(1));

main().catch((e) => {
  console.error(`${C.red}错误：${e?.message || e}${C.r}`);
  process.exit(1);
});

async function main() {
  switch (cmd) {
    case "menu": return menu();
    case "setup": return setup({ force: flags.has("--force") });
    case "deploy": return deploy();
    case "start": return start();
    case "stop": return stop();
    case "restart": return restartCmd();
    case "status": return status();
    case "logs": return logs();
    case "token": return tokenCmd();
    case "url": return urlCmd();
    case "test": return test();
    case "doctor": return doctor();
    case "panel": return panel();
    case "domain": return domainCmd();
    case "admin-pass": case "passwd": return adminPassCmd();
    case "help": case "-h": case "--help": return help();
    case "-v": case "--version": return version();
    default:
      console.error(`未知命令：${cmd}`);
      help();
      process.exit(1);
  }
}

// ============================ 交互基础 ============================
// 非 TTY（管道/脚本）时退化为逐行读取，方便自动化；TTY 时提供隐藏输入
function readPiped() {
  try { return fs.readFileSync(0, "utf8").split(/\r?\n/); } catch { return []; }
}

function ask(question, { def = "", mask = false } = {}) {
  const suffix = def ? ` ${C.dim}[${mask ? "已设置" : def}]${C.r}` : "";
  if (!IS_TTY) {
    const line = pipedNext();
    process.stdout.write(`${question}${suffix} ${mask && line ? "***" : line}\n`);
    return Promise.resolve(String(line || def).trim());
  }
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (!mask) {
    return new Promise((resolve) => {
      rl.question(`${C.c}?${C.r} ${question}${suffix} `, (a) => resolve(a.trim() || def));
    });
  }
  // 隐藏输入
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk) => {
      const s = String(chunk);
      for (const ch of s) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          process.stdin.removeListener("data", onData);
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdout.write("\n");
          resolve(buf || def);
          return;
        }
        if (ch === "\u0003") { process.stdout.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") {
          if (buf.length) { buf = buf.slice(0, -1); process.stdout.write("\b \b"); }
        } else if (ch >= " ") {
          buf += ch;
          process.stdout.write("*");
        }
      }
    };
    process.stdout.write(`${C.c}?${C.r} ${question}${suffix} `);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
function closeRl() { try { rl?.close(); } catch { } rl = null; }

function hr(title) {
  console.log(`\n${C.b}${C.m}${title}${C.r}`);
  console.log(`${C.dim}${"─".repeat(Math.min(60, Math.max(20, title.length * 2)))}${C.r}`);
}
function tip(s) { console.log(`${C.dim}${s}${C.r}`); }
function good(s) { console.log(`${C.g}✓${C.r} ${s}`); }
function warn(s) { console.log(`${C.y}!${C.r} ${s}`); }
function bad(s) { console.log(`${C.red}✗${C.r} ${s}`); }

function help() {
  console.log(`${C.b}termux-mcp-remote${C.r} —— 用 Cloudflare Worker 远程使用 Termux 终端

${C.b}用法${C.r}
  tmcp                 交互式菜单
  tmcp setup           配置向导（首次使用）
  tmcp deploy          用 wrangler 部署 Worker 并自动写入密钥
  tmcp start           后台启动 Agent（守护进程）
  tmcp stop            停止 Agent
  tmcp status          查看连接状态
  tmcp logs [-f]       查看日志
  tmcp token [rotate]  查看 / 轮换访问令牌
  tmcp url <地址>      修改 Worker 地址
  tmcp test            本地自检（MCP 握手 + 工具调用）
  tmcp doctor          环境体检
  tmcp panel           本地应急面板（只监听 127.0.0.1；日常用 Worker 的 /admin）
  tmcp domain          给 Worker 绑定自有域名（解决 workers.dev 被污染）
  tmcp admin-pass      设置 / 重置后台登录密码（与 API token 无关）

${C.b}典型流程${C.r}
  tmcp deploy      ${C.dim}# 一次性，部署 Worker 并生成 token${C.r}
  tmcp setup       ${C.dim}# 确认地址（直接回车用刚部署的）${C.r}
  tmcp start       ${C.dim}# 让手机连上 Worker${C.r}

${C.b}客户端配置${C.r}
  URL:      https://<你的-worker>/mcp
  请求头:   Authorization: Bearer <AUTH_TOKEN>
`);
}

async function version() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  console.log(`termux-mcp-remote v${pkg.version}`);
  console.log(`config: ${CONFIG_PATH}`);
  console.log(`node:   ${process.version}`);
}

// ============================ 菜单 ============================
async function menu() {
  ensureDirs();
  const cfg = loadConfig();
  console.log(`\n${C.b}${C.m}termux-mcp-remote${C.r} ${C.dim}· 手机终端远程 MCP · Cloudflare Worker${C.r}`);
  const pid = readPid();
  const running = pidAlive(pid);
  console.log(`${running ? `${C.g}● Agent 运行中${C.r} ${C.dim}pid=${pid}${C.r}` : `${C.dim}○ Agent 未运行${C.r}`}`);
  console.log(`${cfg.workerUrl ? `${C.dim}Worker:${C.r} ${cfg.workerUrl}` : `${C.y}尚未配置 Worker 地址${C.r}`}`);
  if (cfg.workerUrl) console.log(`${C.dim}管理界面:${C.r} ${cfg.workerUrl}/admin\n`);

  const items = [
    ["1", "配置向导（setup）", setup],
    ["2", "启动 Agent", start],
    ["3", "停止 Agent", stop],
    ["4", "查看状态", status],
    ["5", "查看日志", logs],
    ["6", "部署 / 更新 Worker", deploy],
    ["7", "查看令牌", tokenCmd],
    ["8", "本地自检", test],
    ["9", "环境体检", doctor],
    ["p", "管理面板", panel],
    ["q", "退出", null],
  ];
  for (const [k, label] of items) console.log(`  ${C.c}${k}${C.r}  ${label}`);
  const pick = await ask("\n选择", { def: "q" });
  closeRl();
  const item = items.find(([k]) => k === pick.toLowerCase());
  if (item && item[2]) await item[2]();
  else if (pick.toLowerCase() !== "q") { warn("没有这个选项"); }
}

// ============================ setup ============================
async function setup({ force = false } = {}) {
  ensureDirs();
  const cfg = loadConfig();
  if (isConfigured(cfg) && !force) {
    console.log(`\n当前配置已存在：${CONFIG_PATH}`);
    const again = await ask("重新配置？(y/N)", { def: "N" });
    if (!/^y/i.test(again)) { closeRl(); return; }
  }

  hr("配置向导");
  console.log("这一步只需要填 Worker 地址。它由「tmcp deploy」部署后给出，形如：");
  tip("   https://termux-mcp.你的账号.workers.dev");
  tip("   或你自己的域名：https://mcp.example.com");
  console.log("");
  const urlIn = await ask("Worker 地址", { def: cfg.workerUrl || "" });
  if (!urlIn) { bad("地址不能为空"); closeRl(); return; }
  const workerUrl = normalizeUrl(urlIn);
  if (!/^https?:\/\//.test(workerUrl)) { bad("地址格式不对，应以 http(s):// 开头"); closeRl(); return; }

  // 尝试从 Worker 读取公开健康信息，确认可达
  process.stdout.write(`${C.dim}正在检查地址是否可达…${C.r}\n`);
  let reachable = false;
  try {
    const r = await fetch(`${workerUrl}/api/health`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    reachable = r.ok && j.ok;
    if (reachable) good(`服务器响应正常（v${j.version}）`);
    else warn(`服务器返回 HTTP ${r.status}，可能地址不对或尚未部署`);
  } catch (e) {
    warn(`无法访问 ${workerUrl}/api/health：${e.message}`);
    const go = await ask("仍然保存这个地址？(y/N)", { def: "N" });
    if (!/^y/i.test(go)) { closeRl(); return; }
  }

  const authIn = await ask("AUTH_TOKEN（AI 客户端用，留空则自动生成）", { def: cfg.authToken || "", mask: true });
  const authToken = authIn && authIn.length >= 16 ? authIn : randomToken(32);
  const agentIn = await ask("AGENT_TOKEN（手机连接用，留空则自动生成）", { def: cfg.agentToken || "", mask: true });
  const agentToken = agentIn && agentIn.length >= 16 ? agentIn : randomToken(32);

  const nameIn = await ask("设备名（显示用）", { def: cfg.name || defaultDeviceName() });

  const saved = saveConfig({ ...cfg, workerUrl, authToken, agentToken, name: nameIn });
  good(`配置已保存：${CONFIG_PATH}（权限 600）`);

  console.log(`\n${C.b}接下来${C.r}`);
  console.log(`  1) 把这两个值同步到 Worker（若用 tmcp deploy 部署会自动同步）：`);
  console.log(`     AUTH_TOKEN  = ${C.dim}${authToken.slice(0, 6)}…${authToken.slice(-4)}${C.r}`);
  console.log(`     AGENT_TOKEN = ${C.dim}${agentToken.slice(0, 6)}…${agentToken.slice(-4)}${C.r}`);
  console.log(`     手工同步：cd ${WORKER_DIR} && npx wrangler secret put AUTH_TOKEN`);
  console.log(`  2) 启动：${C.c}tmcp start${C.r}`);
  console.log(`  3) 客户端填：${C.c}${saved.workerUrl}/mcp${C.r} + 请求头 ${C.dim}Authorization: Bearer <AUTH_TOKEN>${C.r}`);
  console.log(`  4) 管理界面：${C.c}${saved.workerUrl}/admin${C.r} ${C.dim}（用 AUTH_TOKEN 登录）${C.r}`);
  closeRl();

  const go = await ask("\n现在启动 Agent？(Y/n)", { def: "Y" });
  closeRl();
  if (!/^n/i.test(go)) await start();
}

// ============================ deploy ============================
async function deploy() {
  ensureDirs();
  hr("部署 Worker");
  if (!commandExists("npx")) {
    bad("找不到 npx，请先：pkg install nodejs-lts");
    return;
  }
  if (!fs.existsSync(path.join(WORKER_DIR, "node_modules"))) {
    console.log(`${C.dim}首次部署，安装依赖…${C.r}`);
    const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: WORKER_DIR, stdio: "inherit" });
    if (r.status !== 0) { bad("依赖安装失败"); return; }
  }

  const WR = wranglerCmd();
  if (!WR) { bad("找不到 wrangler，请先：npm i -g wrangler"); return; }
  console.log(`${C.dim}使用 ${WR.display}${C.r}`);

  console.log(`${C.dim}检查 Cloudflare 登录状态…${C.r}`);
  const who = spawnSync(WR.cmd, [...WR.pre, "whoami"], { cwd: WORKER_DIR, encoding: "utf8", timeout: 120000 });
  const whoOut = (who.stdout || "") + (who.stderr || "");
  if (!/You are logged in/i.test(whoOut)) {
    bad("尚未登录 Cloudflare");
    console.log(`请先执行：${C.c}cd ${WORKER_DIR} && npx wrangler login${C.r}`);
    console.log(`${C.dim}登录后用浏览器授权即可，token 会存在本机。${C.r}`);
    return;
  }
  const email = /associated with the email (\S+)/i.exec(whoOut)?.[1];
  good(`已登录${email ? `：${email}` : ""}`);

  // 复用已有配置里的 token，没有就生成
  const cfg = loadConfig();
  const authToken = cfg.authToken || randomToken(32);
  const agentToken = cfg.agentToken || randomToken(32);
  saveConfig({ ...cfg, authToken, agentToken });

  console.log(`\n${C.dim}写入 Worker 密钥…${C.r}`);
  const secrets = JSON.stringify({ AUTH_TOKEN: authToken, AGENT_TOKEN: agentToken });
  const put = spawnSync(WR.cmd, [...WR.pre, "secret", "bulk"], {
    cwd: WORKER_DIR, input: secrets, encoding: "utf8", timeout: 180000,
  });
  if (put.status !== 0) {
    bad("密钥写入失败");
    console.log((put.stderr || "").slice(-1500));
    return;
  }
  good("AUTH_TOKEN / AGENT_TOKEN 已写入");

  console.log(`${C.dim}部署中…${C.r}`);
  const dep = spawnSync(WR.cmd, [...WR.pre, "deploy"], { cwd: WORKER_DIR, encoding: "utf8", timeout: 300000 });
  const out = (dep.stdout || "") + (dep.stderr || "");
  if (dep.status !== 0) {
    bad("部署失败");
    console.log(out.slice(-2500));
    return;
  }
  const m = /https:\/\/[a-z0-9-]+\.[a-z0-9.-]*workers\.dev/i.exec(out);
  const deployedUrl = m ? m[0] : "";
  console.log(out.split("\n").filter((l) => /Uploaded|Deployed|https:\/\//i.test(l)).join("\n"));
  good("Worker 已部署");

  if (deployedUrl) {
    const keep = cfg.workerUrl && cfg.workerUrl !== deployedUrl;
    const useIt = !keep ? "Y" : await ask(`当前配置的地址是 ${cfg.workerUrl}，改用 ${deployedUrl}？(y/N)`, { def: "N" });
    closeRl();
    if (/^y/i.test(useIt)) {
      saveConfig({ ...loadConfig(), workerUrl: deployedUrl, authToken, agentToken });
      good(`已更新地址：${deployedUrl}`);
    } else if (!cfg.workerUrl) {
      saveConfig({ ...loadConfig(), workerUrl: deployedUrl, authToken, agentToken });
      good(`已保存地址：${deployedUrl}`);
    }
  }

  const final = loadConfig();
  console.log(`\n${C.b}客户端配置${C.r}`);
  console.log(JSON.stringify({
    mcpServers: {
      termux: {
        type: "http",
        url: `${final.workerUrl}/mcp`,
        headers: { Authorization: `Bearer ${final.authToken}` },
      },
    },
  }, null, 2));
  console.log(`\n${C.b}下一步${C.r}  ${C.c}tmcp start${C.r}`);
  console.log(`${C.b}管理界面${C.r}  ${C.c}${final.workerUrl}/admin${C.r} ${C.dim}（用 AUTH_TOKEN 登录，可看设备/日志、改默认设备、轮换 token）${C.r}`);
}

// ============================ start / stop ============================
async function start() {
  ensureDirs();
  const cfg = loadConfig();
  if (!isConfigured(cfg)) {
    bad("尚未配置，请先运行：tmcp setup");
    return;
  }
  const pid = readPid();
  if (pidAlive(pid)) {
    // 可能是上一个实例正在退出（restart 场景）：等它退干净再继续
    for (let i = 0; i < 25 && pidAlive(pid); i++) await sleep(200);
    if (pidAlive(pid)) {
      good(`Agent 已在运行（pid=${pid}）`);
      return;
    }
  }
  clearPid();

  // Termux 上顺手拿个唤醒锁（其他系统没有这个命令，静默跳过）
  if (detectPlatform().isTermux) {
    try { spawnSync("termux-wake-lock", [], { timeout: 5000 }); } catch { }
  }

  const supLog = path.join(LOG_DIR, "supervisor.log");
  const out = fs.openSync(supLog, "a");
  const err = fs.openSync(supLog, "a");
  const child = spawn(process.execPath, [SUPERVISOR], {
    detached: true,
    stdio: ["ignore", out, err],
    cwd: ROOT,
    env: { ...process.env },
  });
  child.unref();

  // 等它自己写 pid 并连上 Worker
  let ok = false;
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    const p = readPid();
    if (pidAlive(p)) { ok = true; break; }
    if (child.exitCode !== null) break;
  }
  if (!ok) {
    bad("启动失败，最近日志：");
    console.log(tailFile(ERR_LOG, 1200) || tailFile(OUT_LOG, 1200) || "(无输出)");
    return;
  }
  good(`Agent 已启动（pid=${readPid()}）`);

  // 顺便确认链路上线
  for (let i = 0; i < 8; i++) {
    await sleep(700);
    let s = null;
    try { s = await fetchStatus(cfg); } catch (e) {
      if (/401/.test(String(e.message))) {
        bad("Worker 拒绝了 AUTH_TOKEN（401）：本地 token 与 Worker 上的密钥不一致");
        console.log(`${C.dim}修复：cd ${WORKER_DIR} && npx wrangler secret put AUTH_TOKEN，粘贴：${cfg.authToken}${C.r}`);
        console.log(`${C.dim}或在 WebUI（${cfg.workerUrl}/admin）登录后查看当前 token，再执行 tmcp token sync 同步。${C.r}`);
        return;
      }
    }
    if (s?.agent?.online) {
      good(`已连上 Worker，Agent 在线（${s.agent.name || cfg.name}）`);
      console.log(`${C.dim}MCP 端点：${cfg.workerUrl}/mcp${C.r}`);
      console.log(`${C.dim}管理界面：${cfg.workerUrl}/admin${C.r}`);
      return;
    }
  }
  warn("进程已启动，但暂未确认 Worker 侧在线。用 tmcp status 或 tmcp logs -f 查看");
}

// 重启：必须先把「延时启动器」派生到独立进程组，再停服务。
// 否则如果本命令是通过 MCP 的 job_start 起的，agent 停机时 jobs.killAll()
// 会连带杀掉本进程（日志里表现为 exit=null signal=SIGKILL），结果只停了没起。
async function restartCmd() {
  spawnDetachedStarter();
  await stop({ quiet: true });
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const p = readPid();
    if (pidAlive(p)) {
      good(`Agent 已重启（pid=${p}）`);
      await confirmOnline();
      return;
    }
  }
  warn("重启命令已下发，但还没确认进程启动。稍后用 tmcp status 查看");
}

// 重启后确认隧道真的连回来了（而不是只有进程活着）
async function confirmOnline() {
  const cfg = loadConfig();
  if (!cfg.workerUrl) return;
  for (let i = 0; i < 10; i++) {
    await sleep(700);
    try {
      const s = await fetchStatus(cfg);
      const n = (s.agent?.devices || []).length;
      if (n > 0) {
        good(`已连上 Worker（${n} 台设备在线）`);
        return;
      }
    } catch { }
  }
  warn("进程已启动，但暂未确认在线。用 tmcp status 复查");
}

// 独立进程组里跑 `cli.js start`，不受 agent 停机时的 killAll 影响
function spawnDetachedStarter() {
  try {
    const log = fs.openSync(path.join(LOG_DIR, "restart.log"), "a");
    const cli = path.join(ROOT, "agent", "cli.js");
    const child = spawn("bash", ["-c", `sleep 1; exec "${process.execPath}" "${cli}" start`], {
      detached: true,
      stdio: ["ignore", log, log],
      cwd: ROOT,
      env: { ...process.env },
    });
    child.unref();
  } catch (e) {
    warn(`派生启动器失败：${e.message}`);
  }
}

async function stop({ quiet = false } = {}) {
  const supPid = readSupPid();
  if (pidAlive(supPid)) {
    try { process.kill(supPid, "SIGTERM"); } catch { }
    for (let i = 0; i < 25; i++) {
      await sleep(200);
      if (!pidAlive(supPid)) break;
    }
    if (pidAlive(supPid)) { try { process.kill(supPid, "SIGKILL"); } catch { } }
  }

  const pid = readPid();
  if (!pidAlive(pid)) {
    clearPid();
    if (!quiet) warn("Agent 未运行");
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch { }
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    if (!pidAlive(pid)) break;
  }
  if (pidAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { }
    warn("进程未响应 SIGTERM，已强制结束");
  } else if (!quiet) {
    good(`Agent 已停止（pid=${pid}）`);
  }
  clearPid();
  if (detectPlatform().isTermux) {
    try { spawnSync("termux-wake-unlock", [], { timeout: 5000 }); } catch { }
  }
}

// ============================ status ============================
async function fetchStatus(cfg) {
  const r = await fetch(`${cfg.workerUrl}/api/status`, {
    headers: { authorization: `Bearer ${cfg.authToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (r.ok) return r.json();

  // AUTH_TOKEN 可能已经在 WebUI 上被轮换过。用设备自己的 AGENT_TOKEN 取回当前值，
  // 顺手写回本地配置——AUTH_TOKEN 只用于调 /mcp，自动同步不影响安全边界。
  if (r.status === 401 && cfg.agentToken) {
    const healed = await tryHealToken(cfg);
    if (healed) {
      const r2 = await fetch(`${cfg.workerUrl}/api/status`, {
        headers: { authorization: `Bearer ${healed}` },
        signal: AbortSignal.timeout(15000),
      });
      if (r2.ok) {
        good("AUTH_TOKEN 已过期，已用设备凭证自动同步");
        return r2.json();
      }
    }
  }
  const t = await r.text().catch(() => "");
  throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`);
}

// 用 AGENT_TOKEN 读取 Worker 上的 AUTH_TOKEN 并写回本地配置
async function tryHealToken(cfg) {
  try {
    const r = await fetch(`${cfg.workerUrl}/api/admin/reveal-token`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.agentToken}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "auth" }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.ok || typeof j.token !== "string" || !j.token) return null;
    if (j.token === cfg.authToken) return null;
    saveConfig({ ...loadConfig(), authToken: j.token });
    return j.token;
  } catch {
    return null;
  }
}

async function status() {
  const cfg = loadConfig();
  const pid = readPid();
  const running = pidAlive(pid);
  hr("状态");
  const supPid = readSupPid();
  const supRunning = pidAlive(supPid);
  console.log(`本地 Agent   ${running ? `${C.g}运行中${C.r}（pid=${pid}）` : `${C.dim}未运行${C.r}`}`);
  console.log(`守护进程     ${supRunning ? `${C.g}运行中${C.r}（pid=${supPid}，崩溃自动重启）` : `${C.dim}未运行${C.r}`}`);
  console.log(`Worker 地址  ${cfg.workerUrl || `${C.y}未配置${C.r}`}`);
  if (!cfg.workerUrl || !cfg.authToken) return;

  try {
    const s = await fetchStatus(cfg);
    const a = s.agent || {};
    const devices = a.devices || [];
    console.log(`Worker       ${C.g}在线${C.r}（v${s.worker?.version}）`);
    if (devices.length) {
      console.log(`设备         ${C.g}${devices.length} 台在线${C.r}`);
      for (const d of devices) {
        const online = d.state === "ready";
        const mark = online ? `${C.g}●${C.r}` : `${C.y}○${C.r}`;
        const label = `${d.id}`.padEnd(20);
        const kind = [d.os, d.distro, d.arch].filter(Boolean).join(" · ");
        const def = a.defaultDevice === d.id ? ` ${C.dim}(默认)${C.r}` : "";
        console.log(`  ${mark} ${label} ${d.name || "-"}${def}`);
        console.log(`    ${C.dim}${kind || "-"}${d.version ? " · v" + d.version : ""} · 最后活跃 ${d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString("zh-CN") : "-"}${C.r}`);
      }
      console.log(`累计调用     ${a.calls ?? 0}（失败 ${a.errors ?? 0}，排队 ${a.pending ?? 0}）`);
    } else {
      console.log(`设备         ${C.y}无设备连接${C.r}`);
      console.log(`${C.dim}本机未连上 Worker。检查 tmcp logs，或稍等自动重连。${C.r}`);
    }
    console.log(`\nMCP 端点     ${cfg.workerUrl}/mcp`);
    console.log(`管理界面     ${cfg.workerUrl}/admin`);
  } catch (e) {
    bad(`查询 Worker 失败：${e.message}`);
  }
}

// ============================ logs ============================
async function logs() {
  ensureDirs();
  if (flags.has("-f") || flags.has("--follow")) {
    console.log(`${C.dim}跟踪 ${OUT_LOG}（Ctrl-C 退出）${C.r}`);
    const child = spawn("tail", ["-f", "-n", "80", OUT_LOG, ERR_LOG], { stdio: "inherit" });
    await new Promise((resolve) => {
      process.on("SIGINT", () => { child.kill(); resolve(); });
      child.on("exit", resolve);
    });
    return;
  }
  const n = Number([...flags].find((f) => /^-\d+$/.test(f))?.slice(1) || 60);
  console.log(`${C.dim}—— ${OUT_LOG} ——${C.r}`);
  console.log(tailFile(OUT_LOG, 20000, n) || "(空)");
  const errTail = tailFile(ERR_LOG, 8000, 20);
  if (errTail.trim()) {
    console.log(`\n${C.dim}—— ${ERR_LOG} ——${C.r}`);
    console.log(errTail);
  }
}

function readSupPid() {
  try {
    const pid = Number(fs.readFileSync(SUP_PID_PATH, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function tailFile(file, maxBytes, lines) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let s = buf.toString("utf8");
    if (lines) s = s.split("\n").slice(-lines).join("\n");
    return s;
  } catch { return ""; }
}

// ============================ token ============================
async function tokenCmd() {
  const cfg = loadConfig();

  // 从 Worker 拉取当前 token（在 WebUI 上轮换过之后用这个同步本机）
  if (args[1] === "sync") {
    if (!cfg.workerUrl) { bad("尚未配置 Worker 地址"); return; }
    const tryToken = args[2] || cfg.authToken;
    try {
      const r = await fetch(`${cfg.workerUrl}/api/admin/state`, {
        headers: { authorization: `Bearer ${tryToken}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        bad(`拉取失败：HTTP ${r.status}。请用 tmcp token sync <当前有效的 AUTH_TOKEN>`);
        return;
      }
      const j = await r.json();
      const next = { ...loadConfig(), authToken: j.authToken };
      saveConfig(next);
      good("已从 Worker 同步 AUTH_TOKEN");
      if (pidAlive(readPid())) {
        await stop({ quiet: true });
        await start();
      }
    } catch (e) {
      bad(`拉取失败：${e.message}`);
    }
    return;
  }

  const rotate = args[1] === "rotate";
  if (rotate) {
    const which = args[2] || "auth";
    if (!["auth", "agent"].includes(which)) { bad("用法：tmcp token rotate [auth|agent]"); return; }
    const next = randomToken(32);
    if (which === "auth") cfg.authToken = next; else cfg.agentToken = next;
    saveConfig(cfg);
    good(`已生成新的 ${which === "auth" ? "AUTH_TOKEN" : "AGENT_TOKEN"}`);
    warn("记得同步到 Worker：cd worker && npx wrangler secret put " + (which === "auth" ? "AUTH_TOKEN" : "AGENT_TOKEN"));
    if (which === "agent") warn("并重启 Agent：tmcp restart");
    return;
  }
  hr("令牌");
  console.log(`AUTH_TOKEN   ${cfg.authToken || "(未设置)"}`);
  console.log(`AGENT_TOKEN  ${cfg.agentToken || "(未设置)"}`);
  console.log(`\n${C.dim}客户端请求头：Authorization: Bearer <AUTH_TOKEN>${C.r}`);
  console.log(`${C.dim}在 Worker 的 /admin 上轮换过 token 后，用 tmcp token sync 把新值取回本机。${C.r}`);
  console.log(`${C.dim}轮换：tmcp token rotate auth | tmcp token rotate agent${C.r}`);
}

async function urlCmd() {
  const u = args[1];
  if (!u) { bad("用法：tmcp url https://xxx.workers.dev"); return; }
  const cfg = loadConfig();
  cfg.workerUrl = normalizeUrl(u);
  saveConfig(cfg);
  good(`Worker 地址已更新：${cfg.workerUrl}`);
  if (pidAlive(readPid())) {
    await stop({ quiet: true });
    await start();
  }
}

// ============================ test ============================
async function test() {
  ensureDirs();
  const cfg = loadConfig();
  if (!isConfigured(cfg)) { bad("尚未配置，请先 tmcp setup"); return; }
  hr("本地自检");

  console.log(`${C.dim}1/4 Worker 健康检查${C.r}`);
  try {
    const r = await fetch(`${cfg.workerUrl}/api/health`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    good(`Worker 在线 v${j.version}`);
  } catch (e) { bad(`不可达：${e.message}`); return; }

  console.log(`${C.dim}2/4 鉴权与隧道状态${C.r}`);
  let st;
  try {
    st = await fetchStatus(cfg);
    if (!st.agent?.online) { bad("Agent 未连接，先执行 tmcp start"); return; }
    good(`Agent 在线：${st.agent.name} v${st.agent.version}`);
  } catch (e) { bad(`失败：${e.message}`); return; }

  console.log(`${C.dim}3/4 MCP 握手${C.r}`);
  let sid = null;
  try {
    const init = await mcpCall(cfg, null, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tmcp-test", version: "1.0" } },
    });
    sid = init.headers.get("mcp-session-id");
    if (init.body?.result?.serverInfo) good(`握手成功：${init.body.result.serverInfo.name} v${init.body.result.serverInfo.version}`);
    else { bad(`握手异常：${JSON.stringify(init.body).slice(0, 300)}`); return; }
    await mcpCall(cfg, sid, { jsonrpc: "2.0", method: "notifications/initialized" }, { notify: true });
  } catch (e) { bad(`失败：${e.message}`); return; }

  console.log(`${C.dim}4/4 工具调用${C.r}`);
  try {
    const r = await mcpCall(cfg, sid, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "run_command", arguments: { command: "echo tmcp-ok; uname -m; date +%s" } },
    });
    const text = r.body?.result?.content?.[0]?.text || "";
    if (r.body?.result?.isError) { bad(`工具返回错误：${text.slice(0, 300)}`); return; }
    if (text.includes("tmcp-ok")) good("工具调用成功（run_command 已在手机上执行）");
    else warn(`调用完成但输出异常：${text.slice(0, 200)}`);
  } catch (e) { bad(`失败：${e.message}`); return; }

  console.log(`\n${C.g}${C.b}全部通过${C.r} —— 可以把这个地址填进 AI 客户端：`);
  console.log(`  ${cfg.workerUrl}/mcp`);
  console.log(`  ${C.dim}请求头 Authorization: Bearer <AUTH_TOKEN>${C.r}`);
}

async function mcpCall(cfg, sid, payload, { notify = false } = {}) {
  const headers = {
    authorization: `Bearer ${cfg.authToken}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  };
  if (sid) headers["mcp-session-id"] = sid;
  const r = await fetch(`${cfg.workerUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  let body = null;
  const text = await r.text();
  if (text.trim()) {
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      const line = text.split("\n").find((l) => l.startsWith("data:"));
      body = line ? JSON.parse(line.slice(5).trim()) : null;
    } else {
      try { body = JSON.parse(text); } catch { body = { raw: text }; }
    }
  }
  if (notify) return { headers: r.headers, body };
  if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 200)}`);
  return { headers: r.headers, body };
}

// ============================ panel ============================
async function panel() {
  const { startPanel } = await import("./panel.js");
  const port = Number(process.env.PANEL_PORT || 29201);
  const host = process.env.PANEL_HOST || "127.0.0.1";
  const server = startPanel({ port, host, log: (m) => good(m) });
  const url = `http://${host}:${port}/panel`;
  console.log(`\n本地面板：${C.c}${url}${C.r}`);
  console.log(`${C.dim}只监听 ${host}，不会暴露到公网。Ctrl-C 退出。${C.r}`);
  console.log(`${C.dim}远程管理用 Worker 的 /admin：${loadConfig().workerUrl}/admin${C.r}`);
  await new Promise((resolve) => {
    process.on("SIGINT", () => { server.close(); resolve(); });
    process.on("SIGTERM", () => { server.close(); resolve(); });
  });
}

// ============================ admin-pass ============================
// 后台密码只用于登录 WebUI；这里直接写 Worker，不需要旧密码（要 AUTH_TOKEN 证明身份）。
async function adminPassCmd() {
  hr("后台登录密码");
  const cfg = loadConfig();
  if (!cfg.workerUrl) { bad("尚未配置 Worker 地址，请先 tmcp setup"); return; }
  console.log(`${C.dim}这个密码只用于登录 ${cfg.workerUrl}/admin，与 AI 客户端使用的 AUTH_TOKEN 无关。${C.r}`);
  console.log(`${C.dim}服务端只保存 PBKDF2 哈希，忘记时用本命令重设。${C.r}\n`);

  const pw = await ask("新密码（至少 8 位，留空则清除密码）", { mask: true });
  closeRl();
  if (pw && pw.length < 8) { bad("密码至少 8 位"); return; }

  try {
    const r = await fetch(`${cfg.workerUrl}/api/auth/reset`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ password: pw }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) { bad(`失败：${j.error || "HTTP " + r.status}`); return; }
    if (pw) {
      good(`后台密码已设置（所有已登录会话已失效）`);
      console.log(`${C.dim}打开 ${cfg.workerUrl}/admin 用新密码登录。${C.r}`);
    } else {
      good("后台密码已清除，下次打开 /admin 会重新引导设置");
    }
  } catch (e) {
    bad(`请求失败：${e.message}`);
  }
}

// ============================ domain ============================
// *.workers.dev 在很多网络下会被 DNS 污染，绑自有域名是最省事的解法。
async function domainCmd() {
  hr("绑定自有域名");
  const cf = await import("./cf-api.js");
  const auth = cf.readWranglerAuth();
  if (!auth) {
    bad("找不到 wrangler 登录凭据，请先执行：wrangler login");
    return;
  }
  const cfg = loadConfig();

  let accounts, zones;
  try {
    accounts = await cf.listAccounts(auth.token);
    zones = await cf.listZones(auth.token);
  } catch (e) {
    bad(`读取 Cloudflare 账号失败：${e.message}`);
    console.log(`${C.dim}权限不足时，请在 Cloudflare Dashboard 手动添加 Workers 自定义域（Worker → Settings → Domains & Routes）。${C.r}`);
    return;
  }
  if (!zones.length) {
    bad("账号下没有可用的域名（Zone）");
    return;
  }

  const hostDefault = cfg.workerUrl ? new URL(cfg.workerUrl).hostname : "";
  console.log("可用域名：");
  zones.forEach((z, i) => console.log(`  ${C.c}${i + 1}${C.r}  ${z.name} ${C.dim}(${z.status})${C.r}`));
  const pick = await ask("\n选择域名编号", { def: "1" });
  const zone = zones[Number(pick) - 1];
  if (!zone) { bad("编号无效"); closeRl(); return; }

  const guess = hostDefault && hostDefault.endsWith(zone.name) ? hostDefault : `mcp.${zone.name}`;
  const hostname = (await ask("要绑定的主机名", { def: guess })).trim();
  closeRl();
  if (!hostname.includes(".")) { bad("主机名不合法"); return; }

  const accountId = accounts[0]?.id;
  if (!accountId) { bad("没有可用的 Cloudflare 账号"); return; }

  try {
    const existing = await cf.listWorkerDomains(auth.token, accountId);
    const hit = existing.find((d) => d.hostname === hostname);
    if (hit && hit.service !== "termux-mcp") {
      bad(`${hostname} 已经被 Worker「${hit.service}」占用`);
      return;
    }
    const r = await cf.attachWorkerDomain(auth.token, {
      accountId, zoneId: zone.id, hostname, service: "termux-mcp",
    });
    good(`已绑定 ${hostname} → termux-mcp（证书由 Cloudflare 自动签发）`);
    tip("证书签发通常需要 10-60 秒");
  } catch (e) {
    bad(`绑定失败：${e.message}`);
    console.log(`${C.dim}也可以在 Dashboard 里绑定：Worker → Settings → Domains & Routes → Add custom domain${C.r}`);
    return;
  }

  console.log(`\n${C.dim}等待 DNS 与证书就绪…${C.r}`);
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const dns = await cf.resolveHost(hostname);
    if (!dns.v4.length && !dns.v6.length) continue;
    try {
      const r = await fetch(`https://${hostname}/api/health`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) { ready = true; break; }
    } catch { }
  }
  if (!ready) {
    warn("还不能通过新域名访问，稍等一会儿用 tmcp status 复查");
  } else {
    good(`https://${hostname} 已可用`);
  }

  const use = await ask(`把当前 Worker 地址改成 https://${hostname}？(Y/n)`, { def: "Y" });
  closeRl();
  if (!/^n/i.test(use)) {
    const next = { ...loadConfig(), workerUrl: `https://${hostname}` };
    saveConfig(next);
    good(`已更新：${next.workerUrl}`);
    if (pidAlive(readPid())) {
      await stop({ quiet: true });
      await start();
    } else {
      tip("下一步：tmcp start");
    }
    console.log(`\n${C.b}客户端地址${C.r}  ${next.workerUrl}/mcp`);
  }
}

// ============================ doctor ============================
async function doctor() {
  hr("环境体检");
  const rows = [];
  const add = (name, ok, detail) => rows.push([name, ok, detail]);

  const major = Number(process.versions.node.split(".")[0]);
  add("Node.js", major >= 20, `${process.version}${major >= 20 ? "" : "（需要 >=20）"}`);
  add("WebSocket", typeof WebSocket === "function", typeof WebSocket === "function" ? "内置可用" : "缺少全局 WebSocket");
  add("fetch", typeof fetch === "function", "内置");
  add("script(PTY)", commandExists("script"), commandExists("script") ? "交互式 shell 可用" : "pkg install util-linux");
  add("wrangler", commandExists("npx"), commandExists("npx") ? "可用于部署 Worker" : "pkg install nodejs-lts");
  const plat = detectPlatform();
  add("运行平台", true, `${plat.isAndroid ? "Android" : plat.os} · ${plat.distro || "-"} · ${plat.arch}`);

  const cfg = loadConfig();
  add("配置文件", fs.existsSync(CONFIG_PATH), CONFIG_PATH);
  try {
    const st = fs.statSync(CONFIG_PATH);
    add("配置权限", (st.mode & 0o077) === 0, `0${(st.mode & 0o777).toString(8)}${(st.mode & 0o077) === 0 ? "" : "（建议 chmod 600）"}`);
  } catch { }

  add("Worker 地址", !!cfg.workerUrl, cfg.workerUrl || "未配置");
  const pid = readPid();
  add("Agent 进程", pidAlive(pid), pidAlive(pid) ? `pid=${pid}` : "未运行");
  const supPid = readSupPid();
  add("守护进程", pidAlive(supPid), pidAlive(supPid) ? `pid=${supPid}` : "未运行（tmcp start 会拉起）");

  for (const [name, ok, detail] of rows) {
    const w = [...name].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
    console.log(`${ok ? `${C.g}✓${C.r}` : `${C.red}✗${C.r}`} ${name}${" ".repeat(Math.max(1, 14 - w))}${C.dim}${detail}${C.r}`);
  }

  if (cfg.workerUrl) {
    try {
      const st = await fetchStatus(cfg);
      const devices = st.agent?.devices || [];
      if (devices.length) {
        console.log(`\n隧道：${C.g}${devices.length} 台设备在线${C.r}`);
        for (const d of devices) {
          console.log(`  ${C.dim}${d.id} · ${d.name} · ${[d.os, d.arch].filter(Boolean).join("/")} 最后活跃 ${d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString("zh-CN") : "-"}${C.r}`);
        }
      } else {
        console.log(`\n隧道：${C.y}无设备在线${C.r}`);
      }
      console.log(`管理界面：${cfg.workerUrl}/admin`);
    } catch (e) {
      console.log(`\n隧道：${C.red}查询失败${C.r} ${C.dim}${e.message}${C.r}`);
    }
  }
}

// 优先本地 wrangler，其次全局，最后 npx
function wranglerCmd() {
  const local = path.join(WORKER_DIR, "node_modules", ".bin", "wrangler");
  if (fs.existsSync(local)) return { cmd: local, pre: [], display: "本地 wrangler" };
  if (commandExists("wrangler")) return { cmd: "wrangler", pre: [], display: "全局 wrangler" };
  if (commandExists("npx")) return { cmd: "npx", pre: ["wrangler"], display: "npx wrangler" };
  return null;
}

// 设备名：Android 取机型，其他系统取主机名
function defaultDeviceName() {
  return deviceName();
}

function commandExists(c) {
  const r = spawnSync("sh", ["-c", `command -v ${c}`], { encoding: "utf8" });
  return r.status === 0 && !!r.stdout.trim();
}

