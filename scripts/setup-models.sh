#!/bin/bash
# Phase 4 of scripts/setup.sh — download MinerU ML models.
#
# Pulls ~3.4 GB of models from Hugging Face into the locations the
# MinerU runtime expects:
#   ~/models/MinerU/models/{Layout,MFD,MFR,OCR,TabRec}/
#   ~/.cache/huggingface/hub/models--hantian--layoutreader/
#
# Also writes ~/magic-pdf.json pointing at the models dir. MinerU's
# runtime requires this config file; without it, _get_models_dir() in
# mineru_server.py returns None and warm-up logs a warning.
#
# Uses huggingface_hub Python lib (resumable, integrity-checked,
# parallel-safe). Re-runs are cheap: HF cache stays warm.
#
# Exit code 4 = model download failure.

set -e

PHASE="models"
EXIT_MODELS=4

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_PYTHON="$PROJECT_DIR/mineru-venv/bin/python"
MODELS_DIR="$HOME/models/MinerU/models"
MAGIC_PDF_CONFIG="$HOME/magic-pdf.json"

echo "=== Phase 4/6: Model download (~3.4 GB) ==="

if [ ! -x "$VENV_PYTHON" ]; then
    echo "❌ mineru-venv not provisioned (run phase 2 first)" >&2
    exit "$EXIT_MODELS"
fi

# Confirm before mutating $HOME with a large download
if [ ! -d "$MODELS_DIR" ]; then
    echo ""
    echo "This will download ~3.4 GB to $MODELS_DIR."
    echo "Cache: ~/.cache/huggingface/hub/ (kept across runs to avoid re-downloads)."
    read -r -p "Proceed? [y/N] " ans
    case "$ans" in
        [yY]|[yY][eE][sS]) ;;
        *) echo "Aborted by user."; exit "$EXIT_MODELS" ;;
    esac
fi

mkdir -p "$MODELS_DIR"

# Run the download via the venv's python (huggingface_hub is in requirements.txt)
"$VENV_PYTHON" - <<PYEOF
import os
import sys
from huggingface_hub import snapshot_download

models_dir = os.path.expanduser("~/models/MinerU/models")
os.makedirs(models_dir, exist_ok=True)

# Each tuple: (HF repo, local subdirectory under models_dir, allow_patterns)
# Subdir names match what build-app.sh expects when copying for bundling
# and what mineru_server.py reads at runtime.
DOWNLOADS = [
    ("opendatalab/PDF-Extract-Kit-1.0", None, ["models/Layout/**", "models/MFD/**", "models/MFR/**", "models/OCR/**", "models/TabRec/**"]),
    ("hantian/layoutreader", None, None),  # downloaded into HF cache by default
]

for repo, subdir, patterns in DOWNLOADS:
    print(f"\n→ {repo}")
    target = os.path.join(models_dir, subdir) if subdir else None
    try:
        snapshot_download(
            repo_id=repo,
            local_dir=target,
            allow_patterns=patterns,
            max_workers=4,
        )
    except Exception as e:
        print(f"   FAILED: {e}", file=sys.stderr)
        print(f"   Re-run setup.sh to resume; HF cache makes retries cheap.", file=sys.stderr)
        sys.exit(1)

# Move PDF-Extract-Kit's models/ subtree up to models_dir if it landed nested
import shutil
nested = os.path.join(models_dir, "models")
if os.path.isdir(nested):
    for item in os.listdir(nested):
        src = os.path.join(nested, item)
        dst = os.path.join(models_dir, item)
        if not os.path.exists(dst):
            shutil.move(src, dst)
    os.rmdir(nested)

print("\n✓ All models downloaded.")
PYEOF

# Write the magic-pdf.json config MinerU runtime requires
echo ""
echo "Writing ~/magic-pdf.json..."
cat > "$MAGIC_PDF_CONFIG" <<EOF
{
  "models-dir": "$MODELS_DIR",
  "device-mode": "mps",
  "table-config": {
    "model": "rapid_table",
    "enable": true,
    "max_time": 400
  },
  "layout-config": {
    "model": "doclayout_yolo"
  },
  "formula-config": {
    "mfd_model": "yolo_v8_mfd",
    "mfr_model": "unimernet_small",
    "enable": true
  }
}
EOF

# Total size sanity check
TOTAL_SIZE=$(du -sh "$MODELS_DIR" 2>/dev/null | cut -f1)
echo "✓ Models in $MODELS_DIR ($TOTAL_SIZE)"
echo "✓ Config at $MAGIC_PDF_CONFIG"
echo "=== Phase 4 OK ==="
