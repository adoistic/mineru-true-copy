#!/bin/bash
set -e

# Build the Node.js standalone sidecar for Tauri bundling.
#
# Outputs:
#   src-tauri/resources/node-standalone/  — Next.js standalone server + static files
#   src-tauri/resources/node-runtime/     — Node.js binary
#   src-tauri/binaries/node-server-aarch64-apple-darwin  — wrapper script

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TAURI_DIR="$PROJECT_DIR/src-tauri"

# Node.js version to bundle (LTS)
NODE_VERSION="${NODE_VERSION:-22.16.0}"
NODE_ARCH="arm64"
NODE_PLATFORM="darwin"
CACHE_DIR="$SCRIPT_DIR/.cache"

echo "=== Building Node.js sidecar ==="

# --- Step 1: Build Next.js standalone ---
echo ""
echo "--- Step 1: Building Next.js standalone ---"
cd "$PROJECT_DIR/app"

# Embed API key at build time if available
if [ -f "$PROJECT_DIR/app/.env.local" ]; then
    echo "Loading .env.local for build-time env"
    set -a
    source "$PROJECT_DIR/app/.env.local"
    set +a
fi

PATH="/opt/homebrew/opt/node/bin:$PATH"
npm run build

# Verify standalone output
if [ ! -f "$PROJECT_DIR/app/.next/standalone/server.js" ]; then
    echo "ERROR: Next.js standalone output not found at app/.next/standalone/server.js"
    echo "Ensure next.config.ts has: output: 'standalone'"
    exit 1
fi

# --- Step 2: Download Node.js runtime ---
echo ""
echo "--- Step 2: Downloading Node.js ${NODE_VERSION} (${NODE_ARCH}) ---"
mkdir -p "$CACHE_DIR"
NODE_TARBALL="node-v${NODE_VERSION}-${NODE_PLATFORM}-${NODE_ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"

if [ -f "$CACHE_DIR/$NODE_TARBALL" ]; then
    echo "Using cached $NODE_TARBALL"
else
    echo "Downloading $NODE_URL"
    curl -fL -o "$CACHE_DIR/$NODE_TARBALL" "$NODE_URL"
fi

# Extract just the node binary
NODE_EXTRACT_DIR="$CACHE_DIR/node-v${NODE_VERSION}-${NODE_PLATFORM}-${NODE_ARCH}"
if [ ! -f "$NODE_EXTRACT_DIR/bin/node" ]; then
    echo "Extracting node binary..."
    cd "$CACHE_DIR"
    tar xzf "$NODE_TARBALL"
fi

# --- Step 3: Copy files to Tauri resources ---
echo ""
echo "--- Step 3: Copying to Tauri resources ---"

# Clean previous
rm -rf "$TAURI_DIR/resources/node-standalone" "$TAURI_DIR/resources/node-runtime"
mkdir -p "$TAURI_DIR/resources/node-standalone" "$TAURI_DIR/resources/node-runtime/bin"

# Copy standalone server
cp -r "$PROJECT_DIR/app/.next/standalone/." "$TAURI_DIR/resources/node-standalone/"

# Copy static files (Next.js standalone doesn't include these automatically)
if [ -d "$PROJECT_DIR/app/.next/static" ]; then
    mkdir -p "$TAURI_DIR/resources/node-standalone/.next/static"
    cp -r "$PROJECT_DIR/app/.next/static/." "$TAURI_DIR/resources/node-standalone/.next/static/"
fi

# Copy public dir
if [ -d "$PROJECT_DIR/app/public" ]; then
    mkdir -p "$TAURI_DIR/resources/node-standalone/public"
    cp -r "$PROJECT_DIR/app/public/." "$TAURI_DIR/resources/node-standalone/public/"
fi

# Copy Node.js binary
cp "$NODE_EXTRACT_DIR/bin/node" "$TAURI_DIR/resources/node-runtime/bin/node"

# --- Step 4: Create wrapper script ---
echo ""
echo "--- Step 4: Creating sidecar wrapper ---"
mkdir -p "$TAURI_DIR/binaries"

cat > "$TAURI_DIR/binaries/node-server-aarch64-apple-darwin" << 'WRAPPER'
#!/bin/bash
# Node.js sidecar wrapper for MinerU True Copy
# Usage: node-server <port> <mineru_url>
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-3000}"
MINERU_URL="${2:-http://127.0.0.1:8765}"

export PORT="$PORT"
export MINERU_API_URL="$MINERU_URL"
export NODE_ENV="production"

exec "$DIR/../Resources/node-runtime/bin/node" "$DIR/../Resources/node-standalone/server.js"
WRAPPER

chmod +x "$TAURI_DIR/binaries/node-server-aarch64-apple-darwin"

# --- Report ---
STANDALONE_SIZE=$(du -sh "$TAURI_DIR/resources/node-standalone" | cut -f1)
NODE_SIZE=$(du -sh "$TAURI_DIR/resources/node-runtime" | cut -f1)

echo ""
echo "=== Build complete ==="
echo "Standalone server: $TAURI_DIR/resources/node-standalone/ ($STANDALONE_SIZE)"
echo "Node.js runtime:   $TAURI_DIR/resources/node-runtime/ ($NODE_SIZE)"
echo "Wrapper script:    $TAURI_DIR/binaries/node-server-aarch64-apple-darwin"
echo ""
echo "Test with:"
echo "  PORT=3001 MINERU_API_URL=http://127.0.0.1:8765 $TAURI_DIR/resources/node-runtime/bin/node $TAURI_DIR/resources/node-standalone/server.js"
