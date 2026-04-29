#!/bin/bash
# MinerU True Copy v0.1 — dev runner.
#
# Starts the three processes the dev workflow needs:
#   1. mineru_server.py (port 51820)
#   2. translation_server.py (port 51823, optional, kept on a try-best basis)
#   3. npx tauri dev (which starts Next.js on :51821 and the Tauri shell)
#
# Sidecars run as background children of this script. Ctrl-C stops
# everything cleanly via the trap.
#
# Logs:
#   .run-mineru.log       MinerU server stdout/stderr
#   .run-translation.log  Translation server stdout/stderr
#   (Tauri + Next.js stream to the foreground terminal)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_PYTHON="$PROJECT_DIR/mineru-venv/bin/python"

if [ ! -x "$VENV_PYTHON" ]; then
    echo "❌ mineru-venv not found. Run ./scripts/setup.sh first." >&2
    exit 1
fi

cleanup_pids=()
cleanup() {
    echo ""
    echo "Stopping sidecars..."
    for pid in "${cleanup_pids[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
}
trap cleanup EXIT INT TERM

echo "Starting MinerU server on :51820 (logs: .run-mineru.log)..."
"$VENV_PYTHON" "$PROJECT_DIR/mineru_server.py" --port 51820 \
    > "$PROJECT_DIR/.run-mineru.log" 2>&1 &
cleanup_pids+=($!)

echo "Starting translation server on :51823 (logs: .run-translation.log)..."
"$VENV_PYTHON" "$PROJECT_DIR/translation_server.py" --port 51823 \
    > "$PROJECT_DIR/.run-translation.log" 2>&1 &
cleanup_pids+=($!)

# Brief warm-up window so the WebView doesn't load before /health is ready
sleep 2

echo ""
echo "Starting Tauri dev (Next.js will spin up on :51821)..."
echo "Press Ctrl-C to stop everything."
echo ""
cd "$PROJECT_DIR/app"
exec npx @tauri-apps/cli dev
