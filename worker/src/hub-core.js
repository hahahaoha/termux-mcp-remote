// 隧道协议核心：与运行环境无关，Worker Durable Object 和本地测试服务器共用。
// 支持多设备：每个 Agent 带一个 deviceId，调用时按 id 路由；不指定则用默认设备。
// 适配器需要提供：
//   send(ws, obj)          向 socket 发送 JSON（自动分块）
//   sockets()              当前所有 Agent socket
//   close(ws, code, why)   关闭 socket
//   sendFail(ws)           发送失败时清理该 socket
import { createAssembler, sendJSON } from "../../shared/wsjson.js";

export const CALL_TIMEOUT_MS = 90_000;
export const MAX_PENDING = 32;

export class HubCore {
  constructor({ send = sendJSON, log = () => { } } = {}) {
    this._send = send;
    this.log = log;
    this.pending = new Map();   // id -> { resolve, timer, tool, startedAt, device }
    this.deviceOf = new Map();  // ws -> deviceId
    this.assemblers = new WeakMap();
    this.seq = 0;
    this.calls = 0;
    this.errors = 0;
    this.defaultDevice = null;
  }

  send(ws, obj) { return this._send(ws, obj); }

  failAll(reason) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: reason, code: "agent-offline" });
      this.pending.delete(id);
    }
  }

  // ---------- 连接生命周期 ----------
  onOpen(ws, deviceId = "default", build = "dev") {
    this.build = build;
    this.deviceOf.set(ws, deviceId);
    if (!this.defaultDevice) this.defaultDevice = deviceId;
    // welcome 里带上 build：Agent 发现变化就重连（DO 可能还驻留着旧代码）
    this.send(ws, {
      t: "welcome", v: 1, build, now: Date.now(),
      maxCallMs: CALL_TIMEOUT_MS, hub: "termux-mcp-remote",
    });
  }

  onClose(ws, code, reason, { wasReplaced = false } = {}) {
    this.deviceOf.delete(ws);
    // 只取消属于这台设备的排队请求；别的设备不受影响
    this.failDevicePending(ws, wasReplaced
      ? "设备重新连接，旧请求已取消"
      : `Agent 断开连接（code=${code}${reason ? "，" + reason : ""}）`);
  }

  failDevicePending(ws, reason) {
    const dev = this.deviceOf.get(ws);
    if (!dev) return;
    for (const [id, p] of this.pending) {
      if (p.device !== dev) continue;
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: reason, code: "agent-offline" });
      this.pending.delete(id);
    }
  }

  // ---------- 收到 Agent 消息 ----------
  handleData(ws, data) {
    let handle = this.assemblers.get(ws);
    if (!handle) {
      handle = createAssembler(
        (msg) => this.onMessage(ws, msg),
        (err) => this.log("assemble error: " + (err?.message || err)),
      );
      this.assemblers.set(ws, handle);
    }
    const dev = this.deviceMeta(ws);
    if (dev) dev.lastSeen = Date.now();
    handle(data);
  }

  // 每个 socket 的设备元数据（hello 之后填充）
  deviceMeta(ws) {
    if (!this.metaByWs) this.metaByWs = new WeakMap();
    let m = this.metaByWs.get(ws);
    if (!m) {
      m = { lastSeen: null, name: null, version: null, host: null, os: null, distro: null, arch: null, tools: 0, connectedAt: null };
      this.metaByWs.set(ws, m);
    }
    return m;
  }

  onMessage(ws, msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.t) {
      case "hello": {
        const m = this.deviceMeta(ws);
        if (typeof msg.deviceId === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(msg.deviceId)) {
          this.deviceOf.set(ws, msg.deviceId);
        }
        m.name = str(msg.name, 64) || "device";
        m.version = str(msg.version, 32);
        m.host = str(msg.host, 64);
        m.os = str(msg.os, 32);
        m.distro = str(msg.distro, 64);
        m.arch = str(msg.arch, 16);
        m.tools = Number(msg.tools) || 0;
        m.connectedAt = Date.now();
        m.lastSeen = Date.now();
        this.send(ws, { t: "hello-ack", build: this.build, now: Date.now() });
        break;
      }
      case "ping":
        this.deviceMeta(ws).lastSeen = Date.now();
        this.send(ws, { t: "pong", now: Date.now() });
        break;
      case "pong":
        this.deviceMeta(ws).lastSeen = Date.now();
        break;
      case "result": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) {
          p.resolve({ ok: true, text: typeof msg.text === "string" ? msg.text : String(msg.text ?? "") });
        } else {
          this.errors++;
          p.resolve({ ok: false, error: str(msg.error, 4000) || "未知错误", code: msg.code || "tool-error" });
        }
        break;
      }
      default:
        break;
    }
  }

  // ---------- 状态 ----------
  devices() {
    const out = [];
    for (const ws of this._sockets()) {
      const id = this.deviceOf.get(ws) || "default";
      const m = this.deviceMeta(ws);
      out.push({
        id,
        // 刚连上但还没收到 hello 时，标为 connecting，避免 UI 显示空白
        state: m.name ? "ready" : "connecting",
        name: m.name || id,
        version: m.version,
        host: m.host,
        os: m.os,
        distro: m.distro,
        arch: m.arch,
        tools: m.tools,
        connectedAt: m.connectedAt,
        lastSeen: m.lastSeen,
        pending: [...this.pending.values()].filter((p) => p.device === id).length,
      });
    }
    return out;
  }

  status() {
    const devices = this.devices();
    const first = devices[0] || {};
    return {
      ok: true,
      online: devices.length > 0,
      defaultDevice: this.defaultDevice,
      devices,
      // 兼容旧字段（单设备客户端）
      name: first.name ?? null,
      version: first.version ?? null,
      host: first.host ?? null,
      tools: first.tools ?? 0,
      connectedAt: first.connectedAt ?? null,
      lastSeen: first.lastSeen ?? null,
      calls: this.calls,
      errors: this.errors,
      pending: this.pending.size,
      now: Date.now(),
    };
  }

  // ---------- 调用 ----------
  pickDevice(deviceId) {
    const socks = this._sockets();
    if (!socks.length) return null;
    if (deviceId) {
      return socks.find((ws) => this.deviceOf.get(ws) === deviceId) || null;
    }
    if (this.defaultDevice) {
      const hit = socks.find((ws) => this.deviceOf.get(ws) === this.defaultDevice);
      if (hit) return hit;
    }
    return socks[0];
  }

  async rpc({ tool, args, timeout_ms, device }) {
    const ws = this.pickDevice(device);
    if (!ws) {
      const known = this._sockets().length
        ? `设备「${device}」目前未连接。可用设备：${this.devices().map((d) => d.id).join(", ")}`
        : "Agent 离线：没有任何设备连上 Worker。请在设备上运行 tmcp start 后重试。";
      return { ok: false, code: "agent-offline", error: known };
    }
    const devId = this.deviceOf.get(ws) || "default";
    if (this.pending.size >= MAX_PENDING) {
      return { ok: false, code: "busy", error: `并发调用已达上限 ${MAX_PENDING}，请稍后再试` };
    }
    const timeoutMs = Math.min(Number(timeout_ms) || 45000, CALL_TIMEOUT_MS);
    const id = `c${++this.seq}-${Date.now().toString(36)}`;
    this.calls++;

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.errors++;
          resolve({
            ok: false,
            code: "timeout",
            error: `调用超时（>${Math.round(timeoutMs / 1000)}s）。长任务请用 job_start / job_status。`,
          });
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, tool, startedAt: Date.now(), device: devId });
      try {
        this.send(ws, { t: "call", id, tool, args, timeout_ms: timeoutMs });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        this._sendFail?.(ws);
        resolve({
          ok: false,
          code: "agent-reconnecting",
          error: `设备「${devId}」连接已失效，正在自动重连（约 1-5 秒）。请稍后重试同一条命令。`,
        });
      }
    });
  }

  // ---------- 适配器注入 ----------
  setSockets(fn) { this._sockets = fn; }
  setSendFail(fn) { this._sendFail = fn; }
}

function str(v, max) {
  if (typeof v !== "string") return "";
  return v.slice(0, max);
}
