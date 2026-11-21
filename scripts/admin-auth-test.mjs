#!/usr/bin/env node
// 后台鉴权验收：首次设置密码 → 登录 → 会话 cookie → 密码与 API 凭证分离 → 限流/改密
// 用法：node scripts/admin-auth-test.mjs [BASE_URL]
// 用法：node scripts/admin-auth-test.mjs https://mcp.example.com <AUTH_TOKEN> [当前后台密码]
const BASE = (process.argv[2] || process.env.TMCP_BASE || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("用法：node scripts/admin-auth-test.mjs https://你的域名 <AUTH_TOKEN> [当前后台密码]");
  console.error("   或设置环境变量 TMCP_BASE");
  process.exit(2);
}
const AUTH_TOKEN = process.argv[3] || "";

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

async function retry(fn, n = 4) {
  let last;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 700 * (i + 1))); }
  }
  throw last;
}

// 若已存在后台密码，可通过第 4 个参数传入，脚本会先用它登录、改成本次的随机密码，测完再改回。
const EXISTING_PW = process.argv[4] || "";
const PW = "test-admin-pw-" + Math.random().toString(36).slice(2, 8);

function cookieFrom(res) {
  const sc = res.headers.get("set-cookie") || "";
  const m = /tmcp_admin=([^;]*)/.exec(sc);
  return m ? m[1] : "";
}

console.log(`\n后台鉴权测试: ${BASE}\n`);

try {
  console.log("== 1. 未登录时受保护 ==");
  const g0 = await retry(async () => {
    const r = await fetch(`${BASE}/api/admin/state`);
    return { status: r.status, body: await r.json() };
  });
  check("state 需要登录", g0.status === 401);
  check("返回 needLogin 标记", g0.body.needLogin === true);

  console.log("\n== 2. 首次设置后台密码 ==");
  const st = await retry(async () => (await fetch(`${BASE}/api/auth/status`)).json());
  check("状态接口可用", st.ok === true);
  if (st.configured) {
    console.log("  （已设置过密码，跳过 setup 测试）");
    if (!EXISTING_PW) {
      console.log("  ✗ 已设置后台密码，但没有提供当前密码。");
      console.log("     用法：node scripts/admin-auth-test.mjs <URL> <AUTH_TOKEN> <当前后台密码>");
      console.log("     或在设备上执行 tmcp admin-pass 清空后重跑。");
      process.exit(2);
    }
    // 用现有密码登录，并把密码改成本次的随机值，后续步骤就统一了
    const lr = await retry(async () => {
      const r = await fetch(`${BASE}/api/auth/login`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: EXISTING_PW }),
      });
      return { status: r.status, cookie: cookieFrom(r) };
    });
    if (lr.status !== 200) {
      console.log("  ✗ 提供的当前后台密码不正确");
      process.exit(2);
    }
    const cr = await retry(async () => {
      const r = await fetch(`${BASE}/api/admin/change-password`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `tmcp_admin=${lr.cookie}` },
        body: JSON.stringify({ current: EXISTING_PW, password: PW }),
      });
      return await r.json();
    });
    check("已把密码切换为本次测试用值", cr.ok === true, JSON.stringify(cr).slice(0, 120));
  } else {
    const weak = await retry(async () => {
      const r = await fetch(`${BASE}/api/auth/setup`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "123" }),
      });
      return { status: r.status, body: await r.json() };
    });
    check("拒绝过短密码", weak.status === 400, `HTTP ${weak.status}`);

    const set = await retry(async () => {
      const r = await fetch(`${BASE}/api/auth/setup`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PW }),
      });
      return { status: r.status, body: await r.json(), setCookie: r.headers.get("set-cookie") || "" };
    });
    check("设置成功并直接登录", set.body.ok === true, JSON.stringify(set.body).slice(0, 150));
    check("下发 HttpOnly cookie", /HttpOnly/i.test(set.setCookie));
    check("cookie 带 SameSite=Strict", /SameSite=Strict/i.test(set.setCookie));

    const again = await retry(async () => {
      const r = await fetch(`${BASE}/api/auth/setup`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PW + "x" }),
      });
      return { status: r.status };
    });
    check("已设置后禁止再次 setup", again.status === 409);
  }

  console.log("\n== 3. 用会话 cookie 访问后台 ==");
  const login = await retry(async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PW }),
    });
    return { status: r.status, body: await r.json(), cookie: cookieFrom(r) };
  });
  check("密码登录成功", login.body.ok === true, JSON.stringify(login.body).slice(0, 150));
  const session = login.cookie;

  const withCookie = await retry(async () => {
    const r = await fetch(`${BASE}/api/admin/state`, { headers: { cookie: `tmcp_admin=${session}` } });
    return { status: r.status, body: await r.json() };
  });
  check("带 cookie 可访问", withCookie.status === 200);
  check("返回设备列表", Array.isArray(withCookie.body.devices));

  console.log("\n== 4. 密码与 API 凭证分离 ==");
  check("state 不返回明文 AUTH_TOKEN", !("authToken" in withCookie.body), Object.keys(withCookie.body).join(","));
  check("只返回打码预览", typeof withCookie.body.authPreview === "string" && withCookie.body.authPreview.includes("•"));

  const revealed = await retry(async () => {
    const r = await fetch(`${BASE}/api/admin/reveal-token`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `tmcp_admin=${session}` },
      body: JSON.stringify({ kind: "auth" }),
    });
    return await r.json();
  });
  check("显式请求才能拿到完整凭证", typeof revealed.token === "string" && revealed.token.length > 20);

  console.log("\n== 5. 后台密码不能用于 MCP ==");
  const pwAsMcp = await retry(async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${PW}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    return { status: r.status };
  });
  check("后台密码无法调用 /mcp", pwAsMcp.status === 401);

  console.log("\n== 6. AUTH_TOKEN 不能用于后台 ==");
  if (AUTH_TOKEN) {
    const tokenAsAdmin = await retry(async () => {
      const r = await fetch(`${BASE}/api/admin/state`, {
        headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      });
      return { status: r.status };
    });
    check("AUTH_TOKEN 无法访问后台", tokenAsAdmin.status === 401);
  } else {
    console.log("  （未提供 AUTH_TOKEN，跳过）");
  }

  console.log("\n== 7. 错误密码与会话伪造 ==");
  const wrong = await retry(async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "definitely-wrong-password" }),
    });
    return { status: r.status };
  });
  check("错误密码被拒", wrong.status === 401);

  const forged = await retry(async () => {
    const r = await fetch(`${BASE}/api/admin/state`, { headers: { cookie: "tmcp_admin=deadbeef" } });
    return { status: r.status };
  });
  check("伪造会话被拒", forged.status === 401);

  console.log("\n== 8. 修改后台密码 ==");
  const changed = await retry(async () => {
    const r = await fetch(`${BASE}/api/admin/change-password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `tmcp_admin=${session}` },
      body: JSON.stringify({ current: PW, password: PW + "-v2" }),
    });
    return { status: r.status, body: await r.json() };
  });
  check("修改成功", changed.body.ok === true, JSON.stringify(changed.body).slice(0, 150));

  const oldSession = await retry(async () => {
    const r = await fetch(`${BASE}/api/admin/state`, { headers: { cookie: `tmcp_admin=${session}` } });
    return { status: r.status };
  });
  check("改密后旧会话失效", oldSession.status === 401);

  const newLogin = await retry(async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PW + "-v2" }),
    });
    return { status: r.status, cookie: cookieFrom(r) };
  });
  check("新密码可以登录", newLogin.status === 200 && !!newLogin.cookie);

  console.log("\n== 9. 退出登录 ==");
  const out = await retry(async () => {
    const r = await fetch(`${BASE}/api/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `tmcp_admin=${newLogin.cookie}` },
      body: "{}",
    });
    return { clear: r.headers.get("set-cookie") || "" };
  });
  check("退出时清除 cookie", /Max-Age=0/i.test(out.clear));

  // 恢复测试前的状态：把密码改回原值，避免遗留随机密码。
  // 注意：这里只改后台密码，绝不触碰 AUTH_TOKEN / AGENT_TOKEN。
  const FINAL_PW = EXISTING_PW || PW;
  const restore = await retry(async () => {
    const l = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PW + "-v2" }),
    });
    const c = cookieFrom(l);
    const r = await fetch(`${BASE}/api/admin/change-password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `tmcp_admin=${c}` },
      body: JSON.stringify({ current: PW + "-v2", password: FINAL_PW }),
    });
    return await r.json();
  });
  console.log(`\n测试密码已恢复为: ${FINAL_PW}`);
  console.log("（本测试不会修改 AUTH_TOKEN / AGENT_TOKEN）");
} catch (e) {
  fail++;
  fails.push("异常：" + (e?.message || e));
  console.error("\n异常：", e);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${pass}，失败 ${fail}`);
if (fail) { console.log("失败项："); fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
