#!/usr/bin/env bash
# 安装 tmcp 命令：自动适配 Termux / Debian / Ubuntu / 其他 Linux
# 用法：bash install.sh
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- 探测环境 ---
if [ -n "$TERMUX_VERSION" ] || [ -d /data/data/com.termux ]; then
  PLATFORM="termux"
  BIN_DIR="${PREFIX:-/data/data/com.termux/files/usr}/bin"
else
  PLATFORM="linux"
  # 优先用户目录，避免要 root
  if [ -w /usr/local/bin ] 2>/dev/null; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
fi

echo "安装目录: $ROOT"
echo "平台:     $PLATFORM"
echo "命令路径: $BIN_DIR/tmcp"

# --- 依赖检查 ---
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未找到 node。请先安装 Node.js >= 20："
  if [ "$PLATFORM" = "termux" ]; then echo "    pkg install nodejs-lts"; else echo "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"; fi
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node.js 版本过低（${NODE_MAJOR}），需要 >= 20"
  exit 1
fi
echo "✓ Node.js $(node -v)"

if [ ! -d "$ROOT/node_modules" ]; then
  echo "→ 安装依赖…"
  (cd "$ROOT" && npm install --no-audit --no-fund)
fi

# PTY 需要 util-linux 的 script 命令
if ! command -v script >/dev/null 2>&1; then
  echo "! 未找到 script（交互式 PTY 需要）"
  if [ "$PLATFORM" = "termux" ]; then echo "    pkg install util-linux"
  else echo "    sudo apt install util-linux"; fi
fi

# --- 写启动器 ---
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/tmcp" <<EOF
#!/usr/bin/env bash
exec node "$ROOT/agent/cli.js" "\$@"
EOF
chmod 755 "$BIN_DIR/tmcp"
echo "✓ 已安装 $BIN_DIR/tmcp"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "! $BIN_DIR 不在 PATH 里，请把它加进 shell 配置" ;;
esac

# --- 后台运行提示（不同平台方式不同） ---
echo
echo "启动方式：tmcp start"
if [ "$PLATFORM" = "linux" ]; then
  echo
  echo "Linux 上想开机自启，可用 systemd（本项目自带模板）："
  echo "    sudo cp $ROOT/contrib/tmcp.service /etc/systemd/system/"
  echo "    sudo sed -i \"s|__USER__|\$USER|g; s|__ROOT__|$ROOT|g\" /etc/systemd/system/tmcp.service"
  echo "    sudo systemctl daemon-reload && sudo systemctl enable --now tmcp"
fi
echo "✓ 安装完成，运行 tmcp 查看菜单"
