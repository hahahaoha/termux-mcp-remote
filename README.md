# termux-mcp-remote

把一台 Linux 机器的终端，变成**你一个人专用**的远程 MCP 服务。

```
AI 客户端 (Claude / ChatGPT / Cursor / 任意 MCP 客户端)
   │  https://mcp.你的域名/mcp
   │  请求头: Authorization: Bearer <AUTH_TOKEN>
   ▼
Cloudflare Worker（MCP 服务 + 鉴权 + 隧道 + WebUI）
   │  WebSocket（设备主动连出去，穿过 NAT）
   ▼
Agent（Termux / Debian / Ubuntu / 树莓派 / 任意 Linux）
   └─ shell / 文件 / 交互式 PTY / 后台长任务
```

设备**不需要公网 IP、不需要开端口、不需要 cloudflared / frp**。
它主动往 Worker 建一条 WebSocket，外面的 MCP 请求由 Worker 顺着这条连接转进来。

> 一个 Worker 可以同时接**多台设备**，MCP 调用时用 `device` 参数指定目标。

---

## 1. 安装

### 一行命令（推荐）

安装脚本有两个版本，内容完全一致，只是输出语言不同：

**English**

```bash
curl -fsSL https://gh-proxy.org/https://raw.githubusercontent.com/hahahaoha/termux-mcp-remote/main/get.sh | bash
```

**中文**

```bash
curl -fsSL https://gh-proxy.org/https://raw.githubusercontent.com/hahahaoha/termux-mcp-remote/main/get-zh.sh | bash
```

> 默认走 **gh-proxy**（国内实测 0.9 秒，比直连还快一点）。
> 注意代理域名是 **`gh-proxy.org`**，`gh-proxy.com` 只是官网，直接拼路径会返回 403。
> 它只有 60 秒缓存，刚推完代码稍等一下就是新版。

如果 gh-proxy 不通，可以换这些源（内容一样）：

```bash
# GitHub 直连（永远最新，但国内可能连不上）
curl -fsSL https://raw.githubusercontent.com/hahahaoha/termux-mcp-remote/main/get.sh | bash

# ghfast
curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/hahahaoha/termux-mcp-remote/main/get.sh | bash

# ghproxy（较慢，实测 12 秒）
curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/hahahaoha/termux-mcp-remote/main/get.sh | bash

# jsDelivr —— 必须带 commit hash，不能用 @main（分支有 12 小时缓存）
curl -fsSL https://cdn.jsdelivr.net/gh/hahahaoha/termux-mcp-remote@<hash>/get.sh | bash
```

脚本下载代码包时也会按 **gh-proxy → codeload → ghproxy → ghfast → github → git clone**
的顺序自动回退，所以只要有一个源通就能装完。
Node.js 缺失时在 Termux 上会自动 `pkg install nodejs-lts`（Linux 会提示安装方法）。

**环境依赖会自动装**，不用自己配：

| 依赖 | Termux | Debian / Ubuntu | Alpine / Fedora / Arch | macOS |
| --- | --- | --- | --- | --- |
| `curl` `tar` | `pkg` | `apt` | 各自包管理器 | 系统自带 |
| Node.js ≥ 20 | `pkg install nodejs-lts` | `apt install nodejs` | 各自包管理器 | `brew` |
| Node 太旧时 | — | **nvm 装到 `~/.nvm`**（不需要 root） | 同左 | 同左 |
| `util-linux`（交互式 shell 用） | `pkg` | `apt` | 各自包管理器 | 自带 |

- 需要 root 时用 `sudo -n`（免密才用），装不了就明确告诉你怎么装，不会静默跳过
- 装完的 `tmcp` 启动器里写的是 **node 的绝对路径**，所以即使 Node 是用 nvm 装的、没配进 PATH，`tmcp` 也能直接跑
- 不想让脚本碰系统包就加 `--no-system-deps`
- 想先看它要装什么（不改动任何东西）就 `TMCP_DRY_RUN=1 bash get.sh`

```bash
# 预览
curl -fsSL https://gh-proxy.org/https://raw.githubusercontent.com/hahahaoha/termux-mcp-remote/main/get.sh | TMCP_DRY_RUN=1 bash
```

常用参数（`get-zh.sh` 与 `get.sh` 完全相同）：

```bash
# 装到指定目录
bash get.sh --dir /opt/termux-mcp-remote

# 更新现有安装
bash get.sh --dir ~/termux-mcp-remote

# 跳过 npm install（依赖已装好）
bash get.sh --no-deps

# 不动系统包，只提示缺什么
bash get.sh --no-system-deps

# 指定下载源
bash get.sh --mirror gh-proxy

# 确认要覆盖另一个位置的 tmcp 命令
bash get.sh --dir /opt/new --force
```

> **安全保护**：如果检测到已有另一个位置的安装，脚本会**中止并且不改动任何文件**，
> 而不是悄悄覆盖你的 `tmcp` 命令。必须显式加 `--force` 才会切换。

### 界面语言

安装脚本会记住你用的是哪个版本：

| 用哪个脚本装的 | tmcp 的输出语言 |
| --- | --- |
| `get.sh` / `install.sh`（$LANG 非中文） | English |
| `get-zh.sh` / `install.sh`（$LANG=zh*） | 中文 |

随时可以切换：

```bash
tmcp lang          # 查看当前语言
tmcp lang en       # 切到英文
tmcp lang zh       # 切到中文
```

优先级：`TMCP_LANG` 环境变量 > `config.json` 的 `lang` > `~/.config/termux-mcp-remote/lang`（安装脚本写的）> 系统 locale > 英文。
`tmcp logs` 里的日志同样跟随这个设置。

### 手动安装

```bash
git clone https://github.com/hahahaoha/termux-mcp-remote.git
cd termux-mcp-remote
npm install
bash install.sh              # 安装 tmcp 命令（跟随 $LANG 自动中/英文）
```

需要 Node.js >= 20。

**Termux**：`pkg install -y nodejs-lts util-linux`
**Debian/Ubuntu**：`sudo apt install -y nodejs npm util-linux`

`util-linux` 提供 `script` 命令，交互式 PTY 需要它；不装则只有 `shell_*` 工具不可用。

## 2. 首次部署（只做一次）

```bash
tmcp deploy
```

依次完成：

1. 检查 `wrangler` 登录状态（没有则提示 `wrangler login`）
2. 生成 `AUTH_TOKEN` / `AGENT_TOKEN`，写入 Worker Secrets
3. 部署 Worker（含 Durable Object）
4. 把地址和 token 存到 `~/.config/termux-mcp-remote/config.json`（600）

### 给新设备一键配置（配置码）

再也不用抄地址和密钥了。在后台 `https://<worker>/admin` →「配置码」→ 生成，
然后在设备上：

```bash
tmcp enroll          # 回车，然后粘贴那串码
tmcp enroll <码>     # 或者直接作为参数
```

**一个码就够了**，不用再输入地址、也不用输入 token。

码长这样（125 个字符，看不出内容）：

```
tmcp1_eyJ2IjoxLCJoIjoiaHR0cHM6Ly9tY3Au...
```

前 6 位 `tmcp1_` 是格式标记，后面是 base64url 编码的 `{"v":1,"h":"<地址>","c":"<随机码>"}`。
所以它自带 Worker 地址，粘上去就能直接绑定。

> 只是**编码**不是加密——Worker 地址本身是公开的（任何人访问 `/mcp` 都只会拿到 401），
> 混进去只是省得你手打。真正的凭证是那 32 字节随机数，它只存在服务端，
> 兑换的那一刻才连同 token 一起下发。

如果这张码里没有地址（比如旧版生成的裸码，43 个字符），才会追问一次地址，
这种旧码仍然可以用 `tmcp enroll <地址> <码>`。

**它为什么安全：**

| 属性 | 实现 |
| --- | --- |
| 码里不含密钥 | 只有地址 + 32 字节随机数；token 在兑换那一刻才由 Worker 现取注入 |
| 服务端不存明文 | Durable Object 里存的是随机码的 SHA-256 哈希，拿到存储快照也还原不出码 |
| 一次性 | 兑换成功即标记 `used`，再用返回 410 |
| 有时效 | 默认 10 分钟（可选 5 分钟 ~ 1 小时），过期记录直接删除 |
| 过期不可复原 | 记录被删 + 码里没有密钥，过了有效期就是一串无用字符 |
| 可撤销 | 后台可随时撤销单个码；同时最多 20 个有效码 |
| 轮换友好 | 密钥是兑换时现取的，轮换 AUTH_TOKEN 后旧码兑换出来的也是新值 |

> 码只显示一次，页面刷新后就看不到了——需要就重新生成。
> 终端里识别到地址时会打码显示（`mcp.***.cc.cd`），不会把完整地址打出来。

### 如果 `*.workers.dev` 访问不了

国内网络下 `*.workers.dev` 常被 DNS 污染。绑自有域名：

```bash
tmcp domain
```

列出你账号下的域名 → 选一个 → 填子域（如 `mcp.example.com`）→ 自动创建 Workers 自定义域
并签发证书 → 顺手把本地 `workerUrl` 改过去。

> 也可以 Dashboard 手动：Worker → Settings → Domains & Routes → Add custom domain。

## 3. 启动

```bash
tmcp start      # 守护进程 + 崩溃自动重启
tmcp status     # 本地进程 / Worker / 各设备状态
tmcp test       # 4 步自检
```

各系统后台常驻方式不同：

| 平台 | 常驻方式 |
| --- | --- |
| Termux | `tmcp start`；想开机自启装 Termux:Boot，并关掉电池优化 |
| systemd | `contrib/tmcp.service` 模板：`sudo cp contrib/tmcp.service /etc/systemd/system/` 后改路径启用 |
| 其他 | nohup / supervisor / pm2 / Docker 随意 |

## 4. 接进 AI 客户端

```json
{
  "mcpServers": {
    "termux": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <AUTH_TOKEN>"
      }
    }
  }
}
```

`tmcp deploy` / `tmcp token` 会打印这段配置。

**鉴权就是那个请求头。** 没有正确的 `Authorization: Bearer <AUTH_TOKEN>`，`/mcp` 一律 401。
不支持自定义 header 的客户端可以用 `X-Mcp-Token: <token>`。

### 可选：OAuth（网页版客户端用）

Claude 网页版、ChatGPT 连接器、MCP Inspector 会自动走 OAuth。给 Worker 加一个只有你知道的密码：

```bash
cd worker && wrangler secret put OWNER_PASSWORD
```

客户端会自动发现 `/.well-known/oauth-protected-resource` → 跳 `/authorize` 输密码 → 拿到
30 天令牌（PKCE + refresh token）。不设这个 secret 时 OAuth 端点完全不存在。

验证：`node scripts/oauth-test.mjs https://你的域名 <密码>`。
不需要了就 `wrangler secret delete OWNER_PASSWORD`。

---

## 5. WebUI（Worker 上，随时可访问）

```
https://<你的-worker>/admin
```

**用独立的后台密码登录**，不是 AUTH_TOKEN。第一次打开会引导你设置一个（至少 8 位）；
之后用这个密码登录，会话存在 HttpOnly cookie 里（7 天有效）。

```bash
tmcp admin-pass      # 设置 / 重置后台密码（忘了密码时用这个）
tmcp admin-pass      # 输入留空 = 清除密码，下次访问重新引导
```

密码在服务端只存 PBKDF2-SHA256 哈希（10 万次迭代，Cloudflare 上限），
连续 8 次输错锁定 10 分钟。它和 AI 客户端用的 `AUTH_TOKEN` 完全无关：
拿后台密码调 `/mcp` 会被拒，拿 `AUTH_TOKEN` 也进不了后台。

登录后可以：

- **看设备列表**：在线状态、系统/发行版/架构、版本、最后活跃时间
- **设备详情**：进程 pid、内存、PTY 会话数、后台任务数、连接时长、磁盘
- **看日志**：agent.log / supervisor.log / agent.err.log，可选行数
- **强制重连**：某台设备连接卡住时
- **改默认设备**：MCP 不传 `device` 时用哪台
- **生成配置码**：给新设备用，一次性 + 倒计时 + 可撤销
- **修改后台密码**：需要先输入当前密码
- **轮换 AUTH_TOKEN**：自动生成或自定义，立即生效
- **轮换 AGENT_TOKEN**：同样立即生效（之后要更新各设备配置）

界面是深色玻璃拟态风格，带弹性过渡动画、LED 呼吸灯、骨架屏加载，支持明暗主题切换
（跟随系统 + 手动切换，记在 localStorage），并且响应 `prefers-reduced-motion`。

**凭证默认打码显示**，要复制客户端配置时点「显示完整凭证」，看完可以再点回去隐藏。

**令牌存在 Worker 的 Durable Object 里，优先级高于 Secrets**，所以在网页上改完不用重新部署。
轮换后在设备上执行 `tmcp token sync` 就能把新 token 拉回本地。

> 本地还有个应急面板 `tmcp panel`（只监听 127.0.0.1），外网打不开 WebUI 时用。

### 三种凭证的分工

| 凭证 | 用途 | 存放 | 谁能看到 |
| --- | --- | --- | --- |
| **后台密码** | 登录 `/admin` | PBKDF2 哈希（DO） | 只有你 |
| **AUTH_TOKEN** | AI 客户端调 `/mcp` | DO / Secret | 后台点「显示」才看得到完整值 |
| **AGENT_TOKEN** | 设备连 Worker | DO / Secret | 同上 |

---

## 工具清单（19 个 + 4 个设备管理）

| 工具 | 说明 |
| --- | --- |
| `run_command` | 非交互式命令（默认 30s，最长 45s） |
| `read_file` / `write_file` / `edit_file` | 读写、精确替换（大文件自动分块） |
| `list_dir` / `delete` / `move` | 目录与文件管理 |
| `search_files` / `grep_files` | 文件名 / 内容搜索 |
| `system_info` | 系统、发行版、CPU、内存、磁盘 |
| `shell_open` / `shell_send` / `shell_view` / `shell_close` / `shell_list` | 真实 PTY（`top`、`vim`，`cd` 跨调用保留） |
| `job_start` / `job_status` / `job_kill` / `job_list` | 后台长任务，不受 45s 限制 |
| `list_devices` | 列出所有设备与在线状态 |
| `device_status` | 某台设备的进程/系统详情 |
| `device_logs` | 读某台设备的日志 |
| `device_kick` | 强制某台设备重连 |

相对路径基于 `$HOME`，`~/x` 也支持。

**多设备**：所有工具都接受可选的 `device` 参数（设备 id）。不传则用默认设备。

```json
{ "name": "run_command", "arguments": { "command": "docker ps", "device": "debian-vps" } }
```

**给 AI 的建议**：普通命令用 `run_command`；要 TTY 用 `shell_*`；超过 45 秒用 `job_start` +
`job_status(wait_ms=...)` 轮询；大文件分段读；多设备先 `list_devices`。

---

## 命令

```bash
tmcp                 交互菜单
tmcp setup           配置向导（可反复执行）
tmcp deploy          部署 / 更新 Worker 并同步 token
tmcp domain          绑定自有域名
tmcp start | stop | restart
tmcp status          本地 + Worker + 各设备
tmcp logs -f         跟日志
tmcp test            自检
tmcp doctor          环境体检
tmcp enroll [配置码]   用一次性配置码一键配置（码里含地址）
tmcp lang [en|zh]    切换界面语言
tmcp admin-pass      设置 / 重置后台登录密码
tmcp token           查看 token
tmcp token sync      从 Worker 拉回当前 token（WebUI 轮换后用）
tmcp token rotate auth|agent
tmcp url <地址>      改 Worker 地址
tmcp panel           本地应急面板
```

## 配置

`~/.config/termux-mcp-remote/config.json`（600）

| 字段 | 说明 |
| --- | --- |
| `workerUrl` | Worker 根地址（不要带 `/mcp`） |
| `authToken` | AI 客户端用的 token |
| `agentToken` | 设备连 Worker 用的 token（不要外泄） |
| `name` | 设备显示名 |
| `deviceId` | 设备 id（默认由主机名派生，如 `debian-vps`） |
| `maxShells` | 最大 PTY 会话数（默认 6） |
| `shellIdleMs` | PTY 空闲回收毫秒（默认 30 分钟） |

改完 `tmcp restart`。

## 安全模型

- 设备只**主动外连**，不监听任何公网端口
- `/mcp` 必须带正确 token，定长比较防时序攻击
- Agent 通道用独立的 `AGENT_TOKEN`
- 同一 deviceId 只保留一条连接，新连接顶掉旧的，避免双写
- `delete` / `move` 拒绝操作 `/`、`$HOME`、`$PREFIX` 等根路径本身
- 远程单条响应截断到 ~180KB；大消息自动切片（Cloudflare 单帧 1MiB 限制）
- WebUI 需 AUTH_TOKEN；本地应急面板只监听 `127.0.0.1`

## 目录结构

```
agent/      设备侧：连接 / 工具执行 / PTY / 后台任务 / CLI / 守护进程 / 平台探测
worker/     Cloudflare Worker：MCP 服务、多设备隧道、WebUI、OAuth、运行时设置
shared/     两端共用：工具定义、WebSocket 分块传输
local/      本地模拟服务器（不联网也能端到端验证）
scripts/    验收测试
contrib/    systemd 服务模板
install.sh  安装 tmcp（自动适配 Termux / Debian / Linux）
```

## 排障

| 现象 | 处理 |
| --- | --- |
| 设备显示离线 | `tmcp status`、`tmcp logs -f`，确认 `tmcp start` |
| curl Worker 超时 | `*.workers.dev` 被污染 → `tmcp domain` 绑自有域名 |
| 401 | 请求头没带或 token 不匹配；`tmcp token` 核对，`tmcp token sync` 从 WebUI 拉回 |
| 忘记后台密码 | `tmcp admin-pass` 重设（会踢掉所有已登录会话） |
| 后台密码输错被锁 | 等 10 分钟，或 `tmcp admin-pass` 立即重设 |
| 部署后行为没变 | 已内置 build 检测：Agent 发现 Worker 换了代码会自动重连 |
| 手机重启后没连上 | Termux:Boot + 关闭电池优化 |
| systemd 起不来 | 检查 `contrib/tmcp.service` 里的路径和用户 |
| PTY 打不开 | `apt install util-linux` / `pkg install util-linux` |
| 命令超时 | 改用 `job_start` |
| 调用报「正在自动重连」 | 网络抖动导致长连接重建，1-5 秒后重试 |
| `system_info` 里没有 loadavg | Android 内核不导出 `/proc/loadavg`，属正常；Android 上还会缺 `cpuUsagePercent`（`/proc/stat` 也受限） |
| AUTH_TOKEN 与 Worker 不一致 | `tmcp status` 会自动用设备凭证取回并写回本地，看到「已用设备凭证自动同步」即已修好 |

## 两个值得记住的坑

**`tmcp restart` 不能把自己杀掉。**
早先把后台任务跑在独立进程组（`detached: true`），Agent 停机时 `killAll()` 的
`process.kill(-pid)` 会把「正在执行 restart」的那个进程一并杀掉——日志表现为
`exit=null signal=SIGKILL`，结果只停了没起。现在：
- 后台任务不再 detached，改用 `trap '' HUP INT` 屏蔽挂断信号；
- `restart` 先把「延时启动器」`spawn(detached)` 到独立进程组，再执行 stop。
即使 restart 本身被杀，启动器也会在 1 秒后把服务拉起来。

**AUTH_TOKEN 会被 WebUI 轮换，CLI 要能自愈。**
`/api/admin/reveal-token` 额外接受设备凭证（`AGENT_TOKEN`）。理由：设备本来就能
执行任意命令、也能读到本地配置里的 token，所以这不算提权；好处是 AUTH_TOKEN 在
后台被轮换后，`tmcp status` 能自动取回并写回本地，不会卡在 401。

## 本地测试（不碰 Cloudflare）

```bash
node local/local-server.js        # 模拟 Worker @ 127.0.0.1:29200
tmcp url http://127.0.0.1:29200 && tmcp start
node scripts/remote-test.mjs http://127.0.0.1:29200/mcp <AUTH_TOKEN>
```

## 验收状态

实测环境：华为 LIO-AN00 / Termux / Node 24

- `scripts/remote-test.mjs`（经公网 Worker）：**37 项全通过**
  —— 19 个工具、700KB 分块写入、大输出截断、PTY 交互、后台任务、错误处理
- `scripts/oauth-test.mjs`：**23 项全通过**
  —— 元数据发现、动态注册、PKCE、密码校验、授权码一次性、refresh、401 语义
- `scripts/multidevice-test.mjs`：**11 项全通过**
  —— 三设备同时在线、按 device 路由、不存在设备报错、单设备断开不影响其他
- `scripts/admin-auth-test.mjs`：**18 项全通过**
  —— 首次设置、HttpOnly/SameSite cookie、密码与 token 互不通用、伪造会话被拒、改密后旧会话失效
- `scripts/enroll-test.mjs`：**32 项全通过**
  —— 生成、兑换、一次性、过期即焚、撤销、TTL 钳制、码内不含密钥、
  自包含码（link 里看不到域名、能解出地址与随机码）、列表不泄漏明文
- WebUI DOM 测试（jsdom）：**25 项全通过**
  —— 登录门、设备卡渲染、凭证打码/显示、主题切换、标签页、设备详情查询、控制台无错误
