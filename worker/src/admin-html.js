// Worker WebUI（单页，零外部依赖）。
// 视觉：深色玻璃拟态 + 柔和渐变光晕 + 弹性过渡动画；支持明暗主题。
// 认证：/admin 用独立的后台密码登录（HttpOnly cookie 会话），
//       与 AI 客户端使用的 AUTH_TOKEN 完全分离。
export const ADMIN_HTML = String.raw`<!doctype html>
<html lang="zh-CN" data-theme="dark"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>termux-mcp-remote</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>◈</text></svg>">
<style>
*,*::before,*::after{box-sizing:border-box}
:root{
  --ease:cubic-bezier(.22,1,.36,1);
  --ease-soft:cubic-bezier(.4,0,.2,1);
  --r-lg:18px;--r-md:13px;--r-sm:9px;
}
html[data-theme="dark"]{
  --bg:#07090e;--bg2:#0b0f16;
  --glass:rgba(19,25,36,.72);
  --glass-hi:rgba(30,39,55,.85);
  --line:rgba(255,255,255,.075);
  --line-hi:rgba(255,255,255,.14);
  --fg:#e6ecf7;--fg2:#a7b3c8;--muted:#6b7789;
  --acc:#4f8dff;--acc2:#8b5cf6;
  --ok:#34d399;--bad:#fb7185;--warn:#fbbf24;
  --shadow:0 24px 60px -22px rgba(0,0,0,.9);
  --glow1:rgba(79,141,255,.22);--glow2:rgba(139,92,246,.18);
  --input:rgba(8,11,17,.85);
}
html[data-theme="light"]{
  --bg:#eef1f7;--bg2:#f7f9fc;
  --glass:rgba(255,255,255,.78);
  --glass-hi:rgba(255,255,255,.95);
  --line:rgba(15,23,42,.09);
  --line-hi:rgba(15,23,42,.17);
  --fg:#0f172a;--fg2:#475569;--muted:#8394ab;
  --acc:#2563eb;--acc2:#7c3aed;
  --ok:#059669;--bad:#e11d48;--warn:#d97706;
  --shadow:0 20px 50px -24px rgba(15,23,42,.35);
  --glow1:rgba(37,99,235,.13);--glow2:rgba(124,58,237,.11);
  --input:rgba(255,255,255,.9);
}
html,body{margin:0;min-height:100%}
body{
  background:
    radial-gradient(1100px 620px at 12% -12%, var(--glow1), transparent 62%),
    radial-gradient(900px 560px at 92% 4%, var(--glow2), transparent 60%),
    linear-gradient(180deg, var(--bg) 0%, var(--bg2) 100%);
  background-attachment:fixed;
  color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC","PingFang SC",sans-serif;
  padding:0 14px 80px;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1040px;margin:0 auto}

/* ---------- 顶栏 ---------- */
header{
  display:flex;align-items:center;gap:11px;flex-wrap:wrap;
  padding:22px 4px 18px;position:sticky;top:0;z-index:20;
  backdrop-filter:blur(18px) saturate(180%);
  -webkit-backdrop-filter:blur(18px) saturate(180%);
  background:linear-gradient(180deg,var(--bg) 55%,transparent);
}
.logo{
  width:29px;height:29px;border-radius:9px;flex:none;
  background:linear-gradient(135deg,var(--acc),var(--acc2));
  display:grid;place-items:center;color:#fff;font-size:15px;font-weight:700;
  box-shadow:0 6px 18px -6px var(--acc);
  animation:logoIn .55s var(--ease) both;
}
@keyframes logoIn{from{transform:scale(.6) rotate(-14deg);opacity:0}to{transform:none;opacity:1}}
h1{font-size:15.5px;margin:0;font-weight:650;letter-spacing:.15px}
h1 b{background:linear-gradient(90deg,var(--acc),var(--acc2));-webkit-background-clip:text;background-clip:text;color:transparent}
.tag{font-size:11px;color:var(--muted);border:1px solid var(--line);padding:2px 8px;border-radius:999px;white-space:nowrap}
.spacer{flex:1}
.iconbtn{
  width:32px;height:32px;border-radius:9px;border:1px solid var(--line);
  background:var(--glass);color:var(--fg2);cursor:pointer;display:grid;place-items:center;
  font-size:14px;transition:all .22s var(--ease);
}
.iconbtn:hover{color:var(--fg);border-color:var(--line-hi);transform:translateY(-1px)}
.iconbtn:active{transform:scale(.94)}

/* ---------- 卡片 ---------- */
.card{
  background:var(--glass);
  border:1px solid var(--line);
  border-radius:var(--r-lg);
  padding:19px 20px;margin-bottom:15px;
  box-shadow:var(--shadow);
  backdrop-filter:blur(20px) saturate(160%);
  -webkit-backdrop-filter:blur(20px) saturate(160%);
  animation:cardIn .5s var(--ease) both;
}
@keyframes cardIn{from{opacity:0;transform:translateY(14px) scale(.985)}to{opacity:1;transform:none}}
.card:nth-child(1){animation-delay:.02s}
.card:nth-child(2){animation-delay:.07s}
.card:nth-child(3){animation-delay:.12s}
.card:nth-child(4){animation-delay:.17s}
.card:nth-child(5){animation-delay:.22s}
.card-head{display:flex;align-items:center;gap:9px;margin-bottom:15px}
.card-head h2{font-size:13px;margin:0;font-weight:600;color:var(--fg2);letter-spacing:.35px;text-transform:uppercase}
.pip{width:6px;height:6px;border-radius:50%;background:linear-gradient(135deg,var(--acc),var(--acc2));flex:none;
  box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 16%,transparent)}

/* ---------- 设备卡 ---------- */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:11px}
.dev{
  position:relative;overflow:hidden;
  border:1px solid var(--line);border-radius:var(--r-md);
  padding:14px 15px;background:var(--glass-hi);
  transition:transform .28s var(--ease),border-color .28s var(--ease),box-shadow .28s var(--ease);
  animation:devIn .45s var(--ease) both;
}
@keyframes devIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.dev:hover{transform:translateY(-2px);border-color:var(--line-hi);box-shadow:0 14px 34px -18px rgba(0,0,0,.6)}
.dev::after{
  content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(420px 120px at 80% -30%, color-mix(in srgb,var(--ok) 12%,transparent), transparent 70%);
  opacity:0;transition:opacity .35s var(--ease);
}
.dev.on::after{opacity:1}
.dev-top{display:flex;align-items:center;gap:9px;margin-bottom:3px}
.led{width:8px;height:8px;border-radius:50%;background:var(--muted);flex:none;position:relative}
.dev.on .led{background:var(--ok)}
.dev.on .led::after{
  content:"";position:absolute;inset:-3px;border-radius:50%;border:1.5px solid var(--ok);
  animation:pulse 2.4s var(--ease-soft) infinite;
}
@keyframes pulse{0%{transform:scale(.7);opacity:.9}70%{transform:scale(1.9);opacity:0}100%{opacity:0}}
.dev-name{font-weight:620;font-size:14px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip{
  font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);
  background:color-mix(in srgb,var(--fg) 5%,transparent);
  border:1px solid var(--line);padding:1px 7px;border-radius:999px;white-space:nowrap;
}
.chip.def{color:var(--acc);border-color:color-mix(in srgb,var(--acc) 35%,transparent);
  background:color-mix(in srgb,var(--acc) 10%,transparent)}
.dev-id{font:11.5px ui-monospace,Menlo,monospace;color:var(--muted);margin-bottom:9px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dev-meta{font-size:12px;color:var(--fg2);line-height:1.65;min-height:34px}
.dev-meta .dim{color:var(--muted)}
.dev-acts{display:flex;gap:6px;margin-top:11px;opacity:.72;transition:opacity .25s var(--ease)}
.dev:hover .dev-acts{opacity:1}

/* ---------- 按钮 ---------- */
button{
  font:inherit;font-size:12.5px;font-weight:500;
  padding:6px 12px;border-radius:var(--r-sm);
  border:1px solid var(--line);background:color-mix(in srgb,var(--fg) 5%,transparent);
  color:var(--fg);cursor:pointer;
  transition:all .2s var(--ease);white-space:nowrap;
}
button:hover{border-color:var(--line-hi);background:color-mix(in srgb,var(--fg) 9%,transparent);transform:translateY(-1px)}
button:active{transform:scale(.97)}
button.primary{
  background:linear-gradient(135deg,var(--acc),var(--acc2));border-color:transparent;color:#fff;
  box-shadow:0 8px 22px -10px var(--acc);
}
button.primary:hover{filter:brightness(1.09);box-shadow:0 10px 26px -8px var(--acc)}
button.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 30%,transparent)}
button.danger:hover{background:color-mix(in srgb,var(--bad) 12%,transparent)}
button:disabled{opacity:.5;cursor:not-allowed;transform:none!important}

/* ---------- 表单 ---------- */
label{display:block;font-size:11.5px;color:var(--muted);margin:13px 0 5px;font-weight:500;letter-spacing:.2px}
input,select,textarea{
  font:inherit;font-size:13px;padding:9px 11px;border-radius:var(--r-sm);
  border:1px solid var(--line);background:var(--input);color:var(--fg);width:100%;
  transition:border-color .2s var(--ease),box-shadow .2s var(--ease),background .2s var(--ease);
}
input:hover,select:hover{border-color:var(--line-hi)}
input:focus,select:focus,textarea:focus{
  outline:none;border-color:var(--acc);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 17%,transparent);
}
input::placeholder{color:var(--muted)}
.row{display:flex;gap:9px;align-items:flex-end;flex-wrap:wrap}
.row>div{flex:1;min-width:145px}
.row>.tight{flex:0 0 auto;min-width:0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{
  background:var(--input);border:1px solid var(--line);border-radius:var(--r-sm);
  padding:12px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
  overflow:auto;max-height:320px;margin:9px 0 0;white-space:pre-wrap;word-break:break-word;
  color:var(--fg2);
}
pre:empty::before{content:"（空）";color:var(--muted)}
.kv{display:flex;justify-content:space-between;gap:14px;padding:7px 0;border-bottom:1px solid var(--line);font-size:13px;align-items:baseline}
.kv:last-child{border:none}
.kv span{color:var(--muted);flex:none}
.kv b{font-weight:500;font-family:ui-monospace,Menlo,monospace;text-align:right;word-break:break-all;font-size:12.5px}
.hint{color:var(--muted);font-size:11.8px;margin-top:9px;line-height:1.65}
.hint code{background:color-mix(in srgb,var(--fg) 7%,transparent);padding:1px 5px;border-radius:4px;font-size:11.5px}

/* ---------- 分段控件 ---------- */
.seg{display:inline-flex;gap:2px;padding:3px;border-radius:10px;background:color-mix(in srgb,var(--fg) 6%,transparent);border:1px solid var(--line)}
.seg button{border:none;background:transparent;padding:5px 12px;border-radius:7px;font-size:12px;color:var(--muted)}
.seg button:hover{transform:none;background:transparent;color:var(--fg2)}
.seg button.act{background:var(--glass-hi);color:var(--fg);box-shadow:0 2px 8px -3px rgba(0,0,0,.5)}
.pane{animation:fadeUp .3s var(--ease) both}
@keyframes fadeUp{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}

/* ---------- 凭证块 ---------- */
.secret{
  display:flex;align-items:center;gap:9px;
  background:var(--input);border:1px solid var(--line);border-radius:var(--r-sm);
  padding:9px 11px;font:12px ui-monospace,Menlo,monospace;color:var(--fg2);
  transition:border-color .2s var(--ease);
}
.secret:hover{border-color:var(--line-hi)}
.secret .v{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.secret .v.revealed{white-space:normal;word-break:break-all}
.eyebtn{border:none;background:transparent;color:var(--muted);cursor:pointer;padding:2px 4px;border-radius:5px;font-size:12px}
.eyebtn:hover{color:var(--fg);background:color-mix(in srgb,var(--fg) 8%,transparent);transform:none}

/* ---------- 登录遮罩 ---------- */
#gate{
  position:fixed;inset:0;z-index:60;display:grid;place-items:center;padding:20px;
  background:linear-gradient(180deg,var(--bg),var(--bg2));
  transition:opacity .4s var(--ease),visibility .4s;
}
#gate.out{opacity:0;visibility:hidden;pointer-events:none}
.gate-box{
  width:min(392px,100%);
  background:var(--glass);border:1px solid var(--line);border-radius:20px;
  padding:30px 28px;box-shadow:var(--shadow);
  backdrop-filter:blur(24px) saturate(170%);
  -webkit-backdrop-filter:blur(24px) saturate(170%);
  animation:gateIn .6s var(--ease) both;
}
@keyframes gateIn{from{opacity:0;transform:translateY(22px) scale(.96)}to{opacity:1;transform:none}}
.gate-logo{
  width:46px;height:46px;border-radius:14px;margin-bottom:16px;
  background:linear-gradient(135deg,var(--acc),var(--acc2));
  display:grid;place-items:center;color:#fff;font-size:23px;
  box-shadow:0 12px 30px -10px var(--acc);
  animation:float 4s ease-in-out infinite;
}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
.gate-box h2{font-size:17px;margin:0 0 4px;font-weight:650}
.gate-box p{color:var(--muted);font-size:12.5px;margin:0 0 18px;line-height:1.6}
.gate-box .btnrow{margin-top:16px}
.gate-box .btnrow button{width:100%;padding:11px;font-size:13.5px}
.err{color:var(--bad);font-size:12.5px;margin-top:11px;min-height:18px;
  opacity:0;transform:translateY(-4px);transition:all .25s var(--ease)}
.err.show{opacity:1;transform:none}
.shake{animation:shake .42s var(--ease-soft)}
@keyframes shake{0%,100%{transform:translateX(0)}18%{transform:translateX(-7px)}38%{transform:translateX(6px)}58%{transform:translateX(-4px)}78%{transform:translateX(2px)}}

/* ---------- toast ---------- */
#toast{
  position:fixed;left:50%;bottom:26px;transform:translate(-50%,16px);
  background:var(--glass-hi);border:1px solid var(--line);
  padding:10px 18px;border-radius:11px;font-size:13px;
  box-shadow:var(--shadow);backdrop-filter:blur(20px);
  -webkit-backdrop-filter:blur(20px);
  opacity:0;pointer-events:none;transition:all .34s var(--ease);z-index:80;
  max-width:min(92vw,460px);text-align:center;
}
#toast.show{opacity:1;transform:translate(-50%,0)}
#toast.bad{border-color:color-mix(in srgb,var(--bad) 45%,transparent);color:var(--bad)}

/* ---------- 骨架 ---------- */
.skel{height:82px;border-radius:var(--r-md);border:1px solid var(--line);
  background:linear-gradient(100deg,transparent 20%,color-mix(in srgb,var(--fg) 7%,transparent) 40%,transparent 60%);
  background-size:220% 100%;animation:shimmer 1.5s linear infinite}
@keyframes shimmer{from{background-position:140% 0}to{background-position:-60% 0}}
.hide{display:none!important}
@media (max-width:520px){
  body{padding:0 11px 76px}
  .card{padding:16px 15px;border-radius:16px}
  header{padding:16px 2px 13px}
  .grid{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){
  *{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
}
</style></head><body>

<div id="gate">
  <div class="gate-box" id="gate-box">
    <div class="gate-logo">◈</div>
    <h2 id="gate-title">正在检查…</h2>
    <p id="gate-desc">请稍候</p>
    <div id="gate-form" class="hide">
      <input id="inp-pw" type="password" placeholder="后台密码" autocomplete="current-password" autofocus>
      <div class="err" id="gate-err"></div>
      <div class="btnrow"><button class="primary" id="btn-gate">登录</button></div>
      <div class="hint" id="gate-hint"></div>
    </div>
  </div>
</div>

<div class="wrap">
  <header>
    <div class="logo">◈</div>
    <h1>termux<b>-mcp</b></h1>
    <span class="tag" id="ver">…</span>
    <div class="spacer"></div>
    <button class="iconbtn" id="btn-theme" title="切换主题">◐</button>
    <button class="iconbtn" id="btn-refresh" title="刷新">↻</button>
    <button class="iconbtn hide" id="btn-logout" title="退出">⏻</button>
  </header>

  <section class="card">
    <div class="card-head"><i class="pip"></i><h2>设备</h2>
      <span class="chip" id="devcount">0</span></div>
    <div class="grid" id="devices"><div class="skel"></div><div class="skel"></div></div>
    <div class="hint">一个 Worker 可接多台设备。调用工具时加 <code>device</code> 参数指定目标；不填则用默认设备。</div>
  </section>

  <section class="card">
    <div class="card-head"><i class="pip"></i><h2>客户端接入</h2></div>
    <div id="endpoint"></div>
    <label>复制到 MCP 客户端</label>
    <pre id="clientcfg">…</pre>
    <div class="hint" id="reveal-hint">凭证默认打码。点下方按钮可临时显示完整值。</div>
    <div class="row" style="margin-top:10px">
      <div class="tight"><button id="btn-reveal">显示完整凭证</button></div>
      <div class="tight"><button id="btn-copy">复制配置</button></div>
    </div>
  </section>

  <section class="card">
    <div class="card-head"><i class="pip"></i><h2>运行</h2>
      <div class="spacer"></div>
      <div class="seg">
        <button id="tab-sys" class="act">详情</button>
        <button id="tab-logs">日志</button>
      </div>
    </div>

    <div class="pane" id="pane-sys">
      <div class="row">
        <div><label>设备</label><select id="sel-dev"></select></div>
        <div><label>类型</label><select id="sel-which">
          <option value="agent">运行状态</option><option value="system">系统信息</option></select></div>
        <div class="tight"><button class="primary" id="btn-sys">查询</button></div>
      </div>
      <pre id="sysout"></pre>
    </div>

    <div class="pane hide" id="pane-logs">
      <div class="row">
        <div><label>设备</label><select id="sel-dev-logs"></select></div>
        <div><label>文件</label><select id="sel-logfile">
          <option value="agent">agent.log</option>
          <option value="supervisor">supervisor.log</option>
          <option value="error">agent.err.log</option></select></div>
        <div><label>行数</label><input id="inp-lines" type="number" value="200" min="10" max="2000"></div>
        <div class="tight"><button class="primary" id="btn-logs">读取</button></div>
      </div>
      <pre id="logout"></pre>
    </div>
  </section>

  <section class="card">
    <div class="card-head"><i class="pip"></i><h2>后台</h2></div>
    <label>默认设备（MCP 未指定 device 时使用）</label>
    <div class="row">
      <div><select id="sel-default"></select></div>
      <div class="tight"><button class="primary" id="btn-def">保存</button></div>
    </div>
    <div class="hint">这个设置保存在 Worker 上，换任何设备打开后台都是同一份。</div>
  </section>

  <section class="card">
    <div class="card-head"><i class="pip"></i><h2>后台密码</h2></div>
    <div id="pw-state"></div>
    <div class="row" style="margin-top:11px">
      <div><label>当前密码</label><input id="inp-pw-cur" type="password" autocomplete="current-password" placeholder="当前后台密码"></div>
    </div>
    <div class="row">
      <div><label>新密码</label><input id="inp-pw-new" type="password" autocomplete="new-password" placeholder="至少 8 位"></div>
      <div><label>确认新密码</label><input id="inp-pw-new2" type="password" autocomplete="new-password" placeholder="再输入一次"></div>
      <div class="tight"><button class="primary" id="btn-chpw">修改</button></div>
    </div>
    <div class="hint">后台密码只用于登录这个页面（服务端存 PBKDF2 哈希）。它和下面给 AI 用的 AUTH_TOKEN 完全无关。忘了密码可在设备上执行 <code>tmcp admin-pass</code> 重设。</div>
  </section>

  <section class="card">
    <div class="card-head"><i class="pip"></i><h2>API 凭证</h2></div>
    <div id="creds"></div>
    <div class="hint">这些是给程序用的，不是登录密码。改动会立即生效；轮换 AUTH_TOKEN 后所有 AI 客户端都要更新。</div>

    <label>轮换 AUTH_TOKEN（AI 客户端用）</label>
    <div class="row">
      <div><input id="inp-newauth" placeholder="留空则自动生成 32 字节随机值"></div>
      <div class="tight"><button class="primary" id="btn-rotauth">轮换</button></div>
    </div>

    <label>轮换 AGENT_TOKEN（设备连接用）</label>
    <div class="row">
      <div><input id="inp-newagent" placeholder="留空则自动生成"></div>
      <div class="tight"><button class="primary" id="btn-rotagent">轮换</button></div>
    </div>
    <div class="hint">轮换后需要在每台设备上 <code>tmcp token sync</code>（AUTH_TOKEN）或更新配置并重启（AGENT_TOKEN）。</div>
  </section>

  <div class="hint" style="text-align:center;margin-top:22px">
    termux-mcp-remote · <span id="footver">v1.0.0</span> · <a id="footlink" href="/" style="color:var(--muted)">状态页</a>
  </div>
</div>

<div id="toast"></div>

<script>
(function(){
  "use strict";
  var $=function(id){return document.getElementById(id)};
  var state={devices:[],defaultDevice:null,worker:null,authPreview:"",agentPreview:""};
  var revealed=null;      // 点"显示"后缓存的完整凭证
  var toastT=null, loggedIn=false, needSetup=false;

  // ---------- 主题 ----------
  var THEME_KEY="tmcp_theme";
  function applyTheme(t){
    document.documentElement.setAttribute("data-theme",t);
    localStorage.setItem(THEME_KEY,t);
  }
  (function initTheme(){
    var saved=localStorage.getItem(THEME_KEY);
    if(!saved){
      saved=window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";
    }
    applyTheme(saved);
  })();
  $("btn-theme").onclick=function(){
    var cur=document.documentElement.getAttribute("data-theme");
    applyTheme(cur==="dark"?"light":"dark");
  };

  // ---------- 基础 UI ----------
  function toast(msg,bad){
    var el=$("toast");
    el.textContent=msg;
    el.className="show"+(bad?" bad":"");
    clearTimeout(toastT);
    toastT=setTimeout(function(){el.className=""},2800);
  }
  function esc(s){
    return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function err(msg){
    var e=$("gate-err");
    e.textContent=msg||"";
    e.className="err"+(msg?" show":"");
    if(msg){
      $("gate-box").classList.remove("shake");
      void $("gate-box").offsetWidth;
      $("gate-box").classList.add("shake");
    }
  }

  function api(path,opt){
    opt=opt||{};
    var h={"Accept":"application/json"};
    if(opt.body!==undefined)h["Content-Type"]="application/json";
    return fetch(path,{
      method:opt.method||(opt.body!==undefined?"POST":"GET"),
      headers:h,
      credentials:"same-origin",
      body:opt.body===undefined?undefined:JSON.stringify(opt.body)
    }).then(function(r){
      return r.text().then(function(t){
        var j={};
        try{j=JSON.parse(t)}catch(e){j={raw:t}}
        if(r.status===401&&j.needLogin){showGate();throw new Error("unauthorized")}
        if(!r.ok)throw new Error(j.error||("HTTP "+r.status));
        return j;
      });
    });
  }

  // ---------- 登录门 ----------
  function showGate(mode){
    $("gate").classList.remove("out");
    $("btn-logout").classList.add("hide");
    loggedIn=false;
    $("gate-form").classList.remove("hide");
    $("inp-pw").value="";
    err("");
    if(mode==="setup"){
      needSetup=true;
      $("gate-title").textContent="设置后台密码";
      $("gate-desc").textContent="第一次使用，请为这个后台设置一个密码（与 AI 用的 token 分开）。";
      $("inp-pw").setAttribute("placeholder","设置密码，至少 8 位");
      $("inp-pw").setAttribute("autocomplete","new-password");
      $("btn-gate").textContent="设置并进入";
      $("gate-hint").innerHTML="这个密码只用于登录管理界面。AI 客户端用的是另一个 AUTH_TOKEN。";
    }else{
      needSetup=false;
      $("gate-title").textContent="需要登录";
      $("gate-desc").textContent="输入后台密码以继续。";
      $("inp-pw").setAttribute("placeholder","后台密码");
      $("inp-pw").setAttribute("autocomplete","current-password");
      $("btn-gate").textContent="登录";
      $("gate-hint").textContent="";
    }
    setTimeout(function(){$("inp-pw").focus()},120);
  }
  function hideGate(){
    $("gate").classList.add("out");
    $("btn-logout").classList.remove("hide");
    loggedIn=true;
  }

  async function checkAuth(){
    try{
      var r=await fetch("/api/auth/status",{credentials:"same-origin"});
      var j=await r.json();
      if(j.configured){
        // 已设置密码，尝试用现有 cookie 直接进
        var s=await fetch("/api/admin/state",{credentials:"same-origin"});
        if(s.ok){ await load(); hideGate(); return; }
        showGate("login");
      }else{
        showGate("setup");
      }
    }catch(e){
      showGate("login");
    }
  }

  async function doGateAction(){
    var pw=$("inp-pw").value;
    if(!pw){ err("请输入密码"); return; }
    var btn=$("btn-gate");
    btn.disabled=true; btn.textContent="请稍候…";
    try{
      var path=needSetup?"/api/auth/setup":"/api/auth/login";
      var r=await fetch(path,{
        method:"POST",headers:{"Content-Type":"application/json"},
        credentials:"same-origin",body:JSON.stringify({password:pw})
      });
      var j=await r.json();
      if(!j.ok) throw new Error(j.error||"失败");
      await load();
      hideGate();
      toast(needSetup?"后台密码已设置":"登录成功");
    }catch(e){
      err(e.message||"失败");
    }finally{
      btn.disabled=false;
      btn.textContent=needSetup?"设置并进入":"登录";
    }
  }
  $("btn-gate").onclick=doGateAction;
  $("inp-pw").addEventListener("keydown",function(e){if(e.key==="Enter")doGateAction()});
  $("btn-logout").onclick=async function(){
    try{ await fetch("/api/auth/logout",{method:"POST",credentials:"same-origin",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({})}); }catch(e){}
    showGate("login");
    toast("已退出");
  };

  // ---------- 渲染 ----------
  function ago(ts){
    if(!ts) return "—";
    var s=Math.round((Date.now()-ts)/1000);
    if(s<10) return "刚刚";
    if(s<60) return s+" 秒前";
    if(s<3600) return Math.round(s/60)+" 分钟前";
    if(s<86400) return Math.round(s/3600)+" 小时前";
    return Math.round(s/86400)+" 天前";
  }
  function dur(sec){
    if(sec==null) return "—";
    if(sec<60) return sec+" 秒";
    if(sec<3600) return Math.floor(sec/60)+" 分";
    if(sec<86400) return Math.floor(sec/3600)+" 小时 "+(Math.floor(sec/60)%60)+" 分";
    return Math.floor(sec/86400)+" 天";
  }

  function renderDevices(){
    var box=$("devices");
    var list=state.devices||[];
    $("devcount").textContent=list.length+" 台";
    if(!list.length){
      box.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:26px 12px;color:var(--muted);font-size:13px">'+
        '还没有设备接入<br><span style="font-size:12px">在设备上执行 <code style="background:rgba(127,127,127,.14);padding:1px 5px;border-radius:4px">tmcp start</code></span></div>';
      return;
    }
    box.innerHTML=list.map(function(d,i){
      var on=(d.state==="ready");
      var kind=[d.os,d.distro,d.arch].filter(Boolean).join(" · ");
      var isDef=(state.defaultDevice===d.id);
      return '<div class="dev'+(on?" on":"")+'" style="animation-delay:'+(i*55)+'ms">'
        +'<div class="dev-top"><i class="led"></i>'
          +'<span class="dev-name">'+esc(d.name||d.id)+'</span>'
          +(isDef?'<span class="chip def">默认</span>':'')
          +(on?'':'<span class="chip">待握手</span>')
        +'</div>'
        +'<div class="dev-id">'+esc(d.id)+'</div>'
        +'<div class="dev-meta">'
          +(kind?esc(kind)+'<br>':'')
          +'<span class="dim">'+(d.version?'v'+esc(d.version)+' · ':'')+'活跃 '+ago(d.lastSeen)+'</span>'
          +(d.pending?'<br><span class="dim">排队 '+d.pending+'</span>':'')
        +'</div>'
        +'<div class="dev-acts">'
          +'<button data-act="sys" data-id="'+esc(d.id)+'">详情</button>'
          +'<button data-act="log" data-id="'+esc(d.id)+'">日志</button>'
          +'<button class="danger" data-act="kick" data-id="'+esc(d.id)+'">重连</button>'
        +'</div></div>';
    }).join("");
  }

  function fillSelect(el,withAuto){
    var list=state.devices||[];
    var opts=list.map(function(d){
      return '<option value="'+esc(d.id)+'">'+esc(d.name||d.id)+" ("+esc(d.id)+")</option>";
    }).join("");
    el.innerHTML=(withAuto?'<option value="">（自动：第一台连上的）</option>':'')+opts
      ||'<option value="">（无设备）</option>';
    if(withAuto&&state.defaultDevice) el.value=state.defaultDevice;
  }

  function renderEndpoint(){
    var base=location.origin;
    $("endpoint").innerHTML=
       '<div class="kv"><span>MCP 端点</span><b>'+esc(base)+'/mcp</b></div>'
      +'<div class="kv"><span>鉴权头</span><b>Authorization: Bearer &lt;AUTH_TOKEN&gt;</b></div>'
      +'<div class="kv"><span>设备在线</span><b>'+(state.devices||[]).filter(function(d){return d.state==="ready"}).length+' / '+(state.devices||[]).length+'</b></div>';
    renderClientCfg();
  }

  function renderClientCfg(){
    var t=revealed?revealed.auth:(state.authPreview||"<AUTH_TOKEN>");
    $("clientcfg").textContent=JSON.stringify({
      mcpServers:{termux:{type:"http",url:location.origin+"/mcp",
        headers:{Authorization:"Bearer "+t}}}
    },null,2);
  }

  function renderCreds(){
    var authVal=revealed?revealed.auth:(state.authPreview||"—");
    var agentVal=revealed?revealed.agent:(state.agentPreview||"—");
    $("creds").innerHTML=
       '<div class="kv"><span>AUTH_TOKEN · AI 客户端</span>'
      +'<b class="mono" style="font-size:12px">'+esc(authVal)+'</b></div>'
      +'<div class="kv"><span>AGENT_TOKEN · 设备</span>'
      +'<b class="mono" style="font-size:12px">'+esc(agentVal)+'</b></div>'
      +'<div class="kv"><span>来源</span><b>'
        +esc((state.authFrom==="webui"?"WebUI 设置":"Worker Secret")+" / "
             +(state.agentFrom==="webui"?"WebUI 设置":"Worker Secret"))+'</b></div>';
  }

  function renderPwState(){
    var set=state.adminPasswordSet;
    var when=state.adminPasswordUpdatedAt?new Date(state.adminPasswordUpdatedAt).toLocaleString("zh-CN"):"—";
    $("pw-state").innerHTML=
       '<div class="kv"><span>状态</span><b>'+(set?'已设置':'未设置')+'</b></div>'
      +'<div class="kv"><span>更新时间</span><b>'+esc(when)+'</b></div>';
  }

  function render(){
    $("ver").textContent=(state.worker&&state.worker.version?"v"+state.worker.version:"—");
    $("footver").textContent="v"+(state.worker&&state.worker.version||"1.0.0");
    renderDevices();
    fillSelect($("sel-dev"),false);
    fillSelect($("sel-dev-logs"),false);
    fillSelect($("sel-default"),true);
    renderEndpoint();
    renderCreds();
    renderPwState();
  }

  // ---------- 数据 ----------
  async function load(){
    var j=await api("/api/admin/state");
    state=j;
    render();
  }

  // ---------- 交互 ----------
  document.addEventListener("click",function(ev){
    var b=ev.target.closest("button[data-act]");
    if(!b) return;
    var act=b.getAttribute("data-act"), id=b.getAttribute("data-id");
    if(act==="kick"){
      if(!confirm("断开设备 "+id+"？它会自动重连。")) return;
      api("/api/admin/kick",{body:{device:id}}).then(function(){
        toast("已断开，正在重连");
        setTimeout(function(){load().catch(function(){})},1400);
      }).catch(function(e){toast(e.message,true)});
    }else if(act==="sys"){
      $("tab-sys").click(); $("sel-dev").value=id; $("btn-sys").click();
    }else if(act==="log"){
      $("tab-logs").click(); $("sel-dev-logs").value=id; $("btn-logs").click();
    }
  });

  $("btn-refresh").onclick=function(){
    load().then(function(){toast("已刷新")}).catch(function(e){toast(e.message,true)});
  };

  $("tab-sys").onclick=function(){
    $("tab-sys").classList.add("act"); $("tab-logs").classList.remove("act");
    $("pane-sys").classList.remove("hide"); $("pane-logs").classList.add("hide");
  };
  $("tab-logs").onclick=function(){
    $("tab-logs").classList.add("act"); $("tab-sys").classList.remove("act");
    $("pane-logs").classList.remove("hide"); $("pane-sys").classList.add("hide");
  };

  $("btn-sys").onclick=function(){
    var dev=$("sel-dev").value, which=$("sel-which").value;
    if(!dev){toast("没有可用设备",true);return}
    $("sysout").textContent="查询中…";
    api("/api/admin/device-info",{body:{device:dev,which:which}})
      .then(function(j){$("sysout").textContent=j.text||"(空)"})
      .catch(function(e){$("sysout").textContent="失败："+e.message});
  };

  $("btn-logs").onclick=function(){
    var dev=$("sel-dev-logs").value, which=$("sel-logfile").value;
    var lines=Number($("inp-lines").value)||200;
    if(!dev){toast("没有可用设备",true);return}
    $("logout").textContent="读取中…";
    api("/api/admin/logs",{body:{device:dev,which:which,lines:lines}})
      .then(function(j){$("logout").textContent=j.text||"(空)"})
      .catch(function(e){$("logout").textContent="失败："+e.message});
  };

  $("btn-def").onclick=function(){
    var v=$("sel-default").value;
    api("/api/admin/default-device",{body:{device:v||null}})
      .then(function(){toast("已保存");load().catch(function(){})})
      .catch(function(e){toast(e.message,true)});
  };

  $("btn-reveal").onclick=async function(){
    if(revealed){
      revealed=null;
      $("btn-reveal").textContent="显示完整凭证";
      renderClientCfg(); renderCreds();
      return;
    }
    try{
      var a=await api("/api/admin/reveal-token",{body:{kind:"auth"}});
      var g=await api("/api/admin/reveal-token",{body:{kind:"agent"}});
      revealed={auth:a.token,agent:g.token};
      $("btn-reveal").textContent="隐藏凭证";
      renderClientCfg(); renderCreds();
    }catch(e){toast(e.message,true)}
  };

  $("btn-copy").onclick=async function(){
    try{
      await navigator.clipboard.writeText($("clientcfg").textContent);
      toast("已复制客户端配置");
    }catch(e){
      toast("复制失败，请手动选择文本",true);
    }
  };

  $("btn-chpw").onclick=async function(){
    var cur=$("inp-pw-cur").value, n1=$("inp-pw-new").value, n2=$("inp-pw-new2").value;
    if(!cur){toast("请输入当前密码",true);return}
    if(n1.length<8){toast("新密码至少 8 位",true);return}
    if(n1!==n2){toast("两次输入的新密码不一致",true);return}
    try{
      await api("/api/admin/change-password",{body:{current:cur,password:n1}});
      toast("密码已修改，请重新登录");
      $("inp-pw-cur").value="";$("inp-pw-new").value="";$("inp-pw-new2").value="";
      setTimeout(function(){showGate("login")},700);
    }catch(e){toast(e.message,true)}
  };

  $("btn-rotauth").onclick=async function(){
    if(!confirm("轮换后所有 AI 客户端都要改用新 token，继续？")) return;
    var v=$("inp-newauth").value.trim();
    try{
      var j=await api("/api/admin/rotate-token",{body:{kind:"auth",value:v||null}});
      $("inp-newauth").value="";
      revealed=null; $("btn-reveal").textContent="显示完整凭证";
      await load();
      toast("已轮换 AUTH_TOKEN（新值："+j.token.slice(0,6)+"…"+j.token.slice(-4)+"）");
    }catch(e){toast(e.message,true)}
  };

  $("btn-rotagent").onclick=async function(){
    if(!confirm("轮换后所有设备都要更新 AGENT_TOKEN 并重启，继续？")) return;
    var v=$("inp-newagent").value.trim();
    try{
      await api("/api/admin/rotate-token",{body:{kind:"agent",value:v||null}});
      $("inp-newagent").value="";
      revealed=null; $("btn-reveal").textContent="显示完整凭证";
      await load();
      toast("已轮换 AGENT_TOKEN，请更新各设备");
    }catch(e){toast(e.message,true)}
  };

  // 自动刷新（仅在已登录时）
  setInterval(function(){ if(loggedIn) load().catch(function(){}); },15000);

  checkAuth();
})();
</script></body></html>`;
