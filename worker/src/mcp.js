// MCP 服务定义（与运行环境无关）：Worker 与本地测试服务器共用同一套工具表。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { TOOL_SPECS } from "../../shared/tools.mjs";

// 所有工具共享的可选设备参数
const deviceParam = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
  .optional()
  .describe("目标设备 id（多设备时指定；不填用默认设备）");

export const VERSION = "1.0.0";

export function pickTimeout(tool, args) {
  const clamp = (v, min, max, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(Math.max(n, min), max);
  };
  switch (tool) {
    // 网络往返有开销，给足尾部余量，避免本地还在跑就被 Worker 判超时
    case "run_command": return clamp(args?.timeout_ms, 500, 45000, 30000) + 20000;
    case "shell_send": return clamp(args?.wait_ms, 50, 30000, 1500) + 20000;
    case "job_status": return clamp(args?.wait_ms, 0, 30000, 0) + 30000;
    case "search_files":
    case "grep_files": return 75000;
    default: return 30000;
  }
}

// callTool(tool, args, timeoutMs, device) -> { ok, text } | { ok:false, error }
// status() / kick() 可选，用于 device_status / device_kick
export function buildServer({ callTool, status, kick, deviceLogs }) {
  const server = new McpServer(
    { name: "termux-remote", version: VERSION },
    {
      instructions:
        "这是用户自己手机（Termux）的远程终端 MCP。文件相对路径基于 $HOME。" +
        "普通命令用 run_command；需要 TTY 的程序（vim/top）用 shell_open + shell_send；" +
        "超过 45 秒的任务用 job_start，再用 job_status 轮询，不要用 run_command 硬等。",
    }
  );

  for (const spec of TOOL_SPECS) {
    server.registerTool(
      spec.name,
      {
        description: spec.description + "\n可选参数 device：指定目标设备 id（多设备时才需要；默认用第一个连上的设备）。",
        inputSchema: { ...spec.schema, device: deviceParam },
      },
      async (args) => {
        const { device, ...rest } = args || {};
        const res = await callTool(spec.name, rest, pickTimeout(spec.name, rest), device);
        if (res.ok) return { content: [{ type: "text", text: String(res.text ?? "") }] };
        return { isError: true, content: [{ type: "text", text: String(res.error || "调用失败") }] };
      }
    );
  }

  server.registerTool(
    "list_devices",
    {
      description: "列出所有已接入的设备和在线状态（id、名称、系统、版本、最后活跃）。多设备部署时先调它，再用 device 参数指定目标。",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await status(), null, 2) }] })
  );

  server.registerTool(
    "device_status",
    {
      description: "查看某台设备的详细运行状态（进程、内存、PTY 数、后台任务数、连接时长）。",
      inputSchema: {
        device: deviceParam,
        which: z.enum(["agent", "system"]).default("agent").describe("agent=运行状态，system=系统信息"),
      },
    },
    async ({ device, which }) => {
      const tool = which === "system" ? "system_info" : "__sysinfo";
      const res = await callTool(tool, {}, 20000, device);
      if (res.ok) return { content: [{ type: "text", text: String(res.text) }] };
      return { isError: true, content: [{ type: "text", text: String(res.error) }] };
    }
  );

  server.registerTool(
    "device_logs",
    {
      description: "读取设备上 Agent 的日志尾部（排障用）。",
      inputSchema: {
        device: deviceParam,
        which: z.enum(["agent", "supervisor", "error"]).default("agent"),
        lines: z.number().int().min(10).max(2000).default(200),
      },
    },
    async ({ device, which, lines }) => {
      const res = await callTool("__logs", { which, lines }, 20000, device);
      if (res.ok) return { content: [{ type: "text", text: String(res.text) }] };
      return { isError: true, content: [{ type: "text", text: String(res.error) }] };
    }
  );

  server.registerTool(
    "device_kick",
    {
      description: "强制断开某台设备的隧道连接（该设备会自动重连）。用于连接卡死。",
      inputSchema: { device: deviceParam },
    },
    async ({ device }) => {
      await kick(device);
      return { content: [{ type: "text", text: device ? `已断开设备 ${device}，它会在 1-5 秒内自动重连。` : "已断开所有设备连接，它们会自动重连。" }] };
    }
  );

  return server;
}

// 处理一次 MCP HTTP 请求（Web 标准 Request/Response，Worker 与 Node 都能跑）
// authorize(request) -> true | { error: string, resourceMetadataUrl?: string }
export async function handleMcpHttp(request, { authorize, callTool, status, kick }) {
  const auth = authorize ? await authorize(request) : true;
  if (auth !== true) {
    // RFC 9728：多了 resource_metadata，支持 OAuth 的客户端才能自动发现授权服务器
    let wwwAuth = 'Bearer realm="termux-mcp-remote"';
    if (auth && auth.resourceMetadataUrl) {
      wwwAuth += `, resource_metadata="${auth.resourceMetadataUrl}"`;
    }
    return json(
      { jsonrpc: "2.0", error: { code: -32001, message: (auth && auth.error) || "unauthorized" }, id: null },
      401,
      { "www-authenticate": wwwAuth }
    );
  }

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (request.method === "DELETE") return new Response(null, { status: 204, headers: cors() });
  if (request.method === "GET") {
    return new Response("此 MCP 端点为 stateless，仅支持 POST（客户端会直接 POST JSON-RPC）", {
      status: 405,
      headers: { "content-type": "text/plain; charset=utf-8", ...cors() },
    });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: cors() });

  let body;
  try {
    body = await request.clone().json();
  } catch {
    return json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
  }

  const server = buildServer({ callTool, status, kick });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(request, { parsedBody: body });
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors())) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  } finally {
    Promise.resolve(server.close()).catch(() => { });
  }
}

export function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, x-mcp-token",
    "access-control-expose-headers": "mcp-session-id",
    "access-control-max-age": "86400",
  };
}

export function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}
