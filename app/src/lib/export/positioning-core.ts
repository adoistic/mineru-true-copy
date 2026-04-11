/**
 * Positioning core: font sizing for true-copy exports.
 *
 * Three modes (auto-selected):
 * 1. Pretext-based (canvas required): Pixel-perfect binary search via
 *    CanvasRenderingContext2D. Used in Tauri WebView renderer process.
 * 2. Font-metric based (TTF data provided): Uses opentype.js to parse the
 *    TTF and compute exact advance widths. Used in Node.js API routes
 *    when the font TTF has been fetched from MinerU.
 * 3. Heuristic fallback (no canvas, no TTF): Estimates font size from bbox
 *    dimensions using statistical character width ratios. Last resort only.
 *
 * The exported `fitTextToBox()` function auto-detects the environment and
 * falls back gracefully.
 */

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
 * Check if Pretext canvas measurement is available in this environment.
 */
function canUsePretext(): boolean {
  try {
    // OffscreenCanvas is available in modern browsers and some Node.js builds
    if (typeof OffscreenCanvas !== 'undefined') return true;
    // DOM canvas fallback
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const canvas = document.createElement('canvas');
      return !!canvas.getContext('2d');
    }
    return false;
  } catch {
    return false;
  }
}

let _pretextAvailable: boolean | null = null;
function isPretextAvailable(): boolean {
  if (_pretextAvailable === null) _pretextAvailable = canUsePretext();
  return _pretextAvailable;
}

// ─── Font-metric based measurement (opentype.js) ──────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpentypeFont = any;

// Cache parsed opentype fonts by family name
const _opentypeFontCache = new Map<string, OpentypeFont>();

/**
 * Load and cache an opentype.js font from TTF data.
 */
function getOpentypeFont(ttfData: ArrayBuffer, familyKey: string): OpentypeFont | null {
  const cached = _opentypeFontCache.get(familyKey);
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const opentype = require('opentype.js');
    const font = opentype.parse(ttfData);
    _opentypeFontCache.set(familyKey, font);
    return font;
  } catch {
    return null;
  }
}

/**
 * Measure text width at a given font size using opentype.js advance widths.
 */
function measureTextWidth(
  opFont: OpentypeFont,
  text: string,
  fontSize: number,
): number {
  return opFont.getAdvanceWidth(text, fontSize);
}

/**
 * Compute total height needed for text at a given font size using real font metrics.
 * Word-wraps text using actual advance widths from the TTF.
 */
function totalHeightWithMetrics(
  opFont: OpentypeFont,
  lines: string[],
  fontSize: number,
  boxWidth: number,
): number {
  const lineH = fontSize * LINE_HEIGHT_RATIO;
  let totalLines = 0;

  for (const line of lines) {
    if (!line.trim()) {
      totalLines += 1;
      continue;
    }

    // Word-wrap using actual font metrics
    const words = line.split(/\s+/);
    let currentLine = '';
    let wrappedCount = 0;

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const testWidth = measureTextWidth(opFont, testLine, fontSize);

      if (testWidth <= boxWidth || !currentLine) {
        currentLine = testLine;
      } else {
        wrappedCount++;
        currentLine = word;
      }
    }
    if (currentLine) wrappedCount++;
    totalLines += Math.max(1, wrappedCount);
  }

  return totalLines * lineH;
}

/**
 * Estimate font size using real font metrics from TTF data (opentype.js).
 * Binary search for the largest font size where wrapped text fits in the box.
 */
function estimateFontSizeWithMetrics(
  rawText: string,
  boxWidth: number,
  boxHeight: number,
  ttfData: ArrayBuffer,
  fontFamily: string,
): FitResult {
  if (!rawText || boxWidth <= 0 || boxHeight <= 0) {
    return { fontSize: FLOOR, lineHeight: Math.round(FLOOR * LINE_HEIGHT_RATIO) };
  }

  const opFont = getOpentypeFont(ttfData, fontFamily);
  if (!opFont) {
    // Fall back to heuristic if font parsing fails
    return estimateFontSizeHeuristic(rawText, boxWidth, boxHeight);
  }

  const lines = rawText.split('\n');

  // Binary search for largest font size that fits
  let lo = FLOOR;
  let hi = boxHeight; // max possible (single char fills box)
  let bestSize = FLOOR;

  for (let iter = 0; iter < 25; iter++) {
    if (hi - lo < 0.25) break;
    const mid = (lo + hi) / 2;
    const h = totalHeightWithMetrics(opFont, lines, mid, boxWidth);
    if (h <= boxHeight) {
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

// ─── Heuristic fallback (no canvas, no TTF) ────────────────────────────────

// Fallback average character width ratios by font category
const FONT_WIDTH_RATIOS: Record<string, number> = {
  'monospace': 0.60,
  'serif': 0.44,
  'sans-serif': 0.50,
  'default': 0.48,
};

function guessWidthRatio(fontFamily: string): number {
  const lower = fontFamily.toLowerCase();
  if (lower.includes('courier') || lower.includes('mono') || lower.includes('consolas')) {
    return FONT_WIDTH_RATIOS['monospace'];
  }
  if (lower.includes('times') || lower.includes('georgia') || lower.includes('serif') && !lower.includes('sans')) {
    return FONT_WIDTH_RATIOS['serif'];
  }
  if (lower.includes('arial') || lower.includes('helvetica') || lower.includes('calibri') || lower.includes('inter') || lower.includes('rubik')) {
    return FONT_WIDTH_RATIOS['sans-serif'];
  }
  return FONT_WIDTH_RATIOS['default'];
}

/**
 * Estimate font size from bbox dimensions and text content (heuristic).
 * Used only when both Pretext and TTF data are unavailable.
 */
function estimateFontSizeHeuristic(
  rawText: string,
  boxWidth: number,
  boxHeight: number,
  fontFamily?: string,
): FitResult {
  if (!rawText || boxWidth <= 0 || boxHeight <= 0) {
    return { fontSize: FLOOR, lineHeight: Math.round(FLOOR * LINE_HEIGHT_RATIO) };
  }

  const avgCharWidthRatio = guessWidthRatio(fontFamily || 'default');
  const lines = rawText.split('\n');

  function totalHeightAtSize(size: number): number {
    const lineH = size * LINE_HEIGHT_RATIO;
    const charW = size * avgCharWidthRatio;
    const charsPerLine = Math.max(1, Math.floor(boxWidth / charW));
    let totalLines = 0;
    for (const line of lines) {
      totalLines += Math.max(1, Math.ceil(line.length / charsPerLine));
    }
    return totalLines * lineH;
  }

  // Binary search for largest font size that fits
  let lo = FLOOR;
  let hi = boxHeight;
  let bestSize = FLOOR;

  for (let iter = 0; iter < 20; iter++) {
    if (hi - lo < 0.5) break;
    const mid = (lo + hi) / 2;
    if (totalHeightAtSize(mid) <= boxHeight) {
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

// ─── Pretext-based measurement (canvas required) ────────────────────────────

/**
 * Lazy-load Pretext only when canvas is available, to avoid import-time errors
 * in Node.js environments.
 */
let _Pretext: typeof import('@chenglou/pretext') | null = null;
function getPretext() {
  if (!_Pretext) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _Pretext = require('@chenglou/pretext');
  }
  return _Pretext!;
}

/**
 * Measure text height with equation-aware line wrapping.
 */
function measureWithEquations(
  text: string,
  font: string,
  boxWidth: number,
  lineH: number,
  eqInfo: EquationInfo[],
  opts?: Record<string, unknown>,
): number {
  const Pretext = getPretext();
  const cleanText = text.replace(/\{\{EQ:\d+\}\}/g, '');
  const prepared = Pretext.prepareWithSegments(cleanText, font, opts);

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
 * Measure text height at a given font size (canvas-based).
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
  const Pretext = getPretext();
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
 * Probe a descending ladder of candidate sizes to discover [lo, hi] bounds.
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

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Find the largest font size that fits text within a bounding box.
 *
 * Auto-detects environment:
 * - With canvas (browser/Tauri): Pretext binary search for pixel-perfect results
 * - With TTF data (server-side): opentype.js for exact font-metric measurement
 * - Without either: Heuristic estimation (last resort)
 *
 * @param rawText Plain text content (HTML tags stripped)
 * @param boxWidth Region width in PDF points
 * @param boxHeight Region height in PDF points
 * @param fontFamily CSS font family string
 * @param isBold Whether to use font-weight 600
 * @param eqInfo Inline equation geometry (null if no equations)
 * @param preWrap Whether to use white-space: pre-wrap
 * @param ttfData Optional TTF font data for server-side metric measurement
 */
export function fitTextToBox(
  rawText: string,
  boxWidth: number,
  boxHeight: number,
  fontFamily: string,
  isBold: boolean,
  eqInfo: EquationInfo[] | null = null,
  preWrap: boolean = false,
  ttfData?: ArrayBuffer | null,
): FitResult {
  if (!rawText || boxWidth <= 0 || boxHeight <= 0) {
    return { fontSize: FLOOR, lineHeight: Math.round(FLOOR * LINE_HEIGHT_RATIO) };
  }

  // Server-side with TTF data: use real font metrics
  if (!isPretextAvailable()) {
    if (ttfData) {
      return estimateFontSizeWithMetrics(rawText, boxWidth, boxHeight, ttfData, fontFamily);
    }
    return estimateFontSizeHeuristic(rawText, boxWidth, boxHeight, fontFamily);
  }

  // Canvas available: use Pretext for pixel-perfect measurement
  const opts = preWrap ? { whiteSpace: 'pre-wrap' as const } : undefined;

  const bounds = findFontBounds(rawText, boxWidth, boxHeight, isBold, opts, eqInfo, fontFamily);
  let lo = bounds.lo;
  let hi = bounds.hi;
  let bestSize = lo;

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

/**
 * Clear the opentype font cache. Call after export session completes.
 */
export function clearPositioningCache(): void {
  _opentypeFontCache.clear();
}
