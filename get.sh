#!/usr/bin/env bash
# termux-mcp-remote 一键安装
#
# 用法（任选其一）：
#   curl -fsSL https://cdn.jsdelivr.net/gh/hahahaoha/termux-mcp-remote@main/get.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/hahahaoha/termux-mcp-remote/main/get.sh | bash
#   bash get.sh                 # 已下载到本地
#
# 可选参数 / 环境变量：
#   --dir <路径>      安装目录（默认 ~/termux-mcp-remote）
#   --branch <分支>   安装分支（默认 main）
#   --mirror <名字>   强制使用某个源：jsdelivr | github | ghproxy | gitee
#   --no-deps         跳过 npm install
#   --force           覆盖已有的 tmcp 命令 / 在运行中的实例上强制更新
#   TMCP_DIR=...      同 --dir
#   TMCP_BRANCH=...   同 --branch
#   TMCP_FORCE=1      同 --force
#
# 设计要点：
#   - 通过 curl | bash 运行时 stdin 被脚本占用，所以本脚本【不读 stdin】；
#     需要交互的步骤（tmcp setup）留给用户在装完后自己执行。
#   - 多种下载源自动回退，适配国内网络。
#   - 全程幂等：重复运行只会更新代码，不动已有的配置和 token。
set -u

REPO="hahahaoha/termux-mcp-remote"
DEFAULT_DIR="$HOME/termux-mcp-remote"
TARGET_DIR="${TMCP_DIR:-}"
BRANCH="${TMCP_BRANCH:-main}"
MIRROR="${TMCP_MIRROR:-}"
[ "${TMCP_FORCE:-0}" = "1" ] && FORCE=1
SKIP_DEPS=0
FORCE=0

# ---------- 彩色输出（非 TTY 时自动关闭） ----------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'
  G=$'\033[32m'; Y=$'\033[33m'; RED=$'\033[31m'; C=$'\033[36m'; M=$'\033[35m'
else
  B=""; D=""; R=""; G=""; Y=""; RED=""; C=""; M=""
fi
step() { printf '\n%s▸ %s%s\n' "$B$M" "$1" "$R"; }
ok()   { printf '%s✓%s %s\n' "$G" "$R" "$1"; }
warn() { printf '%s!%s %s\n' "$Y" "$R" "$1"; }
die()  { printf '%s✗%s %s\n' "$RED" "$R" "$1" >&2; exit 1; }
dim()  { printf '%s%s%s\n' "$D" "$1" "$R"; }

# ---------- 解析参数 ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)      TARGET_DIR="${2:-}"; shift 2 ;;
    --branch)   BRANCH="${2:-}"; shift 2 ;;
    --mirror)   MIRROR="${2:-}"; shift 2 ;;
    --no-deps)  SKIP_DEPS=1; shift ;;
    --force)    FORCE=1; shift ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done
[ -n "$TARGET_DIR" ] || TARGET_DIR="$DEFAULT_DIR"

printf '%s\n' "${B}${M}termux-mcp-remote${R} ${D}· 一键安装${R}"
dim "仓库: $REPO  分支: $BRANCH"

# ---------- 1. 环境探测 ----------
step "检查环境"
if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux ]; then
  PLATFORM="termux"
  BIN_DIR="${PREFIX:-/data/data/com.termux/files/usr}/bin"
else
  PLATFORM="linux"
  if [ -w /usr/local/bin ] 2>/dev/null; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
fi
ok "平台 $PLATFORM，命令装到 $BIN_DIR"

for c in curl tar; do
  command -v "$c" >/dev/null 2>&1 || die "缺少 $c，请先安装（$([ "$PLATFORM" = termux ] && echo 'pkg install curl tar' || echo 'apt install curl tar')）"
done

# ---------- 2. Node.js ----------
step "检查 Node.js"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
    ok "Node.js $(node -v)"
    NEED_NODE=0
  else
    warn "Node.js $(node -v 2>/dev/null || echo '?') 版本过低，需要 >= 20"
  fi
else
  warn "未找到 Node.js"
fi

if [ "$NEED_NODE" = 1 ]; then
  if [ "$PLATFORM" = "termux" ]; then
    dim "尝试 pkg install nodejs-lts（可能需要一点时间）…"
    if command -v pkg >/dev/null 2>&1; then
      pkg install -y nodejs-lts >/dev/null 2>&1 || true
    fi
    if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; then
      ok "已安装 Node.js $(node -v)"
    else
      die "请手动执行：pkg install nodejs-lts，然后重跑本脚本"
    fi
  else
    die "请先安装 Node.js >= 20：
  Debian/Ubuntu:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
  或使用 nvm:     curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22"
  fi
fi

# ---------- 3. 检查已有安装 ----------
step "检查已有安装"
EXISTING_CMD=""
if [ -f "$BIN_DIR/tmcp" ]; then
  EXISTING_CMD=$(sed -n 's|.*exec node "\([^"]*\)/agent/cli.js".*|\1|p' "$BIN_DIR/tmcp" 2>/dev/null | head -n1)
  if [ -z "$EXISTING_CMD" ]; then
    EXISTING_CMD=$(grep -o '/[^"]*agent/cli.js' "$BIN_DIR/tmcp" 2>/dev/null | sed 's|/agent/cli.js||' | head -n1)
  fi
fi

if [ -n "$EXISTING_CMD" ] && [ "$EXISTING_CMD" != "$TARGET_DIR" ]; then
  warn "已存在另一个安装："
  dim "  命令 $BIN_DIR/tmcp → $EXISTING_CMD"
  dim "  本次要装到 $TARGET_DIR"
  if [ "$FORCE" != 1 ]; then
    printf '\n%s不会覆盖现有的 tmcp 命令。%s\n' "$Y" "$R"
    printf '  如果想换到新目录，请加 --force，或先执行：\n'
    printf '    %srm -f %s/tmcp%s\n' "$C" "$BIN_DIR" "$R"
    printf '  如果只是想更新现有安装，请用：\n'
    printf '    %sbash get.sh --dir %s%s\n\n' "$C" "$EXISTING_CMD" "$R"
    die "已中止（未改动任何文件）"
  fi
  warn "--force：将把 tmcp 命令切到新目录"
fi

# 有实例在跑时提醒
RUNNING_PID=""
for p in "$TARGET_DIR/.config" "$HOME/.config/termux-mcp-remote/state/agent.pid"; do :; done
PIDFILE="$HOME/.config/termux-mcp-remote/state/agent.pid"
if [ -f "$PIDFILE" ]; then
  P=$(cat "$PIDFILE" 2>/dev/null | tr -dc '0-9')
  if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then
    RUNNING_PID="$P"
  fi
fi
if [ -n "$RUNNING_PID" ]; then
  warn "检测到 Agent 正在运行（pid=$RUNNING_PID）"
  dim "  会更新代码，但不会重启服务；装完请执行：tmcp restart"
fi

# ---------- 4. 下载代码 ----------
step "下载代码"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/tmcp-install-XXXXXX") || die "无法创建临时目录"
trap 'rm -rf "$TMP"' EXIT

TARBALL="$TMP/repo.tar.gz"
GOT=0
try_mirror() {
  local name="$1" url="$2"
  [ -n "$MIRROR" ] && [ "$MIRROR" != "$name" ] && return 1
  printf '%s→ %s%s\n' "$D" "$name" "$R"
  if curl -fsSL --connect-timeout 12 --max-time 180 -o "$TARBALL" "$url" 2>/dev/null; then
    # 简单校验：能列出内容且包含 package.json
    if tar -tzf "$TARBALL" 2>/dev/null | grep -q 'package\.json$'; then
      ok "已从 $name 下载"
      GOT=1
      return 0
    fi
    warn "$name 返回的内容不像代码包"
    rm -f "$TARBALL"
  else
    warn "$name 不可用"
  fi
  return 1
}

ENC_BRANCH=$(printf '%s' "$BRANCH" | sed 's|/|%2F|g')
# 注意：jsDelivr 不支持 tarball（对 @main 会 404），它只在 get.sh 自举时用来加速。
try_mirror "codeload"  "https://codeload.github.com/$REPO/tar.gz/refs/heads/$ENC_BRANCH" || \
try_mirror "ghproxy"   "https://ghproxy.net/https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || \
try_mirror "ghfast"    "https://ghfast.top/https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || \
try_mirror "github"    "https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || true

if [ "$GOT" = 0 ]; then
  if [ -n "$MIRROR" ]; then
    die "指定的源 $MIRROR 下载失败"
  fi
  # 最后回退：git clone（需要 git）
  if command -v git >/dev/null 2>&1; then
    dim "尝试 git clone…"
    rm -rf "$TMP/src"
    if git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$TMP/src" >/dev/null 2>&1; then
      ok "已用 git 克隆"
      GOT=2
    fi
  fi
  [ "$GOT" != 0 ] || die "所有下载源都失败了。请检查网络，或手动 git clone 后运行 bash install.sh"
fi

# 解包
step "安装到 $TARGET_DIR"
if [ "$GOT" = 1 ]; then
  rm -rf "$TMP/src"
  mkdir -p "$TMP/src"
  tar -xzf "$TARBALL" -C "$TMP/src" || die "解压失败"
  SRC=$(find "$TMP/src" -mindepth 1 -maxdepth 1 -type d | head -n1)
  [ -n "$SRC" ] && [ -d "$SRC" ] || SRC="$TMP/src"
else
  SRC="$TMP/src"
fi
[ -f "$SRC/package.json" ] || die "下载的包里没有 package.json，可能源返回了错误页"

# 保留已有的配置文件（配置在 ~/.config，不在这里，但保险起见排除这些）
mkdir -p "$TARGET_DIR"
# 用 rsync 风格：覆盖代码，但不动 node_modules（省时间）
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude 'node_modules' --exclude '.git' --exclude 'logs' \
        --exclude 'run' --exclude 'state' "$SRC"/ "$TARGET_DIR"/ || die "复制文件失败"
else
  # 没有 rsync 就逐个复制，跳过大目录
  (cd "$SRC" && find . -mindepth 1 -maxdepth 1 \
      ! -name node_modules ! -name .git ! -name logs ! -name run ! -name state \
      -exec cp -R {} "$TARGET_DIR"/ \; ) || die "复制文件失败"
fi
chmod +x "$TARGET_DIR/bin/tmcp" "$TARGET_DIR/install.sh" 2>/dev/null || true
ok "代码已就位"

# ---------- 5. 依赖 ----------
if [ "$SKIP_DEPS" = 0 ]; then
  step "安装依赖"
  if [ -f "$TARGET_DIR/node_modules/zod/package.json" ]; then
    ok "依赖已存在，跳过（要强制重装可加 --no-deps 之外的参数）"
  else
    dim "npm install（第一次会慢一些）…"
    if (cd "$TARGET_DIR" && npm install --no-audit --no-fund --omit=dev >/dev/null 2>&1); then
      ok "依赖安装完成"
    else
      warn "npm install 失败，稍后可在 $TARGET_DIR 手动执行 npm install"
    fi
  fi
else
  warn "已跳过依赖安装（--no-deps）"
fi

# ---------- 6. 注册 tmcp 命令 ----------
step "安装 tmcp 命令"
mkdir -p "$BIN_DIR" 2>/dev/null || true
if [ -w "$BIN_DIR" ]; then
  CMD_OWNER=$(grep -o '/[^"]*agent/cli.js' "$BIN_DIR/tmcp" 2>/dev/null | sed 's|/agent/cli.js||' | head -n1)
  if [ -n "$CMD_OWNER" ] && [ "$CMD_OWNER" != "$TARGET_DIR" ] && [ "$FORCE" != 1 ]; then
    warn "保留原有的 $BIN_DIR/tmcp（指向 $CMD_OWNER），未覆盖"
    dim "  想切换请加 --force"
  else
    cat > "$BIN_DIR/tmcp" <<EOF
#!/bin/sh
exec node "$TARGET_DIR/agent/cli.js" "\$@"
EOF
    chmod 755 "$BIN_DIR/tmcp"
    ok "已安装 $BIN_DIR/tmcp"
  fi
else
  warn "$BIN_DIR 不可写，跳过全局命令"
fi

# util-linux 的 script 用于交互式 PTY
if ! command -v script >/dev/null 2>&1; then
  warn "未找到 script（交互式 PTY 需要）"
  if [ "$PLATFORM" = "termux" ]; then dim "  pkg install util-linux"; else dim "  sudo apt install util-linux"; fi
fi

# ---------- 7. 完成 ----------
printf '\n%s%s安装完成%s\n' "$B$G" "" "$R"
printf '  目录    %s\n' "$TARGET_DIR"
printf '  命令    %s\n' "$BIN_DIR/tmcp"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR 不在 PATH 里，请加到 shell 配置：
    echo 'export PATH=\"\$PATH:$BIN_DIR\"' >> ~/.${SHELL##*/}rc" ;;
esac

printf '\n%s下一步%s\n' "$B" "$R"
if [ -f "$HOME/.config/termux-mcp-remote/config.json" ]; then
  ok "检测到已有配置，可直接启动："
  printf '  %stmcp start%s\n' "$C" "$R"
else
  printf '  1) 有配置码的话（推荐）：\n'
  printf '     %stmcp enroll%s   %s然后粘贴后台生成的配置码%s\n' "$C" "$R" "$D" "$R"
  printf '  2) 没有的话手动配置：\n'
  printf '     %stmcp setup%s\n' "$C" "$R"
  printf '  3) 启动：\n'
  printf '     %stmcp start%s\n' "$C" "$R"
fi
printf '\n  后台管理：%shttps://<你的-worker>/admin%s\n' "$D" "$R"
