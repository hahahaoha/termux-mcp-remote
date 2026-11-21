#!/usr/bin/env node
// 用官方 MCP 客户端 SDK 通过公网（或本地）Worker 做完整验收。
// 用法：node scripts/remote-test.mjs [URL] [TOKEN]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../agent/config.js";

const cfg = loadConfig();
const url = process.argv[2] || `${cfg.workerUrl}/mcp`;
const token = process.argv[3] || cfg.authToken;

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

function text(res) {
  return res?.content?.map((c) => c.text ?? "").join("\n") ?? "";
}

console.log(`\n目标: ${url}\n`);

// 移动网络到 Cloudflare 可能丢包：网络层错误自动重试（工具调用本身不重试）
const RETRYABLE = /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR|socket hang up|terminated|network/i;
async function retryingFetch(input, init = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fetch(input, init);
    } catch (e) {
      lastErr = e;
      if (!RETRYABLE.test(String(e?.message || e) + String(e?.cause?.code || ""))) throw e;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  throw lastErr;
}

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
  fetch: retryingFetch,
});
const client = new Client({ name: "tmcp-acceptance", version: "1.0.0" }, { capabilities: {} });

try {
  console.log("== 连接与工具清单 ==");
  await client.connect(transport);
  const { tools } = await client.listTools();
  check("握手成功", true);
  check(`工具数量 >= 19（实际 ${tools.length}）`, tools.length >= 19);
  for (const required of ["run_command", "read_file", "write_file", "edit_file", "shell_open", "job_start", "list_devices"]) {
    check(`包含工具 ${required}`, tools.some((t) => t.name === required));
  }

  console.log("\n== list_devices ==");
  const st = await client.callTool({ name: "list_devices", arguments: {} });
  const stJson = JSON.parse(text(st));
  check("有设备在线", Array.isArray(stJson.devices) && stJson.devices.length > 0, JSON.stringify(stJson).slice(0,200));
  check("报告设备名", !!(stJson.devices?.[0]?.name));

  console.log("\n== run_command ==");
  const r1 = await client.callTool({ name: "run_command", arguments: { command: "echo ACCEPT-OK; uname -m" } });
  const out1 = JSON.parse(text(r1)).stdout || "";
  check("命令输出正确", out1.includes("ACCEPT-OK"));
  check("架构为 aarch64", out1.includes("aarch64"));

  console.log("\n== 文件读写改 ==");
  const marker = `m${Date.now()}`;
  await client.callTool({
    name: "write_file",
    arguments: { path: `~/tmcp-accept/${marker}.txt`, content: `line1 ${marker}\nline2\n中文内容` },
  });
  const rf = await client.callTool({ name: "read_file", arguments: { path: `~/tmcp-accept/${marker}.txt` } });
  check("读回内容一致", text(rf).includes(marker) && text(rf).includes("中文内容"));

  const ef = await client.callTool({
    name: "edit_file",
    arguments: { path: `~/tmcp-accept/${marker}.txt`, old_text: "line2", new_text: "line2-edited" },
  });
  check("edit_file 成功", text(ef).includes("已替换"), text(ef));

  const ls = await client.callTool({ name: "list_dir", arguments: { path: "~/tmcp-accept" } });
  check("list_dir 能看到文件", text(ls).includes(`${marker}.txt`));

  const gr = await client.callTool({ name: "grep_files", arguments: { pattern: marker, dir: "~/tmcp-accept" } });
  check("grep_files 命中", text(gr).includes(marker));

  const sf = await client.callTool({ name: "search_files", arguments: { pattern: `${marker}.txt`, dir: "~/tmcp-accept" } });
  check("search_files 命中", text(sf).includes(marker));

  const mv = await client.callTool({
    name: "move",
    arguments: { from: `~/tmcp-accept/${marker}.txt`, to: `~/tmcp-accept/${marker}.moved.txt` },
  });
  check("move 成功", text(mv).includes("moved"));

  const del = await client.callTool({ name: "delete", arguments: { path: `~/tmcp-accept/${marker}.moved.txt` } });
  // 偶发的网络抖动会让删除已经生效但响应丢失，因此以「文件是否还在」为准
  const delCheck = await client.callTool({ name: "run_command", arguments: { command: `test -e ~/tmcp-accept/${marker}.moved.txt && echo still-exists || echo gone` } });
  check("delete 成功", JSON.parse(text(delCheck)).stdout.includes("gone"), text(del).slice(0, 150));

  console.log("\n== 大文件（分块传输） ==");
  const big = "A".repeat(700 * 1024);
  const bw = await client.callTool({ name: "write_file", arguments: { path: `~/tmcp-accept/big-${marker}.txt`, content: big } });
  check("700KB 写入成功", text(bw).includes("716800"), text(bw));
  const sizeCheck = await client.callTool({
    name: "run_command",
    arguments: { command: `wc -c < ~/tmcp-accept/big-${marker}.txt` },
  });
  check("落盘大小正确", JSON.parse(text(sizeCheck)).stdout.trim() === String(700 * 1024));
  await client.callTool({ name: "delete", arguments: { path: `~/tmcp-accept/big-${marker}.txt` } });

  console.log("\n== 大输出截断 ==");
  const bigOut = await client.callTool({
    name: "run_command",
    arguments: { command: `head -c 400000 /dev/zero | tr '\\0' 'B'` },
  });
  const bo = text(bigOut);
  check("大输出被截断并说明", bo.includes("已截断"), `长度 ${bo.length}`);

  console.log("\n== PTY 交互 ==");
  const open = await client.callTool({ name: "shell_open", arguments: { rows: 30, cols: 100 } });
  const sid = JSON.parse(text(open)).sessionId;
  check("shell_open 返回 sessionId", !!sid);
  const sent = await client.callTool({
    name: "shell_send",
    arguments: { sessionId: sid, text: "cd ~ && echo PTY-$((1+1)); pwd" },
  });
  const sj = JSON.parse(text(sent));
  check("PTY 命令执行完成", sj.completed === true, text(sent));
  check("PTY 输出正确", (sj.output || "").includes("PTY-2"));
  const view = await client.callTool({ name: "shell_view", arguments: { sessionId: sid, tail: 500 } });
  check("shell_view 可用", text(view).length > 0);
  const list = await client.callTool({ name: "shell_list", arguments: {} });
  check("shell_list 含该会话", text(list).includes(sid));
  await client.callTool({ name: "shell_close", arguments: { sessionId: sid } });
  check("shell_close 成功", true);

  console.log("\n== 后台任务 ==");
  const job = await client.callTool({
    name: "job_start",
    arguments: { command: "for i in 1 2 3 4; do echo step$i; sleep 1; done; echo JOB-DONE", name: "acceptance" },
  });
  const jobId = JSON.parse(text(job)).jobId;
  check("job_start 返回 jobId", !!jobId);
  const js = await client.callTool({ name: "job_status", arguments: { jobId, wait_ms: 6000, tail_bytes: 4000 } });
  const jj = JSON.parse(text(js));
  check("任务结束", jj.running === false, JSON.stringify(jj).slice(0, 200));
  check("任务输出完整", (jj.output || "").includes("JOB-DONE"));
  check("退出码为 0", jj.exitCode === 0);
  const jl = await client.callTool({ name: "job_list", arguments: {} });
  check("job_list 含该任务", text(jl).includes(jobId));

  console.log("\n== 错误处理 ==");
  const bad = await client.callTool({ name: "run_command", arguments: { command: "exit 7" } });
  check("非零退出码被报告", bad.isError === true, text(bad).slice(0, 200));
  const badPath = await client.callTool({ name: "read_file", arguments: { path: "~/definitely-not-exists-xyz.txt" } });
  check("不存在文件报错", badPath.isError === true);
  const guard = await client.callTool({ name: "delete", arguments: { path: "~" } });
  check("受保护路径被拒绝", guard.isError === true && text(guard).includes("受保护"));

  await client.callTool({ name: "run_command", arguments: { command: "rm -rf ~/tmcp-accept" } });
} catch (e) {
  fail++;
  failures.push("异常：" + (e?.message || e));
  console.error("\n测试过程异常：", e);
} finally {
  try { await client.close(); } catch { }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
