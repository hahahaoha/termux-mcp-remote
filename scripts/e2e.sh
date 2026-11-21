#!/usr/bin/env bash
# 端到端自测：本地服务器（模拟 Worker）+ Agent + MCP 调用
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)
LOG="$ROOT/logs/e2e"
mkdir -p "$LOG"

cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  [ -n "$AGT_PID" ] && kill "$AGT_PID" 2>/dev/null
  sleep 0.3
}
trap cleanup EXIT

echo "=== 1. 启动本地服务器 ==="
node local/local-server.js > "$LOG/server.log" 2>&1 &
SRV_PID=$!
for i in $(seq 1 20); do
  sleep 0.3
  if curl -sf http://127.0.0.1:29200/api/health >/dev/null 2>&1; then break; fi
done
cat "$LOG/server.log"

# 本地服务器用独立的 token，避免受 Worker WebUI 轮换影响
AUTH=$(node -e 'console.log(require(process.env.HOME+"/.config/termux-mcp-remote/config.json").localAuthToken||"")')
AGENT=$(node -e 'console.log(require(process.env.HOME+"/.config/termux-mcp-remote/config.json").localAgentToken||"")')
if [ -z "$AUTH" ] || [ -z "$AGENT" ]; then
  echo "缺少本地 token，正在生成…"
  (node local/local-server.js > logs/gen.log 2>&1 &)
  sleep 2.5
  pkill -f "node local/local-server.js" 2>/dev/null
  AUTH=$(node -e 'console.log(require(process.env.HOME+"/.config/termux-mcp-remote/config.json").localAuthToken||"")')
  AGENT=$(node -e 'console.log(require(process.env.HOME+"/.config/termux-mcp-remote/config.json").localAgentToken||"")')
fi
if [ -z "$AUTH" ]; then echo "生成失败，请手动运行 node local/local-server.js"; exit 1; fi

echo
echo "=== 2. Agent 连接前的状态 ==="
curl -sS -H "Authorization: Bearer $AUTH" http://127.0.0.1:29200/api/status; echo

echo
echo "=== 3. 启动 Agent（指向本地服务器） ==="
node -e '
const { Agent } = await import("./agent/agent.js");
const { loadConfig } = await import("./agent/config.js");
const cfg = loadConfig();
const a = new Agent({ ...cfg, workerUrl: "http://127.0.0.1:29200",
  authToken: cfg.localAuthToken, agentToken: cfg.localAgentToken, deviceId: "local-test",
  jobsDir: process.env.HOME + "/.config/termux-mcp-remote/state/jobs" });
a.start();
process.on("SIGTERM", () => { a.stop(); process.exit(0); });
setInterval(() => {}, 1000);
' > "$LOG/agent.log" 2>&1 &
AGT_PID=$!
sleep 3
echo "--- agent log ---"; cat "$LOG/agent.log"

echo
echo "=== 4. Agent 连接后的状态 ==="
curl -sS -H "Authorization: Bearer $AUTH" http://127.0.0.1:29200/api/status; echo

echo
echo "=== 5. 鉴权：无 token 应 401 ==="
curl -sS -o /dev/null -w "HTTP %{http_code}\n" -X POST http://127.0.0.1:29200/mcp \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

echo
echo "=== 6. 鉴权：错误 token 应 401 ==="
curl -sS -o /dev/null -w "HTTP %{http_code}\n" -X POST http://127.0.0.1:29200/mcp \
  -H "Authorization: Bearer wrong-token-123456" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

echo
echo "=== 7. MCP initialize ==="
curl -sS -X POST http://127.0.0.1:29200/mcp \
  -H "Authorization: Bearer $AUTH" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify({server:j.result?.serverInfo,protocol:j.result?.protocolVersion}));})'

echo
echo "=== 8. MCP tools/list ==="
curl -sS -X POST http://127.0.0.1:29200/mcp \
  -H "Authorization: Bearer $AUTH" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const t=j.result?.tools||[];console.log(`工具数: ${t.length}`);console.log(t.map(x=>x.name).join(", "));})'

call() {
  curl -sS -X POST http://127.0.0.1:29200/mcp \
    -H "Authorization: Bearer $AUTH" \
    -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
    -d "$1" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const c=j.result?.content?.[0]?.text;const err=j.result?.isError?" [isError]":"";if(j.error){console.log("JSONRPC ERROR:",JSON.stringify(j.error))}else{console.log(err+(c??JSON.stringify(j)).slice(0,700))}})'
}

echo
echo "=== 9. run_command ==="
call '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_command","arguments":{"command":"echo HELLO-REMOTE; uname -m; pwd"}}}'

echo
echo "=== 10. write_file + read_file ==="
call '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"write_file","arguments":{"path":"~/tmcp-e2e/test.txt","content":"第一行\n第二行\nhello 世界"}}}'
call '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"~/tmcp-e2e/test.txt"}}}'

echo
echo "=== 11. edit_file ==="
call '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"edit_file","arguments":{"path":"~/tmcp-e2e/test.txt","old_text":"第二行","new_text":"第二行(已改)"}}}'

echo
echo "=== 12. list_dir ==="
call '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_dir","arguments":{"path":"~/tmcp-e2e"}}}'

echo
echo "=== 13. job_start / job_status / job_kill ==="
JOB=$(curl -sS -X POST http://127.0.0.1:29200/mcp -H "Authorization: Bearer $AUTH" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"job_start","arguments":{"command":"for i in 1 2 3; do echo tick$i; sleep 1; done; echo DONE","name":"e2e-loop"}}}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const t=j.result?.content?.[0]?.text||"";try{console.log(JSON.parse(t).jobId)}catch{console.log("")}})')
echo "jobId=$JOB"
sleep 1
call "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/call\",\"params\":{\"name\":\"job_status\",\"arguments\":{\"jobId\":\"$JOB\",\"wait_ms\":2500}}}"
call "{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"tools/call\",\"params\":{\"name\":\"job_list\",\"arguments\":{}}}"

echo
echo "=== 14. shell_open / shell_send / shell_view / shell_close ==="
SID=$(curl -sS -X POST http://127.0.0.1:29200/mcp -H "Authorization: Bearer $AUTH" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"shell_open","arguments":{"rows":24,"cols":80}}}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const t=j.result?.content?.[0]?.text||"";try{console.log(JSON.parse(t).sessionId)}catch{console.log("")}})')
echo "sessionId=$SID"
call "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"tools/call\",\"params\":{\"name\":\"shell_send\",\"arguments\":{\"sessionId\":\"$SID\",\"text\":\"cd /tmp 2>/dev/null || cd ~; echo PTY-OK; pwd\"}}}"
call "{\"jsonrpc\":\"2.0\",\"id\":13,\"method\":\"tools/call\",\"params\":{\"name\":\"shell_close\",\"arguments\":{\"sessionId\":\"$SID\"}}}"

echo
echo "=== 15. search_files / grep_files / system_info ==="
call '{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"search_files","arguments":{"pattern":"test.txt","dir":"~/tmcp-e2e"}}}'
call '{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"grep_files","arguments":{"pattern":"HELLO|第二行","dir":"~/tmcp-e2e"}}}'
call '{"jsonrpc":"2.0","id":16,"method":"tools/call","params":{"name":"list_devices","arguments":{}}}'

echo
echo "=== 16. 大输出（>180KB 截断逻辑） ==="
call '{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"run_command","arguments":{"command":"head -c 400000 /dev/zero | tr \"\\0\" \"A\" | wc -c"}}}'

echo
echo "=== 17. 大文件写入（分块传输，约 600KB） ==="
node -e '
const big = "X".repeat(600*1024);
console.log(JSON.stringify({jsonrpc:"2.0",id:18,method:"tools/call",params:{name:"write_file",arguments:{path:"~/tmcp-e2e/big.txt",content:big}}}));
' > "$LOG/big-req.json"
curl -sS -X POST http://127.0.0.1:29200/mcp \
  -H "Authorization: Bearer $AUTH" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  --data-binary @"$LOG/big-req.json" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.result?.content?.[0]?.text || JSON.stringify(j).slice(0,300))})'
# 清理
rm -rf ~/tmcp-e2e

echo
echo "=== 18. Agent 离线时应给出明确提示 ==="
kill "$AGT_PID" 2>/dev/null; AGT_PID=""
sleep 1.5
call '{"jsonrpc":"2.0","id":19,"method":"tools/call","params":{"name":"run_command","arguments":{"command":"echo should-not-run"}}}'

echo
echo "=== 完成 ==="
