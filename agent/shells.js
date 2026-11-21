// 交互式 PTY 会话管理（基于 util-linux 的 script，Termux 自带）
import { spawn } from "node:child_process";

const MARKER = "__MCP_DONE_4f8a2c__";
const KEY_BYTES = {
  "ctrl-c": "\x03", "ctrl-d": "\x04", "ctrl-z": "\x1a",
  enter: "\n", esc: "\x1b", tab: "\t", backspace: "\x7f",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r/g, "");
}
function stripMarker(s) {
  return s.replace(/\n?__MCP_DONE_4f8a2c__-?\d+\n?/g, "\n");
}

export class Shells {
  constructor({ maxShells = 6, idleMs = 30 * 60 * 1000, log = () => { } } = {}) {
    this.map = new Map();
    this.seq = 0;
    this.maxShells = maxShells;
    this.idleMs = idleMs;
    this.log = log;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  killShell(id, reason) {
    const entry = this.map.get(id);
    if (!entry) return false;
    try { entry.proc.kill("SIGKILL"); } catch { }
    this.map.delete(id);
    if (reason) this.log(`PTY ${id} 已回收：${reason}`);
    return true;
  }

  sweep(now = Date.now()) {
    let freed = 0;
    for (const [id, e] of this.map) {
      if (!e.alive || now - e.lastUsed > this.idleMs) {
        this.killShell(id, e.alive ? "空闲超时" : "进程已退出");
        freed++;
      }
    }
    return freed;
  }

  async open(rows = 24, cols = 80) {
    this.sweep();
    if (this.map.size >= this.maxShells) {
      const sorted = [...this.map].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      while (this.map.size >= this.maxShells) this.killShell(sorted.shift()[0], `超过并发上限 ${this.maxShells}`);
    }
    const proc = spawn("script", ["-qfc", "bash", "/dev/null"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm", LINES: String(rows), COLUMNS: String(cols) },
    });
    const id = `sh-${++this.seq}`;
    const entry = { proc, buffer: "", rows, cols, alive: true, spawnError: null, lastUsed: Date.now() };
    this.map.set(id, entry);
    proc.on("error", (e) => { entry.spawnError = e; entry.alive = false; });
    proc.stdout.on("data", (d) => {
      entry.buffer += d.toString("utf8");
      if (entry.buffer.length > 262144) entry.buffer = entry.buffer.slice(-131072);
    });
    proc.stderr.on("data", (d) => { entry.buffer += d.toString("utf8"); });
    proc.on("exit", () => { entry.alive = false; });
    await sleep(600);
    if (entry.spawnError) {
      this.map.delete(id);
      throw new Error("没找到 script 命令，交互式 shell 需要它：pkg install -y util-linux");
    }
    try {
      proc.stdin.write(`stty rows ${rows} cols ${cols} 2>/dev/null\n`);
      proc.stdin.write("stty -echo\n");
      proc.stdin.write("export PS1='\\w\\$ '\n");
      proc.stdin.write(`PROMPT_COMMAND='echo ${MARKER}$?'\n`);
      proc.stdin.write("bind 'set enable-bracketed-paste off' 2>/dev/null\n");
    } catch { }
    await sleep(500);
    entry.buffer = "";
    return JSON.stringify({
      sessionId: id, rows, cols, mode: "pty",
      tip: "submit=true 自动补换行并等完成；回答交互提示用 submit=false；中断用 key=ctrl-c。",
    });
  }

  async send({ sessionId, text, key, submit = true, wait_ms = 1500 }) {
    const entry = this.map.get(sessionId);
    if (!entry) throw new Error("会话不存在: " + sessionId);
    if (!entry.alive) throw new Error("会话已退出");
    entry.lastUsed = Date.now();
    const startPos = entry.buffer.length;
    if (key) {
      const b = KEY_BYTES[key];
      if (!b) throw new Error(`未知 key: ${key}，可选: ${Object.keys(KEY_BYTES).join(",")}`);
      entry.proc.stdin.write(b);
    } else if (text !== undefined) {
      let t = text;
      if (submit && !t.endsWith("\n")) t += "\n";
      entry.proc.stdin.write(t);
    } else {
      throw new Error("给 text 发文本，或给 key 发特殊键");
    }
    const lookingForMarker = submit && key === undefined && text !== undefined;
    if (lookingForMarker) {
      const deadline = Date.now() + wait_ms;
      while (Date.now() < deadline) {
        const slice = entry.buffer.slice(startPos);
        const idx = slice.indexOf(MARKER);
        if (idx >= 0) {
          const after = slice.slice(idx);
          const nl = after.indexOf("\n");
          const markerLen = nl >= 0 ? nl + 1 : after.length;
          entry.buffer = entry.buffer.slice(0, startPos + idx) + entry.buffer.slice(startPos + idx + markerLen);
          let exitCode = null;
          const m = after.match(/__MCP_DONE_4f8a2c__(-?\d+)/);
          if (m) exitCode = Number(m[1]);
          const out = stripAnsi(slice.slice(0, idx));
          return JSON.stringify({ output: out.slice(-16384), exitCode, completed: true, alive: entry.alive });
        }
        await sleep(50);
      }
    } else {
      await sleep(Math.min(wait_ms, 1500));
    }
    const out = stripMarker(stripAnsi(entry.buffer.slice(startPos)));
    return JSON.stringify({
      output: out.slice(-16384), exitCode: null, completed: false,
      timedOut: lookingForMarker, alive: entry.alive,
    });
  }

  view(sessionId, tail = 4000) {
    const entry = this.map.get(sessionId);
    if (!entry) throw new Error("会话不存在: " + sessionId);
    entry.lastUsed = Date.now();
    const text = stripMarker(stripAnsi(entry.buffer));
    return text.slice(-tail) + (entry.alive ? "" : "\n[会话已退出]");
  }

  close(sessionId) {
    const entry = this.map.get(sessionId);
    if (!entry) throw new Error("会话不存在: " + sessionId);
    this.killShell(sessionId);
    return "已关闭 " + sessionId;
  }

  list() {
    const items = [...this.map.entries()].map(([id, e]) => ({
      sessionId: id,
      alive: e.alive,
      rows: e.rows,
      cols: e.cols,
      idleSeconds: Math.round((Date.now() - e.lastUsed) / 1000),
      preview: stripMarker(stripAnsi(e.buffer)).trimEnd().slice(-120),
    }));
    if (items.length === 0) return "当前没有活跃的交互式 shell 会话（shell_open 可新开一个）";
    return JSON.stringify({ count: items.length, sessions: items }, null, 2);
  }

  closeAll() {
    for (const id of [...this.map.keys()]) this.killShell(id);
  }
}
