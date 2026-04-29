#!/bin/bash
# Phase 2 of scripts/setup.sh — provision the mineru-venv.
#
# Creates ./mineru-venv/ from python3.12 and installs requirements.txt
# (which covers both MinerU and IndicTrans2 — they share a venv per the
# design doc, verified against the working test-venv on the maintainer's
# machine). Idempotent: re-runs detect existing venv and skip.
#
# Exit code 2 = venv setup failure.

set -e

PHASE="venv-mineru"
EXIT_VENV=2

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$PROJECT_DIR/mineru-venv"
REQUIREMENTS="$PROJECT_DIR/requirements.txt"

echo "=== Phase 2/6: Python venv (mineru-venv) ==="

if [ ! -f "$REQUIREMENTS" ]; then
    echo "❌ requirements.txt not found at $REQUIREMENTS" >&2
    exit "$EXIT_VENV"
fi

# Idempotent venv creation
if [ -d "$VENV_DIR" ] && [ -x "$VENV_DIR/bin/python" ]; then
    echo "✓ mineru-venv exists; checking installed packages"
else
    echo "Creating mineru-venv with python3.12..."
    python3.12 -m venv "$VENV_DIR"
fi

PIP="$VENV_DIR/bin/pip"

# Always upgrade pip + tooling first; cheap, prevents resolver bugs
"$PIP" install --upgrade pip setuptools wheel 2>&1 | tail -3

echo "Installing requirements.txt (this can take 5-10 min on first run)..."
if ! "$PIP" install -r "$REQUIREMENTS" 2>&1 | tail -20; then
    echo "❌ pip install failed." >&2
    echo "   Common causes: network drop, version conflict, missing brew deps." >&2
    echo "   Re-run setup.sh once network is stable; pip cache will speed it up." >&2
    exit "$EXIT_VENV"
fi

# Sanity import check
echo "Verifying installed packages can import..."
if ! "$VENV_DIR/bin/python" -c "import magic_pdf, torch, transformers, IndicTransToolkit, huggingface_hub" 2>&1; then
    echo "❌ Post-install import check failed." >&2
    echo "   Some package compiled but cannot be imported." >&2
    exit "$EXIT_VENV"
fi

echo "✓ mineru-venv ready: $VENV_DIR"
echo "=== Phase 2 OK ==="
