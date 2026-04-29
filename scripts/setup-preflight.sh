#!/bin/bash
# Phase 1 of scripts/setup.sh — preflight environment checks.
#
# Verifies the host has everything the rest of setup needs. Exits early
# with a clear actionable message on the first missing prerequisite so
# the user fixes one thing at a time. Exit code 1 = preflight failure.
#
# Standalone usage: bash scripts/setup-preflight.sh
# Idempotent: safe to re-run.

set -e

# shellcheck disable=SC2034
PHASE="preflight"
EXIT_PREFLIGHT=1

fail() {
    echo "❌ $1" >&2
    [ -n "${2:-}" ] && echo "   $2" >&2
    exit "$EXIT_PREFLIGHT"
}

ok() { echo "✓ $1"; }
warn() { echo "⚠ $1"; }

echo "=== Phase 1/6: Preflight ==="

# --- macOS only ---
if [ "$(uname -s)" != "Darwin" ]; then
    fail "v0.1 supports macOS only." \
         "Linux/Windows are HELP-WANTED items in docs/HELP-WANTED.md."
fi
ok "macOS detected"

# --- Apple Silicon recommended (Intel = warn) ---
ARCH=$(uname -m)
if [ "$ARCH" != "arm64" ]; then
    warn "Detected $ARCH (Intel). v0.1 is built and tested on Apple Silicon (arm64)."
    warn "Setup may complete but the app's MinerU PyInstaller binary won't be available."
    warn "Continue at your own risk; press Ctrl-C to abort."
    sleep 3
else
    ok "Apple Silicon (arm64)"
fi

# --- Xcode CLT ---
if ! xcode-select -p >/dev/null 2>&1; then
    fail "Xcode Command Line Tools not installed." \
         "Install with: xcode-select --install"
fi
ok "Xcode CLT"

# --- Homebrew + system deps ---
if ! command -v brew >/dev/null 2>&1; then
    fail "Homebrew not installed." \
         "Install from https://brew.sh"
fi
ok "Homebrew"

for pkg in pkg-config openssl cmake; do
    if ! brew list --formula "$pkg" >/dev/null 2>&1; then
        fail "Missing brew formula: $pkg" \
             "Install with: brew install $pkg"
    fi
done
ok "Homebrew deps (pkg-config, openssl, cmake)"

# --- Node 22+ ---
if ! command -v node >/dev/null 2>&1; then
    fail "Node.js not installed." \
         "Install Node 22 LTS: brew install node@22"
fi
NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 22 ]; then
    fail "Node $NODE_MAJOR detected, need 22 or newer." \
         "brew install node@22 && brew link --force node@22"
fi
ok "Node $(node -v)"

# --- Python 3.12 ---
if ! command -v python3.12 >/dev/null 2>&1; then
    fail "Python 3.12 not installed." \
         "Install with: brew install python@3.12"
fi
ok "Python $(python3.12 --version | cut -d' ' -f2)"

# --- Rust stable ---
if ! command -v rustc >/dev/null 2>&1; then
    fail "Rust not installed." \
         "Install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
fi
ok "Rust $(rustc --version | cut -d' ' -f2)"

# --- ~15 GB free disk in $HOME ---
HOME_FREE_KB=$(df -k "$HOME" | awk 'NR==2 {print $4}')
HOME_FREE_GB=$(( HOME_FREE_KB / 1024 / 1024 ))
if [ "$HOME_FREE_GB" -lt 15 ]; then
    fail "Only ${HOME_FREE_GB} GB free in \$HOME; need at least 15 GB." \
         "Models (~3.4 GB) + venv (~3 GB) + node_modules (~1 GB) + Cargo target (~5 GB)."
fi
ok "${HOME_FREE_GB} GB free in \$HOME"

# --- Network ---
if ! curl -fsS --max-time 5 https://huggingface.co >/dev/null 2>&1; then
    fail "Cannot reach huggingface.co (model download host)." \
         "Check your network connection."
fi
ok "Network reachable"

echo "=== Preflight OK ==="
