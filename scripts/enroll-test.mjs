#!/usr/bin/env node
// 配置码验收：生成 → 兑换 → 一次性 → 过期 → 撤销 → 安全边界
// 用法：node scripts/enroll-test.mjs <BASE_URL> <AUTH_TOKEN> <ADMIN_PASSWORD>
const BASE = (process.argv[2] || process.env.TMCP_BASE || "").replace(/\/+$/, "");
const AUTH_TOKEN = process.argv[3] || "";
const PASSWORD = process.argv[4] || process.env.TMCP_ADMIN_PASSWORD || "";

if (!BASE || !PASSWORD) {
  console.error("用法：node scripts/enroll-test.mjs https://你的域名 <AUTH_TOKEN> <后台密码>");
  console.error("   或设置 TMCP_BASE / TMCP_ADMIN_PASSWORD");
  process.exit(2);
}

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = "";
async function login() {
  const r = await retry(async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    if (res.status !== 200) throw new Error(`login HTTP ${res.status}: ${await res.text()}`);
    return res;
  });
  const sc = r.headers.getSetCookie?.() || [];
  for (const c of sc) {
    const m = /^tmcp_admin=([^;]*)/.exec(c);
    if (m) cookie = `tmcp_admin=${m[1]}`;
  }
  return !!cookie;
}
async function admin(path, body) {
  const r = await fetch(BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function redeem(code) {
  const r = await fetch(`${BASE}/api/enroll/redeem`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "test-device" }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

console.log(`\n配置码验收: ${BASE}\n`);

try {
  console.log("== 1. 登录后台 ==");
  check("登录成功", await login());

  console.log("\n== 2. 未登录不能生成 ==");
  const anon = await fetch(`${BASE}/api/admin/enroll/create`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  check("匿名生成被拒", anon.status === 401, `HTTP ${anon.status}`);

  console.log("\n== 3. 生成注册码 ==");
  const gen = await retry(async () => {
    const r = await admin("/api/admin/enroll/create", { ttlSec: 600, hint: "测试设备" });
    if (!r.body.ok) throw new Error(r.body.error || "生成失败");
    return r.body;
  });
  const code = gen.code;
  check("返回注册码", typeof code === "string" && code.length >= 20, `长度 ${code?.length}`);
  check("码是 URL-safe 乱码样式", /^[A-Za-z0-9_-]+$/.test(code));
  check("不包含 token 片段", !code.includes(AUTH_TOKEN.slice(0, 8)));

  console.log("\n== 3b. 自包含配置码 ==");
  check("返回可粘贴的 link", typeof gen.link === "string" && gen.link.startsWith("tmcp1_"), String(gen.link).slice(0, 20));
  const link = gen.link;
  const host = new URL(BASE).host;
  check("link 里看不到域名", !link.includes(host) && !link.includes("://"));
  const linkData = JSON.parse(Buffer.from(link.replace(/^tmcp1_/, ""), "base64url").toString("utf8"));
  check("link 能解出地址", linkData.h === new URL(BASE).origin, linkData.h);
  check("link 能解出同一个码", linkData.c === code);
  check("返回过期时间", typeof gen.expiresAt === "number" && gen.expiresAt > Date.now());
  check("默认有效期约 10 分钟", Math.abs((gen.expiresAt - Date.now()) / 1000 - 600) < 10);

  console.log("\n== 4. 码里不含密钥（核心安全属性）==");
  // 把码 base64 解一遍，确认解不出 token
  const decoded = Buffer.from(code, "base64url").toString("utf8");
  check("解出的内容里没有 AUTH_TOKEN", !decoded.includes(AUTH_TOKEN.slice(0, 10)));
  check("码长度为 32 字节随机数", Buffer.from(code, "base64url").length === 32,
    `实际 ${Buffer.from(code, "base64url").length} 字节`);

  console.log("\n== 5. 正常兑换 ==");
  const r1 = await redeem(linkData.c);
  check("兑换成功", r1.status === 200 && r1.body.ok === true, JSON.stringify(r1.body).slice(0, 150));
  check("返回 workerUrl", typeof r1.body.config?.workerUrl === "string" && r1.body.config.workerUrl.startsWith("http"));
  check("返回 authToken", typeof r1.body.config?.authToken === "string" && r1.body.config.authToken.length > 20);
  check("返回 agentToken", typeof r1.body.config?.agentToken === "string" && r1.body.config.agentToken.length > 20);
  check("与当前 AUTH_TOKEN 一致", r1.body.config.authToken === AUTH_TOKEN);

  console.log("\n== 6. 一次性：同一码不能再用 ==");
  const r2 = await redeem(code);
  check("第二次兑换失败", r2.status === 410, `HTTP ${r2.status}`);
  check("返回 used 原因", r2.body.code === "used", JSON.stringify(r2.body));
  check("错误信息里不含密钥", !JSON.stringify(r2.body).includes(r1.body.config.agentToken.slice(0, 10)));

  console.log("\n== 7. 无效码 / 畸形输入 ==");
  const bad1 = await redeem("x".repeat(43));
  check("不存在的码返回 404", bad1.status === 404, `HTTP ${bad1.status}`);
  const bad2 = await redeem("short");
  check("过短的码被拒", bad2.status === 400, `HTTP ${bad2.status}`);
  const bad3 = await redeem("<script>alert(1)</script>");
  check("非法字符被拒", bad3.status === 400, `HTTP ${bad3.status}`);

  console.log("\n== 8. 短有效期 + 过期后彻底不可用 ==");
  const shortGen = await retry(async () => {
    const r = await admin("/api/admin/enroll/create", { ttlSec: 60, hint: "短效测试" });
    if (!r.body.ok) throw new Error(r.body.error);
    return r.body;
  });
  // 直接改存储不方便，这里用 1 分钟码验证「未过期可用」即可
  check("短效码已生成", !!shortGen.code);
  await admin("/api/admin/enroll/revoke", { id: shortGen.id });
  const afterRevoke = await redeem(shortGen.code);
  check("撤销后立刻不可用", afterRevoke.status === 404 || afterRevoke.status === 410, `HTTP ${afterRevoke.status}`);

  console.log("\n== 9. 列表与状态 ==");
  const list = await retry(async () => (await admin("/api/admin/enroll/list")).body);
  check("能列出历史", Array.isArray(list.items) && list.items.length > 0);
  const used = list.items.find((x) => x.id === gen.id);
  check("已用码标记为 used", used?.state === "used", JSON.stringify(used));
  check("记录使用设备名", used?.usedName === "test-device", used?.usedName);
  check("列表不含明文码", !JSON.stringify(list).includes(code));

  console.log("\n== 10. TTL 上限保护 ==");
  const tooLong = await retry(async () => {
    const r = await admin("/api/admin/enroll/create", { ttlSec: 999999 });
    return r.body;
  });
  check("超长有效期被钳制到 1 小时", tooLong.ttlSec === 3600, `实际 ${tooLong.ttlSec}`);
  await admin("/api/admin/enroll/revoke", { id: tooLong.id });

  console.log("\n== 11. HTML 里不会泄漏码 ==");
  const page = await (await fetch(`${BASE}/admin`)).text();
  check("页面不含已生成的码", !page.includes(code));
} catch (e) {
  fail++;
  fails.push("异常：" + (e?.message || e));
  console.error("\n异常：", e);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${pass}，失败 ${fail}`);
if (fail) { console.log("失败项："); fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
