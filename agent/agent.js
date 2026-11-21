// Termux Agent：主动连到 Cloudflare Worker，接收工具调用并在本机执行。
// 关键点：手机不需要公网 IP、不需要开端口、不需要 cloudflared。
import { spawn, spawnSync, exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createAssembler, sendJSON } from "../shared/wsjson.js";
import { TOOL_SPECS } from "../shared/tools.mjs";
import z from "zod";
import { loadConfig } from "./config.js";
import { Jobs } from "./jobs.js";
import { deviceName, detectPlatform, systemInfo, cpuUsagePercent } from "./platform.js";
import { Shells } from "./shells.js";

const execAsync = promisify(exec);
export const VERSION = "1.0.0";

// 仅供 Worker WebUI 调用，不暴露在 MCP 工具清单里
const INTERNAL_TOOLS = new Set(["__sysinfo", "__logs"]);

const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_EDIT_BYTES = 10 * 1024 * 1024;
// 远程单次返回的文本上限（Worker 侧 JSON body 有限制，留足余量）
const REMOTE_TEXT_LIMIT = 180 * 1024;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROTECTED_PATHS = [
  "/", "/data", "/system", "/vendor", "/etc", "/proc", "/sys",
  os.homedir(), os.tmpdir(), process.env.PREFIX,
].filter(Boolean);

const KEY_BYTES = {
  "ctrl-c": "\x03", "ctrl-d": "\x04", "ctrl-z": "\x1a",
  enter: "\n", esc: "\x1b", tab: "\t", backspace: "\x7f",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
};

// 把超长文本截断成可安全过 Worker 的大小，并附带说明
function clampText(text, limit = REMOTE_TEXT_LIMIT) {
  const s = typeof text === "string" ? text : String(text ?? "");
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= limit) return s;
  const buf = Buffer.from(s, "utf8").subarray(0, limit);
  // 避免截断在多字节字符中间
  let out = buf.toString("utf8");
  if (out.endsWith("\uFFFD")) out = out.slice(0, -1);
  return out + `\n\n[已截断：原始 ${bytes} 字节，这里只返回前约 ${limit} 字节。需要更多请用 run_command 分段读取，或写到文件后用 read_file 指定 max_bytes]`;
}

export class Agent {
  constructor(cfg) {
    this.cfg = cfg;
    this.ws = null;
    this.connected = false;
    this.attempt = 0;
    this.stopped = false;
    this.timer = null;
    this.hbTimer = null;
    this.lastPong = 0;
    this.jobs = new Jobs({ dir: cfg.jobsDir, log: (m) => this.log(m) });
    this.shells = new Shells({
      maxShells: cfg.maxShells ?? 6,
      idleMs: cfg.shellIdleMs ?? 30 * 60 * 1000,
      log: (m) => this.log(m),
    });
  }

  log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.hbTimer);
    try { this.ws?.close(1000, "agent shutdown"); } catch { }
    this.jobs.killAll();
    this.shells.closeAll();
  }

  wsUrl() {
    const base = this.cfg.workerUrl.replace(/^http/i, "ws").replace(/\/+$/, "");
    const id = encodeURIComponent(this.deviceId());
    return `${base}/agent/ws?device=${id}`;
  }

  // 设备标识：优先配置里的 deviceId，否则由主机名派生
  deviceId() {
    if (this.cfg.deviceId) return this.cfg.deviceId;
    const base = (this.cfg.name || os.hostname() || "device")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    return base || "device";
  }

  connect() {
    if (this.stopped) return;
    if (this.ws) {
      try { this.ws.close(4000, "reconnecting"); } catch { }
      this.ws = null;
    }
    const url = this.wsUrl();
    this.log(`连接 ${url}`);
    let ws;
    try {
      ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.cfg.agentToken}` } });
    } catch (e) {
      this.log(`创建 WebSocket 失败：${e.message}`);
      return this.scheduleReconnect();
    }
    this.ws = ws;

    const assemble = createAssembler(
      (msg) => this.onMessage(msg).catch((e) => this.log(`处理消息出错：${e.stack || e}`)),
      (err) => this.log(`分块错误：${err.message}`)
    );

    ws.addEventListener("open", () => {
      this.connected = true;
      this.connectedAt = Date.now();
      this.attempt = 0;
      this.lastPong = Date.now();
      this.log("已连上 Worker");
      const p = detectPlatform();
      sendJSON(ws, {
        t: "hello",
        deviceId: this.deviceId(),
        name: this.cfg.name || deviceName(),
        version: VERSION,
        host: p.hostname,
        os: p.isAndroid ? "android" : p.os,
        distro: p.distro,
        arch: p.arch,
        tools: TOOL_SPECS.length,
        node: process.version,
      });
      this.startHeartbeat();
    });

    ws.addEventListener("message", (ev) => assemble(ev.data));

    ws.addEventListener("close", (ev) => {
      this.connected = false;
      clearInterval(this.hbTimer);
      this.log(`连接断开 code=${ev.code} ${ev.reason || ""}`.trim());
      this.scheduleReconnect();
    });

    ws.addEventListener("error", (ev) => {
      // Node 的 WebSocket 错误事件信息很少，close 事件随后会到
      this.log(`连接错误${ev?.message ? "：" + ev.message : ""}`);
    });
  }

  // Worker 部署了新代码后会给出新 build；发现变化就主动重连，
  // 否则本机可能一直挂在运行旧代码的 Durable Object 上。
  offerBuild(build) {
    if (!build) return;
    if (!this.build) { this.build = build; return; }
    if (this.build === build) return;
    this.log(`Worker 代码已更新（build ${this.build} → ${build}），重连以加载新版本`);
    this.build = build;
    const old = this.ws;
    this.ws = null;
    this.connected = false;
    try { old?.close(4000, "worker build changed"); } catch { }
    this.scheduleReconnect();
  }

  startHeartbeat() {
    clearInterval(this.hbTimer);
    this.lastPong = Date.now();
    this.hbTimer = setInterval(() => {
      if (!this.connected) return;
      // 60 秒没有任何 pong，判定链路已死并重连
      if (Date.now() - this.lastPong > 120_000) {
        this.log("心跳超时，主动重连");
        const dead = this.ws;
        this.ws = null;
        this.connected = false;
        try { dead?.close(4000, "heartbeat timeout"); } catch { }
        this.scheduleReconnect();
        return;
      }
      try { sendJSON(this.ws, { t: "ping", now: Date.now() }); } catch { }
      // 每 5 分钟核对一次 Worker build
      if (!this.lastBuildCheck || Date.now() - this.lastBuildCheck > 300_000) {
        this.lastBuildCheck = Date.now();
        this.checkBuild().catch(() => { });
      }
    }, 30_000);
  }

  async checkBuild() {
    try {
      const r = await fetch(`${this.cfg.workerUrl}/api/health`, { signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      if (j?.build) this.offerBuild(j.build);
    } catch { }
  }

  scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.attempt++;
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5));
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.log(`${(delay / 1000).toFixed(1)}s 后重连（第 ${this.attempt} 次）`);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  async onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.t) {
      case "welcome":
        this.lastPong = Date.now();
        this.offerBuild(msg.build);
        break;
      case "hello-ack":
        if (msg.build) this.offerBuild(msg.build);
        break;
      case "ping":
        this.lastPong = Date.now();
        try { sendJSON(this.ws, { t: "pong", now: Date.now() }); } catch { }
        break;
      case "pong":
        this.lastPong = Date.now();
        break;
      case "call":
        await this.handleCall(msg);
        break;
      default:
        break;
    }
  }

  async handleCall(msg) {
    const id = String(msg.id || "");
    const tool = String(msg.tool || "");
    let args = msg.args;
    if (!id) return;
    try {
      if (tool.startsWith("__")) {
        // 内部工具（WebUI 用），不走对外工具表的参数校验
        if (!INTERNAL_TOOLS.has(tool)) throw new Error(`未知内部工具：${tool}`);
        args = args && typeof args === "object" ? args : {};
      } else {
        const spec = TOOL_SPECS.find((t) => t.name === tool);
        if (!spec) throw new Error(`未知工具：${tool}`);
        const parser = z.object(spec.schema);
        const parsed = parser.safeParse(args ?? {});
        if (!parsed.success) {
          const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
          throw new Error(`参数不合法：${detail}`);
        }
        args = parsed.data;
      }
      // 给单次执行加本地超时兜底，避免 Worker 已超时但这里一直跑
      const budget = Math.min(Number(msg.timeout_ms) || 45_000, 90_000) + 10_000;
      const text = await withTimeout(this.dispatch(tool, args), budget, `本地执行超时（>${Math.round(budget / 1000)}s）`);
      sendJSON(this.ws, { t: "result", id, ok: true, text: clampText(text) });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      try { sendJSON(this.ws, { t: "result", id, ok: false, error: err, code: e?.code || "tool-error" }); } catch { }
    }
  }

  // ---------------- 工具分发 ----------------
  async dispatch(tool, args) {
    switch (tool) {
      case "run_command": return this.runCommand(args);
      case "read_file": return this.readFile(args);
      case "write_file": return this.writeFile(args);
      case "edit_file": return this.editFile(args);
      case "list_dir": return this.listDir(args);
      case "delete": return this.deletePath(args);
      case "move": return this.movePath(args);
      case "search_files": return this.searchFiles(args);
      case "grep_files": return this.grepFiles(args);
      case "system_info": return this.systemInfo();
      case "shell_open": return this.shells.open(args.rows, args.cols);
      case "shell_send": return this.shells.send(args);
      case "shell_view": return this.shells.view(args.sessionId, args.tail);
      case "shell_close": return this.shells.close(args.sessionId);
      case "shell_list": return this.shells.list();
      case "job_start": return this.jobs.start(args);
      case "job_status": return this.jobs.status(args);
      case "job_kill": return this.jobs.kill(args.jobId, args.signal);
      case "job_list": return this.jobs.list();
      // 内部命令（不在工具清单里暴露，供 Worker 的 WebUI 使用）
      case "__sysinfo": return this.internalSysinfo();
      case "__logs": return this.internalLogs(args);
      default: throw new Error(`未知工具：${tool}`);
    }
  }

  resolvePath(p) {
    if (typeof p !== "string" || p.length === 0) throw new Error("path 不能为空");
    let q = p;
    if (q === "~") q = os.homedir();
    else if (q.startsWith("~/")) q = path.join(os.homedir(), q.slice(2));
    const abs = path.isAbsolute(q) ? q : path.join(os.homedir(), q);
    return path.normalize(abs);
  }

  assertNotProtected(abs, op) {
    for (const p of PROTECTED_PATHS) {
      if (abs === p) throw new Error(`拒绝${op}：${p} 是受保护的根路径；需要操作内部文件请给出具体路径`);
    }
  }

  async runCommand({ command, cwd, timeout_ms }) {
    const dir = cwd ? this.resolvePath(cwd) : os.homedir();
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: dir, timeout: timeout_ms, maxBuffer: MAX_OUTPUT, env: { ...process.env },
      });
      return JSON.stringify({ stdout: clampText(stdout), stderr: clampText(stderr), exitCode: 0 }, null, 2);
    } catch (err) {
      const killed = err.killed === true;
      const exitCode = typeof err.code === "number" ? err.code : killed ? 124 : 1;
      const payload = {
        stdout: clampText(err.stdout || ""),
        stderr: clampText(err.stderr || ""),
        exitCode,
        killed,
        signal: err.signal || null,
        error: killed
          ? `命令超时（>${timeout_ms}ms）被终止。长任务请改用 job_start 后台运行`
          : err.message,
      };
      const e = new Error(JSON.stringify(payload, null, 2));
      e.code = "command-failed";
      throw e;
    }
  }

  async readFile({ path: p, max_bytes }) {
    const abs = this.resolvePath(p);
    const limit = max_bytes || MAX_READ_BYTES;
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new Error(`${abs} 不是普通文件（可能是目录/设备/链接）`);
    if (st.size === 0) return "[空文件]";
    const truncated = st.size > limit;
    const fh = await fs.open(abs, "r");
    try {
      const buf = Buffer.allocUnsafe(Math.min(limit, st.size));
      const { bytesRead } = await fh.read({ buffer: buf, length: buf.length, position: 0 });
      if (buf.subarray(0, Math.min(bytesRead, 4096)).includes(0)) {
        throw new Error(`${abs} 疑似二进制文件（共 ${st.size} 字节）。请用 run_command：base64 / xxd / strings / file`);
      }
      const text = buf.toString("utf8");
      const notice = truncated
        ? `\n\n[已截断：文件共 ${st.size} 字节，只返回前 ${bytesRead} 字节。可用 run_command 分段读取]`
        : "";
      return text + notice;
    } finally {
      await fh.close();
    }
  }

  async writeFile({ path: p, content, create_dirs }) {
    const abs = this.resolvePath(p);
    if (create_dirs) await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
    return `已写入 ${abs}（${Buffer.byteLength(content, "utf-8")} 字节）`;
  }

  async editFile({ path: p, old_text, new_text, replace_all }) {
    if (old_text.length === 0) throw new Error("old_text 不能为空");
    if (old_text === new_text) throw new Error("old_text 和 new_text 相同，无需编辑");
    const abs = this.resolvePath(p);
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new Error(`${abs} 不是普通文件`);
    if (st.size > MAX_EDIT_BYTES) throw new Error(`文件 ${st.size} 字节超过编辑上限，请改用 write_file`);
    const content = await fs.readFile(abs, "utf8");
    if (content.includes("\x00")) throw new Error(`${abs} 疑似二进制文件，不能用 edit_file`);
    const count = content.split(old_text).length - 1;
    if (count === 0) throw new Error("没找到 old_text。必须与文件内容逐字一致（含缩进、换行）；可先 read_file 核对");
    if (count > 1 && !replace_all) throw new Error(`old_text 出现了 ${count} 次。请扩大选区使其唯一，或 replace_all=true`);
    let updated;
    if (replace_all) updated = content.split(old_text).join(new_text);
    else {
      const i = content.indexOf(old_text);
      updated = content.slice(0, i) + new_text + content.slice(i + old_text.length);
    }
    await fs.writeFile(abs, updated, "utf8");
    return `已替换 ${replace_all ? count : 1} 处：${abs}（${st.size} -> ${Buffer.byteLength(updated, "utf8")} 字节）`;
  }

  async listDir({ path: p }) {
    const abs = this.resolvePath(p || ".");
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const items = [];
    for (const d of entries) {
      const full = path.join(abs, d.name);
      let size = null, mtime = null;
      try {
        const st = await fs.stat(full);
        size = st.isDirectory() ? null : st.size;
        mtime = st.mtime.toISOString();
      } catch { }
      items.push({
        name: d.name,
        type: d.isDirectory() ? "dir" : d.isFile() ? "file" : d.isSymbolicLink() ? "symlink" : "other",
        size, mtime,
      });
    }
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : b.type === "dir" ? 1 : 0));
    return JSON.stringify({ dir: abs, count: items.length, items }, null, 2);
  }

  async deletePath({ path: p, recursive }) {
    const abs = this.resolvePath(p);
    this.assertNotProtected(abs, "删除");
    const st = await fs.lstat(abs);
    if (st.isDirectory()) await fs.rm(abs, { recursive, force: false });
    else await fs.unlink(abs);
    return `已删除 ${abs}`;
  }

  async movePath({ from, to }) {
    const a = this.resolvePath(from), b = this.resolvePath(to);
    this.assertNotProtected(a, "移动");
    this.assertNotProtected(b, "移动");
    await fs.mkdir(path.dirname(b), { recursive: true });
    try {
      await fs.rename(a, b);
    } catch (e) {
      if (e.code !== "EXDEV") throw e;
      await fs.cp(a, b, { recursive: true, dereference: false });
      await fs.rm(a, { recursive: true, force: true });
    }
    return `已移动 ${a} -> ${b}`;
  }

  async searchFiles({ pattern, dir, type, max_depth, max_results, exclude_dirs }) {
    const abs = this.resolvePath(dir || ".");
    const args = [abs, "-maxdepth", String(max_depth)];
    if (type === "file") args.push("-type", "f");
    else if (type === "dir") args.push("-type", "d");
    for (const ex of exclude_dirs) args.push("-not", "-path", `*/${ex}/*`);
    args.push("-iname", pattern);
    const cmdStr = `find ${args.map(shQuote).join(" ")} 2>/dev/null | head -n ${max_results + 1}`;
    let stdout = "";
    try {
      ({ stdout } = await execAsync(cmdStr, { timeout: 60000, maxBuffer: MAX_OUTPUT }));
    } catch (e) {
      if (e.killed) throw new Error("搜索超时。请缩小 dir、减小 max_depth，或用 exclude_dirs 排除大目录");
      throw e;
    }
    let lines = stdout.split("\n").filter(Boolean);
    const truncated = lines.length > max_results;
    if (truncated) lines = lines.slice(0, max_results);
    if (lines.length === 0) return `在 ${abs} 下没有找到匹配 "${pattern}" 的${type === "any" ? "文件或目录" : type === "file" ? "文件" : "目录"}`;
    return JSON.stringify({ dir: abs, pattern, count: lines.length, truncated, matches: lines }, null, 2);
  }

  async grepFiles({ pattern, dir, include, ignore_case, context_lines, max_results, exclude_dirs }) {
    const abs = this.resolvePath(dir || ".");
    const parts = ["grep", "-r", "-n", "-E", "-I"];
    if (ignore_case) parts.push("-i");
    if (context_lines > 0) parts.push("-C", String(context_lines));
    for (const ex of exclude_dirs) parts.push("--exclude-dir", shQuote(ex));
    if (include) parts.push("--include", shQuote(include));
    parts.push("--", shQuote(pattern), shQuote(abs));
    const perMatch = context_lines > 0 ? context_lines * 2 + 1 : 1;
    const headN = (max_results + 1) * perMatch;
    const cmdStr = `${parts.join(" ")} | head -n ${headN}`;
    let stdout = "", stderr = "";
    try {
      ({ stdout, stderr } = await execAsync(cmdStr, { timeout: 60000, maxBuffer: MAX_OUTPUT }));
    } catch (e) {
      if (e.killed) throw new Error("搜索超时。请缩小 dir、用 include 限定类型，或用 exclude_dirs 排除大目录");
      throw e;
    }
    if (!stdout) {
      return `在 ${abs} 下没有找到内容匹配的行${stderr ? `\n(grep 提示: ${stderr.trim().slice(0, 300)})` : ""}`;
    }
    const lines = stdout.split("\n").filter(Boolean);
    const truncated = lines.length >= headN;
    return clampText(lines.join("\n") + (truncated ? `\n\n[结果已截断，仅显示前 ${max_results} 条匹配]` : ""));
  }

  async systemInfo() {
    const info = systemInfo();
    // loadavg 在 Android 上不可用，用一次短采样算 CPU 使用率代替
    if (info.loadavg === undefined) {
      const usage = await cpuUsagePercent();
      if (usage !== null) info.cpuUsagePercent = usage;
    }
    return clampText(JSON.stringify({
      ...info,
      agent: { version: VERSION, pid: process.pid, shells: this.shells.map.size, jobs: this.jobs.map.size },
    }, null, 2));
  }

  // Worker WebUI 用：进程与连接概况
  async internalSysinfo() {
    const p = detectPlatform();
    const info = systemInfo();
    if (info.loadavg === undefined) {
      const usage = await cpuUsagePercent();
      if (usage !== null) info.cpuUsagePercent = usage;
    }
    let connectedSec = null;
    if (this.connectedAt) connectedSec = Math.round((Date.now() - this.connectedAt) / 1000);
    return JSON.stringify({
      ...info,
      agent: {
        version: VERSION,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        connectedSec,
        workerUrl: this.cfg.workerUrl,
        shells: this.shells.map.size,
        jobs: this.jobs.map.size,
        runningJobs: [...this.jobs.map.values()].filter((j) => !j.endedAt).length,
        platform: p,
        execPath: process.execPath,
        memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      },
    }, null, 2);
  }

  // Worker WebUI 用：读 Agent 自己的日志尾部
  async internalLogs({ lines = 200, which = "agent" } = {}) {
    const n = Math.min(Math.max(Number(lines) || 200, 10), 2000);
    const name = which === "supervisor" ? "supervisor.log" : which === "error" ? "agent.err.log" : "agent.log";
    const file = path.join(this.cfg.logDir || path.join(os.homedir(), ".config", "termux-mcp-remote", "logs"), name);
    try {
      const st = await fs.stat(file);
      const limit = 512 * 1024;
      const start = Math.max(0, st.size - limit);
      const fh = await fs.open(file, "r");
      try {
        const buf = Buffer.alloc(st.size - start);
        await fh.read({ buffer: buf, length: buf.length, position: start });
        const text = buf.toString("utf8").split("\n").slice(-n).join("\n");
        return text;
      } finally {
        await fh.close();
      }
    } catch (e) {
      return `[读取日志失败：${e.message}]`;
    }
  }
}

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
