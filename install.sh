#!/usr/bin/env bash
# Install the `tmcp` command for this checkout.
# Works on Termux / Debian / Ubuntu / any Linux.
#
# Usage / 用法:
#   bash install.sh
#
# Language: follows $LANG (zh* -> Chinese), or force with LANG_FORCE=zh|en
# 语言：跟随 $LANG（zh* 用中文），也可用 LANG_FORCE=zh|en 强制指定
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- language / 语言 ---
case "${LANG_FORCE:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}" in
  zh*|ZH*) ZH=1 ;;
  *)       ZH=0 ;;
esac
say() { if [ "$ZH" = 1 ]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }
ok()  { say "✓ $1" "✓ $2"; }
warn(){ say "! $1" "! $2"; }
bad() { say "✗ $1" "✗ $2"; }

# --- detect platform / 探测环境 ---
if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux ]; then
  PLATFORM="termux"
  BIN_DIR="${PREFIX:-/data/data/com.termux/files/usr}/bin"
else
  PLATFORM="linux"
  if [ -w /usr/local/bin ] 2>/dev/null; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
fi

say "Install dir: $ROOT"  "安装目录: $ROOT"
say "Platform:    $PLATFORM" "平台:     $PLATFORM"
say "Command:     $BIN_DIR/tmcp" "命令路径: $BIN_DIR/tmcp"

# --- Node.js ---
if ! command -v node >/dev/null 2>&1; then
  bad "node not found. Install Node.js >= 20 first:" "未找到 node。请先安装 Node.js >= 20："
  if [ "$PLATFORM" = "termux" ]; then echo "    pkg install nodejs-lts"
  else echo "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"; fi
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  bad "Node.js ${NODE_MAJOR} is too old, need >= 20" "Node.js 版本过低（${NODE_MAJOR}），需要 >= 20"
  exit 1
fi
ok "Node.js $(node -v)" "Node.js $(node -v)"

if [ ! -d "$ROOT/node_modules" ]; then
  say "→ Installing dependencies..." "→ 安装依赖…"
  (cd "$ROOT" && npm install --no-audit --no-fund)
fi

# PTY needs `script` from util-linux
if ! command -v script >/dev/null 2>&1; then
  warn "'script' not found (needed for interactive PTY)" "未找到 script（交互式 PTY 需要）"
  if [ "$PLATFORM" = "termux" ]; then echo "    pkg install util-linux"
  else echo "    sudo apt install util-linux"; fi
fi

# --- write launcher / 写启动器 ---
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/tmcp" <<EOF
#!/bin/sh
exec node "$ROOT/agent/cli.js" "\$@"
EOF
chmod 755 "$BIN_DIR/tmcp"
ok "Installed $BIN_DIR/tmcp" "已安装 $BIN_DIR/tmcp"

# --- record the UI language for tmcp / the agent ---
mkdir -p "$HOME/.config/termux-mcp-remote" 2>/dev/null || true
if [ "$ZH" = 1 ]; then printf 'zh\n'; else printf 'en\n'; fi > "$HOME/.config/termux-mcp-remote/lang" 2>/dev/null || true
chmod 600 "$HOME/.config/termux-mcp-remote/lang" 2>/dev/null || true
ok "UI language: $([ "$ZH" = 1 ] && echo zh || echo en)" "界面语言: $([ "$ZH" = 1 ] && echo 中文 || echo English)"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not in PATH, add it to your shell profile" "$BIN_DIR 不在 PATH 里，请把它加进 shell 配置" ;;
esac

# --- how to keep it running / 后台运行 ---
echo
say "Start with: tmcp start" "启动方式：tmcp start"
if [ "$PLATFORM" = "linux" ]; then
  echo
  say "To start on boot with systemd (template included):" "Linux 上想开机自启，可用 systemd（本项目自带模板）："
  echo "    sudo cp $ROOT/contrib/tmcp.service /etc/systemd/system/"
  echo "    sudo sed -i \"s|__USER__|\$USER|g; s|__ROOT__|$ROOT|g\" /etc/systemd/system/tmcp.service"
  echo "    sudo systemctl daemon-reload && sudo systemctl enable --now tmcp"
fi
ok "Done. Run 'tmcp' to see the menu." "安装完成，运行 tmcp 查看菜单"
