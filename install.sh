#!/usr/bin/env bash
# mneme installer — curl -fsSL https://raw.githubusercontent.com/amar3012005/HIVEMIND/main/mneme/install.sh | bash
#
# Installs the mneme memory filesystem locally: ensures toolchain, builds the native addon,
# installs the `mneme` CLI to ~/.mneme, and (optionally) connects your HIVEMIND account.
# Idempotent — safe to re-run.
set -euo pipefail

REPO="${MNEME_REPO:-https://github.com/amar3012005/HIVEMIND}"
BRANCH="${MNEME_BRANCH:-main}"
HOME_DIR="${MNEME_HOME:-$HOME/.mneme}"
SRC_DIR="$HOME_DIR/src"
DATA_DIR="$HOME_DIR/data"
BIN_DIR="$HOME_DIR/bin"

c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
info() { c "36" "▸ $1"; }
ok()   { c "32" "✓ $1"; }
warn() { c "33" "! $1"; }
die()  { c "31" "✗ $1"; exit 1; }

banner() {
  c "35" "
   ███╗   ███╗███╗   ██╗███████╗███╗   ███╗███████╗
   ████╗ ████║████╗  ██║██╔════╝████╗ ████║██╔════╝
   ██╔████╔██║██╔██╗ ██║█████╗  ██╔████╔██║█████╗
   ██║╚██╔╝██║██║╚██╗██║██╔══╝  ██║╚██╔╝██║██╔══╝
   ██║ ╚═╝ ██║██║ ╚████║███████╗██║ ╚═╝ ██║███████╗
   ╚═╝     ╚═╝╚═╝  ╚═══╝╚══════╝╚═╝     ╚═╝╚══════╝
   memory filesystem for AI agents — one file per tenant"
}

# --- 1. preflight ----------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1; }

ensure_toolchain() {
  info "Checking toolchain"
  if ! need git; then die "git is required (install it first)"; fi
  if ! need node; then
    die "Node.js >= 18 is required. Install from https://nodejs.org and re-run."
  fi
  local nodev; nodev="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$nodev" -ge 18 ] || die "Node.js >= 18 required (found $(node -v))"
  if ! need cargo; then
    warn "Rust not found — installing via rustup (needed to build the native addon)"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
  ok "git $(git --version | awk '{print $3}'), node $(node -v), cargo $(cargo --version | awk '{print $2}')"
}

# --- 2. fetch source -------------------------------------------------------
fetch_src() {
  mkdir -p "$HOME_DIR" "$DATA_DIR" "$BIN_DIR"
  if [ -d "$SRC_DIR/.git" ]; then
    info "Updating source"
    git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH" -q
    git -C "$SRC_DIR" reset --hard "origin/$BRANCH" -q
  else
    info "Cloning $REPO ($BRANCH)"
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$SRC_DIR" -q
  fi
  ok "Source at $SRC_DIR"
}

# --- 3. build addon --------------------------------------------------------
build_addon() {
  info "Building native addon (this takes ~1-2 min the first time)"
  local node_dir="$SRC_DIR/mneme/crate/mneme-node"
  ( cd "$node_dir" && npm install --silent && npx napi build --release ) \
    || die "addon build failed"
  [ -f "$node_dir/mneme.node" ] || die "mneme.node not produced"
  ok "Built $node_dir/mneme.node"
}

# --- 4. install CLI --------------------------------------------------------
install_cli() {
  local node_dir="$SRC_DIR/mneme/crate/mneme-node"
  cat > "$BIN_DIR/mneme" <<EOF
#!/usr/bin/env bash
exec node "$node_dir/mneme-cli.js" "\$@"
EOF
  chmod +x "$BIN_DIR/mneme"
  ok "Installed CLI → $BIN_DIR/mneme"

  # add to PATH if not present
  local rc; rc="$HOME/.zshrc"; [ -n "${BASH_VERSION:-}" ] && rc="$HOME/.bashrc"
  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
    if [ -w "$rc" ] || [ ! -e "$rc" ]; then
      echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$rc"
      warn "Added $BIN_DIR to PATH in $rc — run: source $rc"
    else
      warn "Add to PATH manually: export PATH=\"$BIN_DIR:\$PATH\""
    fi
  fi
}

# --- 5. config + HIVEMIND OAuth (optional) ---------------------------------
write_config() {
  local cfg="$HOME_DIR/config.json"
  [ -f "$cfg" ] || cat > "$cfg" <<EOF
{
  "dataRoot": "$DATA_DIR",
  "dim": 1024,
  "embeddings": {
    "endpoint": "${LITELLM_BASE_URL:-https://api.blaiq.ai/v1}",
    "model": "bge-m3"
  },
  "hivemind": { "connected": false }
}
EOF
  ok "Config → $cfg"
}

connect_hivemind() {
  # only prompt when interactive; piping `| bash` is non-interactive, so skip gracefully.
  if [ ! -t 0 ]; then
    warn "Non-interactive install — skipping HIVEMIND connect."
    echo "    Run later:  mneme connect"
    return 0
  fi
  printf '\n'
  c "36" "Connect your HIVEMIND account now? mneme can sync recall with HIVEMIND."
  read -r -p "  Connect? [y/N] " ans
  case "$ans" in
    y|Y) node "$SRC_DIR/mneme/crate/mneme-node/mneme-cli.js" connect ;;
    *)   echo "    Skipped. Run later:  mneme connect" ;;
  esac
}

# --- 6. verify -------------------------------------------------------------
verify() {
  info "Verifying"
  node -e "require('$SRC_DIR/mneme/crate/mneme-node/mneme.node'); console.log('addon loads ok')" \
    || die "addon failed to load"
  ok "mneme installed"
}

main() {
  banner
  ensure_toolchain
  fetch_src
  build_addon
  install_cli
  write_config
  verify
  connect_hivemind
  printf '\n'
  c "32" "Done. Try:  mneme status"
  c "90" "Docs: $SRC_DIR/mneme/README.md   Thesis: $SRC_DIR/mneme/THESIS.md"
}

main "$@"
