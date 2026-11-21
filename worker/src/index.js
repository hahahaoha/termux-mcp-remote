// Cloudflare Worker：远程 MCP 入口 + 多设备隧道 + WebUI
//
// 架构：
//   AI 客户端 --(Authorization: Bearer)--> Worker --(WebSocket)--> 各设备 Agent --(exec)--> 终端
//
// 路由：
//   POST /mcp                      MCP（Streamable HTTP，stateless）
//   GET  /agent/ws?device=<id>     设备长连接（Bearer AGENT_TOKEN）
//   GET  /admin                    WebUI（用 AUTH_TOKEN 登录）
//   GET  /                        状态页
//   GET  /api/health               健康检查（公开）
//   GET  /api/status               状态（Bearer AUTH_TOKEN）
//   /api/admin/*                   WebUI 后端（Bearer AUTH_TOKEN）
//   /authorize /token /register / .well-known/*   OAuth（仅当设置 OWNER_PASSWORD）
import { handleMcpHttp, json, VERSION } from "./mcp.js";
import { AgentHub } from "./hub.js";
import { AuthStore } from "./auth.js";
import { Settings } from "./settings.js";
import { AdminAuth } from "./admin-auth.js";
import { EnrollStore } from "./enroll.js";
import { ADMIN_HTML } from "./admin-html.js";
import { checkToken } from "./crypto.js";

export { AgentHub, AuthStore, Settings, AdminAuth, EnrollStore };

const HUB_NAME = "hub-v4";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/api/health") {
      return json({
        ok: true,
        service: "termux-mcp-remote",
        version: VERSION,
        build: buildId(env),
        now: Date.now(),
      });
    }

    if (path === "/") return landing(request, env);

    // ---------- 设备通道 ----------
    if (path === "/agent/ws") {
      // 设备连接时把当前 build 塞进 URL，DO 会随 welcome 回给 Agent

      const settings = await getSettings(env);
      if (!checkBearer(request, settings.agentToken)) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      // 透传 device 查询参数给 DO
      const q = new URLSearchParams(url.search);
      q.set("build", buildId(env));
      return hubStub(env).fetch(new Request(`https://hub/connect?${q}`, request));
    }

    // ---------- WebUI ----------
    if (path === "/admin") {
      return new Response(ADMIN_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
        },
      });
    }

    // ---------- 一次性注册码 ----------
    // /api/enroll/redeem 必须公开：此时设备还没有任何凭证，这个码就是它唯一的身份证明
    if (path === "/api/enroll/redeem") {
      if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
      const body = await request.json().catch(() => ({}));
      const settings = await getSettings(env);
      return enrollStub(env).fetch("https://enroll/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // 关键：token 在兑换这一刻现取，不存进 DO
        body: JSON.stringify({
          code: body.code,
          deviceId: body.deviceId,
          name: body.name,
          inject: {
            workerUrl: new URL(request.url).origin,
            authToken: settings.authToken,
            agentToken: settings.agentToken,
          },
        }),
      });
    }

    // ---------- 后台登录（独立于 MCP 凭证） ----------
    if (path.startsWith("/api/auth/")) {
      const sub = path.slice("/api/auth".length);
      // 重置密码需要 AUTH_TOKEN（CLI 用），其余公开
      if (sub === "/reset") {
        const settings = await getSettings(env);
        if (!checkBearer(request, settings.authToken) && !checkBearer(request, settings.agentToken)) {
          return json({ ok: false, error: "unauthorized" }, 401);
        }
      }
      return adminAuthStub(env).fetch(new Request(`https://admin-auth${sub}`, request));
    }

    // ---------- 状态查询：给 CLI 用，接受 AUTH_TOKEN（服务端到服务端） ----------
    if (path === "/api/status") {
      const settings = await getSettings(env);
      const byToken = checkBearer(request, settings.authToken) || checkBearer(request, settings.agentToken);
      if (!byToken) {
        const gate = await requireAdminSession(request, env);
        if (!gate.ok) return json({ ok: false, error: gate.error, needLogin: true }, 401);
      }
      const agent = await getStatus(env);
      return json({ ok: true, worker: { version: VERSION, now: Date.now() }, agent });
    }

    // ---------- 管理 API（后台会话） ----------
    if (path.startsWith("/api/")) {
      const settings = await getSettings(env);
      // 只读端点额外接受设备凭证（AGENT_TOKEN）：设备本来就能执行任意命令、
      // 也能读到本地配置里的 AUTH_TOKEN，所以这不算提权；好处是 AUTH_TOKEN
      // 在 WebUI 上被轮换后，CLI 还能用设备凭证自愈。
      const DEVICE_OK = new Set(["/api/admin/state", "/api/admin/reveal-token"]);
      const byDevice = DEVICE_OK.has(path) && checkBearer(request, settings.agentToken);
      if (!byDevice) {
        const gate = await requireAdminSession(request, env);
        if (!gate.ok) return json({ ok: false, error: gate.error, needLogin: true }, gate.status || 401);
      }
      return handleAdminApi(request, env, settings, path);
    }

    // ---------- OAuth（可选） ----------
    if (env.OWNER_PASSWORD) {
      if (
        path.startsWith("/.well-known/") ||
        path === "/authorize" || path === "/token" || path === "/register" || path === "/revoke"
      ) {
        return authStub(env).fetch(new Request(url.toString(), request));
      }
    }

    // ---------- MCP ----------
    if (path === "/mcp") {
      const settings = await getSettings(env);
      return handleMcpHttp(request, {
        authorize: (req) => authorizeMcp(req, env, settings),
        callTool: (tool, args, timeoutMs, device) => callAgent(env, tool, args, timeoutMs, device || settings.defaultDevice),
        status: () => getStatus(env),
        kick: (device) => kickDevice(env, device),
      });
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};

// ============================== 管理 API ==============================

async function handleAdminApi(request, env, settings, path) {
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

  switch (path) {
    case "/api/admin/state": {
      const agent = await getStatus(env);
      const auth = await adminAuthStub(env).fetch("https://admin-auth/status").then((r) => r.json()).catch(() => ({}));
      // 只回打码后的凭证预览；完整值要显式调用 /reveal-token
      return json({
        ok: true,
        worker: { version: VERSION, now: Date.now(), host: new URL(request.url).origin },
        devices: agent.devices || [],
        defaultDevice: settings.defaultDevice ?? agent.defaultDevice ?? null,
        authPreview: maskToken(settings.authToken),
        authFrom: settings.authFrom,
        agentPreview: maskToken(settings.agentToken),
        agentFrom: settings.agentFrom,
        oauth: !!env.OWNER_PASSWORD,
        adminPasswordSet: !!auth.configured,
        adminPasswordUpdatedAt: auth.updatedAt || null,
        calls: agent.calls ?? 0,
        errors: agent.errors ?? 0,
      });
    }

    // 显式查看完整凭证（需要后台会话；用于复制客户端配置）
    case "/api/admin/reveal-token": {
      const which = body.kind === "agent" ? "agent" : "auth";
      return json({ ok: true, kind: which, token: which === "auth" ? settings.authToken : settings.agentToken });
    }

    // 修改后台密码（需要当前密码）
    case "/api/admin/change-password": {
      const cur = String(body.current || "");
      const next = String(body.password || "");
      const rec = await adminAuthStub(env).fetch("https://admin-auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: cur }),
      });
      const rj = await rec.json().catch(() => ({}));
      if (!rj.ok) return json({ ok: false, error: "当前密码不正确" }, 400);
      const r = await adminAuthStub(env).fetch("https://admin-auth/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: next }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) return json(j, 400);
      // reset 会清空所有会话，需要用新密码重新登录
      return json({ ok: true, relogin: true, message: "密码已修改，请重新登录" });
    }

    case "/api/admin/kick": {
      const r = await kickDevice(env, body.device || null);
      return json({ ok: true, ...r });
    }

    case "/api/admin/device-info": {
      const tool = body.which === "system" ? "system_info" : "__sysinfo";
      const res = await callAgent(env, tool, {}, 20000, body.device);
      return json({ ok: res.ok, text: res.ok ? res.text : res.error });
    }

    case "/api/admin/logs": {
      const res = await callAgent(env, "__logs", {
        which: body.which || "agent",
        lines: Number(body.lines) || 200,
      }, 25000, body.device);
      return json({ ok: res.ok, text: res.ok ? res.text : res.error });
    }

    case "/api/admin/enroll/create": {
      const ttl = Number(body.ttlSec) || 600;
      return enrollStub(env).fetch("https://enroll/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ttlSec: ttl, hint: body.hint || "" }),
      });
    }

    case "/api/admin/enroll/list": {
      return enrollStub(env).fetch("https://enroll/list");
    }

    case "/api/admin/enroll/revoke": {
      return enrollStub(env).fetch("https://enroll/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: body.id }),
      });
    }

    case "/api/admin/default-device": {
      const saved = await setSettings(env, { defaultDevice: body.device || null });
      return json({ ok: true, defaultDevice: saved.defaultDevice });
    }

    case "/api/admin/rotate-token": {
      const kind = body.kind === "agent" ? "agent" : "auth";
      const value = typeof body.value === "string" && body.value.trim()
        ? body.value.trim()
        : randomToken();
      if (value.length < 16) return json({ ok: false, error: "token 至少 16 个字符" }, 400);
      const patch = kind === "auth" ? { authToken: value } : { agentToken: value };
      await setSettings(env, patch);
      return json({ ok: true, kind, token: value });
    }

    default:
      return json({ ok: false, error: "not found" }, 404);
  }
}

// ============================== 鉴权 ==============================

async function authorizeMcp(request, env, settings) {
  const origin = new URL(request.url).origin;
  const prmUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
  const authHeader = request.headers.get("authorization") || "";
  const bearer =
    /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim() || request.headers.get("x-mcp-token") || "";

  if (!bearer) {
    return {
      error: `缺少鉴权请求头。请发送 Authorization: Bearer <AUTH_TOKEN>${env.OWNER_PASSWORD ? "，或使用 OAuth 登录" : ""}`,
      resourceMetadataUrl: env.OWNER_PASSWORD ? prmUrl : undefined,
    };
  }
  if (checkToken(bearer, settings.authToken)) return true;

  if (env.OWNER_PASSWORD) {
    const r = await authStub(env).fetch("https://auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: bearer }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.ok) return true;
  }
  return {
    error: "请求头里的 token 无效或已过期",
    resourceMetadataUrl: env.OWNER_PASSWORD ? prmUrl : undefined,
  };
}

// 后台会话：读 HttpOnly cookie（也接受 Authorization: Session <token>，方便脚本）
async function requireAdminSession(request, env) {
  const token = readAdminCookie(request);
  if (!token) return { ok: false, status: 401, error: "未登录" };
  const r = await adminAuthStub(env).fetch("https://admin-auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: token }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) return { ok: false, status: 401, error: j.expired ? "登录已过期" : "会话无效" };
  return { ok: true, expiresAt: j.expiresAt };
}

function readAdminCookie(request) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "tmcp_admin") return rest.join("=") || "";
  }
  // 脚本友好：Authorization: Session <token>
  const a = request.headers.get("authorization") || "";
  const m = /^Session\s+(.+)$/i.exec(a);
  return m ? m[1].trim() : "";
}

// aaaaaaaa…zzzz 形式的凭证预览
function maskToken(t) {
  if (!t) return "";
  if (t.length <= 14) return "•".repeat(t.length);
  return `${t.slice(0, 6)}${"•".repeat(10)}${t.slice(-4)}`;
}

function checkBearer(request, expected) {
  if (!expected) return false;
  const h = request.headers.get("authorization") || "";
  const v = /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim();
  return !!v && checkToken(v, expected);
}

function randomToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ============================== 隧道 ==============================

async function getSettings(env) {
  const r = await settingsStub(env).fetch("https://settings/get");
  return r.json();
}

async function setSettings(env, patch) {
  const r = await settingsStub(env).fetch("https://settings/set", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  return r.json();
}

async function callAgent(env, tool, args, timeoutMs, device) {
  let r;
  try {
    r = await hubStub(env).fetch("https://hub/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, args, timeout_ms: timeoutMs, device }),
    });
  } catch (e) {
    return { ok: false, error: "无法连接 Worker 内部通道：" + (e?.message || e) };
  }
  try { return await r.json(); } catch { return { ok: false, error: `Worker 返回异常（HTTP ${r.status}）` }; }
}

async function getStatus(env) {
  try {
    const r = await hubStub(env).fetch("https://hub/status");
    return await r.json();
  } catch (e) {
    return { ok: false, online: false, devices: [], error: String(e?.message || e) };
  }
}

async function kickDevice(env, device) {
  const q = device ? `?device=${encodeURIComponent(device)}` : "";
  const r = await hubStub(env).fetch(`https://hub/disconnect${q}`);
  return r.json().catch(() => ({ ok: true }));
}

// 当前 Worker 的版本标识（用于让 Agent 感知"代码换了，请重连"）
function buildId(env) {
  return env.CF_VERSION?.id || "dev";
}

function hubStub(env) {
  return env.AGENT_HUB.get(env.AGENT_HUB.idFromName(env.HUB_NAME || HUB_NAME));
}
function settingsStub(env) {
  return env.SETTINGS.get(env.SETTINGS.idFromName("default"));
}
function enrollStub(env) {
  return env.ENROLL.get(env.ENROLL.idFromName("default"));
}
function adminAuthStub(env) {
  return env.ADMIN_AUTH.get(env.ADMIN_AUTH.idFromName("default"));
}
function authStub(env) {
  return env.AUTH_STORE.get(env.AUTH_STORE.idFromName("default"));
}

// ============================== 状态页 ==============================

async function landing(request, env) {
  const status = await getStatus(env);
  const url = new URL(request.url);
  const devices = status.devices || [];
  const rows = devices.length
    ? devices.map((d) => `
      <div class="dev on">
        <div class="dn"><i class="dot"></i>${esc(d.name || d.id)}</div>
        <div class="di">${esc(d.id)}</div>
        <div class="dm">${esc([d.os, d.distro, d.arch].filter(Boolean).join(" · "))}${d.version ? " · v" + esc(d.version) : ""}</div>
      </div>`).join("")
    : `<div class="empty">还没有设备接入 — 在设备上执行 <code>tmcp start</code></div>`;

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>termux-mcp-remote</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;
background:#0b0e14;color:#d8dee9;font:15px/1.65 -apple-system,"Segoe UI",Roboto,"Noto Sans SC",sans-serif}
.card{width:min(720px,100%);padding:26px 28px;border:1px solid #222838;border-radius:16px;background:#11151f;
box-shadow:0 24px 60px -20px #000}
h1{font-size:20px;margin:0 0 3px}
.sub{color:#7d879b;font-size:12.5px;margin-bottom:18px}
.pill{display:inline-flex;align-items:center;gap:7px;padding:4px 11px;border-radius:999px;font-size:12.5px}
.on{background:#0f2f22;color:#5ee2a0;border:1px solid #1c5c43}
.off{background:#331a1a;color:#ff8b8b;border:1px solid #5c2626}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.grid{display:grid;gap:8px;margin-top:14px}
.dev{border:1px solid #1f2937;border-radius:10px;padding:10px 12px;background:#0d1219}
.dn{font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:7px}
.dn .dot{color:#5ee2a0}
.di{font:11.5px ui-monospace,Menlo,monospace;color:#7d879b;margin:2px 0}
.dm{font-size:12px;color:#7d879b}
.empty{border:1px dashed #2a3244;border-radius:10px;padding:16px;text-align:center;color:#7d879b;font-size:13px}
dl{display:grid;grid-template-columns:auto 1fr;gap:7px 18px;margin:18px 0 0;font-size:13px}
dt{color:#7d879b}dd{margin:0;font-family:ui-monospace,Menlo,monospace;word-break:break-all}
code{background:#1a2030;padding:1px 6px;border-radius:5px;font-size:12px}
.btn{display:inline-block;margin-top:18px;padding:9px 18px;border-radius:9px;background:#3b82f6;color:#fff;
text-decoration:none;font-size:13.5px;font-weight:600}
</style></head><body>
<div class="card">
  <h1>termux-mcp-remote</h1>
  <div class="sub">${esc(url.host)} · v${VERSION}</div>
  <span class="pill ${devices.length ? "on" : "off"}"><span class="dot"></span>${devices.length ? `${devices.length} 台设备在线` : "没有设备在线"}</span>
  <div class="grid">${rows}</div>
  <dl>
    <dt>MCP 端点</dt><dd>${esc(url.origin)}/mcp</dd>
    <dt>鉴权</dt><dd>Authorization: Bearer &lt;AUTH_TOKEN&gt;</dd>
  </dl>
  <a class="btn" href="/admin">打开管理界面 →</a>
</div></body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
