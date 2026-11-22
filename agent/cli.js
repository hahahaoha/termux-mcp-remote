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
import { t, lang, saveLang } from "./i18n.js";
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
  console.error(t("{0}错误：{1}{2}", C.red, e?.message || e, C.r));
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
    case "enroll": return enrollCmd();
    case "lang": return langCmd();
    case "help": case "-h": case "--help": return help();
    case "-v": case "--version": return version();
    default:
      console.error(t("未知命令：{0}", cmd));
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
  const suffix = def ? ` ${C.dim}[${mask ? t("已设置") : def}]${C.r}` : "";
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
  console.log(t("{0}termux-mcp-remote{1} —— 用 Cloudflare Worker 远程使用 Termux 终端\n\n{2}用法{3}\n  tmcp                 交互式菜单\n  tmcp setup           配置向导（首次使用）\n  tmcp deploy          用 wrangler 部署 Worker 并自动写入密钥\n  tmcp start           后台启动 Agent（守护进程）\n  tmcp stop            停止 Agent\n  tmcp status          查看连接状态\n  tmcp logs [-f]       查看日志\n  tmcp token [rotate]  查看 / 轮换访问令牌\n  tmcp url <地址>      修改 Worker 地址\n  tmcp test            本地自检（MCP 握手 + 工具调用）\n  tmcp doctor          环境体检\n  tmcp panel           本地应急面板（只监听 127.0.0.1；日常用 Worker 的 /admin）\n  tmcp domain          给 Worker 绑定自有域名（解决 workers.dev 被污染）\n  tmcp admin-pass      设置 / 重置后台登录密码（与 API token 无关）\n  tmcp enroll [地址] [注册码]   用一次性注册码一键配置（地址+密钥）\n\n{4}典型流程{5}\n  tmcp deploy      {6}# 一次性，部署 Worker 并生成 token{7}\n  tmcp setup       {8}# 确认地址（直接回车用刚部署的）{9}\n  tmcp start       {10}# 让手机连上 Worker{11}\n\n{12}客户端配置{13}\n  URL:      https://<你的-worker>/mcp\n  请求头:   Authorization: Bearer <AUTH_TOKEN>\n", C.b, C.r, C.b, C.r, C.b, C.r, C.dim, C.r, C.dim, C.r, C.dim, C.r, C.b, C.r));
  console.log(t("  tmcp lang [en|zh]    切换界面语言"));
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
  console.log(t("\n{0}{1}termux-mcp-remote{2} {3}· 手机终端远程 MCP · Cloudflare Worker{4}", C.b, C.m, C.r, C.dim, C.r));
  const pid = readPid();
  const running = pidAlive(pid);
  console.log(`${running ? t("{0}● Agent 运行中{1} {2}pid={3}{4}", C.g, C.r, C.dim, pid, C.r) : t("{0}○ Agent 未运行{1}", C.dim, C.r)}`);
  console.log(`${cfg.workerUrl ? `${C.dim}Worker:${C.r} ${cfg.workerUrl}` : t("{0}尚未配置 Worker 地址{1}", C.y, C.r)}`);
  if (cfg.workerUrl) console.log(t("{0}管理界面:{1} {2}/admin\n", C.dim, C.r, cfg.workerUrl));

  const items = [
    ["1", t("配置向导（setup）"), setup],
    ["2", t("启动 Agent"), start],
    ["3", t("停止 Agent"), stop],
    ["4", t("查看状态"), status],
    ["5", t("查看日志"), logs],
    ["6", t("部署 / 更新 Worker"), deploy],
    ["7", t("查看令牌"), tokenCmd],
    ["8", t("本地自检"), test],
    ["9", t("环境体检"), doctor],
    ["p", t("管理面板"), panel],
    ["q", t("退出"), null],
  ];
  for (const [k, label] of items) console.log(`  ${C.c}${k}${C.r}  ${label}`);
  const pick = await ask(t("\n选择"), { def: "q" });
  closeRl();
  const item = items.find(([k]) => k === pick.toLowerCase());
  if (item && item[2]) await item[2]();
  else if (pick.toLowerCase() !== "q") { warn(t("没有这个选项")); }
}

// ============================ setup ============================
async function setup({ force = false } = {}) {
  ensureDirs();
  const cfg = loadConfig();
  if (isConfigured(cfg) && !force) {
    console.log(t("\n当前配置已存在：{0}", CONFIG_PATH));
    const again = await ask(t("重新配置？(y/N)"), { def: "N" });
    if (!/^y/i.test(again)) { closeRl(); return; }
  }

  hr(t("配置向导"));
  console.log(t("有注册码的话最省事：在 Worker 后台点「生成配置码」，然后把码粘进来，"));
  console.log(t("{0}地址和两个 token 会自动填好，不用手抄。{1}", C.dim, C.r));
  console.log("");
  const first = await ask(t("注册码（没有就按回车，手动填地址）"), { def: "" });
  if (first) {
    closeRl();
    await enrollCmd({ code: first, fromSetup: true });
    return;
  }

  console.log("");
  console.log(t("手动配置。Worker 地址由「tmcp deploy」部署后给出，形如："));
  tip(t("   https://termux-mcp.你的账号.workers.dev"));
  tip(t("   或你自己的域名：https://mcp.example.com"));
  console.log("");
  const urlIn = await ask(t("Worker 地址"), { def: cfg.workerUrl || "" });
  if (!urlIn) { bad(t("地址不能为空")); closeRl(); return; }
  const workerUrl = normalizeUrl(urlIn);
  if (!/^https?:\/\//.test(workerUrl)) { bad(t("地址格式不对，应以 http(s):// 开头")); closeRl(); return; }

  // 尝试从 Worker 读取公开健康信息，确认可达
  process.stdout.write(t("{0}正在检查地址是否可达…{1}\n", C.dim, C.r));
  let reachable = false;
  try {
    const r = await fetch(`${workerUrl}/api/health`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    reachable = r.ok && j.ok;
    if (reachable) good(t("服务器响应正常（v{0}）", j.version));
    else warn(t("服务器返回 HTTP {0}，可能地址不对或尚未部署", r.status));
  } catch (e) {
    warn(t("无法访问 {0}/api/health：{1}", workerUrl, e.message));
    const go = await ask(t("仍然保存这个地址？(y/N)"), { def: "N" });
    if (!/^y/i.test(go)) { closeRl(); return; }
  }

  const authIn = await ask(t("AUTH_TOKEN（AI 客户端用，留空则自动生成）"), { def: cfg.authToken || "", mask: true });
  const authToken = authIn && authIn.length >= 16 ? authIn : randomToken(32);
  const agentIn = await ask(t("AGENT_TOKEN（手机连接用，留空则自动生成）"), { def: cfg.agentToken || "", mask: true });
  const agentToken = agentIn && agentIn.length >= 16 ? agentIn : randomToken(32);

  const nameIn = await ask(t("设备名（显示用）"), { def: cfg.name || defaultDeviceName() });

  const saved = saveConfig({ ...cfg, workerUrl, authToken, agentToken, name: nameIn });
  good(t("配置已保存：{0}（权限 600）", CONFIG_PATH));

  console.log(t("\n{0}接下来{1}", C.b, C.r));
  console.log(t("  1) 把这两个值同步到 Worker（若用 tmcp deploy 部署会自动同步）："));
  console.log(`     AUTH_TOKEN  = ${C.dim}${authToken.slice(0, 6)}…${authToken.slice(-4)}${C.r}`);
  console.log(`     AGENT_TOKEN = ${C.dim}${agentToken.slice(0, 6)}…${agentToken.slice(-4)}${C.r}`);
  console.log(t("     手工同步：cd {0} && npx wrangler secret put AUTH_TOKEN", WORKER_DIR));
  console.log(t("  2) 启动：{0}tmcp start{1}", C.c, C.r));
  console.log(t("  3) 客户端填：{0}{1}/mcp{2} + 请求头 {3}Authorization: Bearer <AUTH_TOKEN>{4}", C.c, saved.workerUrl, C.r, C.dim, C.r));
  console.log(t("  4) 管理界面：{0}{1}/admin{2} {3}（用 AUTH_TOKEN 登录）{4}", C.c, saved.workerUrl, C.r, C.dim, C.r));
  closeRl();

  const go = await ask(t("\n现在启动 Agent？(Y/n)"), { def: "Y" });
  closeRl();
  if (!/^n/i.test(go)) await start();
}

// ============================ deploy ============================
async function deploy() {
  ensureDirs();
  hr(t("部署 Worker"));
  if (!commandExists("npx")) {
    bad(t("找不到 npx，请先：pkg install nodejs-lts"));
    return;
  }
  if (!fs.existsSync(path.join(WORKER_DIR, "node_modules"))) {
    console.log(t("{0}首次部署，安装依赖…{1}", C.dim, C.r));
    const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: WORKER_DIR, stdio: "inherit" });
    if (r.status !== 0) { bad(t("依赖安装失败")); return; }
  }

  const WR = wranglerCmd();
  if (!WR) { bad(t("找不到 wrangler，请先：npm i -g wrangler")); return; }
  console.log(t("{0}使用 {1}{2}", C.dim, WR.display, C.r));

  console.log(t("{0}检查 Cloudflare 登录状态…{1}", C.dim, C.r));
  const who = spawnSync(WR.cmd, [...WR.pre, "whoami"], { cwd: WORKER_DIR, encoding: "utf8", timeout: 120000 });
  const whoOut = (who.stdout || "") + (who.stderr || "");
  if (!/You are logged in/i.test(whoOut)) {
    bad(t("尚未登录 Cloudflare"));
    console.log(t("请先执行：{0}cd {1} && npx wrangler login{2}", C.c, WORKER_DIR, C.r));
    console.log(t("{0}登录后用浏览器授权即可，token 会存在本机。{1}", C.dim, C.r));
    return;
  }
  const email = /associated with the email (\S+)/i.exec(whoOut)?.[1];
  good(t("已登录{0}", email ? `：${email}` : ""));

  // 复用已有配置里的 token，没有就生成
  const cfg = loadConfig();
  const authToken = cfg.authToken || randomToken(32);
  const agentToken = cfg.agentToken || randomToken(32);
  saveConfig({ ...cfg, authToken, agentToken });

  console.log(t("\n{0}写入 Worker 密钥…{1}", C.dim, C.r));
  const secrets = JSON.stringify({ AUTH_TOKEN: authToken, AGENT_TOKEN: agentToken });
  const put = spawnSync(WR.cmd, [...WR.pre, "secret", "bulk"], {
    cwd: WORKER_DIR, input: secrets, encoding: "utf8", timeout: 180000,
  });
  if (put.status !== 0) {
    bad(t("密钥写入失败"));
    console.log((put.stderr || "").slice(-1500));
    return;
  }
  good(t("AUTH_TOKEN / AGENT_TOKEN 已写入"));

  console.log(t("{0}部署中…{1}", C.dim, C.r));
  const dep = spawnSync(WR.cmd, [...WR.pre, "deploy"], { cwd: WORKER_DIR, encoding: "utf8", timeout: 300000 });
  const out = (dep.stdout || "") + (dep.stderr || "");
  if (dep.status !== 0) {
    bad(t("部署失败"));
    console.log(out.slice(-2500));
    return;
  }
  const m = /https:\/\/[a-z0-9-]+\.[a-z0-9.-]*workers\.dev/i.exec(out);
  const deployedUrl = m ? m[0] : "";
  console.log(out.split("\n").filter((l) => /Uploaded|Deployed|https:\/\//i.test(l)).join("\n"));
  good(t("Worker 已部署"));

  if (deployedUrl) {
    const keep = cfg.workerUrl && cfg.workerUrl !== deployedUrl;
    const useIt = !keep ? "Y" : await ask(t("当前配置的地址是 {0}，改用 {1}？(y/N)", cfg.workerUrl, deployedUrl), { def: "N" });
    closeRl();
    if (/^y/i.test(useIt)) {
      saveConfig({ ...loadConfig(), workerUrl: deployedUrl, authToken, agentToken });
      good(t("已更新地址：{0}", deployedUrl));
    } else if (!cfg.workerUrl) {
      saveConfig({ ...loadConfig(), workerUrl: deployedUrl, authToken, agentToken });
      good(t("已保存地址：{0}", deployedUrl));
    }
  }

  const final = loadConfig();
  console.log(t("\n{0}客户端配置{1}", C.b, C.r));
  console.log(JSON.stringify({
    mcpServers: {
      termux: {
        type: "http",
        url: `${final.workerUrl}/mcp`,
        headers: { Authorization: `Bearer ${final.authToken}` },
      },
    },
  }, null, 2));
  console.log(t("\n{0}下一步{1}  {2}tmcp start{3}", C.b, C.r, C.c, C.r));
  console.log(t("{0}管理界面{1}  {2}{3}/admin{4} {5}（用 AUTH_TOKEN 登录，可看设备/日志、改默认设备、轮换 token）{6}", C.b, C.r, C.c, final.workerUrl, C.r, C.dim, C.r));
}

// ============================ start / stop ============================
async function start() {
  ensureDirs();
  const cfg = loadConfig();
  if (!isConfigured(cfg)) {
    bad(t("尚未配置，请先运行：tmcp setup"));
    return;
  }
  const pid = readPid();
  if (pidAlive(pid)) {
    // 可能是上一个实例正在退出（restart 场景）：等它退干净再继续
    for (let i = 0; i < 25 && pidAlive(pid); i++) await sleep(200);
    if (pidAlive(pid)) {
      good(t("Agent 已在运行（pid={0}）", pid));
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
    bad(t("启动失败，最近日志："));
    console.log(tailFile(ERR_LOG, 1200) || tailFile(OUT_LOG, 1200) || t("(无输出)"));
    return;
  }
  good(t("Agent 已启动（pid={0}）", readPid()));

  // 顺便确认链路上线
  for (let i = 0; i < 8; i++) {
    await sleep(700);
    let s = null;
    try { s = await fetchStatus(cfg); } catch (e) {
      if (/401/.test(String(e.message))) {
        bad(t("Worker 拒绝了 AUTH_TOKEN（401）：本地 token 与 Worker 上的密钥不一致"));
        console.log(t("{0}修复：cd {1} && npx wrangler secret put AUTH_TOKEN，粘贴：{2}{3}", C.dim, WORKER_DIR, cfg.authToken, C.r));
        console.log(t("{0}或在 WebUI（{1}/admin）登录后查看当前 token，再执行 tmcp token sync 同步。{2}", C.dim, cfg.workerUrl, C.r));
        return;
      }
    }
    if (s?.agent?.online) {
      good(t("已连上 Worker，Agent 在线（{0}）", s.agent.name || cfg.name));
      console.log(t("{0}MCP 端点：{1}/mcp{2}", C.dim, cfg.workerUrl, C.r));
      console.log(t("{0}管理界面：{1}/admin{2}", C.dim, cfg.workerUrl, C.r));
      return;
    }
  }
  warn(t("进程已启动，但暂未确认 Worker 侧在线。用 tmcp status 或 tmcp logs -f 查看"));
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
      good(t("Agent 已重启（pid={0}）", p));
      await confirmOnline();
      return;
    }
  }
  warn(t("重启命令已下发，但还没确认进程启动。稍后用 tmcp status 查看"));
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
        good(t("已连上 Worker（{0} 台设备在线）", n));
        return;
      }
    } catch { }
  }
  warn(t("进程已启动，但暂未确认在线。用 tmcp status 复查"));
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
    warn(t("派生启动器失败：{0}", e.message));
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
    if (!quiet) warn(t("Agent 未运行"));
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch { }
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    if (!pidAlive(pid)) break;
  }
  if (pidAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { }
    warn(t("进程未响应 SIGTERM，已强制结束"));
  } else if (!quiet) {
    good(t("Agent 已停止（pid={0}）", pid));
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
        good(t("AUTH_TOKEN 已过期，已用设备凭证自动同步"));
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
  hr(t("状态"));
  const supPid = readSupPid();
  const supRunning = pidAlive(supPid);
  console.log(t("本地 Agent   {0}", running ? t("{0}运行中{1}（pid={2}）", C.g, C.r, pid) : t("{0}未运行{1}", C.dim, C.r)));
  console.log(t("守护进程     {0}", supRunning ? t("{0}运行中{1}（pid={2}，崩溃自动重启）", C.g, C.r, supPid) : t("{0}未运行{1}", C.dim, C.r)));
  console.log(t("Worker 地址  {0}", cfg.workerUrl || t("{0}未配置{1}", C.y, C.r)));
  if (!cfg.workerUrl || !cfg.authToken) return;

  try {
    const s = await fetchStatus(cfg);
    const a = s.agent || {};
    const devices = a.devices || [];
    console.log(t("Worker       {0}在线{1}（v{2}）", C.g, C.r, s.worker?.version));
    if (devices.length) {
      console.log(t("设备         {0}{1} 台在线{2}", C.g, devices.length, C.r));
      for (const d of devices) {
        const online = d.state === "ready";
        const mark = online ? `${C.g}●${C.r}` : `${C.y}○${C.r}`;
        const label = `${d.id}`.padEnd(20);
        const kind = [d.os, d.distro, d.arch].filter(Boolean).join(" · ");
        const def = a.defaultDevice === d.id ? t(" {0}(默认){1}", C.dim, C.r) : "";
        console.log(`  ${mark} ${label} ${d.name || "-"}${def}`);
        console.log(t("    {0}{1}{2} · 最后活跃 {3}{4}", C.dim, kind || "-", d.version ? " · v" + d.version : "", d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString("zh-CN") : "-", C.r));
      }
      console.log(t("累计调用     {0}（失败 {1}，排队 {2}）", a.calls ?? 0, a.errors ?? 0, a.pending ?? 0));
    } else {
      console.log(t("设备         {0}无设备连接{1}", C.y, C.r));
      console.log(t("{0}本机未连上 Worker。检查 tmcp logs，或稍等自动重连。{1}", C.dim, C.r));
    }
    console.log(t("\nMCP 端点     {0}/mcp", cfg.workerUrl));
    console.log(t("管理界面     {0}/admin", cfg.workerUrl));
  } catch (e) {
    bad(t("查询 Worker 失败：{0}", e.message));
  }
}

// ============================ logs ============================
async function logs() {
  ensureDirs();
  if (flags.has("-f") || flags.has("--follow")) {
    console.log(t("{0}跟踪 {1}（Ctrl-C 退出）{2}", C.dim, OUT_LOG, C.r));
    const child = spawn("tail", ["-f", "-n", "80", OUT_LOG, ERR_LOG], { stdio: "inherit" });
    await new Promise((resolve) => {
      process.on("SIGINT", () => { child.kill(); resolve(); });
      child.on("exit", resolve);
    });
    return;
  }
  const n = Number([...flags].find((f) => /^-\d+$/.test(f))?.slice(1) || 60);
  console.log(`${C.dim}—— ${OUT_LOG} ——${C.r}`);
  console.log(tailFile(OUT_LOG, 20000, n) || t("(空)"));
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
    if (!cfg.workerUrl) { bad(t("尚未配置 Worker 地址")); return; }
    const tryToken = args[2] || cfg.authToken;
    try {
      const r = await fetch(`${cfg.workerUrl}/api/admin/state`, {
        headers: { authorization: `Bearer ${tryToken}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        bad(t("拉取失败：HTTP {0}。请用 tmcp token sync <当前有效的 AUTH_TOKEN>", r.status));
        return;
      }
      const j = await r.json();
      const next = { ...loadConfig(), authToken: j.authToken };
      saveConfig(next);
      good(t("已从 Worker 同步 AUTH_TOKEN"));
      if (pidAlive(readPid())) {
        await stop({ quiet: true });
        await start();
      }
    } catch (e) {
      bad(t("拉取失败：{0}", e.message));
    }
    return;
  }

  const rotate = args[1] === "rotate";
  if (rotate) {
    const which = args[2] || "auth";
    if (!["auth", "agent"].includes(which)) { bad(t("用法：tmcp token rotate [auth|agent]")); return; }
    const next = randomToken(32);
    if (which === "auth") cfg.authToken = next; else cfg.agentToken = next;
    saveConfig(cfg);
    good(t("已生成新的 {0}", which === "auth" ? "AUTH_TOKEN" : "AGENT_TOKEN"));
    warn(t("记得同步到 Worker：cd worker && npx wrangler secret put ") + (which === "auth" ? "AUTH_TOKEN" : "AGENT_TOKEN"));
    if (which === "agent") warn(t("并重启 Agent：tmcp restart"));
    return;
  }
  hr(t("令牌"));
  console.log(`AUTH_TOKEN   ${cfg.authToken || t("(未设置)")}`);
  console.log(`AGENT_TOKEN  ${cfg.agentToken || t("(未设置)")}`);
  console.log(t("\n{0}客户端请求头：Authorization: Bearer <AUTH_TOKEN>{1}", C.dim, C.r));
  console.log(t("{0}在 Worker 的 /admin 上轮换过 token 后，用 tmcp token sync 把新值取回本机。{1}", C.dim, C.r));
  console.log(t("{0}轮换：tmcp token rotate auth | tmcp token rotate agent{1}", C.dim, C.r));
}

async function urlCmd() {
  const u = args[1];
  if (!u) { bad(t("用法：tmcp url https://xxx.workers.dev")); return; }
  const cfg = loadConfig();
  cfg.workerUrl = normalizeUrl(u);
  saveConfig(cfg);
  good(t("Worker 地址已更新：{0}", cfg.workerUrl));
  if (pidAlive(readPid())) {
    await stop({ quiet: true });
    await start();
  }
}

// ============================ test ============================
async function test() {
  ensureDirs();
  const cfg = loadConfig();
  if (!isConfigured(cfg)) { bad(t("尚未配置，请先 tmcp setup")); return; }
  hr(t("本地自检"));

  console.log(t("{0}1/4 Worker 健康检查{1}", C.dim, C.r));
  try {
    const r = await fetch(`${cfg.workerUrl}/api/health`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    good(t("Worker 在线 v{0}", j.version));
  } catch (e) { bad(t("不可达：{0}", e.message)); return; }

  console.log(t("{0}2/4 鉴权与隧道状态{1}", C.dim, C.r));
  let st;
  try {
    st = await fetchStatus(cfg);
    if (!st.agent?.online) { bad(t("Agent 未连接，先执行 tmcp start")); return; }
    good(t("Agent 在线：{0} v{1}", st.agent.name, st.agent.version));
  } catch (e) { bad(t("失败：{0}", e.message)); return; }

  console.log(t("{0}3/4 MCP 握手{1}", C.dim, C.r));
  let sid = null;
  try {
    const init = await mcpCall(cfg, null, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tmcp-test", version: "1.0" } },
    });
    sid = init.headers.get("mcp-session-id");
    if (init.body?.result?.serverInfo) good(t("握手成功：{0} v{1}", init.body.result.serverInfo.name, init.body.result.serverInfo.version));
    else { bad(t("握手异常：{0}", JSON.stringify(init.body).slice(0, 300))); return; }
    await mcpCall(cfg, sid, { jsonrpc: "2.0", method: "notifications/initialized" }, { notify: true });
  } catch (e) { bad(t("失败：{0}", e.message)); return; }

  console.log(t("{0}4/4 工具调用{1}", C.dim, C.r));
  try {
    const r = await mcpCall(cfg, sid, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "run_command", arguments: { command: "echo tmcp-ok; uname -m; date +%s" } },
    });
    const text = r.body?.result?.content?.[0]?.text || "";
    if (r.body?.result?.isError) { bad(t("工具返回错误：{0}", text.slice(0, 300))); return; }
    if (text.includes("tmcp-ok")) good(t("工具调用成功（run_command 已在手机上执行）"));
    else warn(t("调用完成但输出异常：{0}", text.slice(0, 200)));
  } catch (e) { bad(t("失败：{0}", e.message)); return; }

  console.log(t("\n{0}{1}全部通过{2} —— 可以把这个地址填进 AI 客户端：", C.g, C.b, C.r));
  console.log(`  ${cfg.workerUrl}/mcp`);
  console.log(t("  {0}请求头 Authorization: Bearer <AUTH_TOKEN>{1}", C.dim, C.r));
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
  console.log(t("\n本地面板：{0}{1}{2}", C.c, url, C.r));
  console.log(t("{0}只监听 {1}，不会暴露到公网。Ctrl-C 退出。{2}", C.dim, host, C.r));
  console.log(t("{0}远程管理用 Worker 的 /admin：{1}/admin{2}", C.dim, loadConfig().workerUrl, C.r));
  await new Promise((resolve) => {
    process.on("SIGINT", () => { server.close(); resolve(); });
    process.on("SIGTERM", () => { server.close(); resolve(); });
  });
}

// ============================ lang ============================
// 切换 tmcp 的界面语言。安装脚本也会写同一个文件（~/.config/termux-mcp-remote/lang）。
async function langCmd() {
  const cur = lang();
  const arg = (args[1] || "").toLowerCase();

  if (!arg) {
    console.log(t("当前语言：{0}", cur === "zh" ? "中文 (zh)" : "English (en)"));
    console.log(t("切换：tmcp lang en | tmcp lang zh"));
    return;
  }
  if (!["en", "zh", "english", "chinese", "cn"].includes(arg)) {
    bad(t("未知语言：{0}（可用 en / zh）", arg));
    return;
  }
  const v = saveLang(arg);
  good(t("界面语言已切换为 {0}", v === "zh" ? "中文 (zh)" : "English (en)"));
  tip(t("配置码和 token 不受影响，无需重新部署"));
}

// ============================ enroll ============================
// 用一次性注册码完成配置：地址 + AUTH_TOKEN + AGENT_TOKEN 一次到位。
// 支持三种写法：
//   tmcp enroll                    交互式粘贴（自动识别是否带地址前缀）
//   tmcp enroll <注册码>
//   tmcp enroll <Worker地址> <注册码>
async function enrollCmd(opts = {}) {
  const { extractCode, enrollAndSave, looksLikeCode } = await import("./enroll.js");
  const cfg = loadConfig();

  let hint = opts.code || "";
  let urlHint = "";

  // 从命令行参数里解析（opts.code 为空时）
  if (!hint) {
    const a1 = args[1] && !args[1].startsWith("-") ? args[1] : "";
    const a2 = args[2] && !args[2].startsWith("-") ? args[2] : "";
    if (a1 && a2) { urlHint = a1; hint = a2; }
    else if (a1) {
      // 一个参数：可能是码，也可能是地址（带 "/enroll/<码>"）
      if (looksLikeCode(a1)) hint = a1;
      else urlHint = a1;
    }
  }

  if (!opts.fromSetup) hr(t("用注册码配置"));
  if (!hint) {
    console.log(t("{0}在 Worker 后台（{1}/admin）点「生成配置码」，", C.dim, cfg.workerUrl || t("你的 Worker")));
    console.log(t("复制那串码，直接粘到这里。{0}", C.r));
    hint = await ask(t("注册码"), { def: "" });
    closeRl();
  }
  const code = extractCode(hint);
  if (!code) { bad(t("这不是有效的注册码")); return; }

  // 地址优先级：命令行 > 注册码里带的 > 已有配置 > 追问
  let base = urlHint || cfg.workerUrl || "";
  if (!base) {
    console.log(t("{0}还需要 Worker 地址（注册码只含随机数，不含地址时需手填一次）。{1}", C.dim, C.r));
    base = await ask(t("Worker 地址"), { def: "" });
    closeRl();
  }
  if (!base) { bad(t("缺少 Worker 地址")); return; }

  process.stdout.write(t("{0}正在兑换…{1}\n", C.dim, C.r));
  try {
    const saved = await enrollAndSave({ code, workerUrl: base });
    good(t("配置完成：{0}", saved.workerUrl));
    tip(`AUTH_TOKEN  ${saved.authToken.slice(0, 6)}…${saved.authToken.slice(-4)}`);
    tip(`AGENT_TOKEN ${saved.agentToken.slice(0, 6)}…${saved.agentToken.slice(-4)}`);
    tip(t("这串注册码已经作废，不能再用第二次"));
  } catch (e) {
    bad(e.message || String(e));
    if (e.reason === "used") tip(t("一个注册码只能用一次；请回后台重新生成。"));
    else if (e.reason === "expired") tip(t("注册码有时效，过期了就在后台重新生成一个。"));
    else if (e.reason === "notfound") tip(t("码无效、已被撤销或已过期。"));
    return;
  }

  const go = await ask(t("\n现在启动 Agent？(Y/n)"), { def: "Y" });
  closeRl();
  if (!/^n/i.test(go)) await start();
}

// ============================ admin-pass ============================
// 后台密码只用于登录 WebUI；这里直接写 Worker，不需要旧密码（要 AUTH_TOKEN 证明身份）。
async function adminPassCmd() {
  hr(t("后台登录密码"));
  const cfg = loadConfig();
  if (!cfg.workerUrl) { bad(t("尚未配置 Worker 地址，请先 tmcp setup")); return; }
  console.log(t("{0}这个密码只用于登录 {1}/admin，与 AI 客户端使用的 AUTH_TOKEN 无关。{2}", C.dim, cfg.workerUrl, C.r));
  console.log(t("{0}服务端只保存 PBKDF2 哈希，忘记时用本命令重设。{1}\n", C.dim, C.r));

  const pw = await ask(t("新密码（至少 8 位，留空则清除密码）"), { mask: true });
  closeRl();
  if (pw && pw.length < 8) { bad(t("密码至少 8 位")); return; }

  try {
    const r = await fetch(`${cfg.workerUrl}/api/auth/reset`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ password: pw }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) { bad(t("失败：{0}", j.error || "HTTP " + r.status)); return; }
    if (pw) {
      good(t("后台密码已设置（所有已登录会话已失效）"));
      console.log(t("{0}打开 {1}/admin 用新密码登录。{2}", C.dim, cfg.workerUrl, C.r));
    } else {
      good(t("后台密码已清除，下次打开 /admin 会重新引导设置"));
    }
  } catch (e) {
    bad(t("请求失败：{0}", e.message));
  }
}

// ============================ domain ============================
// *.workers.dev 在很多网络下会被 DNS 污染，绑自有域名是最省事的解法。
async function domainCmd() {
  hr(t("绑定自有域名"));
  const cf = await import("./cf-api.js");
  const auth = cf.readWranglerAuth();
  if (!auth) {
    bad(t("找不到 wrangler 登录凭据，请先执行：wrangler login"));
    return;
  }
  const cfg = loadConfig();

  let accounts, zones;
  try {
    accounts = await cf.listAccounts(auth.token);
    zones = await cf.listZones(auth.token);
  } catch (e) {
    bad(t("读取 Cloudflare 账号失败：{0}", e.message));
    console.log(t("{0}权限不足时，请在 Cloudflare Dashboard 手动添加 Workers 自定义域（Worker → Settings → Domains & Routes）。{1}", C.dim, C.r));
    return;
  }
  if (!zones.length) {
    bad(t("账号下没有可用的域名（Zone）"));
    return;
  }

  const hostDefault = cfg.workerUrl ? new URL(cfg.workerUrl).hostname : "";
  console.log(t("可用域名："));
  zones.forEach((z, i) => console.log(`  ${C.c}${i + 1}${C.r}  ${z.name} ${C.dim}(${z.status})${C.r}`));
  const pick = await ask(t("\n选择域名编号"), { def: "1" });
  const zone = zones[Number(pick) - 1];
  if (!zone) { bad(t("编号无效")); closeRl(); return; }

  const guess = hostDefault && hostDefault.endsWith(zone.name) ? hostDefault : `mcp.${zone.name}`;
  const hostname = (await ask(t("要绑定的主机名"), { def: guess })).trim();
  closeRl();
  if (!hostname.includes(".")) { bad(t("主机名不合法")); return; }

  const accountId = accounts[0]?.id;
  if (!accountId) { bad(t("没有可用的 Cloudflare 账号")); return; }

  try {
    const existing = await cf.listWorkerDomains(auth.token, accountId);
    const hit = existing.find((d) => d.hostname === hostname);
    if (hit && hit.service !== "termux-mcp") {
      bad(t("{0} 已经被 Worker「{1}」占用", hostname, hit.service));
      return;
    }
    const r = await cf.attachWorkerDomain(auth.token, {
      accountId, zoneId: zone.id, hostname, service: "termux-mcp",
    });
    good(t("已绑定 {0} → termux-mcp（证书由 Cloudflare 自动签发）", hostname));
    tip(t("证书签发通常需要 10-60 秒"));
  } catch (e) {
    bad(t("绑定失败：{0}", e.message));
    console.log(t("{0}也可以在 Dashboard 里绑定：Worker → Settings → Domains & Routes → Add custom domain{1}", C.dim, C.r));
    return;
  }

  console.log(t("\n{0}等待 DNS 与证书就绪…{1}", C.dim, C.r));
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
    warn(t("还不能通过新域名访问，稍等一会儿用 tmcp status 复查"));
  } else {
    good(t("https://{0} 已可用", hostname));
  }

  const use = await ask(t("把当前 Worker 地址改成 https://{0}？(Y/n)", hostname), { def: "Y" });
  closeRl();
  if (!/^n/i.test(use)) {
    const next = { ...loadConfig(), workerUrl: `https://${hostname}` };
    saveConfig(next);
    good(t("已更新：{0}", next.workerUrl));
    if (pidAlive(readPid())) {
      await stop({ quiet: true });
      await start();
    } else {
      tip(t("下一步：tmcp start"));
    }
    console.log(t("\n{0}客户端地址{1}  {2}/mcp", C.b, C.r, next.workerUrl));
  }
}

// ============================ doctor ============================
async function doctor() {
  hr(t("环境体检"));
  const rows = [];
  const add = (name, ok, detail) => rows.push([name, ok, detail]);

  const major = Number(process.versions.node.split(".")[0]);
  add("Node.js", major >= 20, `${process.version}${major >= 20 ? "" : t("（需要 >=20）")}`);
  add("WebSocket", typeof WebSocket === "function", typeof WebSocket === "function" ? t("内置可用") : t("缺少全局 WebSocket"));
  add("fetch", typeof fetch === "function", t("内置"));
  add("script(PTY)", commandExists("script"), commandExists("script") ? t("交互式 shell 可用") : "pkg install util-linux");
  add("wrangler", commandExists("npx"), commandExists("npx") ? t("可用于部署 Worker") : "pkg install nodejs-lts");
  const plat = detectPlatform();
  add(t("运行平台"), true, `${plat.isAndroid ? "Android" : plat.os} · ${plat.distro || "-"} · ${plat.arch}`);

  const cfg = loadConfig();
  add(t("配置文件"), fs.existsSync(CONFIG_PATH), CONFIG_PATH);
  try {
    const st = fs.statSync(CONFIG_PATH);
    add(t("配置权限"), (st.mode & 0o077) === 0, `0${(st.mode & 0o777).toString(8)}${(st.mode & 0o077) === 0 ? "" : t("（建议 chmod 600）")}`);
  } catch { }

  add(t("Worker 地址"), !!cfg.workerUrl, cfg.workerUrl || t("未配置"));
  const pid = readPid();
  add(t("Agent 进程"), pidAlive(pid), pidAlive(pid) ? `pid=${pid}` : t("未运行"));
  const supPid = readSupPid();
  add(t("守护进程"), pidAlive(supPid), pidAlive(supPid) ? `pid=${supPid}` : t("未运行（tmcp start 会拉起）"));

  for (const [name, ok, detail] of rows) {
    const w = [...name].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
    console.log(`${ok ? `${C.g}✓${C.r}` : `${C.red}✗${C.r}`} ${name}${" ".repeat(Math.max(1, 14 - w))}${C.dim}${detail}${C.r}`);
  }

  if (cfg.workerUrl) {
    try {
      const st = await fetchStatus(cfg);
      const devices = st.agent?.devices || [];
      if (devices.length) {
        console.log(t("\n隧道：{0}{1} 台设备在线{2}", C.g, devices.length, C.r));
        for (const d of devices) {
          console.log(t("  {0}{1} · {2} · {3} 最后活跃 {4}{5}", C.dim, d.id, d.name, [d.os, d.arch].filter(Boolean).join("/"), d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString("zh-CN") : "-", C.r));
        }
      } else {
        console.log(t("\n隧道：{0}无设备在线{1}", C.y, C.r));
      }
      console.log(t("管理界面：{0}/admin", cfg.workerUrl));
    } catch (e) {
      console.log(t("\n隧道：{0}查询失败{1} {2}{3}{4}", C.red, C.r, C.dim, e.message, C.r));
    }
  }
}

// 优先本地 wrangler，其次全局，最后 npx
function wranglerCmd() {
  const local = path.join(WORKER_DIR, "node_modules", ".bin", "wrangler");
  if (fs.existsSync(local)) return { cmd: local, pre: [], display: t("本地 wrangler") };
  if (commandExists("wrangler")) return { cmd: "wrangler", pre: [], display: t("全局 wrangler") };
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

