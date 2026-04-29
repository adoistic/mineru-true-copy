#!/bin/bash
# Phase 3 of scripts/setup.sh — install Node.js dependencies.
#
# Runs `npm ci` in app/ to install the Next.js + Tauri frontend deps.
# Does NOT build the standalone Node sidecar — that's part of the Tauri
# packaging step (scripts/build-node-sidecar.sh, only called by
# scripts/build-app.sh). For the developer flow, `npx tauri dev` is the
# entry point and starts Next.js in dev mode directly.
#
# Idempotent: re-runs are a no-op if node_modules already matches lockfile.
# Exit code 3 = node deps failure.

set -e

PHASE="node"
EXIT_NODE=3

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$PROJECT_DIR/app"

echo "=== Phase 3/6: Node dependencies ==="

if [ ! -f "$APP_DIR/package.json" ]; then
    echo "❌ app/package.json not found" >&2
    exit "$EXIT_NODE"
fi

cd "$APP_DIR"
echo "Running npm ci in app/..."
if ! npm ci --no-audit --no-fund 2>&1 | tail -5; then
    echo "❌ npm ci failed." >&2
    echo "   Common causes: network drop, package-lock.json out of sync." >&2
    echo "   Try: rm -rf node_modules && npm ci" >&2
    exit "$EXIT_NODE"
fi

# Sanity: tauri CLI reachable via npx (we don't install it globally)
if ! npx --no-install @tauri-apps/cli --version >/dev/null 2>&1; then
    echo "⚠ @tauri-apps/cli not found in app/node_modules — npx will download on first run."
fi

echo "✓ Node deps installed"
echo "=== Phase 3 OK ==="
