// 后台长任务管理：不受单次 MCP 调用超时限制。
// 输出写到 state/jobs/<id>.log，status 时读文件尾部，天然支持进程重启后查看。
//
// 关于 detached：不要用。
// 用了 detached 后任务进入自己的进程组，Agent 停机时 killAll() 里的
// process.kill(-pid) 会把「正在执行 tmcp restart」的那个进程一起杀掉，
// 结果只停了服务、没起新的（日志表现为 exit=null signal=SIGKILL）。
// 不用 detached 的副作用是 Agent 退出时任务会收到 SIGHUP，所以在命令前
// 显式 trap 掉 SIGHUP/SIGINT，只让 SIGTERM 和 SIGKILL 生效。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export class Jobs {
  constructor({ dir, log = () => { }, maxJobs = 32, maxLogBytes = 16 * 1024 * 1024 }) {
    this.dir = dir;
    this.log = log;
    this.maxJobs = maxJobs;
    this.maxLogBytes = maxLogBytes;
    this.map = new Map(); // id -> { id, pid, name, command, cwd, startedAt, endedAt, exitCode, signal, proc, logPath, keys }
    this.seq = 0;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { }
  }

  start({ command, cwd, name }) {
    // 回收已结束且过多的任务
    const finished = [...this.map.values()].filter((j) => j.endedAt).sort((a, b) => a.endedAt - b.endedAt);
    while (this.map.size >= this.maxJobs && finished.length) {
      const old = finished.shift();
      this.map.delete(old.id);
      try { fs.unlinkSync(old.logPath); } catch { }
    }
    const id = `job-${++this.seq}`;
    const dir = cwd ? (path.isAbsolute(cwd) ? cwd : path.join(os.homedir(), cwd)) : os.homedir();
    const logPath = path.join(this.dir, `${id}.log`);
    const fd = fs.openSync(logPath, "w");
    fs.writeSync(fd, `# ${new Date().toISOString()} cwd=${dir}\n# $ ${command}\n\n`);

    let proc;
    try {
      proc = spawn("bash", ["-c", `trap '' HUP INT; ${command}`], {
        cwd: dir,
        detached: false,
        stdio: ["ignore", fd, fd],
        env: { ...process.env },
      });
    } catch (e) {
      fs.closeSync(fd);
      throw new Error("启动失败：" + e.message);
    }
    const entry = {
      id, pid: proc.pid, name: name || "", command, cwd: dir,
      startedAt: Date.now(), endedAt: null, exitCode: null, signal: null,
      proc, logPath, keys: [],
    };
    proc.on("exit", (code, signal) => {
      entry.endedAt = Date.now();
      entry.exitCode = code;
      entry.signal = signal;
      try { fs.appendFileSync(logPath, `\n# 进程结束 exit=${code} signal=${signal} ${new Date().toISOString()}\n`); } catch { }
      try { fs.closeSync(fd); } catch { }
      this.log(`任务 ${id} 结束 exit=${code} signal=${signal}`);
    });
    proc.on("error", (e) => {
      entry.endedAt = Date.now();
      entry.error = e.message;
      try { fs.appendFileSync(logPath, `\n# 启动错误：${e.message}\n`); } catch { }
    });
    this.map.set(id, entry);
    this.writeIndex();
    return JSON.stringify({
      jobId: id, pid: proc.pid, name: entry.name, cwd: dir,
      logFile: logPath,
      tip: "用 job_status 查看输出，job_kill 终止。输出也会实时写入 logFile。",
    }, null, 2);
  }

  readTail(logPath, bytes) {
    try {
      const st = fs.statSync(logPath);
      const start = Math.max(0, st.size - bytes);
      const fd = fs.openSync(logPath, "r");
      try {
        const buf = Buffer.alloc(st.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        return buf.toString("utf8");
      } finally { fs.closeSync(fd); }
    } catch (e) {
      return `[读取日志失败：${e.message}]`;
    }
  }

  async status({ jobId, tail_bytes, wait_ms }) {
    const entry = this.map.get(jobId);
    if (!entry) {
      // 进程重启后 Map 丢了，但日志还在：尽量给点线索
      const p = path.join(this.dir, `${jobId}.log`);
      if (fs.existsSync(p)) {
        return JSON.stringify({ jobId, note: "该任务不在当前进程的跟踪表中（Agent 可能重启过），以下为日志尾部", running: false, output: this.readTail(p, tail_bytes) }, null, 2);
      }
      throw new Error(`任务不存在：${jobId}`);
    }
    if (wait_ms > 0 && !entry.endedAt) {
      const deadline = Date.now() + wait_ms;
      while (Date.now() < deadline && !entry.endedAt) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    return JSON.stringify({
      jobId: entry.id,
      name: entry.name,
      pid: entry.pid,
      cwd: entry.cwd,
      command: entry.command,
      running: !entry.endedAt,
      startedAt: new Date(entry.startedAt).toISOString(),
      elapsedSec: Math.round(((entry.endedAt || Date.now()) - entry.startedAt) / 1000),
      endedAt: entry.endedAt ? new Date(entry.endedAt).toISOString() : null,
      exitCode: entry.exitCode,
      signal: entry.signal,
      logFile: entry.logPath,
      output: this.readTail(entry.logPath, tail_bytes),
    }, null, 2);
  }

  kill(jobId, signal = "SIGTERM") {
    const entry = this.map.get(jobId);
    if (!entry) throw new Error(`任务不存在：${jobId}`);
    if (entry.endedAt) return `任务 ${jobId} 已经结束（exit=${entry.exitCode}）`;
    let killed = false;
    // 没有独立进程组，直接对 shell 发信号；需要连同子进程一起结束时
    // 用 pkill -P 递归（见 killTree）
    try {
      killTree(entry.pid, signal);
      killed = true;
    } catch {
      try { entry.proc.kill(signal); killed = true; } catch { }
    }
    if (!killed) throw new Error(`无法向 ${jobId}（pid=${entry.pid}）发送 ${signal}`);
    return `已向 ${jobId}（pid=${entry.pid}）发送 ${signal}`;
  }

  list() {
    const items = [...this.map.values()].map((e) => ({
      jobId: e.id,
      name: e.name,
      pid: e.pid,
      command: e.command.length > 120 ? e.command.slice(0, 120) + "…" : e.command,
      running: !e.endedAt,
      elapsedSec: Math.round(((e.endedAt || Date.now()) - e.startedAt) / 1000),
      exitCode: e.exitCode,
    }));
    if (items.length === 0) return "当前没有后台任务（job_start 可新建）";
    return JSON.stringify({ count: items.length, running: items.filter((x) => x.running).length, jobs: items }, null, 2);
  }

  writeIndex() {
    try {
      const idx = [...this.map.values()].map((e) => ({
        jobId: e.id, name: e.name, pid: e.pid, command: e.command, cwd: e.cwd,
        startedAt: e.startedAt, endedAt: e.endedAt, exitCode: e.exitCode, logPath: e.logPath,
      }));
      fs.writeFileSync(path.join(this.dir, "index.json"), JSON.stringify(idx, null, 2));
    } catch { }
  }

  killAll() {
    for (const e of this.map.values()) {
      if (e.endedAt) continue;
      try { killTree(e.pid, "SIGKILL"); } catch {
        try { e.proc.kill("SIGKILL"); } catch { }
      }
    }
  }
}

// 结束后台任务及其子进程。没有独立进程组时，靠 pkill -P 逐层向下
// （Termux 自带 pkill；取不到就退化成都只杀直接子进程）。
function killTree(pid, signal = "TERM") {
  const sig = String(signal).replace(/^SIG/, "");
  try {
    const r = spawnSync("pkill", ["-" + sig, "-P", String(pid)], { timeout: 3000 });
    void r;
  } catch { }
  try { process.kill(pid, signal); } catch { }
}
