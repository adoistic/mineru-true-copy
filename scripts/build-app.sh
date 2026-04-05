#!/bin/bash
set -e

# Full build orchestrator for DocTransform .dmg
#
# Builds everything in order:
#   1. Next.js standalone + Node.js sidecar
#   2. PyInstaller MinerU binary
#   3. Copies ML models (only the ones we need)
#   4. Builds Tauri .dmg
#
# Prerequisites:
#   - test-venv/ with PyInstaller + MinerU deps
#   - app/node_modules/ installed
#   - Models downloaded at ~/models/MinerU/models/
#   - ~/.cache/huggingface/hub/models--hantian--layoutreader/
#
# Usage:
#   bash scripts/build-app.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TAURI_DIR="$PROJECT_DIR/src-tauri"

echo "=========================================="
echo "  DocTransform Build"
echo "=========================================="
echo ""

# --- Step 1: Node.js sidecar ---
echo ">>> Step 1/4: Building Node.js sidecar"
bash "$SCRIPT_DIR/build-node-sidecar.sh"
echo ""

# --- Step 2: PyInstaller MinerU binary ---
echo ">>> Step 2/4: Building MinerU binary"
bash "$SCRIPT_DIR/build-mineru.sh"

# Copy PyInstaller output to Tauri binaries
echo "Copying MinerU binary to Tauri binaries..."
rm -rf "$TAURI_DIR/binaries/mineru-server-aarch64-apple-darwin"
cp -r "$PROJECT_DIR/dist/mineru-server" "$TAURI_DIR/binaries/mineru-server-aarch64-apple-darwin"
echo ""

# --- Step 3: Copy ML models ---
echo ">>> Step 3/4: Copying ML models (~1.9GB)"
MODELS_SRC="$HOME/models/MinerU/models"
MODELS_DST="$TAURI_DIR/resources/models"
LAYOUTREADER_SRC="$HOME/.cache/huggingface/hub/models--hantian--layoutreader"

rm -rf "$MODELS_DST"
mkdir -p "$MODELS_DST"

# Layout model (DocLayout-YOLO) — ~127MB
if [ -d "$MODELS_SRC/Layout" ]; then
    echo "  Copying Layout/YOLO (DocLayout-YOLO)..."
    cp -r "$MODELS_SRC/Layout" "$MODELS_DST/"
else
    echo "  WARNING: Layout model not found at $MODELS_SRC/Layout"
fi

# MFD model (YOLO v8 Math Formula Detection) — ~334MB
if [ -d "$MODELS_SRC/MFD" ]; then
    echo "  Copying MFD/YOLO (formula detection)..."
    cp -r "$MODELS_SRC/MFD" "$MODELS_DST/"
else
    echo "  WARNING: MFD model not found at $MODELS_SRC/MFD"
fi

# MFR model (UniMerNet formula recognition) — ~776MB
if [ -d "$MODELS_SRC/MFR" ]; then
    echo "  Copying MFR/UniMerNet (formula recognition)..."
    cp -r "$MODELS_SRC/MFR" "$MODELS_DST/"
else
    echo "  WARNING: MFR model not found at $MODELS_SRC/MFR"
fi

# Layoutreader (reading order) — ~680MB
if [ -d "$LAYOUTREADER_SRC" ]; then
    echo "  Copying layoutreader (reading order)..."
    cp -r "$LAYOUTREADER_SRC" "$MODELS_DST/layoutreader"
else
    echo "  WARNING: layoutreader not found at $LAYOUTREADER_SRC"
fi

MODELS_SIZE=$(du -sh "$MODELS_DST" | cut -f1)
echo "  Models total: $MODELS_SIZE"
echo ""

# --- Step 4: Tauri build ---
echo ">>> Step 4/4: Building Tauri .dmg"
cd "$TAURI_DIR"

# Use cargo-tauri if available, fall back to npx
if command -v cargo-tauri &> /dev/null; then
    cargo tauri build
elif command -v npx &> /dev/null; then
    npx @tauri-apps/cli build
else
    echo "ERROR: Neither cargo-tauri nor npx found. Install with:"
    echo "  cargo install tauri-cli"
    echo "  or: npm install -g @tauri-apps/cli"
    exit 1
fi

echo ""
echo "=========================================="
echo "  Build Complete!"
echo "=========================================="
echo ""

# Find the .dmg
DMG=$(find "$TAURI_DIR/target/release/bundle" -name "*.dmg" 2>/dev/null | head -1)
if [ -n "$DMG" ]; then
    DMG_SIZE=$(du -sh "$DMG" | cut -f1)
    echo "DMG: $DMG"
    echo "Size: $DMG_SIZE"
else
    echo "DMG not found — check $TAURI_DIR/target/release/bundle/"
fi
