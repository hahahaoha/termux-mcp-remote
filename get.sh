#!/usr/bin/env bash
# termux-mcp-remote - one-line installer
#
# Usage (pick one):
#   curl -fsSL https://cdn.jsdelivr.net/gh/hahahaoha/termux-mcp-remote@main/get.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/hahahaoha/termux-mcp-remote/main/get.sh | bash
#   bash get.sh                      # already downloaded
#
# Options / environment variables:
#   --dir <path>        install directory (default: ~/termux-mcp-remote)
#   --branch <name>     git branch to install (default: main)
#   --mirror <name>     force one download source:
#                       codeload | ghproxy | ghfast | github
#   --no-deps           skip npm install
#   --force             take over a tmcp command that points elsewhere
#   TMCP_DIR=...        same as --dir
#   TMCP_BRANCH=...     same as --branch
#   TMCP_MIRROR=...     same as --mirror
#   TMCP_FORCE=1        same as --force
#
# Chinese version of this installer: get-zh.sh
#
# Design notes:
#   - When executed as `curl | bash`, stdin is consumed by the script itself,
#     so this script never reads stdin. Interactive steps (tmcp setup) are
#     left for the user to run afterwards.
#   - Several download mirrors are tried in order, so it works behind
#     restrictive networks.
#   - Idempotent: re-running only updates code; it never touches the existing
#     config file or tokens.
#   - Safety: if a tmcp command already points at a different installation,
#     the script aborts WITHOUT modifying anything, unless --force is given.
set -u

REPO="hahahaoha/termux-mcp-remote"
DEFAULT_DIR="$HOME/termux-mcp-remote"
TARGET_DIR="${TMCP_DIR:-}"
BRANCH="${TMCP_BRANCH:-main}"
MIRROR="${TMCP_MIRROR:-}"
SKIP_DEPS=0

# --force can come from the environment or from the command line
FORCE=0
if [ "${TMCP_FORCE:-0}" = "1" ]; then FORCE=1; fi

# ---------- colored output (auto-disabled when not a TTY) ----------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'
  G=$'\033[32m'; Y=$'\033[33m'; RED=$'\033[31m'; C=$'\033[36m'; M=$'\033[35m'
else
  B=""; D=""; R=""; G=""; Y=""; RED=""; C=""; M=""
fi
step() { printf '\n%s> %s%s\n' "$B$M" "$1" "$R"; }
ok()   { printf '%s[ok]%s %s\n' "$G" "$R" "$1"; }
warn() { printf '%s[!]%s %s\n' "$Y" "$R" "$1"; }
die()  { printf '%s[x]%s %s\n' "$RED" "$R" "$1" >&2; exit 1; }
dim()  { printf '%s%s%s\n' "$D" "$1" "$R"; }

usage() {
  cat <<'TXT'
termux-mcp-remote - one-line installer

Usage:
  curl -fsSL https://cdn.jsdelivr.net/gh/hahahaoha/termux-mcp-remote@main/get.sh | bash
  bash get.sh [options]

Options:
  --dir <path>      Install directory (default: ~/termux-mcp-remote)
  --branch <name>   Git branch (default: main)
  --mirror <name>   Force one download source:
                    codeload | ghproxy | ghfast | github
  --no-deps         Skip npm install
  --force           Take over a tmcp command pointing at another install
  --lang <en|zh>    Chinese output: use get-zh.sh instead
  -h, --help        Show this help

Environment:
  TMCP_DIR, TMCP_BRANCH, TMCP_MIRROR, TMCP_FORCE=1

Examples:
  # fresh install
  bash get.sh

  # custom location
  bash get.sh --dir /opt/termux-mcp-remote

  # update an existing install in place
  bash get.sh --dir ~/termux-mcp-remote

  # move an existing install to a new directory
  bash get.sh --dir /opt/termux-mcp-remote --force
TXT
}

# ---------- parse arguments ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)      TARGET_DIR="${2:-}"; shift 2 ;;
    --branch)   BRANCH="${2:-}"; shift 2 ;;
    --mirror)   MIRROR="${2:-}"; shift 2 ;;
    --no-deps)  SKIP_DEPS=1; shift ;;
    --force)    FORCE=1; shift ;;
    --lang)
      case "${2:-}" in
        zh*) die "Chinese output lives in get-zh.sh. Use:
  curl -fsSL https://cdn.jsdelivr.net/gh/hahahaoha/termux-mcp-remote@main/get-zh.sh | bash" ;;
        *) shift 2 ;;
      esac ;;
    -h|--help)  usage; exit 0 ;;
    *) die "Unknown argument: $1 (use --help)" ;;
  esac
done
[ -n "$TARGET_DIR" ] || TARGET_DIR="$DEFAULT_DIR"

printf '%s\n' "${B}${M}termux-mcp-remote${R} ${D}installer${R}"
dim "repo: $REPO  branch: $BRANCH"

# ---------- 1. environment ----------
step "Checking environment"
if [ -n "${TERMUX_VERSION:-}" ] || [ -d /data/data/com.termux ]; then
  PLATFORM="termux"
  BIN_DIR="${PREFIX:-/data/data/com.termux/files/usr}/bin"
else
  PLATFORM="linux"
  if [ -w /usr/local/bin ] 2>/dev/null; then BIN_DIR=/usr/local/bin; else BIN_DIR="$HOME/.local/bin"; fi
fi
ok "platform $PLATFORM, command will be installed to $BIN_DIR"

for c in curl tar; do
  command -v "$c" >/dev/null 2>&1 || die "Missing $c. Install it first:
  Termux: pkg install curl tar
  Debian: sudo apt install curl tar"
done

# ---------- 2. Node.js ----------
step "Checking Node.js"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
    ok "Node.js $(node -v)"
    NEED_NODE=0
  else
    warn "Node.js $(node -v 2>/dev/null || echo '?') is too old, need >= 20"
  fi
else
  warn "Node.js not found"
fi

if [ "$NEED_NODE" = 1 ]; then
  if [ "$PLATFORM" = "termux" ]; then
    dim "trying: pkg install nodejs-lts (this may take a while)..."
    if command -v pkg >/dev/null 2>&1; then
      pkg install -y nodejs-lts >/dev/null 2>&1 || true
    fi
    if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; then
      ok "installed Node.js $(node -v)"
    else
      die "Please run: pkg install nodejs-lts, then re-run this script"
    fi
  else
    die "Please install Node.js >= 20 first:
  Debian/Ubuntu:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
  or with nvm:    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22"
  fi
fi

# ---------- 3. existing installation ----------
step "Checking for an existing installation"
EXISTING_CMD=""
if [ -f "$BIN_DIR/tmcp" ]; then
  EXISTING_CMD=$(grep -o '/[^"]*agent/cli.js' "$BIN_DIR/tmcp" 2>/dev/null | sed 's|/agent/cli.js||' | head -n1)
fi

if [ -n "$EXISTING_CMD" ] && [ "$EXISTING_CMD" != "$TARGET_DIR" ]; then
  warn "another installation already exists:"
  dim "  command  $BIN_DIR/tmcp -> $EXISTING_CMD"
  dim "  this run $TARGET_DIR"
  if [ "$FORCE" != 1 ]; then
    printf '\n%sRefusing to overwrite the existing tmcp command.%s\n' "$Y" "$R"
    printf '  To move the installation, add --force (or remove it first):\n'
    printf '    %srm -f %s/tmcp%s\n' "$C" "$BIN_DIR" "$R"
    printf '  To update the existing installation instead, run:\n'
    printf '    %sbash get.sh --dir %s%s\n\n' "$C" "$EXISTING_CMD" "$R"
    die "aborted, nothing was changed"
  fi
  warn "--force: the tmcp command will be switched to the new directory"
fi

# warn when an agent is currently running
RUNNING_PID=""
PIDFILE="$HOME/.config/termux-mcp-remote/state/agent.pid"
if [ -f "$PIDFILE" ]; then
  P=$(tr -dc '0-9' < "$PIDFILE")
  if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then RUNNING_PID="$P"; fi
fi
if [ -n "$RUNNING_PID" ]; then
  warn "an agent is currently running (pid=$RUNNING_PID)"
  dim "  code will be updated but the service is not restarted; run 'tmcp restart' afterwards"
fi

# ---------- 4. download ----------
step "Downloading"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/tmcp-install-XXXXXX") || die "cannot create a temporary directory"
trap 'rm -rf "$TMP"' EXIT

TARBALL="$TMP/repo.tar.gz"
GOT=0
try_mirror() {
  local name="$1" url="$2"
  if [ -n "$MIRROR" ] && [ "$MIRROR" != "$name" ]; then return 1; fi
  printf '%s  trying %s%s\n' "$D" "$name" "$R"
  if curl -fsSL --connect-timeout 12 --max-time 180 -o "$TARBALL" "$url" 2>/dev/null; then
    if tar -tzf "$TARBALL" 2>/dev/null | grep -q 'package\.json$'; then
      ok "downloaded from $name"
      GOT=1
      return 0
    fi
    warn "$name returned something that is not the code archive"
    rm -f "$TARBALL"
  else
    warn "$name unavailable"
  fi
  return 1
}

ENC_BRANCH=$(printf '%s' "$BRANCH" | sed 's|/|%2F|g')
# Note: jsDelivr cannot serve tarballs (404 for @main); it is only used to
# fetch this script quickly, not the code archive.
try_mirror "codeload" "https://codeload.github.com/$REPO/tar.gz/refs/heads/$ENC_BRANCH" || \
try_mirror "ghproxy"  "https://ghproxy.net/https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || \
try_mirror "ghfast"   "https://ghfast.top/https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || \
try_mirror "github"   "https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || true

if [ "$GOT" = 0 ]; then
  if [ -n "$MIRROR" ]; then die "the requested mirror '$MIRROR' failed"; fi
  if command -v git >/dev/null 2>&1; then
    dim "  falling back to git clone..."
    rm -rf "$TMP/src"
    if git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$TMP/src" >/dev/null 2>&1; then
      ok "cloned with git"
      GOT=2
    fi
  fi
  [ "$GOT" != 0 ] || die "all download sources failed. Check your network, or clone manually and run 'bash install.sh'"
fi

# ---------- 5. unpack ----------
step "Installing to $TARGET_DIR"
if [ "$GOT" = 1 ]; then
  rm -rf "$TMP/src"
  mkdir -p "$TMP/src"
  tar -xzf "$TARBALL" -C "$TMP/src" || die "failed to extract the archive"
  SRC=$(find "$TMP/src" -mindepth 1 -maxdepth 1 -type d | head -n1)
  [ -n "$SRC" ] && [ -d "$SRC" ] || SRC="$TMP/src"
else
  SRC="$TMP/src"
fi
[ -f "$SRC/package.json" ] || die "package.json missing in the archive; the mirror probably returned an error page"

mkdir -p "$TARGET_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude 'node_modules' --exclude '.git' --exclude 'logs' \
        --exclude 'run' --exclude 'state' "$SRC"/ "$TARGET_DIR"/ || die "failed to copy files"
else
  (cd "$SRC" && find . -mindepth 1 -maxdepth 1 \
      ! -name node_modules ! -name .git ! -name logs ! -name run ! -name state \
      -exec cp -R {} "$TARGET_DIR"/ \; ) || die "failed to copy files"
fi
chmod +x "$TARGET_DIR/bin/tmcp" "$TARGET_DIR/install.sh" 2>/dev/null || true
ok "code in place"

# ---------- 6. dependencies ----------
if [ "$SKIP_DEPS" = 0 ]; then
  step "Installing dependencies"
  if [ -f "$TARGET_DIR/node_modules/zod/package.json" ]; then
    ok "dependencies already present, skipping"
  else
    dim "  npm install (the first run takes a moment)..."
    if (cd "$TARGET_DIR" && npm install --no-audit --no-fund --omit=dev >/dev/null 2>&1); then
      ok "dependencies installed"
    else
      warn "npm install failed; run it manually later in $TARGET_DIR"
    fi
  fi
else
  warn "skipping dependency installation (--no-deps)"
fi

# ---------- 7. register the tmcp command ----------
step "Installing the tmcp command"
mkdir -p "$BIN_DIR" 2>/dev/null || true
if [ -w "$BIN_DIR" ]; then
  CMD_OWNER=$(grep -o '/[^"]*agent/cli.js' "$BIN_DIR/tmcp" 2>/dev/null | sed 's|/agent/cli.js||' | head -n1)
  if [ -n "$CMD_OWNER" ] && [ "$CMD_OWNER" != "$TARGET_DIR" ] && [ "$FORCE" != 1 ]; then
    warn "kept the existing $BIN_DIR/tmcp (pointing at $CMD_OWNER), not overwritten"
    dim "  use --force to switch it"
  else
    cat > "$BIN_DIR/tmcp" <<EOF
#!/bin/sh
exec node "$TARGET_DIR/agent/cli.js" "\$@"
EOF
    chmod 755 "$BIN_DIR/tmcp"
    ok "installed $BIN_DIR/tmcp"
  fi
else
  warn "$BIN_DIR is not writable; skipped the global command"
fi

if ! command -v script >/dev/null 2>&1; then
  warn "'script' not found (needed for interactive PTY shells)"
  if [ "$PLATFORM" = "termux" ]; then dim "  pkg install util-linux"; else dim "  sudo apt install util-linux"; fi
fi

# ---------- 8. done ----------
printf '\n%s%sInstallation complete%s\n' "$B$G" "" "$R"
printf '  directory  %s\n' "$TARGET_DIR"
printf '  command    %s\n' "$BIN_DIR/tmcp"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not in PATH. Add it to your shell profile:
    echo 'export PATH=\"\$PATH:$BIN_DIR\"' >> ~/.${SHELL##*/}rc" ;;
esac

printf '\n%sNext steps%s\n' "$B" "$R"
if [ -f "$HOME/.config/termux-mcp-remote/config.json" ]; then
  ok "existing config detected, start it with:"
  printf '  %stmcp start%s\n' "$C" "$R"
else
  printf '  1) If you have an enrollment code (recommended):\n'
  printf '     %stmcp enroll%s   %s(paste the code generated in the web UI)%s\n' "$C" "$R" "$D" "$R"
  printf '  2) Otherwise configure manually:\n'
  printf '     %stmcp setup%s\n' "$C" "$R"
  printf '  3) Start:\n'
  printf '     %stmcp start%s\n' "$C" "$R"
fi
printf '\n  Web UI: %shttps://<your-worker>/admin%s\n' "$D" "$R"
