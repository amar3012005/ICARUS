#!/usr/bin/env bash
# ICARUS installer — curl -fsSL https://raw.githubusercontent.com/amar3012005/ICARUS/main/install.sh | bash
#
# Installs ICARUS (the .amr memory filesystem) locally. On a platform with a prebuilt release
# binary, this downloads ONE self-contained executable (Rust engine + Node runtime bundled via
# `bun build --compile`) and runs it directly — no git, no Node.js, no Rust/cargo required on
# the target machine at all. On any other platform it falls back to the original source-build
# path (needs git + Node >=18, auto-installs Rust via rustup if missing).
# Idempotent — safe to re-run.
#
# One name, on purpose: the product is ICARUS end to end — the command you type, the install
# dir, the env vars below. "mneme" only remains as an internal engine/crate name under the hood
# (crate/mneme-node etc.) — nothing a user runs or configures should say it.
set -euo pipefail

REPO="${ICARUS_REPO:-https://github.com/amar3012005/ICARUS}"
BRANCH="${ICARUS_BRANCH:-main}"
RELEASE_TAG="${ICARUS_RELEASE_TAG:-latest}"
HOME_DIR="${ICARUS_HOME:-$HOME/.icarus}"
SRC_DIR="$HOME_DIR/src"
ROOT="$SRC_DIR" # dir containing crate/ — set by fetch_src (monorepo: $SRC_DIR/mneme, standalone: $SRC_DIR)
DATA_DIR="$HOME_DIR/data"
BIN_DIR="$HOME_DIR/bin"
USED_BINARY=0 # 1 once the prebuilt-binary path succeeds — later steps skip the source build

c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
info() { c "36" "▸ $1"; }
ok()   { c "32" "✓ $1"; }
warn() { c "33" "! $1"; }
die()  { c "31" "✗ $1"; exit 1; }

banner() {
  c "35" "
   ██╗ ██████╗ █████╗ ██████╗ ██╗   ██╗███████╗
   ██║██╔════╝██╔══██╗██╔══██╗██║   ██║██╔════╝
   ██║██║     ███████║██████╔╝██║   ██║███████╗
   ██║██║     ██╔══██║██╔══██╗██║   ██║╚════██║
   ██║╚██████╗██║  ██║██║  ██║╚██████╔╝███████║
   ╚═╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝
   memory filesystem for AI agents — one file per tenant"
}

need() { command -v "$1" >/dev/null 2>&1; }

# --- 0. prebuilt single-binary path (preferred) -----------------------------
# Asset naming: icarus-<os>-<arch>  (e.g. icarus-linux-x64, icarus-darwin-arm64)
binary_asset_name() {
  local os arch
  case "$(uname -s)" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    *) return 1 ;; # Windows/other: no prebuilt binary yet, fall back to source build
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) return 1 ;;
  esac
  echo "icarus-${os}-${arch}"
}

try_binary_install() {
  local asset url
  asset="$(binary_asset_name)" || { warn "no prebuilt binary for $(uname -s)/$(uname -m) — building from source"; return 1; }
  if [ "$RELEASE_TAG" = "latest" ]; then
    url="${REPO}/releases/latest/download/${asset}"
  else
    url="${REPO}/releases/download/${RELEASE_TAG}/${asset}"
  fi
  info "Downloading prebuilt binary ($asset, ~65MB)"
  mkdir -p "$HOME_DIR" "$DATA_DIR" "$BIN_DIR"
  # -s (silent) hides curl's own progress entirely -- on a slow connection this ~65MB download
  # can run a minute or more with ZERO screen output, indistinguishable from a hang (a real user
  # report: "stuck here" right after this line, when it was actually still downloading at ~50%).
  # --progress-bar keeps -f/-S/-L (fail-fast, show real errors, follow redirects) but prints a
  # single updating progress line instead of pure silence.
  if ! curl -fSL --progress-bar "$url" -o "$BIN_DIR/icarus.tmp"; then
    warn "prebuilt binary not available at $url — building from source instead"
    rm -f "$BIN_DIR/icarus.tmp"
    return 1
  fi
  chmod +x "$BIN_DIR/icarus.tmp"
  # sanity check before committing to this path — a corrupt/incompatible download must not
  # silently replace a working install
  if ! "$BIN_DIR/icarus.tmp" status >/dev/null 2>&1; then
    warn "downloaded binary failed to run — building from source instead"
    rm -f "$BIN_DIR/icarus.tmp"
    return 1
  fi
  mv "$BIN_DIR/icarus.tmp" "$BIN_DIR/icarus"
  ok "Installed CLI → $BIN_DIR/icarus (single binary, no toolchain needed)"
  USED_BINARY=1
  return 0
}

# --- 1. preflight (source-build fallback only) ------------------------------
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

# --- 2. fetch source (source-build fallback only) ---------------------------
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
  # standalone repo: crate/ at root. monorepo: under mneme/.
  ROOT="$SRC_DIR"; [ -d "$SRC_DIR/mneme/crate" ] && ROOT="$SRC_DIR/mneme"

  ok "Source at $SRC_DIR"
}

# --- 3. build addon (source-build fallback only) ----------------------------
build_addon() {
  info "Building native addon (this takes ~1-2 min the first time)"
  local node_dir="$ROOT/crate/mneme-node"
  ( cd "$node_dir" && npm install --silent && npx napi build --release ) \
    || die "addon build failed"
  # napi build names the addon from package.json's napi.name ("singulance-amr"), not "mneme" —
  # glob for whatever .node napi actually produced instead of hardcoding a name that was never
  # right (this used to always die here after a successful build; see native.js's own resolver
  # for the same platform-triple convention).
  local built_addon
  built_addon="$(ls "$node_dir"/*.node 2>/dev/null | head -1)"
  [ -n "$built_addon" ] || die "no .node addon produced in $node_dir"
  ok "Built $built_addon"
}

# --- 4. install CLI (source-build fallback only) ----------------------------
install_cli() {
  local node_dir="$ROOT/crate/mneme-node"
  cat > "$BIN_DIR/icarus" <<EOF
#!/usr/bin/env bash
exec node "$node_dir/mneme-cli.js" "\$@"
EOF
  chmod +x "$BIN_DIR/icarus"
  ok "Installed CLI → $BIN_DIR/icarus"
}

# --- 5. config + PATH + HIVEMIND OAuth (both paths) -------------------------
write_config() {
  local cfg="$HOME_DIR/config.json"
  # Default embeddings provider: OpenRouter's real baai/bge-m3 (openrouter.ai/baai/bge-m3,
  # verified live: native 1024-dim output, matches `dim` below exactly). LITELLM_BASE_URL still
  # overrides this wholesale for anyone pointing at their own LiteLLM/blaiq gateway instead.
  local embed_endpoint="${LITELLM_BASE_URL:-https://openrouter.ai/api/v1}"
  local embed_model="bge-m3"
  [ -z "${LITELLM_BASE_URL:-}" ] && embed_model="baai/bge-m3"
  [ -f "$cfg" ] || cat > "$cfg" <<EOF
{
  "dataRoot": "$DATA_DIR",
  "dim": 1024,
  "embeddings": {
    "disabled": false,
    "endpoint": "$embed_endpoint",
    "model": "$embed_model",
    "apiKey": null
  },
  "llm": {
    "disabled": false,
    "provider": "openrouter",
    "endpoint": "https://openrouter.ai/api/v1",
    "model": "anthropic/claude-3.5-haiku",
    "apiKey": null
  },
  "hivemind": { "connected": false }
}
EOF
  ok "Config → $cfg"
}

ensure_path() {
  # `curl | bash` always runs THIS script under bash, regardless of the user's actual login
  # shell — so checking $BASH_VERSION here checks the wrong thing and picks .bashrc even for a
  # zsh user (the macOS default since Catalina), leaving `icarus` silently unreachable after a
  # "successful" install. $SHELL is the user's configured login shell, inherited from the
  # parent process that ran this pipe — check THAT instead.
  local rc
  case "$(basename "${SHELL:-}")" in
    zsh) rc="$HOME/.zshrc" ;;
    bash) rc="$HOME/.bashrc" ;;
    *) rc="$HOME/.profile" ;;
  esac
  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
    if [ -w "$rc" ] || [ ! -e "$rc" ]; then
      echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$rc"
      warn "Added $BIN_DIR to PATH in $rc — run: source $rc"
    else
      warn "Add to PATH manually: export PATH=\"$BIN_DIR:\$PATH\""
    fi
  fi
}

# `curl -fsSL ... | bash` makes bash's OWN stdin the pipe FROM curl, not the user's keyboard —
# `[ -t 0 ]` is always false there even when the user is sitting at a real interactive terminal.
# That's exactly why this installer used to silently skip straight to "run later" messages after
# a `curl | bash` install (a real user reported it as looking "stuck"/abandoned) instead of
# actually guiding them. /dev/tty is the real fix every major curl-pipe installer uses (rustup,
# nvm, homebrew): it's the controlling terminal device, reachable independently of stdin, so
# reads against it work even mid-pipe. Only genuinely non-interactive contexts (CI, a script
# with no controlling terminal at all) fail this check — a real curl|bash-in-a-terminal user
# does not.
#
# `[ -r /dev/tty ] && [ -w /dev/tty ]` alone is NOT enough: those check the device node's
# permission BITS, which can be readable/writable even when nothing is actually attached to open
# it as a controlling terminal — a genuinely detached process (found testing this exact script:
# a sandboxed tool context with no session TTY) passes that check and then fails with "device
# not configured" the moment something actually tries to read/write it. Attempt a real, harmless
# open-for-read instead and trust its exit status, not the permission bits. The `2>/dev/null`
# MUST be on the braced group, not the inner command — bash reports a failed redirection's own
# setup error before a same-command stderr redirect can catch it (confirmed by testing: the
# inner-command form leaked a raw "Device not configured" line straight to the terminal even
# with `2>/dev/null` right there — exactly the scary-looking noise this function exists to avoid).
has_tty() { { : < /dev/tty; } 2>/dev/null; }

# All four guided steps read via bash's own `read ... < /dev/tty` (the single-read pattern every
# curl-pipe installer relies on, well-proven) and then call the matching icarus subcommand with
# the answer already in hand via flags -- NEVER handing off tty control to a long-lived node
# child process for more than the split-second of one non-interactive invocation. Earlier version
# of this function spawned `icarus setup` (a single Node process doing 4+ sequential /dev/tty
# reads) directly as install.sh's child -- a real test of the actual published `curl | bash`
# install showed that process dying silently after its very first question, no error printed
# (consistent with a signal-based kill, not a JS exception) -- most likely a controlling-
# terminal/process-group interaction specific to being spawned from inside a shell pipeline
# (`curl url | bash`), since a plain interactive `icarus setup` run (not spawned by install.sh)
# had no such issue in any of this session's own testing. Untested unknown, so removed the
# dependency on it entirely rather than trying to explain away one unreproduced failure.
guided_setup() {
  if ! has_tty; then
    warn "No controlling terminal — skipping guided setup."
    echo "    Run later:  icarus setup   (or individually: icarus mcp install / connect-llm / connect-embeddings / connect)"
    return 0
  fi
  printf '\n'
  c "36" "Continuing with guided setup. Press Ctrl+C at any point to stop — whatever"
  c "36" "step you're on can always be re-run later with the command shown for it."

  printf '\n'; c "36" "Step 1/4 — registering with any coding agents found on this machine"
  "$BIN_DIR/icarus" mcp install || true

  printf '\n'; c "36" "Step 2/4 — memory generation (distills ingested text into key facts before storing)"
  if [ -n "${OPENROUTER_API_KEY:-}${ANTHROPIC_API_KEY:-}" ]; then
    ok "API key already in the environment — memory generation is enabled, nothing to do."
  else
    echo "  Skip this entirely and ICARUS still works — raw text is stored and searchable as-is."
    echo "    1) OpenRouter (one key, routes to Claude/GPT/etc by model name)"
    echo "    2) Anthropic API key (console.anthropic.com — NOT a Claude.ai subscription login)"
    echo "    3) Skip"
    read -r -p "  Choice [1/2/3]: " llm_choice < /dev/tty
    case "$llm_choice" in
      1) read -r -s -p "  OpenRouter API key: " llm_key < /dev/tty; printf '\n'
         "$BIN_DIR/icarus" connect-llm --provider openrouter --key "$llm_key" ;;
      2) read -r -s -p "  Anthropic API key: " llm_key < /dev/tty; printf '\n'
         "$BIN_DIR/icarus" connect-llm --provider anthropic --key "$llm_key" ;;
      *) "$BIN_DIR/icarus" connect-llm --provider skip ;;
    esac
  fi

  printf '\n'; c "36" "Step 3/4 — vector recall (semantic search on top of lexical/BM25)"
  if [ -n "${OPENROUTER_API_KEY:-}${LITELLM_API_KEY:-}" ]; then
    ok "API key already in the environment — vector recall is enabled, nothing to do."
  else
    echo "  Skip this entirely and ICARUS still works — BM25 lexical search needs no vector."
    read -r -p "  Connect an embedding provider (OpenRouter baai/bge-m3)? [y/N] " emb_ans < /dev/tty
    case "$emb_ans" in
      y|Y) read -r -s -p "  OpenRouter API key: " emb_key < /dev/tty; printf '\n'
           "$BIN_DIR/icarus" connect-embeddings --key "$emb_key" ;;
      *) echo "    Skipped — running lexical-only (BM25) until you run: icarus connect-embeddings" ;;
    esac
  fi

  printf '\n'; c "36" "Step 4/4 — HIVEMIND account (optional)"
  read -r -p "  Connect your HIVEMIND account? [y/N] " hm_ans < /dev/tty
  case "$hm_ans" in
    y|Y)
      echo "  Open: ${HIVEMIND_URL:-https://hivemind.blaiq.ai}/settings/connections (authorize \"icarus local\")"
      read -r -s -p "  Paste HIVEMIND token: " hm_token < /dev/tty; printf '\n'
      "$BIN_DIR/icarus" connect --token "$hm_token" ;;
    *) echo "    Skipped. Run later:  icarus connect" ;;
  esac
}

# --- 6. verify (both paths) --------------------------------------------------
verify() {
  info "Verifying"
  if [ "$USED_BINARY" = "1" ]; then
    "$BIN_DIR/icarus" status >/dev/null 2>&1 || die "binary failed to run"
  else
    # Load through native.js's own platform-triple resolver — the same path mneme-cli.js uses —
    # instead of a hardcoded filename, so this check tracks whatever napi actually names the addon.
    node -e "require('$ROOT/crate/mneme-node/native.js'); console.log('addon loads ok')" \
      || die "addon failed to load"
  fi
  ok "ICARUS installed"
}

main() {
  banner
  if try_binary_install; then
    write_config
    ensure_path
    verify
  else
    ensure_toolchain
    fetch_src
    build_addon
    install_cli
    write_config
    ensure_path
    verify
  fi

  guided_setup

  printf '\n'
  c "32" "Done. Try:  icarus status"
  if [ "$USED_BINARY" = "1" ]; then
    c "90" "Docs: ${REPO}#readme"
  else
    c "90" "Docs: $ROOT/README.md   Thesis: $ROOT/THESIS.md"
  fi
}

main "$@"
