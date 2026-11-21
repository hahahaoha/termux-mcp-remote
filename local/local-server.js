#!/usr/bin/env node
// 本地服务器：在没有 Cloudflare Worker 的情况下，用同一套协议在本机跑通
// 「MCP 客户端 → HTTP+鉴权头 → 隧道 → Agent → 终端」，方便验证与排障。
// 用法：tmcp local  （默认 127.0.0.1:29200）
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HubCore } from "../worker/src/hub-core.js";
import { handleMcpHttp, json, VERSION } from "../worker/src/mcp.js";
import { sendJSON } from "../shared/wsjson.js";
import { loadConfig, randomToken, saveConfig } from "../agent/config.js";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 29200);
const HOST = process.env.HOST || "127.0.0.1";

// 本地模式的 token 独立于 Worker，避免 WebUI 轮换后本地测试跟着失效。
// 优先用环境变量，其次用 config.json 里的 localAuthToken。
const cfg = loadConfig();
const AUTH_TOKEN = process.env.LOCAL_AUTH_TOKEN || cfg.localAuthToken || randomToken(32);
const AGENT_TOKEN = process.env.LOCAL_AGENT_TOKEN || cfg.localAgentToken || randomToken(32);
if (!cfg.localAuthToken || !cfg.localAgentToken) {
  saveConfig({ ...cfg, localAuthToken: AUTH_TOKEN, localAgentToken: AGENT_TOKEN });
}

// ---------------- 极简 WebSocket 服务端（只实现本项目需要的部分） ----------------
const sockets = new Set();

// 与服务端实现等价的 Sec-WebSocket-Accept
function wsAccept(key) {
  return createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}

function wsFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

class LocalSocket {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.open = true;
    this.fragments = [];
    sock.on("data", (d) => this.onData(d));
    sock.on("close", () => this.onClose(1006, "socket closed"));
    sock.on("error", () => this.onClose(1006, "socket error"));
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2)); off = 10;
      }
      let mask = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        mask = this.buf.subarray(off, off + 4); off += 4;
      }
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      this.buf = this.buf.subarray(off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

      if (opcode === 0x8) { this.close(1000, ""); return; }
      if (opcode === 0x9) { this.ping(payload); continue; }
      if (opcode === 0xa) continue; // pong
      if (opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) { const full = Buffer.concat(this.fragments); this.fragments = []; this.emit(full.toString("utf8")); }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) this.emit(payload.toString("utf8"));
        else { this.fragments = [payload]; }
      }
    }
  }
  emit(text) {
    try { this.onmessage && this.onmessage(text); } catch (e) { console.error(e); }
  }
  send(text) {
    if (!this.open) return;
    try { this.sock.write(wsFrame(text)); } catch { }
  }
  ping(payload) {
    const p = Buffer.from(payload);
    const header = Buffer.from([0x8a, p.length]);
    try { this.sock.write(Buffer.concat([header, p])); } catch { }
  }
  close(code = 1000, reason = "") {
    if (!this.open) return;
    this.open = false;
    const r = Buffer.from(reason, "utf8");
    const b = Buffer.alloc(2 + r.length);
    b.writeUInt16BE(code, 0); r.copy(b, 2);
    try { this.sock.write(Buffer.concat([Buffer.from([0x88, b.length]), b])); } catch { }
    try { this.sock.end(); } catch { }
    this.onClose(code, reason);
  }
  onClose(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    try { this.onclose && this.onclose({ code, reason }); } catch { }
  }
}

// ---------------- 隧道核心 ----------------
const core = new HubCore({ send: sendJSON, log: (m) => console.log("[hub]", m) });
core.setSockets(() => [...sockets]);
core.setSendFail((ws) => { try { ws.close(4002, "send failed"); } catch { } });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const authed = () => {
    const h = req.headers.authorization || "";
    const v = /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim();
    return v === AUTH_TOKEN;
  };

  try {
    if (url.pathname === "/api/health") {
      return respond(res, 200, { ok: true, service: "termux-mcp-remote-local", version: VERSION, now: Date.now() });
    }
    if (url.pathname === "/api/status") {
      if (!authed()) return respond(res, 401, { ok: false, error: "unauthorized" });
      return respond(res, 200, { ok: true, worker: { version: VERSION, now: Date.now() }, agent: core.status() });
    }
    if (url.pathname === "/api/agent/kick" && req.method === "POST") {
      if (!authed()) return respond(res, 401, { ok: false, error: "unauthorized" });
      for (const s of sockets) s.close(4000, "kicked");
      return respond(res, 200, { ok: true, kicked: true });
    }
    if (url.pathname === "/mcp") {
      // 转成 Web 标准 Request
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const wreq = new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: body.length ? body : undefined,
      });
      const wres = await handleMcpHttp(wreq, {
        authorize: (r) => {
          const h = r.headers.get("authorization") || "";
          const v = /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim();
          return v === AUTH_TOKEN ? true : { error: "token 无效（本地模式请使用 LOCAL_AUTH_TOKEN）" };
        },
        callTool: (tool, args, timeoutMs) => core.rpc({ tool, args, timeout_ms: timeoutMs }),
        status: () => core.status(),
        kick: () => { for (const s of sockets) s.close(4000, "kicked"); },
      });
      res.writeHead(wres.status, Object.fromEntries(wres.headers));
      const ab = await wres.arrayBuffer();
      res.end(Buffer.from(ab));
      return;
    }
    respond(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    console.error("[local] error", e);
    if (!res.headersSent) respond(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

server.on("upgrade", (req, sock) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname !== "/agent/ws") { sock.destroy(); return; }
  const h = req.headers.authorization || "";
  const v = /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim();
  if (v !== AGENT_TOKEN) {
    sock.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); sock.destroy(); return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) { sock.write("HTTP/1.1 400 Bad Request\r\n\r\n"); sock.destroy(); return; }
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );
  const ws = new LocalSocket(sock);
  sockets.add(ws);
  ws.onmessage = (text) => core.handleData(ws, text);
  ws.onclose = () => { sockets.delete(ws); core.onClose(ws, 1006, "closed"); };
  core.onOpen(ws, url.searchParams.get("device") || "default");
});

function respond(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(s);
}

server.listen(PORT, HOST, () => {
  console.log(`本地模拟服务器已启动：http://${HOST}:${PORT}`);
  console.log(`MCP 端点: http://${HOST}:${PORT}/mcp`);
  console.log(`AUTH_TOKEN: ${AUTH_TOKEN}`);
  console.log(`AGENT_TOKEN: ${AGENT_TOKEN}`);
  console.log(`\n另开一个终端启动 Agent（把 workerUrl 指到本机）：`);
  console.log(`  tmcp url http://${HOST}:${PORT} && tmcp start`);
});
