#!/bin/bash
# Convert a Word/Excel/PowerPoint/etc. file to PDF via local LibreOffice headless.
#
# Usage:
#   samples/to-pdf.sh <input-file> [output-dir]
#
# Defaults: output-dir = samples/out/
#
# Examples:
#   samples/to-pdf.sh samples/out/iess102-true-copy.docx
#   samples/to-pdf.sh report.pptx /tmp
#
# Requires LibreOffice installed at /Applications/LibreOffice.app or on PATH as `soffice`.

set -euo pipefail

INPUT="${1:?Usage: $0 <input-file> [output-dir]}"
OUTDIR="${2:-$(dirname "$0")/out}"

# Find soffice — prefer the macOS .app bundle (consistent across machines),
# fall back to PATH (Homebrew or Linux).
SOFFICE=""
if [ -x "/Applications/LibreOffice.app/Contents/MacOS/soffice" ]; then
  SOFFICE="/Applications/LibreOffice.app/Contents/MacOS/soffice"
elif command -v soffice >/dev/null 2>&1; then
  SOFFICE="$(command -v soffice)"
elif command -v libreoffice >/dev/null 2>&1; then
  SOFFICE="$(command -v libreoffice)"
else
  echo "Error: LibreOffice not found. Install from https://www.libreoffice.org/" >&2
  exit 1
fi

if [ ! -f "$INPUT" ]; then
  echo "Error: input file not found: $INPUT" >&2
  exit 1
fi

mkdir -p "$OUTDIR"

# soffice writes the output PDF as <basename>.pdf in --outdir.
"$SOFFICE" --headless --convert-to pdf --outdir "$OUTDIR" "$INPUT"

BASENAME="$(basename "${INPUT%.*}")"
echo ""
echo "Wrote: $OUTDIR/$BASENAME.pdf"
