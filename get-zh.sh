#!/usr/bin/env bash
# termux-mcp-remote - 一键安装（中文版）
#
# 用法（任选其一）：
#   curl -fsSL https://gh-proxy.org/https://raw.githubusercontent.com/hahahaoha/termux-mcp-remote/main/get-zh.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/hahahaoha/termux-mcp-remote/main/get-zh.sh | bash
#   bash get-zh.sh                   # 已下载到本地
#
# 参数 / 环境变量：
#   --dir <路径>       安装目录（默认 ~/termux-mcp-remote）
#   --branch <分支>    要安装的 git 分支（默认 main）
#   --mirror <名字>    强制使用某个下载源：codeload | gh-proxy | ghproxy | ghfast | github
#   --no-deps          跳过 npm install
#   --force            接管已指向其他位置的 tmcp 命令
#   TMCP_DIR=...       同 --dir
#   TMCP_BRANCH=...    同 --branch
#   TMCP_MIRROR=...    同 --mirror
#   TMCP_FORCE=1       同 --force
#
# 英文版安装脚本：get.sh
#
# 设计说明：
#   - 通过 `curl | bash` 运行时 stdin 被脚本本身占用，所以本脚本【不读 stdin】。
#     需要交互的步骤（tmcp setup）留给用户装完后自己执行。
#   - 会按顺序尝试多个下载源，适配受限网络。
#   - 幂等：重复运行只更新代码，不动已有配置和 token。
#   - 安全：若已有 tmcp 命令指向另一个安装，脚本会【中止且不修改任何文件】，
#     除非显式加 --force。
set -u

REPO="hahahaoha/termux-mcp-remote"
DEFAULT_DIR="$HOME/termux-mcp-remote"
TARGET_DIR="${TMCP_DIR:-}"
BRANCH="${TMCP_BRANCH:-main}"
MIRROR="${TMCP_MIRROR:-}"
SKIP_DEPS=0

# --force 可来自环境变量或命令行
FORCE=0
if [ "${TMCP_FORCE:-0}" = "1" ]; then FORCE=1; fi

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

usage() {
  cat <<'TXT'
termux-mcp-remote - 一键安装（中文版）

用法：
  curl -fsSL https://gh-proxy.org/https://raw.githubusercontent.com/hahahaoha/termux-mcp-remote/main/get-zh.sh | bash
  bash get-zh.sh [参数]

参数：
  --dir <路径>      安装目录（默认 ~/termux-mcp-remote）
  --branch <分支>   git 分支（默认 main）
  --mirror <名字>   强制使用某个下载源：
                    codeload | gh-proxy | ghproxy | ghfast | github
  --no-deps         跳过 npm install
  --force           接管已指向其他位置的 tmcp 命令
  -h, --help        显示本帮助

环境变量：
  TMCP_DIR, TMCP_BRANCH, TMCP_MIRROR, TMCP_FORCE=1

示例：
  # 全新安装
  bash get-zh.sh

  # 装到自定义位置
  bash get-zh.sh --dir /opt/termux-mcp-remote

  # 原地更新已有安装
  bash get-zh.sh --dir ~/termux-mcp-remote

  # 把已有安装迁到新目录
  bash get-zh.sh --dir /opt/termux-mcp-remote --force
TXT
}

# ---------- 解析参数 ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)      TARGET_DIR="${2:-}"; shift 2 ;;
    --branch)   BRANCH="${2:-}"; shift 2 ;;
    --mirror)   MIRROR="${2:-}"; shift 2 ;;
    --no-deps)  SKIP_DEPS=1; shift ;;
    --force)    FORCE=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done
[ -n "$TARGET_DIR" ] || TARGET_DIR="$DEFAULT_DIR"

printf '%s\n' "${B}${M}termux-mcp-remote${R} ${D}中文安装脚本${R}"
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
ok "平台 $PLATFORM，命令将安装到 $BIN_DIR"

for c in curl tar; do
  command -v "$c" >/dev/null 2>&1 || die "缺少 $c，请先安装：
  Termux: pkg install curl tar
  Debian: sudo apt install curl tar"
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
    dim "正在尝试：pkg install nodejs-lts（可能需要一会儿）…"
    if command -v pkg >/dev/null 2>&1; then
      pkg install -y nodejs-lts >/dev/null 2>&1 || true
    fi
    if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; then
      ok "已安装 Node.js $(node -v)"
    else
      die "请手动执行：pkg install nodejs-lts，然后重新运行本脚本"
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
  EXISTING_CMD=$(grep -o '/[^"]*agent/cli.js' "$BIN_DIR/tmcp" 2>/dev/null | sed 's|/agent/cli.js||' | head -n1)
fi

if [ -n "$EXISTING_CMD" ] && [ "$EXISTING_CMD" != "$TARGET_DIR" ]; then
  warn "已存在另一个安装："
  dim "  命令     $BIN_DIR/tmcp -> $EXISTING_CMD"
  dim "  本次安装 $TARGET_DIR"
  if [ "$FORCE" != 1 ]; then
    printf '\n%s不会覆盖现有的 tmcp 命令。%s\n' "$Y" "$R"
    printf '  想迁移到新目录，请加 --force（或先删除旧命令）：\n'
    printf '    %srm -f %s/tmcp%s\n' "$C" "$BIN_DIR" "$R"
    printf '  只想更新现有安装，请改用：\n'
    printf '    %sbash get-zh.sh --dir %s%s\n\n' "$C" "$EXISTING_CMD" "$R"
    die "已中止，未修改任何文件"
  fi
  warn "--force：tmcp 命令将切换到新目录"
fi

# 有实例在跑时提醒
RUNNING_PID=""
PIDFILE="$HOME/.config/termux-mcp-remote/state/agent.pid"
if [ -f "$PIDFILE" ]; then
  P=$(tr -dc '0-9' < "$PIDFILE")
  if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then RUNNING_PID="$P"; fi
fi
if [ -n "$RUNNING_PID" ]; then
  warn "检测到 Agent 正在运行（pid=$RUNNING_PID）"
  dim "  将更新代码但不会重启服务；装完请执行 tmcp restart"
fi

# ---------- 4. 下载 ----------
step "下载代码"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/tmcp-install-XXXXXX") || die "无法创建临时目录"
trap 'rm -rf "$TMP"' EXIT

TARBALL="$TMP/repo.tar.gz"
GOT=0
try_mirror() {
  local name="$1" url="$2"
  if [ -n "$MIRROR" ] && [ "$MIRROR" != "$name" ]; then return 1; fi
  printf '%s  尝试 %s%s\n' "$D" "$name" "$R"
  if curl -fsSL --connect-timeout 12 --max-time 180 -o "$TARBALL" "$url" 2>/dev/null; then
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
# gh-proxy 放第一位：受限网络下最快（约 0.9 秒），缓存只有 60 秒。
# codeload（GitHub 直连）作为备选。
# jsDelivr 不能提供 tarball（对 @main 会 404）且分支缓存 12 小时，这里完全不使用。
try_mirror "gh-proxy" "https://gh-proxy.org/https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || \
try_mirror "codeload" "https://codeload.github.com/$REPO/tar.gz/refs/heads/$ENC_BRANCH" || \
try_mirror "ghproxy"  "https://ghproxy.net/https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || \
try_mirror "ghfast"   "https://ghfast.top/https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || \
try_mirror "github"   "https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || true

if [ "$GOT" = 0 ]; then
  if [ -n "$MIRROR" ]; then die "指定的下载源 '$MIRROR' 失败"; fi
  if command -v git >/dev/null 2>&1; then
    dim "  回退到 git clone…"
    rm -rf "$TMP/src"
    if git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$TMP/src" >/dev/null 2>&1; then
      ok "已用 git 克隆"
      GOT=2
    fi
  fi
  [ "$GOT" != 0 ] || die "所有下载源都失败了。请检查网络，或手动 clone 后运行 bash install.sh"
fi

# ---------- 5. 解包 ----------
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
[ -f "$SRC/package.json" ] || die "压缩包里没有 package.json，下载源可能返回了错误页"

mkdir -p "$TARGET_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude 'node_modules' --exclude '.git' --exclude 'logs' \
        --exclude 'run' --exclude 'state' "$SRC"/ "$TARGET_DIR"/ || die "复制文件失败"
else
  (cd "$SRC" && find . -mindepth 1 -maxdepth 1 \
      ! -name node_modules ! -name .git ! -name logs ! -name run ! -name state \
      -exec cp -R {} "$TARGET_DIR"/ \; ) || die "复制文件失败"
fi
chmod +x "$TARGET_DIR/bin/tmcp" "$TARGET_DIR/install.sh" 2>/dev/null || true
ok "代码已就位"

# ---------- 6. 依赖 ----------
if [ "$SKIP_DEPS" = 0 ]; then
  step "安装依赖"
  if [ -f "$TARGET_DIR/node_modules/zod/package.json" ]; then
    ok "依赖已存在，跳过"
  else
    dim "  npm install（首次会慢一些）…"
    if (cd "$TARGET_DIR" && npm install --no-audit --no-fund --omit=dev >/dev/null 2>&1); then
      ok "依赖安装完成"
    else
      warn "npm install 失败；可稍后在 $TARGET_DIR 手动执行 npm install"
    fi
  fi
else
  warn "已跳过依赖安装（--no-deps）"
fi

# ---------- 7. 注册 tmcp 命令 ----------
step "安装 tmcp 命令"
mkdir -p "$BIN_DIR" 2>/dev/null || true
if [ -w "$BIN_DIR" ]; then
  CMD_OWNER=$(grep -o '/[^"]*agent/cli.js' "$BIN_DIR/tmcp" 2>/dev/null | sed 's|/agent/cli.js||' | head -n1)
  if [ -n "$CMD_OWNER" ] && [ "$CMD_OWNER" != "$TARGET_DIR" ] && [ "$FORCE" != 1 ]; then
    warn "保留原有的 $BIN_DIR/tmcp（指向 $CMD_OWNER），未覆盖"
    dim "  需要切换请加 --force"
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

if ! command -v script >/dev/null 2>&1; then
  warn "未找到 script（交互式 PTY 需要）"
  if [ "$PLATFORM" = "termux" ]; then dim "  pkg install util-linux"; else dim "  sudo apt install util-linux"; fi
fi

# ---------- 8. 完成 ----------
printf '\n%s%s安装完成%s\n' "$B$G" "" "$R"
printf '  目录  %s\n' "$TARGET_DIR"
printf '  命令  %s\n' "$BIN_DIR/tmcp"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR 不在 PATH 中。请加入 shell 配置：
    echo 'export PATH=\"\$PATH:$BIN_DIR\"' >> ~/.${SHELL##*/}rc" ;;
esac

printf '\n%s下一步%s\n' "$B" "$R"
if [ -f "$HOME/.config/termux-mcp-remote/config.json" ]; then
  ok "检测到已有配置，直接启动即可："
  printf '  %stmcp start%s\n' "$C" "$R"
else
  printf '  1) 有配置码的话（推荐）：\n'
  printf '     %stmcp enroll%s   %s（粘贴后台生成的配置码）%s\n' "$C" "$R" "$D" "$R"
  printf '  2) 否则手动配置：\n'
  printf '     %stmcp setup%s\n' "$C" "$R"
  printf '  3) 启动：\n'
  printf '     %stmcp start%s\n' "$C" "$R"
fi
printf '\n  后台管理：%shttps://<你的-worker>/admin%s\n' "$D" "$R"
