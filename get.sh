#!/usr/bin/env bash
# termux-mcp-remote - one-line installer
#
# Usage (pick one):
#   curl -fsSL https://gh-proxy.org/https://raw.githubusercontent.com/hahahaoha/termux-mcp-remote/main/get.sh | bash
#   bash get.sh                      # already downloaded
#
# Options / environment variables:
#   --dir <path>        install directory (default: ~/termux-mcp-remote)
#   --branch <name>     git branch to install (default: main)
#   --mirror <name>     force one download source:
#                       codeload | gh-proxy | ghproxy | ghfast | github
#   --no-deps           skip npm install
#   --no-system-deps    never touch system packages, only report what is missing
#   --force             take over a tmcp command that points elsewhere
#   TMCP_DIR / TMCP_BRANCH / TMCP_MIRROR / TMCP_FORCE=1
#   TMCP_DRY_RUN=1      show what would be installed, change nothing
#
# Chinese version of this installer: get-zh.sh
#
# Design notes:
#   - When executed as `curl | bash`, stdin is consumed by the script itself,
#     so this script never reads stdin. Anything interactive is left to the user.
#   - System prerequisites (curl, tar, node>=20, util-linux) are installed
#     automatically when a package manager is available. On Linux, if the
#     distro ships an old Node, nvm is used so no root is required.
#   - Several download mirrors are tried in order, so it works behind
#     restrictive networks.
#   - Safety: if a tmcp command already points at a different installation,
#     the script aborts WITHOUT modifying anything, unless --force is given.
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
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'TXT'
termux-mcp-remote - one-line installer

Usage:
  curl -fsSL https://gh-proxy.org/https://raw.githubusercontent.com/hahahaoha/termux-mcp-remote/main/get.sh | bash
  bash get.sh [options]

Options:
  --dir <path>        Install directory (default: ~/termux-mcp-remote)
  --branch <name>     Git branch (default: main)
  --mirror <name>     Force one download source:
                      codeload | gh-proxy | ghproxy | ghfast | github
  --no-deps           Skip npm install
  --no-system-deps    Do not install system packages, only report them
  --force             Take over a tmcp command pointing at another install
  -h, --help          Show this help

Environment:
  TMCP_DIR, TMCP_BRANCH, TMCP_MIRROR, TMCP_FORCE=1, TMCP_DRY_RUN=1

Examples:
  bash get.sh                                  # fresh install
  bash get.sh --dir /opt/termux-mcp-remote     # custom location
  bash get.sh --dir ~/termux-mcp-remote        # update in place
  bash get.sh --no-system-deps                 # I manage packages myself
TXT
}

# ---------- parse arguments ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)            TARGET_DIR="${2:-}"; shift 2 ;;
    --branch)         BRANCH="${2:-}"; shift 2 ;;
    --mirror)         MIRROR="${2:-}"; shift 2 ;;
    --no-deps)        SKIP_DEPS=1; shift ;;
    --no-system-deps) NO_SYSTEM_DEPS=1; shift ;;
    --force)          FORCE=1; shift ;;
    --lang)
      case "${2:-}" in
        zh*) die "Chinese output lives in get-zh.sh. Use:
  curl -fsSL https://gh-proxy.org/https://raw.githubusercontent.com/hahahaoha/termux-mcp-remote/main/get-zh.sh | bash" ;;
        *) shift 2 ;;
      esac ;;
    -h|--help)        usage; exit 0 ;;
    *) die "Unknown argument: $1 (use --help)" ;;
  esac
done
[ -n "$TARGET_DIR" ] || TARGET_DIR="$DEFAULT_DIR"

printf '%s\n' "${B}${M}termux-mcp-remote${R} ${D}installer${R}"
dim "repo: $REPO  branch: $BRANCH"
[ -n "$DRY_RUN" ] && warn "dry run: nothing will actually be installed"

# ---------- 1. platform + package manager ----------
step "Detecting platform"
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

# sudo: only use it when it works without a password prompt
SUDO=""
if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
  SUDO=""
elif have sudo && sudo -n true >/dev/null 2>&1; then
  SUDO="sudo -n"
fi

ok "platform $PLATFORM, command will be installed to $BIN_DIR"

# install one or more packages with the platform's package manager
pm_install() {
  if [ "$NO_SYSTEM_DEPS" = 1 ]; then
    return 1
  fi
  if [ -n "$DRY_RUN" ]; then
    dim "  [dry-run] would install: $*"
    return 0
  fi
  case "$PLATFORM" in
    termux) pkg install -y "$@" >/dev/null 2>&1 ;;
    debian) { [ -n "$SUDO" ] || [ "$(id -u)" = "0" ]; } || return 1
            $SUDO apt-get update -qq >/dev/null 2>&1
            $SUDO apt-get install -y "$@" >/dev/null 2>&1 ;;
    alpine) $SUDO apk add --no-cache "$@" >/dev/null 2>&1 ;;
    fedora) $SUDO dnf install -y "$@" >/dev/null 2>&1 ;;
    arch)   $SUDO pacman -Sy --noconfirm "$@" >/dev/null 2>&1 ;;
    suse)   $SUDO zypper -n install -y "$@" >/dev/null 2>&1 ;;
    mac)    have brew && brew install "$@" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

# ---------- 2. curl + tar ----------
step "Checking basic tools"
MISSING=""
for c in curl tar; do have "$c" || MISSING="$MISSING $c"; done
if [ -n "$MISSING" ]; then
  warn "missing:$MISSING"
  if pm_install $MISSING; then
    ok "installed:$MISSING"
  else
    die "cannot install$MISSING automatically. Please install them and re-run:
  Termux: pkg install curl tar
  Debian: sudo apt install curl tar
  Alpine: sudo apk add curl tar"
  fi
fi
if [ -z "$DRY_RUN" ]; then
  have curl || die "curl is still missing after install; aborting"
  have tar  || die "tar is still missing after install; aborting"
fi
ok "curl and tar available"

# ---------- 3. Node.js ----------
step "Checking Node.js"
node_ok() {
  have node || return 1
  local v
  v=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$v" -ge 20 ] 2>/dev/null
}

if node_ok; then
  ok "Node.js $(node -v)"
else
  if have node; then warn "Node.js $(node -v 2>/dev/null || echo '?') is too old, need >= 20"; else warn "Node.js not found"; fi

  case "$PLATFORM" in
    termux) pm_install nodejs-lts || pm_install nodejs ;;
    mac)    pm_install node ;;
    *)      pm_install nodejs npm || pm_install node ;;
  esac

  if node_ok; then
    ok "installed Node.js $(node -v)"
  elif [ -n "$DRY_RUN" ]; then
    ok "would install Node.js >= 20 (and nvm if the distro package is too old)"
  else
    # Distro Node is missing or too old: use nvm, which needs no root
    warn "system Node is still unusable; falling back to nvm (installs into your home directory)"
    export NVM_DIR="$HOME/.nvm"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      if [ -n "$DRY_RUN" ]; then
        dim "  [dry-run] would install nvm into $NVM_DIR"
      else
        for u in \
          "https://gh-proxy.org/https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh" \
          "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh"; do
          if curl -fsSL --connect-timeout 15 --max-time 180 "$u" 2>/dev/null | bash >/dev/null 2>&1; then
            break
          fi
        done
      fi
    fi
    if [ -s "$NVM_DIR/nvm.sh" ]; then
      # shellcheck disable=SC1091
      . "$NVM_DIR/nvm.sh"
      nvm install 22 >/dev/null 2>&1 || true
      NB="$(dirname "$(nvm which 22 2>/dev/null || echo "")" 2>/dev/null || true)"
      [ -n "$NB" ] && [ -d "$NB" ] && PATH="$NB:$PATH"
    fi
    if node_ok; then
      ok "Node.js $(node -v) via nvm"
      warn "nvm lives in $HOME/.nvm — tmcp will use $NB/node explicitly, so no shell setup is needed"
    else
      die "could not get Node.js >= 20 automatically. Install it manually:
  Debian/Ubuntu: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
  or nvm:        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22
  Termux:        pkg install nodejs-lts"
    fi
  fi
fi

NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm 2>/dev/null || true)"
if [ -z "$NPM_BIN" ]; then
  warn "npm not found next to node; trying the package manager"
  pm_install npm || true
  NPM_BIN="$(command -v npm 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ] && [ -z "$DRY_RUN" ]; then
  die "cannot resolve the node binary"
fi

# ---------- 4. util-linux (interactive PTY) ----------
step "Checking util-linux (for interactive shells)"
if have script; then
  ok "script available"
else
  warn "script not found; interactive shell_* tools would be unavailable"
  if pm_install util-linux; then
    if [ -n "$DRY_RUN" ]; then
      ok "would install util-linux"
    elif have script; then
      ok "installed util-linux"
    else
      warn "util-linux did not install cleanly"
    fi
  else
    dim "  install it later if you need shell_* tools:"
    case "$PLATFORM" in
      termux) dim "    pkg install util-linux" ;;
      debian) dim "    sudo apt install util-linux" ;;
      alpine) dim "    sudo apk add util-linux" ;;
      *)      dim "    install the util-linux package for your distro" ;;
    esac
  fi
fi

# ---------- dry run stops here ----------
if [ -n "$DRY_RUN" ]; then
  printf '\n%sdry run summary%s\n' "$B" "$R"
  printf '  target dir : %s\n' "$TARGET_DIR"
  printf '  command    : %s/tmcp\n' "$BIN_DIR"
  printf '  node       : %s\n' "$(command -v node 2>/dev/null || echo '(would be installed)')"
  printf '  next       : drop TMCP_DRY_RUN=1 to actually install\n'
  exit 0
fi

# ---------- 5. existing installation ----------
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

# ---------- 6. download ----------
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
# gh-proxy first: fastest on restrictive networks (~1s) and its cache is only 60s.
try_mirror "gh-proxy" "https://gh-proxy.org/https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || \
try_mirror "codeload" "https://codeload.github.com/$REPO/tar.gz/refs/heads/$ENC_BRANCH" || \
try_mirror "ghproxy"  "https://ghproxy.net/https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || \
try_mirror "ghfast"   "https://ghfast.top/https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || \
try_mirror "github"   "https://github.com/$REPO/archive/refs/heads/$ENC_BRANCH.tar.gz" || true

if [ "$GOT" = 0 ]; then
  if [ -n "$MIRROR" ]; then die "the requested mirror '$MIRROR' failed"; fi
  if ! have git; then
    dim "  git not found, trying to install it for the fallback clone..."
    pm_install git || true
  fi
  if have git; then
    dim "  falling back to git clone..."
    rm -rf "$TMP/src"
    if git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$TMP/src" >/dev/null 2>&1; then
      ok "cloned with git"
      GOT=2
    fi
  fi
  [ "$GOT" != 0 ] || die "all download sources failed. Check your network, or clone manually and run 'bash install.sh'"
fi

# ---------- 7. unpack ----------
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
if have rsync; then
  rsync -a --exclude 'node_modules' --exclude '.git' --exclude 'logs' \
        --exclude 'run' --exclude 'state' "$SRC"/ "$TARGET_DIR"/ || die "failed to copy files"
else
  (cd "$SRC" && find . -mindepth 1 -maxdepth 1 \
      ! -name node_modules ! -name .git ! -name logs ! -name run ! -name state \
      -exec cp -R {} "$TARGET_DIR"/ \; ) || die "failed to copy files"
fi
chmod +x "$TARGET_DIR/bin/tmcp" "$TARGET_DIR/install.sh" 2>/dev/null || true
ok "code in place"

# ---------- 8. npm dependencies ----------
if [ "$SKIP_DEPS" = 0 ]; then
  step "Installing npm dependencies"
  if [ -f "$TARGET_DIR/node_modules/zod/package.json" ]; then
    ok "dependencies already present, skipping"
  elif [ -z "$NPM_BIN" ]; then
    warn "npm is not available; skipping (run 'npm install' in $TARGET_DIR later)"
  else
    dim "  npm install (the first run takes a moment)..."
    if (cd "$TARGET_DIR" && "$NPM_BIN" install --no-audit --no-fund --omit=dev >/dev/null 2>&1); then
      ok "dependencies installed"
    else
      warn "npm install failed; run it manually later in $TARGET_DIR"
    fi
  fi
else
  warn "skipping npm install (--no-deps)"
fi

# ---------- 9. register the tmcp command ----------
step "Installing the tmcp command"
mkdir -p "$BIN_DIR" 2>/dev/null || true
if [ -w "$BIN_DIR" ]; then
  CMD_OWNER=$(grep -o '/[^"]*agent/cli.js' "$BIN_DIR/tmcp" 2>/dev/null | sed 's|/agent/cli.js||' | head -n1)
  if [ -n "$CMD_OWNER" ] && [ "$CMD_OWNER" != "$TARGET_DIR" ] && [ "$FORCE" != 1 ]; then
    warn "kept the existing $BIN_DIR/tmcp (pointing at $CMD_OWNER), not overwritten"
    dim "  use --force to switch it"
  else
    {
      echo '#!/bin/sh'
      echo "exec \"$NODE_BIN\" \"$TARGET_DIR/agent/cli.js\" \"\$@\""
    } > "$BIN_DIR/tmcp"
    chmod 755 "$BIN_DIR/tmcp"
    ok "installed $BIN_DIR/tmcp"
    dim "  launcher uses: $NODE_BIN"
  fi
else
  warn "$BIN_DIR is not writable; skipped the global command"
fi

# ---------- 10. done ----------
printf '\n%s%sInstallation complete%s\n' "$B$G" "" "$R"
printf '  directory  %s\n' "$TARGET_DIR"
printf '  command    %s\n' "$BIN_DIR/tmcp"
printf '  node       %s\n' "$NODE_BIN"
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
