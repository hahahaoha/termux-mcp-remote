#!/usr/bin/env bash
# termux-mcp-remote - 一键安装（中文版）
#
# 用法（任选其一）：
#   curl -fsSL https://gh-proxy.org/https://raw.githubusercontent.com/hahahaoha/termux-mcp-remote/main/get-zh.sh | bash
#   bash get-zh.sh                   # 已下载到本地
#
# 参数 / 环境变量：
#   --dir <路径>       安装目录（默认 ~/termux-mcp-remote）
#   --branch <分支>    要安装的 git 分支（默认 main）
#   --mirror <名字>    强制某个下载源：codeload | gh-proxy | ghproxy | ghfast | github
#   --no-deps          跳过 npm install
#   --no-system-deps   不动系统包，只提示缺什么
#   --force            接管已指向其他位置的 tmcp 命令
#   TMCP_DIR / TMCP_BRANCH / TMCP_MIRROR / TMCP_FORCE=1
#   TMCP_DRY_RUN=1     只预览会装什么，不真正改动
#
# 英文版安装脚本：get.sh
#
# 设计说明：
#   - 通过 `curl | bash` 运行时 stdin 被脚本占用，所以本脚本【不读 stdin】。
#   - 会自动安装系统依赖（curl / tar / node>=20 / util-linux），
#     Linux 上发行版自带的 Node 太旧时会用 nvm 装到用户目录，不需要 root。
#   - 会按顺序尝试多个下载源，适配受限网络。
#   - 安全：若已有 tmcp 命令指向另一个安装，脚本会【中止且不修改任何文件】，
#     除非显式加 --force。
set -u

REPO="hahahaoha/termux-mcp-remote"
DEFAULT_DIR="$HOME/termux-mcp-remote"
TARGET_DIR="${TMCP_DIR:-}"
BRANCH="${TMCP_BRANCH:-main}"
MIRROR="${TMCP_MIRROR:-}"
SKIP_DEPS=0
NO_SYSTEM_DEPS=0
DRY_RUN="${TMCP_DRY_RUN:-}"
FORCE=0
if [ "${TMCP_FORCE:-0}" = "1" ]; then FORCE=1; fi

# ---------- 彩色输出（非 TTY 自动关闭） ----------
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
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'TXT'
termux-mcp-remote - 一键安装（中文版）

用法：
  curl -fsSL https://gh-proxy.org/https://raw.githubusercontent.com/hahahaoha/termux-mcp-remote/main/get-zh.sh | bash
  bash get-zh.sh [参数]

参数：
  --dir <路径>      安装目录（默认 ~/termux-mcp-remote）
  --branch <分支>   git 分支（默认 main）
  --mirror <名字>   强制某个下载源：codeload | gh-proxy | ghproxy | ghfast | github
  --no-deps         跳过 npm install
  --no-system-deps  不动系统包，只提示缺什么
  --force           接管已指向其他位置的 tmcp 命令
  -h, --help        显示本帮助

环境变量：
  TMCP_DIR, TMCP_BRANCH, TMCP_MIRROR, TMCP_FORCE=1, TMCP_DRY_RUN=1

示例：
  bash get-zh.sh                               # 全新安装
  bash get-zh.sh --dir /opt/termux-mcp-remote  # 装到指定位置
  bash get-zh.sh --dir ~/termux-mcp-remote     # 原地更新
  bash get-zh.sh --no-system-deps              # 我自己管包
TXT
}

# ---------- 解析参数 ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)            TARGET_DIR="${2:-}"; shift 2 ;;
    --branch)         BRANCH="${2:-}"; shift 2 ;;
    --mirror)         MIRROR="${2:-}"; shift 2 ;;
    --no-deps)        SKIP_DEPS=1; shift ;;
    --no-system-deps) NO_SYSTEM_DEPS=1; shift ;;
    --force)          FORCE=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done
[ -n "$TARGET_DIR" ] || TARGET_DIR="$DEFAULT_DIR"

printf '%s\n' "${B}${M}termux-mcp-remote${R} ${D}中文安装脚本${R}"
dim "仓库: $REPO  分支: $BRANCH"
[ -n "$DRY_RUN" ] && warn "预览模式：不会真正安装"

# ---------- 1. 平台与包管理器 ----------
step "识别平台"
if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux ]; then
  PLATFORM="termux"
  BIN_DIR="${PREFIX:-/data/data/com.termux/files/usr}/bin"
elif [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
  PLATFORM="mac"
  if [ -w /usr/local/bin ] 2>/dev/null; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
elif have apt-get; then
  PLATFORM="debian"
  if [ -w /usr/local/bin ] 2>/dev/null; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
elif have apk; then
  PLATFORM="alpine"
  if [ -w /usr/local/bin ] 2>/dev/null; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
elif have dnf; then
  PLATFORM="fedora"
  if [ -w /usr/local/bin ] 2>/dev/null; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
elif have pacman; then
  PLATFORM="arch"
  if [ -w /usr/local/bin ] 2>/dev/null; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
elif have zypper; then
  PLATFORM="suse"
  if [ -w /usr/local/bin ] 2>/dev/null; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
else
  PLATFORM="unknown"
  if [ -w /usr/local/bin ] 2>/dev/null; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
fi

SUDO=""
if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
  SUDO=""
elif have sudo && sudo -n true >/dev/null 2>&1; then
  SUDO="sudo -n"
fi

ok "平台 $PLATFORM，命令将安装到 $BIN_DIR"

PM_LABEL="包管理器"
case "$PLATFORM" in
  termux) PM_LABEL="pkg" ;; debian) PM_LABEL="apt" ;; alpine) PM_LABEL="apk" ;;
  fedora) PM_LABEL="dnf" ;; arch) PM_LABEL="pacman" ;; suse) PM_LABEL="zypper" ;;
  mac) PM_LABEL="brew" ;;
esac

pm_install() {
  if [ "$NO_SYSTEM_DEPS" = 1 ]; then
    return 1
  fi
  if [ -n "$DRY_RUN" ]; then
    dim "  [预览] 将执行安装: $*"
    return 0
  fi
  # 关键：所有包管理器都 </dev/null。
  # 通过 `curl | bash` 跑时 stdin 就是脚本本身，包管理器一旦读 stdin
  # 就会把脚本内容当输入吃掉，表现为“卡住不动”。
  printf '%s  正在执行: %s %s%s\n' "$D" "$PM_LABEL" "$*" "$R"
  case "$PLATFORM" in
    termux) pkg install -y "$@" </dev/null ;;
    debian) { [ -n "$SUDO" ] || [ "$(id -u)" = "0" ]; } || return 1
            $SUDO apt-get update -qq </dev/null
            DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y \
              -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
              "$@" </dev/null ;;
    alpine) $SUDO apk add --no-cache "$@" </dev/null ;;
    fedora) $SUDO dnf install -y "$@" </dev/null ;;
    arch)   $SUDO pacman -Sy --noconfirm --needed "$@" </dev/null ;;
    suse)   $SUDO zypper -n install -y "$@" </dev/null ;;
    mac)    have brew && HOMEBREW_NO_AUTO_UPDATE=1 brew install "$@" </dev/null ;;
    *) return 1 ;;
  esac
}

# ---------- 2. curl + tar ----------
step "检查基础工具"
MISSING=""
for c in curl tar; do have "$c" || MISSING="$MISSING $c"; done
if [ -n "$MISSING" ]; then
  warn "缺少:$MISSING"
  if pm_install $MISSING; then
    ok "已安装:$MISSING"
  else
    die "无法自动安装$MISSING。请手动安装后重试：
  Termux: pkg install curl tar
  Debian: sudo apt install curl tar
  Alpine: sudo apk add curl tar"
  fi
fi
if [ -z "$DRY_RUN" ]; then
  have curl || die "安装后仍找不到 curl，已中止"
  have tar  || die "安装后仍找不到 tar，已中止"
fi
ok "curl 与 tar 可用"

# ---------- 3. Node.js ----------
step "检查 Node.js"
node_ok() {
  have node || return 1
  local v
  v=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$v" -ge 20 ] 2>/dev/null
}

if node_ok; then
  ok "Node.js $(node -v)"
else
  if have node; then warn "Node.js $(node -v 2>/dev/null || echo '?') 版本过低，需要 >= 20"; else warn "未找到 Node.js"; fi

  dim "  需要 Node.js，下载可能要几分钟，请耐心等待…"
  case "$PLATFORM" in
    termux) pm_install nodejs-lts || pm_install nodejs ;;
    mac)    pm_install node ;;
    *)      pm_install nodejs npm || pm_install node ;;
  esac

  if node_ok; then
    ok "已安装 Node.js $(node -v)"
  elif [ -n "$DRY_RUN" ]; then
    ok "将会安装 Node.js >= 20（发行版太旧时用 nvm）"
  else
    warn "系统 Node 仍不可用，改用 nvm 安装到用户目录（不需要 root）"
    export NVM_DIR="$HOME/.nvm"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      dim "  正在下载 nvm 安装器（约 10 秒）…"
      for u in \
        "https://gh-proxy.org/https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh" \
        "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh"; do
        if curl -fsSL --connect-timeout 10 --max-time 60 "$u" 2>/dev/null | bash >/dev/null 2>&1; then
          break
        fi
      done
    fi
    if [ -s "$NVM_DIR/nvm.sh" ]; then
      . "$NVM_DIR/nvm.sh"
      dim "  正在通过 nvm 下载 Node.js（约 25 MB），请等待…"
      nvm install 22 </dev/null || true
      NB="$(dirname "$(nvm which 22 2>/dev/null || echo "")" 2>/dev/null || true)"
      [ -n "$NB" ] && [ -d "$NB" ] && PATH="$NB:$PATH"
    fi
    if node_ok; then
      ok "已通过 nvm 安装 Node.js $(node -v)"
      warn "nvm 在 $HOME/.nvm；tmcp 会直接用 $NB/node，无需配置 shell"
    else
      die "无法自动获得 Node.js >= 20，请手动安装：
  Debian/Ubuntu: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
  或 nvm:        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22
  Termux:        pkg install nodejs-lts"
    fi
  fi
fi

NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm 2>/dev/null || true)"
if [ -z "$NPM_BIN" ]; then
  warn "找不到 npm，尝试用包管理器安装"
  pm_install npm || true
  NPM_BIN="$(command -v npm 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ] && [ -z "$DRY_RUN" ]; then
  die "无法确定 node 的路径"
fi

# ---------- 4. util-linux（交互式 PTY） ----------
step "检查 util-linux（交互式 shell 需要）"
if have script; then
  ok "script 可用"
else
  warn "未找到 script，shell_* 系列工具将不可用"
  if pm_install util-linux; then
    if [ -n "$DRY_RUN" ]; then
      ok "将会安装 util-linux"
    elif have script; then
      ok "已安装 util-linux"
    else
      warn "util-linux 没有装成功"
    fi
  else
    dim "  需要时可稍后安装："
    case "$PLATFORM" in
      termux) dim "    pkg install util-linux" ;;
      debian) dim "    sudo apt install util-linux" ;;
      alpine) dim "    sudo apk add util-linux" ;;
      *)      dim "    安装你发行版里的 util-linux 包" ;;
    esac
  fi
fi

# ---------- 预览模式到此为止 ----------
if [ -n "$DRY_RUN" ]; then
  printf '\n%s预览结果%s\n' "$B" "$R"
  printf '  安装目录 : %s\n' "$TARGET_DIR"
  printf '  命令     : %s/tmcp\n' "$BIN_DIR"
  printf '  node     : %s\n' "$(command -v node 2>/dev/null || echo '(将会安装)')"
  printf '  下一步   : 去掉 TMCP_DRY_RUN=1 即可真正安装\n'
  exit 0
fi

# ---------- 5. 检查已有安装 ----------
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

# ---------- 6. 下载 ----------
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
# gh-proxy 放第一位：受限网络下最快（约 1 秒），缓存只有 60 秒。
try_mirror "gh-proxy" "https://gh-proxy.org/https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || \
try_mirror "codeload" "https://codeload.github.com/$REPO/tar.gz/refs/heads/$ENC_BRANCH" || \
try_mirror "ghproxy"  "https://ghproxy.net/https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || \
try_mirror "ghfast"   "https://ghfast.top/https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || \
try_mirror "github"   "https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || true

if [ "$GOT" = 0 ]; then
  if [ -n "$MIRROR" ]; then die "指定的下载源 '$MIRROR' 失败"; fi
  if ! have git; then
    dim "  未找到 git，尝试安装以便用 clone 兜底…"
    pm_install git || true
  fi
  if have git; then
    dim "  回退到 git clone…"
    rm -rf "$TMP/src"
    if git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$TMP/src" >/dev/null 2>&1; then
      ok "已用 git 克隆"
      GOT=2
    fi
  fi
  [ "$GOT" != 0 ] || die "所有下载源都失败了。请检查网络，或手动 clone 后运行 bash install.sh"
fi

# ---------- 7. 解包 ----------
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
if have rsync; then
  rsync -a --exclude 'node_modules' --exclude '.git' --exclude 'logs' \
        --exclude 'run' --exclude 'state' "$SRC"/ "$TARGET_DIR"/ || die "复制文件失败"
else
  (cd "$SRC" && find . -mindepth 1 -maxdepth 1 \
      ! -name node_modules ! -name .git ! -name logs ! -name run ! -name state \
      -exec cp -R {} "$TARGET_DIR"/ \; ) || die "复制文件失败"
fi
chmod +x "$TARGET_DIR/bin/tmcp" "$TARGET_DIR/install.sh" 2>/dev/null || true
ok "代码已就位"

# ---------- 8. npm 依赖 ----------
if [ "$SKIP_DEPS" = 0 ]; then
  step "安装 npm 依赖"
  if [ -f "$TARGET_DIR/node_modules/zod/package.json" ]; then
    ok "依赖已存在，跳过"
  elif [ -z "$NPM_BIN" ]; then
    warn "没有 npm，跳过（稍后可在 $TARGET_DIR 手动 npm install）"
  else
    dim "  npm install（首次会慢一些）…"
    if (cd "$TARGET_DIR" && "$NPM_BIN" install --no-audit --no-fund --omit=dev </dev/null >/dev/null 2>&1); then
      ok "依赖安装完成"
    else
      warn "npm install 失败；可稍后在 $TARGET_DIR 手动执行"
    fi
  fi
else
  warn "已跳过 npm install（--no-deps）"
fi

# ---------- 9. 注册 tmcp 命令 ----------
step "安装 tmcp 命令"
mkdir -p "$BIN_DIR" 2>/dev/null || true
if [ -w "$BIN_DIR" ]; then
  CMD_OWNER=$(grep -o '/[^"]*agent/cli.js' "$BIN_DIR/tmcp" 2>/dev/null | sed 's|/agent/cli.js||' | head -n1)
  if [ -n "$CMD_OWNER" ] && [ "$CMD_OWNER" != "$TARGET_DIR" ] && [ "$FORCE" != 1 ]; then
    warn "保留原有的 $BIN_DIR/tmcp（指向 $CMD_OWNER），未覆盖"
    dim "  需要切换请加 --force"
  else
    {
      echo '#!/bin/sh'
      echo "exec \"$NODE_BIN\" \"$TARGET_DIR/agent/cli.js\" \"\$@\""
    } > "$BIN_DIR/tmcp"
    chmod 755 "$BIN_DIR/tmcp"
    ok "已安装 $BIN_DIR/tmcp"
    dim "  启动器使用的 node：$NODE_BIN"
  fi
else
  warn "$BIN_DIR 不可写，跳过全局命令"
fi

# ---------- 10. 记录界面语言 ----------
LANG_DIR="$HOME/.config/termux-mcp-remote"
mkdir -p "$LANG_DIR" 2>/dev/null || true
printf 'zh\n' > "$LANG_DIR/lang" 2>/dev/null && chmod 600 "$LANG_DIR/lang" 2>/dev/null || true
ok "界面语言已设为中文（可随时用 tmcp lang en 切换）"

# ---------- 11. 完成 ----------
printf '\n%s%s安装完成%s\n' "$B$G" "" "$R"
printf '  目录  %s\n' "$TARGET_DIR"
printf '  命令  %s\n' "$BIN_DIR/tmcp"
printf '  node  %s\n' "$NODE_BIN"
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
