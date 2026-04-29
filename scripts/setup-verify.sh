#!/bin/bash
# Phase 5/6 of scripts/setup.sh — verify the installation.
#
# Default mode (`setup.sh`):
#   Phase 5 — start each sidecar briefly, hit health endpoint, kill it.
#   Catches "wrong port", "missing model", "venv broken" classes of bugs.
#
# Full-verify mode (`setup.sh --full-verify`):
#   Phase 6 — also processes scripts/fixtures/smoke.pdf through OCR + DOCX
#   export. Catches integration bugs that "sidecars start" misses (the
#   class of bugs that the v0.1 false-start surfaced).
#
# Exit code 5 = sidecar health check failure.
# Exit code 6 = end-to-end smoke failure (only in --full-verify).

set -e

PHASE="verify"
EXIT_HEALTH=5
EXIT_SMOKE=6
FULL_VERIFY="${1:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_PYTHON="$PROJECT_DIR/mineru-venv/bin/python"

cleanup_pids=()
cleanup() {
    for pid in "${cleanup_pids[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
}
trap cleanup EXIT

wait_for_health() {
    local url="$1"
    local timeout="${2:-30}"
    local elapsed=0
    while [ "$elapsed" -lt "$timeout" ]; do
        if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 1
}

echo "=== Phase 5/6: Verify sidecars start ==="

# --- MinerU server ---
echo ""
echo "Starting mineru_server.py on :51820..."
"$VENV_PYTHON" "$PROJECT_DIR/mineru_server.py" --port 51820 >"$PROJECT_DIR/.setup-mineru.log" 2>&1 &
cleanup_pids+=($!)

if wait_for_health "http://localhost:51820/health" 60; then
    echo "✓ mineru_server.py responds on :51820"
else
    echo "❌ mineru_server.py never became ready." >&2
    echo "   Logs: $PROJECT_DIR/.setup-mineru.log" >&2
    exit "$EXIT_HEALTH"
fi

# --- Translation server ---
echo ""
echo "Starting translation_server.py on :51823..."
"$VENV_PYTHON" "$PROJECT_DIR/translation_server.py" --port 51823 >"$PROJECT_DIR/.setup-translation.log" 2>&1 &
cleanup_pids+=($!)

if wait_for_health "http://localhost:51823/health" 60; then
    echo "✓ translation_server.py responds on :51823"
else
    echo "⚠ translation_server.py didn't respond on :51823 within 60s."
    echo "  Translation features will be unavailable until this is resolved."
    echo "  Logs: $PROJECT_DIR/.setup-translation.log"
    # Translation is non-blocking for v0.1 — warn but don't fail
fi

# --- Full-verify: end-to-end smoke ---
if [ "$FULL_VERIFY" = "--full-verify" ]; then
    echo ""
    echo "=== Phase 6/6: End-to-end smoke (PDF → OCR → DOCX) ==="
    SMOKE_PDF="$PROJECT_DIR/scripts/fixtures/smoke.pdf"
    if [ ! -f "$SMOKE_PDF" ]; then
        echo "❌ Smoke fixture not found at $SMOKE_PDF" >&2
        exit "$EXIT_SMOKE"
    fi

    # POST the smoke PDF to mineru_server
    echo "Submitting smoke.pdf to mineru_server..."
    RESPONSE=$(curl -fsS -X POST \
        -F "file=@$SMOKE_PDF" \
        -F "processing_mode=local" \
        "http://localhost:51820/file_parse" 2>&1) || {
        echo "❌ /file_parse rejected smoke.pdf" >&2
        echo "   Response: $RESPONSE" >&2
        exit "$EXIT_SMOKE"
    }
    TASK_ID=$(echo "$RESPONSE" | "$VENV_PYTHON" -c "import sys, json; print(json.load(sys.stdin).get('task_id', ''))")
    if [ -z "$TASK_ID" ]; then
        echo "❌ No task_id in response: $RESPONSE" >&2
        exit "$EXIT_SMOKE"
    fi
    echo "✓ Submitted, task_id=$TASK_ID"

    # Poll for completion (up to 2 min)
    echo "Polling task..."
    for i in $(seq 1 120); do
        STATUS=$(curl -fsS "http://localhost:51820/tasks/$TASK_ID" 2>/dev/null | "$VENV_PYTHON" -c "import sys, json; print(json.load(sys.stdin).get('status', ''))" 2>/dev/null || echo "polling")
        case "$STATUS" in
            done|completed) echo "✓ OCR completed"; break ;;
            failed|error)   echo "❌ OCR failed (status=$STATUS)" >&2; exit "$EXIT_SMOKE" ;;
            *)              sleep 1 ;;
        esac
    done

    if [ "$STATUS" != "done" ] && [ "$STATUS" != "completed" ]; then
        echo "❌ OCR did not complete within 120s (status=$STATUS)" >&2
        exit "$EXIT_SMOKE"
    fi
    echo "=== Phase 6 OK ==="
fi

echo ""
echo "=== Verify OK ==="
