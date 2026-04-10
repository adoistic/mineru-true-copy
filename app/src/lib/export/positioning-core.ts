/**
 * Positioning core: Pretext-based font sizing for true-copy exports.
 *
 * Extracts the binary search algorithm from true-copy-html.ts's inline script
 * into an importable TypeScript module. Used at export time by DOCX, PPTX, and
 * PDF serializers to compute font sizes that fit text into bounding boxes.
 *
 * IMPORTANT: This module requires a browser/canvas context (Pretext uses
 * CanvasRenderingContext2D for measurement). It MUST run in the Tauri WebView
 * renderer process, not in Node.js API routes or workers.
 *
 * The inline HTML script (getFitScript in true-copy-html.ts) is a separate copy
 * that runs at open-time in self-contained HTML files. Both implementations use
 * the same algorithm and should produce identical results for the same inputs.
 */
import * as Pretext from '@chenglou/pretext';

const LINE_HEIGHT_RATIO = 1.2;
const FLOOR = 1; // minimum font size in points

export interface EquationInfo {
  charOffset: number;
  aspectRatio: number;
  heightRatio: number;
}

export interface FitResult {
  fontSize: number;   // in PDF points
  lineHeight: number; // in PDF points
}

/**
 * Measure text height with equation-aware line wrapping.
 * Equations reduce available width on lines where they appear.
 */
function measureWithEquations(
  text: string,
  font: string,
  boxWidth: number,
  lineH: number,
  eqInfo: EquationInfo[],
  opts?: Record<string, unknown>,
): number {
  const cleanText = text.replace(/\{\{EQ:\d+\}\}/g, '');
  const prepared = Pretext.prepareWithSegments(cleanText, font, opts);

  // Map char offsets from original text to clean text
  const placeholderRe = /\{\{EQ:(\d+)\}\}/g;
  const removals: Array<{ start: number; len: number; idx: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = placeholderRe.exec(text)) !== null) {
    removals.push({ start: m.index, len: m[0].length, idx: parseInt(m[1]) });
  }

  const offsets: number[] = [];
  for (let ri = 0; ri < eqInfo.length; ri++) {
    let cleanOffset = eqInfo[ri].charOffset;
    for (let rj = 0; rj < removals.length; rj++) {
      if (removals[rj].idx === ri) {
        let shift = 0;
        for (let rk = 0; rk < rj; rk++) shift += removals[rk].len;
        cleanOffset = removals[rj].start - shift;
        break;
      }
    }
    offsets.push(cleanOffset);
  }

  let cursor = { segmentIndex: 0, graphemeIndex: 0 };
  let totalHeight = 0;
  let charPos = 0;

  while (true) {
    let eqWidthOnLine = 0;
    for (let ei = 0; ei < eqInfo.length; ei++) {
      const eqH = lineH * eqInfo[ei].heightRatio;
      const eqW = eqH * eqInfo[ei].aspectRatio;
      if (offsets[ei] >= charPos) {
        eqWidthOnLine += eqW;
        offsets[ei] = -1;
      }
    }

    const availWidth = Math.max(boxWidth - eqWidthOnLine, boxWidth * 0.3);
    const line = Pretext.layoutNextLine(prepared, cursor, availWidth);
    if (!line) break;

    totalHeight += lineH;
    cursor = line.end;
    charPos += line.text.length;
  }

  return totalHeight;
}

/**
 * Measure text height at a given font size.
 * Routes to equation-aware path when needed.
 */
function measureAt(
  rawText: string,
  size: number,
  boxWidth: number,
  isBold: boolean,
  opts: Record<string, unknown> | undefined,
  eqInfo: EquationInfo[] | null,
  fontFamily: string,
): number {
  const font = (isBold ? '600 ' : '') + size + 'px ' + fontFamily;
  let lineH = Math.round(size * LINE_HEIGHT_RATIO);
  if (lineH < 1) lineH = 1;

  if (eqInfo && eqInfo.length > 0) {
    return measureWithEquations(rawText, font, boxWidth, lineH, eqInfo, opts);
  }

  const prepared = Pretext.prepare(rawText, font, opts);
  const result = Pretext.layout(prepared, boxWidth, lineH);
  return result.height;
}

/**
 * Probe a descending ladder of candidate sizes to discover [lo, hi] bounds
 * for the binary search. Returns the tightest known band.
 */
function findFontBounds(
  rawText: string,
  boxWidth: number,
  boxHeight: number,
  isBold: boolean,
  opts: Record<string, unknown> | undefined,
  eqInfo: EquationInfo[] | null,
  fontFamily: string,
): { lo: number; hi: number } {
  const ladder = [
    boxHeight * 4,
    boxHeight * 2,
    boxHeight,
    boxHeight / 2,
    boxHeight / 4,
    FLOOR,
  ];

  const clean: number[] = [];
  for (const v of ladder) {
    let val = v;
    if (!isFinite(val) || val <= 0) continue;
    if (val < FLOOR) val = FLOOR;
    if (clean.length === 0 || val < clean[clean.length - 1]) clean.push(val);
  }
  if (clean.length === 0) clean.push(FLOOR);
  if (clean[clean.length - 1] > FLOOR) clean.push(FLOOR);

  let prevFailed: number | null = null;
  for (const size of clean) {
    const h = measureAt(rawText, size, boxWidth, isBold, opts, eqInfo, fontFamily);
    if (h <= boxHeight) {
      const hi = prevFailed !== null ? prevFailed : size;
      return { lo: size, hi };
    }
    prevFailed = size;
  }
  return { lo: FLOOR, hi: FLOOR };
}

/**
 * Binary-search for the largest font size that fits text within a bounding box.
 *
 * Algorithm:
 * 1. Probe a descending ladder to discover dynamic [lo, hi] bounds
 * 2. Binary search within the discovered window (0.5pt precision, max 20 iterations)
 * 3. Measure via Pretext.prepare() + Pretext.layout() (canvas-based, no DOM)
 *
 * @param rawText Plain text content (HTML tags stripped, {{EQ:N}} placeholders intact)
 * @param boxWidth Region width in PDF points
 * @param boxHeight Region height in PDF points
 * @param fontFamily CSS font family string (e.g. "'Tinos', 'Inter', sans-serif")
 * @param isBold Whether to use font-weight 600
 * @param eqInfo Inline equation geometry (null if no equations)
 * @param preWrap Whether to use white-space: pre-wrap
 */
export function fitTextToBox(
  rawText: string,
  boxWidth: number,
  boxHeight: number,
  fontFamily: string,
  isBold: boolean,
  eqInfo: EquationInfo[] | null = null,
  preWrap: boolean = false,
): FitResult {
  if (!rawText || boxWidth <= 0 || boxHeight <= 0) {
    return { fontSize: FLOOR, lineHeight: Math.round(FLOOR * LINE_HEIGHT_RATIO) };
  }

  const opts = preWrap ? { whiteSpace: 'pre-wrap' as const } : undefined;

  // Phase 1: probe ladder to discover [lo, hi] bounds
  const bounds = findFontBounds(rawText, boxWidth, boxHeight, isBold, opts, eqInfo, fontFamily);
  let lo = bounds.lo;
  let hi = bounds.hi;
  let bestSize = lo;

  // Phase 2: binary search within the discovered window
  for (let iter = 0; iter < 20; iter++) {
    if (hi - lo < 0.5) break;
    const mid = (lo + hi) / 2;
    const measuredHeight = measureAt(rawText, mid, boxWidth, isBold, opts, eqInfo, fontFamily);
    if (measuredHeight <= boxHeight) {
      bestSize = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  if (bestSize < FLOOR) bestSize = FLOOR;

  return {
    fontSize: bestSize,
    lineHeight: Math.round(bestSize * LINE_HEIGHT_RATIO),
  };
}
