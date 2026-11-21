#!/usr/bin/env node
// 多设备验收：同一 Worker 上同时跑三台"虚拟设备"（不同 deviceId），验证路由隔离与失败提示。
// 用法：node scripts/multidevice-test.mjs
import { Agent } from "../agent/agent.js";
import { loadConfig } from "../agent/config.js";
import os from "node:os";

const cfg = loadConfig();
if (!cfg.workerUrl || !cfg.authToken) {
  console.error("请先 tmcp setup");
  process.exit(2);
}

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

const agents = [];
function spawnDevice(id, name) {
  const a = new Agent({
    ...cfg,
    deviceId: id,
    name,
    jobsDir: `${os.homedir()}/.config/termux-mcp-remote/state/jobs`,
  });
  a.start();
  agents.push(a);
  return a;
}

async function mcp(name, args) {
  const r = await fetch(`${cfg.workerUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.authToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(40000),
  });
  const text = await r.text();
  const j = JSON.parse(text);
  return { isError: !!j.result?.isError, text: j.result?.content?.[0]?.text || "", raw: j };
}

async function waitOnline(ids, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await mcp("list_devices", {});
    const list = JSON.parse(r.text).devices || [];
    // 等所有设备完成 hello 握手（state=ready），而不是只要 socket 连上
    if (ids.every((id) => list.some((d) => d.id === id && d.state === "ready"))) return list;
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error(`等待设备上线超时：${ids.join(", ")}`);
}

try {
  console.log("\n== 1. 启动两台虚拟设备 ==");
  spawnDevice("dev-alpha", "ALPHA");
  spawnDevice("dev-beta", "BETA");
  const list = await waitOnline(["dev-alpha", "dev-beta"]);
  check("三台设备同时在线", list.length >= 3, list.map((d) => d.id).join(", "));
  check("设备带系统信息", list.every((d) => d.os && d.arch && d.host && d.host !== "localhost"),
    JSON.stringify(list.map((d) => ({ id: d.id, host: d.host, os: d.os }))).slice(0, 250));

  console.log("\n== 2. 按 device 路由 ==");
  const alpha = await mcp("run_command", { command: "echo from-alpha", device: "dev-alpha" });
  check("dev-alpha 执行成功", JSON.parse(alpha.text).stdout.includes("from-alpha"), alpha.text.slice(0, 150));
  const beta = await mcp("run_command", { command: "echo from-beta", device: "dev-beta" });
  check("dev-beta 执行成功", JSON.parse(beta.text).stdout.includes("from-beta"), beta.text.slice(0, 150));

  console.log("\n== 3. 拒绝不存在的设备 ==");
  const missing = await mcp("run_command", { command: "echo x", device: "dev-nonexistent" });
  check("返回错误", missing.isError);
  check("提示可用设备", missing.text.includes("dev-alpha") && missing.text.includes("dev-beta"), missing.text.slice(0, 200));

  console.log("\n== 4. 不指定 device → 默认设备 ==");
  const def = await mcp("run_command", { command: "echo default-device" });
  check("默认设备可用", def.text.includes("default-device"), def.text.slice(0, 150));

  console.log("\n== 5. 内部工具走 WebUI 通道 ==");
  const sys = await mcp("device_status", { device: "dev-alpha" });
  check("device_status 返回进程信息", sys.text.includes('"pid"'), sys.text.slice(0, 150));
  const logs = await mcp("device_logs", { device: "dev-alpha", lines: 20 });
  check("device_logs 能读到日志", logs.text.includes("连接"), logs.text.slice(0, 120));

  console.log("\n== 6. 断开单台设备不影响其他设备 ==");
  await fetch(`${cfg.workerUrl}/api/admin/kick`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.authToken}`, "content-type": "application/json" },
    body: JSON.stringify({ device: "dev-beta" }),
  });
  await new Promise((r) => setTimeout(r, 900));
  const stillAlpha = await mcp("run_command", { command: "echo alpha-alive", device: "dev-alpha" });
  check("dev-alpha 不受影响", stillAlpha.text.includes("alpha-alive"), stillAlpha.text.slice(0, 120));
  const afterKick = await waitOnline(["dev-beta"], 15000);
  check("dev-beta 自动重连", afterKick.some((d) => d.id === "dev-beta"));
} catch (e) {
  fail++;
  fails.push("异常：" + (e?.message || e));
  console.error("\n异常：", e);
} finally {
  for (const a of agents) { try { a.stop(); } catch { } }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${pass}，失败 ${fail}`);
if (fail) { console.log("失败项："); fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
