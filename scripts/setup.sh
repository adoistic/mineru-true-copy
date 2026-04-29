#!/bin/bash
# MinerU True Copy v0.1 — developer setup orchestrator.
#
# Runs the six-phase setup end-to-end. Each phase is its own sub-script
# in scripts/setup-*.sh; call them directly if you want to repair a
# single phase. Phase exit codes propagate so a CI smoke test can
# point-fix what failed.
#
# Usage:
#   ./scripts/setup.sh                    Full setup, default verify
#   ./scripts/setup.sh --preflight-only   Phase 1 only (CI-friendly, fast)
#   ./scripts/setup.sh --full-verify      Adds end-to-end smoke (~1 min)
#   ./scripts/setup.sh --help             Print usage
#
# Exit codes:
#   0  success
#   1  preflight failure (phase 1)
#   2  Python venv failure (phase 2)
#   3  Node deps failure (phase 3)
#   4  Model download failure (phase 4)
#   5  Sidecar health check failure (phase 5)
#   6  End-to-end smoke failure (phase 6, --full-verify only)
#
# Idempotent: safe to re-run on a partial setup. Each phase detects
# existing state and skips work it can.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$PROJECT_DIR/setup.log"

# Tee all output to setup.log so users can attach it to bug reports
exec > >(tee "$LOG_FILE") 2>&1

usage() {
    sed -n '2,18p' "$0" | sed 's|^# \?||'
    exit 0
}

PREFLIGHT_ONLY=""
FULL_VERIFY=""
for arg in "$@"; do
    case "$arg" in
        --preflight-only) PREFLIGHT_ONLY="1" ;;
        --full-verify)    FULL_VERIFY="--full-verify" ;;
        --help|-h)        usage ;;
        *) echo "Unknown flag: $arg (use --help)" >&2; exit 1 ;;
    esac
done

cat <<'EOF'
==============================================
  MinerU True Copy v0.1 — developer setup
==============================================
Logs are tee'd to setup.log (gitignored).

EOF

bash "$SCRIPT_DIR/setup-preflight.sh"

if [ -n "$PREFLIGHT_ONLY" ]; then
    echo ""
    echo "=== --preflight-only complete ==="
    exit 0
fi

bash "$SCRIPT_DIR/setup-venv-mineru.sh"
bash "$SCRIPT_DIR/setup-node.sh"
bash "$SCRIPT_DIR/setup-models.sh"
bash "$SCRIPT_DIR/setup-verify.sh" "$FULL_VERIFY"

cat <<'EOF'

==============================================
  Setup complete!
==============================================
Next steps:
  1. (Optional) Open Settings in the app and paste your OpenRouter
     API key to enable Cloud OCR. Local OCR works without a key.
  2. Run ./scripts/run.sh to launch the app in dev mode.
  3. Drop a PDF into the app window to verify end-to-end.

If anything broke, check setup.log and re-run setup.sh — phases that
already succeeded will skip.
EOF
