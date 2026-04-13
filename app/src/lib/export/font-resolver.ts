/**
 * Script-aware font resolver for Indic and Latin text.
 *
 * Detects the dominant Unicode script in a text string and resolves
 * the best available font:
 *   1. Document-embedded font (from MinerU sidecar) — highest priority
 *   2. Bundled Noto Sans for the detected script
 *   3. Bundled Noto Sans Latin (fallback for Latin text)
 *   4. Helvetica (absolute last resort, Latin-only)
 *
 * NEVER returns Helvetica for non-Latin scripts (it can't render them).
 */

// ─── Script Detection ─────────────────────────────────────────────────────

export type Script =
  | 'latin'
  | 'devanagari'
  | 'bengali'
  | 'tamil'
  | 'telugu'
  | 'gujarati'
  | 'kannada'
  | 'malayalam'
  | 'gurmukhi'
  | 'oriya';

interface ScriptRange {
  script: Script;
  start: number;
  end: number;
}

/**
 * Unicode block ranges for Indic scripts.
 * Each entry: [start, end] (inclusive) of the Unicode codepoint range.
 */
const SCRIPT_RANGES: ScriptRange[] = [
  // Devanagari + Devanagari Extended
  { script: 'devanagari', start: 0x0900, end: 0x097f },
  { script: 'devanagari', start: 0xa8e0, end: 0xa8ff },
  { script: 'devanagari', start: 0x11b00, end: 0x11b5f },
  // Bengali
  { script: 'bengali', start: 0x0980, end: 0x09ff },
  // Gurmukhi (Punjabi)
  { script: 'gurmukhi', start: 0x0a00, end: 0x0a7f },
  // Gujarati
  { script: 'gujarati', start: 0x0a80, end: 0x0aff },
  // Oriya
  { script: 'oriya', start: 0x0b00, end: 0x0b7f },
  // Tamil
  { script: 'tamil', start: 0x0b80, end: 0x0bff },
  // Telugu
  { script: 'telugu', start: 0x0c00, end: 0x0c7f },
  // Kannada
  { script: 'kannada', start: 0x0c80, end: 0x0cff },
  // Malayalam
  { script: 'malayalam', start: 0x0d00, end: 0x0d7f },
];

/**
 * Detect the dominant script in a text string by counting codepoints.
 *
 * Ignores ASCII punctuation/digits/whitespace. If no Indic script is
 * detected, returns 'latin'.
 */
export function detectScript(text: string): Script {
  const counts = new Map<Script, number>();

  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    // Skip surrogate pair trailing unit
    if (cp > 0xffff) i++;

    // Skip common characters (ASCII, punctuation, whitespace, digits)
    if (cp < 0x0080) continue;

    for (const range of SCRIPT_RANGES) {
      if (cp >= range.start && cp <= range.end) {
        counts.set(range.script, (counts.get(range.script) || 0) + 1);
        break;
      }
    }
  }

  if (counts.size === 0) return 'latin';

  // Return the script with the highest count
  let maxScript: Script = 'latin';
  let maxCount = 0;
  for (const [script, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      maxScript = script;
    }
  }
  return maxScript;
}

// ─── Font File Mapping ────────────────────────────────────────────────────

/**
 * Maps each script to its bundled Noto Sans font filename.
 * These are variable-weight TTF files served from /fonts/noto/.
 */
const NOTO_FONT_FILES: Record<Script, string> = {
  latin: 'NotoSans.ttf',
  devanagari: 'NotoSansDevanagari.ttf',
  bengali: 'NotoSansBengali.ttf',
  tamil: 'NotoSansTamil.ttf',
  telugu: 'NotoSansTelugu.ttf',
  gujarati: 'NotoSansGujarati.ttf',
  kannada: 'NotoSansKannada.ttf',
  malayalam: 'NotoSansMalayalam.ttf',
  gurmukhi: 'NotoSansGurmukhi.ttf',
  oriya: 'NotoSansOriya.ttf',
};

/**
 * CSS font-family names for bundled Noto Sans fonts.
 */
const NOTO_FAMILY_NAMES: Record<Script, string> = {
  latin: 'Noto Sans',
  devanagari: 'Noto Sans Devanagari',
  bengali: 'Noto Sans Bengali',
  tamil: 'Noto Sans Tamil',
  telugu: 'Noto Sans Telugu',
  gujarati: 'Noto Sans Gujarati',
  kannada: 'Noto Sans Kannada',
  malayalam: 'Noto Sans Malayalam',
  gurmukhi: 'Noto Sans Gurmukhi',
  oriya: 'Noto Sans Oriya',
};

export function getNotoFontFile(script: Script): string {
  return NOTO_FONT_FILES[script];
}

export function getNotoFamilyName(script: Script): string {
  return NOTO_FAMILY_NAMES[script];
}

/**
 * Get the URL path for a bundled Noto font (relative to public/).
 */
export function getNotoFontPath(script: Script): string {
  return `/fonts/noto/${NOTO_FONT_FILES[script]}`;
}

// ─── Font Resolution ──────────────────────────────────────────────────────

export interface FontSelection {
  /** The selected font family name */
  family: string;
  /** Source of the font: 'document' | 'bundled-noto' | 'helvetica' */
  source: 'document' | 'bundled-noto' | 'helvetica';
  /** The detected script of the text */
  script: Script;
  /** Bundled font filename (only set when source is 'bundled-noto') */
  notoFile?: string;
  /** Document font filename (only set when source is 'document') */
  documentFile?: string;
}

/**
 * Resolve the best font for a given text string.
 *
 * Priority:
 *   1. Document-embedded font (if usedFonts provided and non-empty)
 *   2. Bundled Noto Sans for detected script
 *   3. Bundled Noto Sans Latin
 *   4. Helvetica (ONLY for Latin text — never for Indic)
 *
 * @param text - The text to render
 * @param usedFonts - Document fonts from MinerU (filename → family)
 * @param preferDocumentFont - If true, prefer document font even for Indic text.
 *   Set to false when the document font is known to not support the script.
 */
export function resolveFont(
  text: string,
  usedFonts?: Record<string, string>,
  preferDocumentFont = true,
): FontSelection {
  const script = detectScript(text);

  // 1. Try document-embedded font (highest priority for Latin, optional for Indic)
  if (preferDocumentFont && usedFonts && Object.keys(usedFonts).length > 0) {
    const [filename, family] = Object.entries(usedFonts)[0];
    return {
      family,
      source: 'document',
      script,
      documentFile: filename,
    };
  }

  // 2. Bundled Noto Sans for the detected script
  // This is the primary path for Indic scripts and a solid fallback for Latin
  return {
    family: NOTO_FAMILY_NAMES[script],
    source: 'bundled-noto',
    script,
    notoFile: NOTO_FONT_FILES[script],
  };
}

/**
 * Resolve font specifically for non-Latin scripts, bypassing document fonts.
 * Use this when you know the document font can't render the text's script
 * (e.g., translated output that uses a different script than the source).
 */
export function resolveFontForScript(script: Script): FontSelection {
  if (script === 'latin') {
    return {
      family: 'Noto Sans',
      source: 'bundled-noto',
      script,
      notoFile: NOTO_FONT_FILES.latin,
    };
  }

  return {
    family: NOTO_FAMILY_NAMES[script],
    source: 'bundled-noto',
    script,
    notoFile: NOTO_FONT_FILES[script],
  };
}

/**
 * Check if a script requires a non-Latin font.
 * Returns true for all Indic scripts.
 */
export function isIndicScript(script: Script): boolean {
  return script !== 'latin';
}

/**
 * Get all supported scripts.
 */
export function getAllScripts(): Script[] {
  return Object.keys(NOTO_FONT_FILES) as Script[];
}

/**
 * Build a CSS font-family stack for the given text.
 * Includes the document font (if any), script-specific Noto, Noto Sans Latin, and sans-serif.
 */
export function buildFontFamilyStack(
  text: string,
  documentFontFamily?: string,
): string {
  const script = detectScript(text);
  const parts: string[] = [];

  if (documentFontFamily) {
    parts.push(`'${documentFontFamily}'`);
  }

  if (script !== 'latin') {
    parts.push(`'${NOTO_FAMILY_NAMES[script]}'`);
  }

  parts.push("'Noto Sans'");
  parts.push("'Inter'");
  parts.push('sans-serif');

  return parts.join(', ');
}
