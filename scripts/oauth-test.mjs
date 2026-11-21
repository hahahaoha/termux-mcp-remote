#!/usr/bin/env node
// OAuth 流程验收：动态注册 → 授权页 → 密码 → 授权码 → PKCE 换 token → 用 token 调 MCP
// 用法：node scripts/oauth-test.mjs [BASE_URL]
import crypto from "node:crypto";

// 用法：node scripts/oauth-test.mjs https://mcp.example.com <OWNER_PASSWORD>
const BASE = (process.argv[2] || process.env.TMCP_BASE || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("用法：node scripts/oauth-test.mjs https://你的域名 <OWNER_PASSWORD>");
  console.error("   或设置环境变量 TMCP_BASE");
  process.exit(2);
}
const PASSWORD = process.argv[3] || process.env.OWNER_PASSWORD;
if (!PASSWORD) {
  console.error("用法：node scripts/oauth-test.mjs https://你的域名 <OWNER_PASSWORD>");
  process.exit(2);
}
const REDIRECT = "http://127.0.0.1:33445/callback";

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

async function retry(fn, n = 4) {
  let last;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
  }
  throw last;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

console.log(`\nOAuth 流程测试: ${BASE}\n`);

try {
  console.log("== 1. 元数据发现 ==");
  const prm = await retry(async () => (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json());
  check("PRM 指向 /mcp", prm.resource === `${BASE}/mcp`, JSON.stringify(prm));
  check("PRM 声明授权服务器", Array.isArray(prm.authorization_servers) && prm.authorization_servers.includes(BASE));

  const asm = await retry(async () => (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json());
  check("AS issuer 正确", asm.issuer === BASE);
  check("有授权端点", asm.authorization_endpoint === `${BASE}/authorize`);
  check("有 token 端点", asm.token_endpoint === `${BASE}/token`);
  check("支持 S256 PKCE", (asm.code_challenge_methods_supported || []).includes("S256"));

  console.log("\n== 2. 动态客户端注册 ==");
  const reg = await retry(async () => {
    const r = await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "oauth-acceptance-test",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
    return r.json();
  });
  check("注册返回 client_id", typeof reg.client_id === "string" && reg.client_id.length > 10);

  console.log("\n== 3. 拒绝非法 redirect_uri ==");
  const badReg = await retry(async () => fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"], token_endpoint_auth_method: "none" }),
  }));
  check("非 https 且非回环被拒", badReg.status === 400, `HTTP ${badReg.status}`);

  console.log("\n== 4. 授权页（未带密码） ==");
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const authUrl = new URL(`${BASE}/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", reg.client_id);
  authUrl.searchParams.set("redirect_uri", REDIRECT);
  authUrl.searchParams.set("state", "test-state-123");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("scope", "mcp");

  const page = await retry(async () => (await fetch(authUrl, { redirect: "manual" })).text());
  check("返回授权表单", page.includes("<form") && page.includes('name="password"'));
  check("表单保留 client_id", page.includes(reg.client_id));

  console.log("\n== 5. 错误密码被拒 ==");
  const form = new URLSearchParams(authUrl.searchParams);
  form.set("password", "definitely-wrong-password");
  const wrong = await retry(async () => fetch(`${BASE}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  }));
  check("错误密码返回 401", wrong.status === 401, `HTTP ${wrong.status}`);

  console.log("\n== 6. 正确密码 → 授权码 ==");
  form.set("password", PASSWORD);
  const ok = await retry(async () => fetch(`${BASE}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  }));
  check("302 重定向", ok.status === 302, `HTTP ${ok.status}`);
  const loc = new URL(ok.headers.get("location"));
  check("回调带回 state", loc.searchParams.get("state") === "test-state-123");
  const code = loc.searchParams.get("code");
  check("回调带回 code", !!code);

  console.log("\n== 7. PKCE 换 access token ==");
  const tokRes = await retry(async () => {
    const r = await fetch(`${BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: reg.client_id,
        redirect_uri: REDIRECT,
      }).toString(),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
    return r.json();
  });
  check("拿到 access_token", typeof tokRes.access_token === "string");
  check("拿到 refresh_token", typeof tokRes.refresh_token === "string");
  check("token_type 是 Bearer", tokRes.token_type === "Bearer");

  console.log("\n== 8. 授权码只能用一次 ==");
  const reuse = await retry(async () => fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id }).toString(),
  }));
  check("重复使用被拒", reuse.status === 400, `HTTP ${reuse.status}`);

  console.log("\n== 9. 用 OAuth token 调 MCP ==");
  const mcp = await retry(async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokRes.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_command", arguments: { command: "echo OAUTH-OK" } } }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 200)}`);
    return text;
  });
  check("OAuth token 可调用工具", mcp.includes("OAUTH-OK"), mcp.slice(0, 200));

  console.log("\n== 10. refresh token ==");
  const refreshed = await retry(async () => {
    const r = await fetch(`${BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokRes.refresh_token,
        client_id: reg.client_id,
      }).toString(),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
    return r.json();
  });
  check("刷新得到新 access_token", refreshed.access_token && refreshed.access_token !== tokRes.access_token);

  console.log("\n== 11. 401 响应带 resource_metadata ==");
  const unauth = await retry(async () => fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }));
  check("未授权返回 401", unauth.status === 401);
  const wa = unauth.headers.get("www-authenticate") || "";
  check("WWW-Authenticate 指向 PRM", wa.includes("resource_metadata"), wa);

  console.log("\n== 12. 伪造 token 被拒 ==");
  const fake = await retry(async () => fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer totally-fake-token-xxxxxxxx", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }));
  check("伪造 token 返回 401", fake.status === 401);
} catch (e) {
  fail++;
  fails.push("异常：" + (e?.message || e));
  console.error("\n异常：", e);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${pass}，失败 ${fail}`);
if (fail) { console.log("失败项："); fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
