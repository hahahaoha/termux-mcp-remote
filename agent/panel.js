// 本地管理面板：默认只监听 127.0.0.1:29201，用浏览器在手机上查看状态、改配置。
// 不复用 AUTH_TOKEN 之外的东西；面板本身不暴露到公网。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig, saveConfig, readPid, pidAlive, ensureDirs, CONFIG_PATH } from "./config.js";
import { PANEL_HTML } from "./panel-html.js";

const PORT = Number(process.env.PANEL_PORT || 29201);
const HOST = process.env.PANEL_HOST || "127.0.0.1";

function json(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(s);
}

async function remoteStatus(cfg) {
  try {
    const r = await fetch(`${cfg.workerUrl}/api/status`, {
      headers: { authorization: `Bearer ${cfg.authToken}` },
      signal: AbortSignal.timeout(12000),
    });
    const j = await r.json();
    return { ok: true, ...j };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export function startPanel({ port = PORT, host = HOST, log = console.log } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    const cfg = loadConfig();

    if (url.pathname === "/" || url.pathname === "/panel") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        "cache-control": "no-store",
      });
      return res.end(PANEL_HTML);
    }

    if (url.pathname === "/api/state") {
      const pid = readPid();
      const status = cfg.workerUrl ? await remoteStatus(cfg) : { ok: false, error: "未配置 Worker 地址" };
      return json(res, 200, {
        configPath: CONFIG_PATH,
        workerUrl: cfg.workerUrl,
        name: cfg.name,
        authTokenTail: cfg.authToken ? cfg.authToken.slice(-6) : "",
        authSet: !!cfg.authToken,
        agentTokenSet: !!cfg.agentToken,
        pid,
        pidAlive: pidAlive(pid),
        maxShells: cfg.maxShells,
        platform: { node: process.version, arch: os.arch(), uptimeHours: Math.round(os.uptime() / 3600) },
        remote: status,
      });
    }

    if (url.pathname === "/api/config" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return json(res, 400, { ok: false, error: "bad json" }); }
      const next = loadConfig();
      if (typeof body.workerUrl === "string" && body.workerUrl.trim()) next.workerUrl = body.workerUrl.trim();
      if (typeof body.name === "string" && body.name.trim()) next.name = body.name.trim().slice(0, 40);
      if (typeof body.authToken === "string" && body.authToken.trim()) next.authToken = body.authToken.trim();
      if (typeof body.agentToken === "string" && body.agentToken.trim()) next.agentToken = body.agentToken.trim();
      if (body.maxShells && Number.isInteger(body.maxShells)) next.maxShells = Math.min(Math.max(body.maxShells, 1), 16);
      saveConfig(next);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/logs") {
      const want = url.searchParams.get("file") || "agent.log";
      const safe = path.basename(want);
      const p = path.join(os.homedir(), ".config", "termux-mcp-remote", "logs", safe);
      let text = "";
      try {
        const st = fs.statSync(p);
        const start = Math.max(0, st.size - 30000);
        const fd = fs.openSync(p, "r");
        const buf = Buffer.alloc(st.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        text = buf.toString("utf8");
      } catch (e) {
        text = `[读取失败：${e.message}]`;
      }
      return json(res, 200, { ok: true, file: safe, text });
    }

    json(res, 404, { ok: false, error: "not found" });
  });

  server.listen(port, host, () => log(`管理面板: http://${host}:${port}/panel`));
  return server;
}
