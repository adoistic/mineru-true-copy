#!/bin/bash
set -e

# Build MinerU server as a PyInstaller --onedir bundle.
# Outputs to: dist/mineru-server/

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

echo "=== Building MinerU server binary ==="
echo "Project: $PROJECT_DIR"

# Use the test-venv which has all dependencies
VENV="$PROJECT_DIR/test-venv"
if [ ! -f "$VENV/bin/pyinstaller" ]; then
    echo "ERROR: PyInstaller not found in $VENV"
    echo "Install with: $VENV/bin/pip install pyinstaller"
    exit 1
fi

# Clean previous build
rm -rf "$PROJECT_DIR/dist/mineru-server" "$PROJECT_DIR/build/mineru-server"

# Run PyInstaller
"$VENV/bin/pyinstaller" scripts/bundle-mineru.spec \
    --distpath "$PROJECT_DIR/dist" \
    --workpath "$PROJECT_DIR/build" \
    --noconfirm

# Verify the binary was created
BINARY="$PROJECT_DIR/dist/mineru-server/mineru-server"
if [ ! -f "$BINARY" ]; then
    echo "ERROR: Binary not found at $BINARY"
    exit 1
fi

# Report size
SIZE=$(du -sh "$PROJECT_DIR/dist/mineru-server" | cut -f1)
echo ""
echo "=== Build complete ==="
echo "Output: $PROJECT_DIR/dist/mineru-server/"
echo "Size: $SIZE"
echo ""
echo "Test with:"
echo "  $BINARY --port 8765"
echo "  curl http://127.0.0.1:8765/health"
