#!/bin/bash
# Download Noto Sans variable fonts for Indic script support.
# Fonts are placed in app/public/fonts/noto/ for bundled serving.
#
# These are variable-weight TTF files (contain Regular through Bold and beyond).
# pdf-lib + fontkit handles variable fonts natively.
#
# Usage: bash scripts/download-noto-fonts.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FONT_DIR="$PROJECT_ROOT/app/public/fonts/noto"

mkdir -p "$FONT_DIR"

BASE_URL="https://raw.githubusercontent.com/google/fonts/main/ofl"

# Map: local filename -> GitHub path (URL-encoded)
# Variable fonts use [wdth,wght] or [wght] axis notation
declare -a FONTS=(
  "NotoSans.ttf|notosans/NotoSans%5Bwdth%2Cwght%5D.ttf"
  "NotoSansDevanagari.ttf|notosansdevanagari/NotoSansDevanagari%5Bwdth%2Cwght%5D.ttf"
  "NotoSansBengali.ttf|notosansbengali/NotoSansBengali%5Bwdth%2Cwght%5D.ttf"
  "NotoSansTamil.ttf|notosanstamil/NotoSansTamil%5Bwdth%2Cwght%5D.ttf"
  "NotoSansTelugu.ttf|notosanstelugu/NotoSansTelugu%5Bwdth%2Cwght%5D.ttf"
  "NotoSansGujarati.ttf|notosansgujarati/NotoSansGujarati%5Bwdth%2Cwght%5D.ttf"
  "NotoSansKannada.ttf|notosanskannada/NotoSansKannada%5Bwdth%2Cwght%5D.ttf"
  "NotoSansMalayalam.ttf|notosansmalayalam/NotoSansMalayalam%5Bwdth%2Cwght%5D.ttf"
  "NotoSansGurmukhi.ttf|notosansgurmukhi/NotoSansGurmukhi%5Bwdth%2Cwght%5D.ttf"
  "NotoSansOriya.ttf|notosansoriya/NotoSansOriya%5Bwdth%2Cwght%5D.ttf"
)

ok=0
fail=0

for entry in "${FONTS[@]}"; do
  local_name="${entry%%|*}"
  remote_path="${entry##*|}"
  url="${BASE_URL}/${remote_path}"
  dest="$FONT_DIR/$local_name"

  if [ -f "$dest" ] && [ -s "$dest" ]; then
    echo "SKIP: $local_name (already exists)"
    ok=$((ok + 1))
    continue
  fi

  echo -n "Downloading $local_name ... "
  if curl -sL -o "$dest" "$url" && [ -s "$dest" ] && file "$dest" | grep -qi "truetype\|font"; then
    size=$(ls -lh "$dest" | awk '{print $5}')
    echo "OK ($size)"
    ok=$((ok + 1))
  else
    echo "FAILED"
    rm -f "$dest"
    fail=$((fail + 1))
  fi
done

echo ""
echo "Results: $ok downloaded, $fail failed"
echo ""
ls -lh "$FONT_DIR"/*.ttf 2>/dev/null || echo "No fonts found."
