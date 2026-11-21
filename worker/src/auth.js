// 可选的 OAuth 2.1 授权服务器（只有设置 OWNER_PASSWORD 时才挂载）。
// 作用：让支持 OAuth 的 MCP 客户端（Claude 网页版、ChatGPT、各种 Inspector）
// 通过「打开网页 → 输入你自己设的密码」拿到访问令牌，不用手工填 AUTH_TOKEN。
// 只有你知道密码，因此等于仍然「仅你一人可用」。
import { checkToken } from "./crypto.js";

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_MS = 30 * 24 * 3600 * 1000;   // 30 天
const REFRESH_TTL_MS = 180 * 24 * 3600 * 1000; // 180 天
const LOGIN_TTL_MS = 12 * 3600 * 1000;

export class AuthStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p.startsWith("/.well-known/oauth-protected-resource")) return this.protectedResource(url);
      if (p === "/.well-known/oauth-authorization-server") return this.serverMetadata(url);
      if (p === "/register") return await this.register(request, url);
      if (p === "/authorize") return await this.authorize(request, url);
      if (p === "/token") return await this.token(request);
      if (p === "/revoke") return await this.revoke(request);
      if (p === "/verify") return await this.verify(request);
      return j({ ok: false, error: "not found" }, 404);
    } catch (e) {
      return j({ ok: false, error: String(e?.message || e) }, 400);
    }
  }

  // ---------- 元数据 ----------
  protectedResource(url) {
    return j(
      {
        resource: `${url.origin}/mcp`,
        authorization_servers: [url.origin],
        scopes_supported: ["mcp"],
        resource_name: "termux-mcp-remote",
        bearer_methods_supported: ["header"],
      },
      200,
      true
    );
  }

  serverMetadata(url) {
    return j(
      {
        issuer: url.origin,
        authorization_endpoint: `${url.origin}/authorize`,
        token_endpoint: `${url.origin}/token`,
        registration_endpoint: `${url.origin}/register`,
        revocation_endpoint: `${url.origin}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        scopes_supported: ["mcp"],
      },
      200,
      true
    );
  }

  // ---------- 动态客户端注册 ----------
  async register(request, url) {
    if (request.method !== "POST") return j({ error: "invalid_request" }, 405);
    const meta = await request.json().catch(() => null);
    if (!meta || !Array.isArray(meta.redirect_uris) || meta.redirect_uris.length === 0) {
      return j({ error: "invalid_client_metadata", error_description: "redirect_uris 必填" }, 400);
    }
    for (const u of meta.redirect_uris) {
      let parsed;
      try { parsed = new URL(u); } catch { return j({ error: "invalid_redirect_uri", error_description: `非法 URI: ${u}` }, 400); }
      // 只允许 https 与回环地址（RFC 8252 原生客户端）
      const isLoop = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
      if (parsed.protocol !== "https:" && !isLoop) {
        return j({ error: "invalid_redirect_uri", error_description: `只接受 https 或本机回环地址：${u}` }, 400);
      }
    }
    const clientId = crypto.randomUUID();
    const client = {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: String(meta.client_name || "mcp-client").slice(0, 100),
      redirect_uris: meta.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    await this.state.storage.put(`client:${clientId}`, client);
    const list = (await this.state.storage.get("clientIndex")) || [];
    list.push(clientId);
    await this.state.storage.put("clientIndex", list.slice(-200));
    return j(client, 201, true);
  }

  // ---------- 授权页 ----------
  async authorize(request, url) {
    const params = request.method === "POST"
      ? new URLSearchParams(await request.text())
      : url.searchParams;

    const clientId = params.get("client_id") || "";
    const redirectUri = params.get("redirect_uri") || "";
    const state = params.get("state") || "";
    const challenge = params.get("code_challenge") || "";
    const method = params.get("code_challenge_method") || "";
    const scope = params.get("scope") || "mcp";
    const responseType = params.get("response_type") || "";

    const client = await this.state.storage.get(`client:${clientId}`);
    if (!client) return htmlPage("客户端未注册", `<p>client_id 无效：<code>${esc(clientId)}</code></p>`, 400);
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      return htmlPage("回调地址不匹配", `<p>请求的 redirect_uri 未在客户端注册：<code>${esc(redirectUri)}</code></p>`, 400);
    }
    if (responseType !== "code") return redirectErr(redirectUri, "unsupported_response_type", state);
    if (!challenge || method !== "S256") return redirectErr(redirectUri, "invalid_request", state, "必须使用 PKCE S256");

    const password = params.get("password");
    if (!password) {
      return htmlPage(
        "授权登录",
        `<p style="color:#94a0b8;font-size:13.5px;margin:0 0 6px">
           客户端 <b>${esc(client.client_name || "MCP 客户端")}</b> 请求访问你的手机终端。
         </p>
         <p style="color:#ffb86b;font-size:13px;margin:0 0 18px">请输入你自己设置的所有者密码。</p>
         <form method="POST">
           ${hidden(params)}
           <input type="password" name="password" placeholder="Owner password" autofocus required
             style="width:100%;padding:11px 13px;border-radius:9px;border:1px solid #2a3244;background:#0b0e14;color:#e6ebf5;font-size:14px;box-sizing:border-box">
           <button type="submit"
             style="margin-top:14px;width:100%;padding:11px;border-radius:9px;border:0;background:#3b82f6;color:#fff;font-size:14px;font-weight:600;cursor:pointer">
             授权
           </button>
         </form>`,
        200
      );
    }

    if (!checkToken(String(password), this.env.OWNER_PASSWORD)) {
      await sleep(600); // 减缓暴力尝试
      return htmlPage(
        "密码错误",
        `<p>密码不正确。</p><form method="POST">${hidden(params).replace('name="password"', 'name="password_unused"')}
          <input type="password" name="password" autofocus required
            style="width:100%;padding:11px 13px;border-radius:9px;border:1px solid #5c2626;background:#0b0e14;color:#e6ebf5;font-size:14px;box-sizing:border-box">
          <button type="submit" style="margin-top:14px;width:100%;padding:11px;border-radius:9px;border:0;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer">重试</button>
         </form>`,
        401
      );
    }

    const code = rand(32);
    await this.state.storage.put(`code:${code}`, {
      clientId, redirectUri, challenge, scope, expiresAt: Date.now() + CODE_TTL_MS,
    });
    await this.state.storage.setAlarm(Date.now() + CODE_TTL_MS + 60_000);

    const loc = new URL(redirectUri);
    loc.searchParams.set("code", code);
    if (state) loc.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { location: loc.href } });
  }

  // ---------- 令牌 ----------
  async token(request) {
    if (request.method !== "POST") return j({ error: "invalid_request" }, 405);
    const ct = request.headers.get("content-type") || "";
    const form = ct.includes("application/json")
      ? new URLSearchParams(await request.json().then((o) => o || {}).catch(() => ({})))
      : new URLSearchParams(await request.text());
    const grant = form.get("grant_type");

    if (grant === "authorization_code") {
      const code = form.get("code") || "";
      const verifier = form.get("code_verifier") || "";
      const clientId = form.get("client_id") || (await this.basicAuthClient(request));
      const rec = await this.state.storage.get(`code:${code}`);
      if (!rec) return j({ error: "invalid_grant", error_description: "授权码无效或已使用" }, 400);
      await this.state.storage.delete(`code:${code}`);
      if (rec.expiresAt < Date.now()) return j({ error: "invalid_grant", error_description: "授权码已过期" }, 400);
      if (clientId && rec.clientId !== clientId) return j({ error: "invalid_grant", error_description: "client 不匹配" }, 400);
      if (form.get("redirect_uri") && form.get("redirect_uri") !== rec.redirectUri) {
        return j({ error: "invalid_grant", error_description: "redirect_uri 不匹配" }, 400);
      }
      const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
      if (!checkToken(challenge, rec.challenge)) return j({ error: "invalid_grant", error_description: "PKCE 校验失败" }, 400);
      return this.issue(rec.clientId, rec.scope || "mcp");
    }

    if (grant === "refresh_token") {
      const rt = form.get("refresh_token") || "";
      const rec = await this.state.storage.get(`refresh:${rt}`);
      if (!rec || rec.expiresAt < Date.now()) return j({ error: "invalid_grant", error_description: "refresh_token 无效" }, 400);
      await this.state.storage.delete(`refresh:${rt}`);
      return this.issue(rec.clientId, rec.scope || "mcp");
    }

    return j({ error: "unsupported_grant_type" }, 400);
  }

  async issue(clientId, scope) {
    const access = rand(32);
    const refresh = rand(32);
    const now = Date.now();
    await this.state.storage.put(`access:${access}`, { clientId, scope, expiresAt: now + ACCESS_TTL_MS });
    await this.state.storage.put(`refresh:${refresh}`, { clientId, scope, expiresAt: now + REFRESH_TTL_MS });
    const idx = (await this.state.storage.get("accessIndex")) || [];
    idx.push(access);
    await this.state.storage.put("accessIndex", idx.slice(-500));
    return j(
      {
        access_token: access,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TTL_MS / 1000),
        refresh_token: refresh,
        scope,
      },
      200,
      true
    );
  }

  async revoke(request) {
    const form = new URLSearchParams(await request.text());
    const t = form.get("token") || "";
    await this.state.storage.delete(`access:${t}`);
    await this.state.storage.delete(`refresh:${t}`);
    return new Response(null, { status: 200, headers: { ...cors(), "cache-control": "no-store" } });
  }

  async verify(request) {
    const { token } = await request.json().catch(() => ({}));
    if (!token) return j({ ok: false }, 200);
    const rec = await this.state.storage.get(`access:${token}`);
    if (!rec) return j({ ok: false }, 200);
    if (rec.expiresAt < Date.now()) {
      await this.state.storage.delete(`access:${token}`);
      return j({ ok: false, reason: "expired" }, 200);
    }
    return j({ ok: true, clientId: rec.clientId, scope: rec.scope, expiresAt: rec.expiresAt }, 200);
  }

  async alarm() {
    const now = Date.now();
    for (const key of await this.state.storage.list({ prefix: "code:" })) {
      if (key[1].expiresAt < now) await this.state.storage.delete(key[0]);
    }
    for (const key of await this.state.storage.list({ prefix: "access:" })) {
      if (key[1].expiresAt < now) await this.state.storage.delete(key[0]);
    }
    for (const key of await this.state.storage.list({ prefix: "refresh:" })) {
      if (key[1].expiresAt < now) await this.state.storage.delete(key[0]);
    }
  }
}

// ---------- 小工具 ----------
function rand(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function b64url(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "cache-control": "no-store",
  };
}
function j(obj, status = 200, withCors = false) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(withCors ? cors() : {}) },
  });
}
async function basicAuthClient(request) {
  const h = request.headers.get("authorization") || "";
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return "";
  try { return atob(m[1]).split(":")[0]; } catch { return ""; }
}
function redirectErr(redirectUri, error, state, desc) {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  if (desc) u.searchParams.set("error_description", desc);
  if (state) u.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { location: u.href } });
}
function hidden(params) {
  return [...params.entries()]
    .filter(([k]) => k !== "password")
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("\n");
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function htmlPage(title, body, status = 200) {
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · termux-mcp-remote</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0b0e14;color:#d8dee9;font:15px/1.6 -apple-system,"Segoe UI",Roboto,"Noto Sans SC",sans-serif}
.card{width:min(400px,92vw);padding:26px 28px;border:1px solid #222838;border-radius:16px;background:#11151f;
box-shadow:0 24px 60px -20px #000}
h2{font-size:17px;margin:0 0 14px}
code{background:#1a2030;padding:2px 6px;border-radius:6px;font-size:12.5px;word-break:break-all}
</style></head><body><div class="card"><h2>${esc(title)}</h2>${body}</div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}
