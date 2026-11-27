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
    this.live = new Map();     // deviceId -> ws（只在 hello 通过后登记）
    this.pending = new Map();  // ws -> 期望的 deviceId（还没 hello）
    this.core = new HubCore({ send: sendJSON, log: (m) => console.log("[hub]", m) });
    this.core.setSockets(() => this.sockets());
    this.core.setSendFail((ws) => this.dropDead(ws));
    this.core.setOnHello((ws, msg) => this.onHello(ws, msg));
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
      const att = ws.deserializeAttachment() || {};
      if (!att.confirmed) continue;
      const id = att.deviceId || "default";
      this.core.hydrate(ws, att);
      if (!this.live.has(id)) this.live.set(id, ws);
    }
    return [...this.live.values()];
  }

  // 决定这条连接最终用哪个 deviceId。
  //  - 同一台机器重连（instanceId 相同）→ 顶掉旧连接，沿用原 id
  //  - 另一台机器撞名（instanceId 不同）→ 给新来的换个 id 并让它改名
  onHello(ws, msg) {
    this.sockets();   // DO 刚被唤醒时 live 是空的，先从 hibernation 恢复
    const desired = sanitizeId(msg?.deviceId) || this.pending.get(ws) || "default";
    const inst = String(msg?.instanceId || "").slice(0, 32);

    const existing = this.live.get(desired);
    if (existing && existing !== ws) {
      const old = this.core.deviceMeta(existing);
      const sameMachine = !!(inst && old.instanceId && old.instanceId === inst);
      if (sameMachine) {
        this.dead.add(existing);
        this.live.delete(desired);
        try { existing.close(4001, "replaced by a newer connection"); } catch { }
      } else {
        // 撞名：算一个空闲 id，通知对端改名后断开，不进入 live
        let n = 2;
        let cand = `${desired}-${n}`;
        while (this.live.has(cand) && n < 100) { n++; cand = `${desired}-${n}`; }
        this.pending.delete(ws);
        console.log("[hub] id collision:", desired, inst, "->", cand);
        try { sendJSON(ws, { t: "rename-to", deviceId: cand, reason: "id-taken" }); } catch { }
        // 不能立刻 close：消息可能还没发出去。留 500ms 让它收到并自己断开重连。
        setTimeout(() => { try { ws.close(4003, "device id already in use"); } catch { } }, 500);
        return false;
      }
    }

    this.live.set(desired, ws);
    this.pending.delete(ws);
    try {
      const m = this.core.deviceMeta(ws);
      ws.serializeAttachment({
        deviceId: desired, instanceId: inst, confirmed: true, since: Date.now(),
        name: m.name, version: m.version, host: m.host, os: m.os,
        distro: m.distro, arch: m.arch, tools: m.tools,
        connectedAt: m.connectedAt, lastSeen: m.lastSeen,
      });
    } catch { }
    return desired;
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

    // 先挂到 pending，等 hello 里拿到 instanceId 再决定是否顶掉旧连接，
    // 否则两台同名机器会互相踢，永远连不上。
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.serializeAttachment({ deviceId, confirmed: false, since: Date.now() });
    this.state.acceptWebSocket(server, ["agent"]);
    this.pending.set(server, deviceId);
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
    this.pending.delete(ws);
    this.dead.add(ws);
    for (const [id, s] of this.live) if (s === ws) this.live.delete(id);
    this.core.onClose(ws, code, reason);
  }

  async webSocketError(ws, err) {
    this.pending.delete(ws);
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
