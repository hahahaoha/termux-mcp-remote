// Durable Object 适配器：把 Cloudflare 的 WebSocket（Hibernation API）接到 HubCore。
// 支持多设备：每个 Agent 用 ?device=<id> 声明身份，同一个 DO 里维护多条连接。
import { HubCore } from "./hub-core.js";
import { sendJSON } from "../../shared/wsjson.js";
import { json } from "./mcp.js";

export class AgentHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.dead = new WeakSet();
    this.live = new Map();     // deviceId -> ws
    this.core = new HubCore({ send: sendJSON, log: (m) => console.log("[hub]", m) });
    this.core.setSockets(() => this.sockets());
    this.core.setSendFail((ws) => this.dropDead(ws));
  }

  // 只返回真正可用的 socket
  sockets() {
    const alive = [];
    for (const [id, ws] of this.live) {
      if (this.dead.has(ws)) { this.live.delete(id); continue; }
      const rs = ws.readyState;
      if (rs !== undefined && rs !== 1) { this.live.delete(id); this.dead.add(ws); continue; }
      alive.push(ws);
    }
    if (alive.length) return alive;
    // DO 被唤醒后 this.live 是空的，从 hibernation 里恢复
    const restored = this.state.getWebSockets("agent").filter((ws) => !this.dead.has(ws));
    for (const ws of restored) {
      const id = ws.deserializeAttachment()?.deviceId || "default";
      if (!this.live.has(id)) this.live.set(id, ws);
    }
    return [...this.live.values()];
  }

  dropDead(ws) {
    this.dead.add(ws);
    for (const [id, s] of this.live) if (s === ws) this.live.delete(id);
    try { ws.close(4002, "send failed, reconnecting"); } catch { }
  }

  async fetch(req) {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/connect": return this.handleConnect(req, url);
      case "/rpc": return this.handleRpc(req);
      case "/status": return json(this.core.status());
      case "/devices": return json({ ok: true, devices: this.core.devices() });
      case "/disconnect": return this.handleDisconnect(url);
      default: return json({ ok: false, error: "not found" }, 404);
    }
  }

  handleConnect(req, url) {
    if (req.headers.get("Upgrade") !== "websocket") {
      return json({ ok: false, error: "expected websocket upgrade" }, 426);
    }
    const deviceId = sanitizeId(url.searchParams.get("device")) || "default";
    const build = url.searchParams.get("build") || "dev";

    // 同一设备重复连接：顶掉旧的，避免双写
    const existing = this.live.get(deviceId);
    if (existing) {
      this.dead.add(existing);
      this.live.delete(deviceId);
      try { existing.close(4001, "replaced by a newer connection"); } catch { }
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.serializeAttachment({ deviceId, since: Date.now() });
    this.state.acceptWebSocket(server, ["agent"]);
    this.live.set(deviceId, server);
    this.core.onOpen(server, deviceId, build);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleRpc(req) {
    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
    const tool = String(body?.tool || "");
    if (!tool) return json({ ok: false, error: "missing tool" }, 400);
    const args = body?.args && typeof body.args === "object" ? body.args : {};
    const result = await this.core.rpc({
      tool, args,
      timeout_ms: body?.timeout_ms,
      device: sanitizeId(body?.device),
    });
    return json(result);
  }

  handleDisconnect(url) {
    const only = sanitizeId(url.searchParams.get("device"));
    let n = 0;
    for (const [id, ws] of this.sockets().map((ws) => [this.core.deviceOf.get(ws) || "default", ws])) {
      if (only && id !== only) continue;
      this.dropDead(ws);
      n++;
    }
    return json({ ok: true, kicked: n });
  }

  // ---- WebSocket Hibernation 回调 ----
  async webSocketMessage(ws, message) {
    this.core.handleData(ws, message);
  }

  async webSocketClose(ws, code, reason) {
    this.dead.add(ws);
    for (const [id, s] of this.live) if (s === ws) this.live.delete(id);
    this.core.onClose(ws, code, reason);
  }

  async webSocketError(ws, err) {
    this.dead.add(ws);
    for (const [id, s] of this.live) if (s === ws) this.live.delete(id);
    console.warn("[hub] ws error:", err?.message || err);
  }
}

function sanitizeId(v) {
  if (typeof v !== "string") return "";
  const s = v.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s) ? s : "";
}
