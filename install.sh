#!/usr/bin/env bash
# Install the `tmcp` command for this checkout, installing missing
# prerequisites automatically where possible.
#
# Usage / 用法:  bash install.sh
# Language / 语言: follows $LANG (zh* -> Chinese), or LANG_FORCE=zh|en
# Dry run / 预览:  TMCP_DRY_RUN=1 bash install.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- language ---
case "${LANG_FORCE:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}" in
  zh*|ZH*) ZH=1 ;;
  *)       ZH=0 ;;
esac
say() { if [ "$ZH" = 1 ]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }
ok()  { say "✓ $1" "✓ $2"; }
warn(){ say "! $1" "! $2"; }
bad() { say "✗ $1" "✗ $2"; }
have(){ command -v "$1" >/dev/null 2>&1; }
DRY_RUN="${TMCP_DRY_RUN:-}"

# --- platform ---
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
else
  PLATFORM="unknown"
  if [ -w /usr/local/bin ] 2>/dev/null; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
fi

SUDO=""
if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then SUDO=""
elif have sudo && sudo -n true >/dev/null 2>&1; then SUDO="sudo -n"; fi

say "Install dir: $ROOT"  "安装目录: $ROOT"
say "Platform:    $PLATFORM" "平台:     $PLATFORM"
say "Command:     $BIN_DIR/tmcp" "命令路径: $BIN_DIR/tmcp"
[ -n "$DRY_RUN" ] && warn "dry run, nothing will change" "预览模式，不会真正改动"

pm_install() {
  [ -n "$DRY_RUN" ] && { say "  would install: $*" "  [预览] 将安装: $*"; return 0; }
  # everything gets </dev/null: under `curl | bash` stdin is the script itself
  say "  running: $*" "  正在执行: $*"
  case "$PLATFORM" in
    termux) pkg install -y "$@" </dev/null ;;
    debian) { [ -n "$SUDO" ] || [ "$(id -u)" = "0" ]; } || return 1
            $SUDO apt-get update -qq </dev/null
            DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y "$@" </dev/null ;;
    alpine) $SUDO apk add --no-cache "$@" </dev/null ;;
    fedora) $SUDO dnf install -y "$@" </dev/null ;;
    arch)   $SUDO pacman -Sy --noconfirm --needed "$@" </dev/null ;;
    mac)    have brew && HOMEBREW_NO_AUTO_UPDATE=1 brew install "$@" </dev/null ;;
    *) return 1 ;;
  esac
}

# --- Node.js ---
node_ok() {
  have node || return 1
  [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ] 2>/dev/null
}

if ! node_ok; then
  if have node; then
    warn "Node.js $(node -v) is too old, need >= 20" "Node.js $(node -v) 版本过低，需要 >= 20"
  else
    warn "Node.js not found, installing..." "未找到 Node.js，正在安装…"
  fi
  case "$PLATFORM" in
    termux) pm_install nodejs-lts || pm_install nodejs ;;
    mac)    pm_install node ;;
    *)      pm_install nodejs npm || pm_install node ;;
  esac

  if ! node_ok && [ -z "$DRY_RUN" ]; then
    warn "falling back to nvm (installs into \$HOME, no root needed)" "改用 nvm 安装到用户目录（不需要 root）"
    export NVM_DIR="$HOME/.nvm"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      for u in \
        "https://gh-proxy.org/https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh" \
        "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh"; do
        if curl -fsSL --connect-timeout 15 --max-time 180 "$u" 2>/dev/null | bash >/dev/null 2>&1; then break; fi
      done
    fi
    if [ -s "$NVM_DIR/nvm.sh" ]; then
      . "$NVM_DIR/nvm.sh"
      nvm install 22 >/dev/null 2>&1 || true
      NB="$(dirname "$(nvm which 22 2>/dev/null || echo "")" 2>/dev/null || true)"
      [ -n "$NB" ] && [ -d "$NB" ] && PATH="$NB:$PATH"
    fi
  fi
fi

if node_ok; then
  ok "Node.js $(node -v)" "Node.js $(node -v)"
elif [ -n "$DRY_RUN" ]; then
  ok "would install Node.js >= 20" "将会安装 Node.js >= 20"
else
  bad "cannot get Node.js >= 20. Install it manually:
  Debian/Ubuntu: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
  Termux:        pkg install nodejs-lts" "无法获得 Node.js >= 20，请手动安装：
  Debian/Ubuntu: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
  Termux:        pkg install nodejs-lts"
  exit 1
fi

# --- util-linux ---
if ! have script; then
  warn "'script' not found, installing util-linux..." "未找到 script，正在安装 util-linux…"
  pm_install util-linux || true
  if have script; then
    ok "util-linux installed" "util-linux 已安装"
  else
    warn "install it later if you need shell_* tools" "需要交互式 shell 时请自行安装 util-linux"
  fi
else
  ok "'script' available" "script 可用"
fi

# --- npm deps ---
if [ ! -d "$ROOT/node_modules" ]; then
  if [ -n "$DRY_RUN" ]; then
    say "→ would run npm install" "→ 将执行 npm install"
  else
    say "→ Installing dependencies..." "→ 安装依赖…"
    (cd "$ROOT" && npm install --no-audit --no-fund </dev/null) || {
      warn "npm install failed" "npm install 失败"
    }
  fi
fi

# --- launcher ---
NODE_BIN="$(command -v node 2>/dev/null || echo node)"
if [ -z "$DRY_RUN" ]; then
  mkdir -p "$BIN_DIR"
  {
    echo '#!/bin/sh'
    echo "exec \"$NODE_BIN\" \"$ROOT/agent/cli.js\" \"\$@\""
  } > "$BIN_DIR/tmcp"
  chmod 755 "$BIN_DIR/tmcp"
  ok "Installed $BIN_DIR/tmcp" "已安装 $BIN_DIR/tmcp"
  say "  launcher uses: $NODE_BIN" "  启动器使用的 node：$NODE_BIN"
fi

# --- UI language ---
if [ -z "$DRY_RUN" ]; then
  mkdir -p "$HOME/.config/termux-mcp-remote" 2>/dev/null || true
  if [ "$ZH" = 1 ]; then printf 'zh\n'; else printf 'en\n'; fi > "$HOME/.config/termux-mcp-remote/lang" 2>/dev/null || true
  chmod 600 "$HOME/.config/termux-mcp-remote/lang" 2>/dev/null || true
  ok "UI language: $([ "$ZH" = 1 ] && echo zh || echo en)" "界面语言: $([ "$ZH" = 1 ] && echo 中文 || echo English)"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not in PATH" "$BIN_DIR 不在 PATH 里，请加入 shell 配置" ;;
esac

echo
say "Start with: tmcp start" "启动方式：tmcp start"
if [ "$PLATFORM" = "linux" ] || [ "$PLATFORM" = "debian" ]; then
  say "systemd template: contrib/tmcp.service" "systemd 模板：contrib/tmcp.service"
fi
ok "Done. Run 'tmcp' to see the menu." "安装完成，运行 tmcp 查看菜单"
