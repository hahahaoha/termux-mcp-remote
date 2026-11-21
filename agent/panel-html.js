// 本地管理面板的单页 HTML（无外部依赖，适合手机浏览器）
export const PANEL_HTML = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>termux-mcp-remote</title>
<style>
:root{color-scheme:dark;--bg:#0b0e14;--card:#11151f;--line:#222838;--fg:#d8dee9;--muted:#7d879b;--acc:#3b82f6;--ok:#3ecf8e;--bad:#ff6b6b}
*{box-sizing:border-box}
body{margin:0;padding:18px 14px 60px;background:var(--bg);color:var(--fg);
font:15px/1.6 -apple-system,"Segoe UI",Roboto,"Noto Sans SC",sans-serif}
h1{font-size:18px;margin:0 0 2px}
.sub{color:var(--muted);font-size:12.5px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:14px}
h2{font-size:14px;margin:0 0 12px;font-weight:600;display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--acc);flex:none}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12.5px}
.on{background:#0f2f22;color:var(--ok);border:1px solid #1c5c43}
.off{background:#331a1a;color:var(--bad);border:1px solid #5c2626}
.kv{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--line);font-size:13.5px}
.kv:last-child{border:none}
.kv span{color:var(--muted);flex:none}
.kv b{font-family:ui-monospace,Menlo,monospace;font-weight:500;word-break:break-all;text-align:right}
label{display:block;font-size:12.5px;color:var(--muted);margin:10px 0 4px}
input{width:100%;padding:9px 11px;border-radius:9px;border:1px solid var(--line);background:#0a0d13;color:var(--fg);font-size:14px}
input:focus{outline:none;border-color:var(--acc)}
button{margin-top:12px;width:100%;padding:10px;border-radius:9px;border:0;background:var(--acc);color:#fff;font-size:14px;font-weight:600}
button.ghost{background:#1a2030;color:var(--fg);border:1px solid var(--line);margin-top:8px}
pre{background:#0a0d13;border:1px solid var(--line);border-radius:9px;padding:11px;font-size:12px;
overflow:auto;max-height:280px;margin:8px 0 0;white-space:pre-wrap;word-break:break-all}
.row{display:flex;gap:8px}
.row>*{flex:1}
#toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:#1c2333;border:1px solid var(--line);
padding:9px 16px;border-radius:10px;font-size:13.5px;opacity:0;transition:opacity .2s;pointer-events:none}
#toast.show{opacity:1}
</style></head><body>
<h1>termux-mcp-remote</h1>
<div class="sub" id="sub">加载中…</div>

<div class="card">
  <h2><i class="dot"></i>运行状态</h2>
  <div id="status"></div>
</div>

<div class="card">
  <h2><i class="dot"></i>连接配置</h2>
  <label>Worker 地址</label>
  <input id="workerUrl" placeholder="https://mcp.example.com">
  <label>设备名</label>
  <input id="name" placeholder="HUAWEI-LIO-AN00">
  <label>最大 PTY 会话数</label>
  <input id="maxShells" type="number" min="1" max="16">
  <button id="save">保存配置</button>
  <div class="sub" style="margin:10px 0 0">改完记得在 Termux 里执行 <b>tmcp restart</b>。</div>
</div>

<div class="card">
  <h2><i class="dot"></i>令牌</h2>
  <label>AUTH_TOKEN（AI 客户端用，留空不修改）</label>
  <input id="authToken" type="password" placeholder="留空表示不修改">
  <label>AGENT_TOKEN（手机连接用，留空不修改）</label>
  <input id="agentToken" type="password" placeholder="留空表示不修改">
  <button id="saveTok" class="ghost">保存令牌</button>
  <div class="sub" style="margin:10px 0 0">修改后需要同步到 Worker：
  <b>cd worker &amp;&amp; wrangler secret put AUTH_TOKEN</b></div>
</div>

<div class="card">
  <h2><i class="dot"></i>日志</h2>
  <div class="row">
    <button class="ghost" data-log="agent.log">Agent</button>
    <button class="ghost" data-log="supervisor.log">守护进程</button>
    <button class="ghost" data-log="agent.err.log">错误</button>
  </div>
  <pre id="log">（点上面的按钮查看）</pre>
</div>

<div id="toast"></div>
<script>
(function(){
  var $=function(id){return document.getElementById(id)};
  var t=null;
  function toast(m){var el=$('toast');el.textContent=m;el.className='show';clearTimeout(t);t=setTimeout(function(){el.className=''},2400)}
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
  function kv(k,v){return '<div class="kv"><span>'+esc(k)+'</span><b>'+v+'</b></div>'}
  function fmtSec(s){if(s==null)return '-';if(s<90)return s+' 秒';if(s<5400)return Math.round(s/60)+' 分钟';return Math.round(s/3600)+' 小时'}

  function render(j){
    $('sub').textContent='v1.0.0 · '+j.platform.node+' · '+j.platform.arch;
    $('workerUrl').value=j.workerUrl||'';
    $('name').value=j.name||'';
    $('maxShells').value=j.maxShells||6;
    var r=j.remote||{};
    var a=r.agent||{};
    var html='';
    html+=kv('本地 Agent', j.pidAlive?'运行中 pid='+j.pid:'未运行');
    html+=kv('Worker', r.ok?'在线':'不可达'+(r.error?'：'+esc(r.error):''));
    html+=kv('隧道', a.online?'已连接':'未连接');
    if(a.online){
      html+=kv('设备', esc(a.name||'-')+' · v'+esc(a.version||'-'));
      html+=kv('型号', esc(a.host||'-'));
      html+=kv('连接时间', a.connectedAt?new Date(a.connectedAt).toLocaleString('zh-CN'):'-');
      html+=kv('最后活跃', a.lastSeen?new Date(a.lastSeen).toLocaleString('zh-CN'):'-');
      html+=kv('累计调用', (a.calls||0)+'（失败 '+(a.errors||0)+'，排队 '+(a.pending||0)+'）');
    }
    html+=kv('AUTH_TOKEN', j.authSet?'已设置 …'+esc(j.authTokenTail):'未设置');
    html+=kv('配置', esc(j.configPath));
    $('status').innerHTML=html;
  }

  function load(){
    fetch('/api/state').then(function(r){return r.json()}).then(render).catch(function(e){$('sub').textContent='加载失败：'+e});
  }

  function post(url,body){
    return fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){return r.json().then(function(j){if(!r.ok||j.ok===false)throw new Error(j.error||('HTTP '+r.status));return j})});
  }

  $('save').onclick=function(){
    post('/api/config',{workerUrl:$('workerUrl').value,name:$('name').value,maxShells:Number($('maxShells').value)})
      .then(function(){toast('已保存，记得 tmcp restart');load()}).catch(function(e){toast('失败：'+e.message)});
  };
  $('saveTok').onclick=function(){
    var b={};
    if($('authToken').value.trim())b.authToken=$('authToken').value.trim();
    if($('agentToken').value.trim())b.agentToken=$('agentToken').value.trim();
    if(!b.authToken&&!b.agentToken){toast('没有要保存的改动');return}
    post('/api/config',b).then(function(){toast('已保存，需同步到 Worker');$('authToken').value='';$('agentToken').value='';load()})
      .catch(function(e){toast('失败：'+e.message)});
  };
  var btns=document.querySelectorAll('button[data-log]');
  for(var i=0;i<btns.length;i++){
    btns[i].onclick=function(){
      var f=this.getAttribute('data-log');
      fetch('/api/logs?file='+encodeURIComponent(f)).then(function(r){return r.json()})
        .then(function(j){$('log').textContent=j.text||'(空)'}).catch(function(e){$('log').textContent='读取失败：'+e});
    };
  }
  load();
  setInterval(load,20000);
})();
</script></body></html>`;
