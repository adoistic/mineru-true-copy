/**
 * Tests for the script-aware font resolver.
 *
 * Verifies Unicode script detection and font selection logic
 * for Latin and all supported Indic scripts.
 */
import { describe, it, expect } from 'vitest';
import {
  detectScript,
  resolveFont,
  resolveFontForScript,
  isIndicScript,
  buildFontFamilyStack,
  getNotoFontFile,
  getNotoFamilyName,
  getAllScripts,
} from '../font-resolver';

// ─── detectScript ─────────────────────────────────────────────────────────

describe('detectScript', () => {
  it('detects Latin text', () => {
    expect(detectScript('Hello world')).toBe('latin');
  });

  it('detects Devanagari (Hindi)', () => {
    expect(detectScript('नमस्ते')).toBe('devanagari');
  });

  it('detects Tamil', () => {
    expect(detectScript('வணக்கம்')).toBe('tamil');
  });

  it('detects Bengali', () => {
    expect(detectScript('নমস্কার')).toBe('bengali');
  });

  it('detects Telugu', () => {
    expect(detectScript('నమస్కారం')).toBe('telugu');
  });

  it('detects Gujarati', () => {
    expect(detectScript('નમસ્તે')).toBe('gujarati');
  });

  it('detects Kannada', () => {
    expect(detectScript('ನಮಸ್ಕಾರ')).toBe('kannada');
  });

  it('detects Malayalam', () => {
    expect(detectScript('നമസ്കാരം')).toBe('malayalam');
  });

  it('detects Gurmukhi (Punjabi)', () => {
    expect(detectScript('ਸਤ ਸ੍ਰੀ ਅਕਾਲ')).toBe('gurmukhi');
  });

  it('detects Oriya', () => {
    expect(detectScript('ନମସ୍କାର')).toBe('oriya');
  });

  it('returns dominant script for mixed text (Hindi + English)', () => {
    // More Devanagari chars than Latin
    expect(detectScript('Hello नमस्ते दुनिया')).toBe('devanagari');
  });

  it('returns latin for ASCII-only text', () => {
    expect(detectScript('123 !@# ABC')).toBe('latin');
  });

  it('returns latin for empty string', () => {
    expect(detectScript('')).toBe('latin');
  });

  it('handles text with only punctuation and digits', () => {
    expect(detectScript('12345...')).toBe('latin');
  });
});

// ─── resolveFont ──────────────────────────────────────────────────────────

describe('resolveFont', () => {
  it('returns document font when available for Latin text', () => {
    const result = resolveFont('Hello world', { 'ArialMT.woff2': 'Arial' });
    expect(result.source).toBe('document');
    expect(result.family).toBe('Arial');
    expect(result.script).toBe('latin');
  });

  it('returns document font for Indic text when preferDocumentFont is true', () => {
    const result = resolveFont('नमस्ते', { 'Mangal.woff2': 'Mangal' }, true);
    expect(result.source).toBe('document');
    expect(result.family).toBe('Mangal');
  });

  it('returns Noto Sans Devanagari for Hindi text without document font', () => {
    const result = resolveFont('नमस्ते');
    expect(result.source).toBe('bundled-noto');
    expect(result.family).toBe('Noto Sans Devanagari');
    expect(result.script).toBe('devanagari');
    expect(result.notoFile).toBe('NotoSansDevanagari.ttf');
  });

  it('returns Noto Sans Tamil for Tamil text', () => {
    const result = resolveFont('வணக்கம்');
    expect(result.source).toBe('bundled-noto');
    expect(result.family).toBe('Noto Sans Tamil');
    expect(result.notoFile).toBe('NotoSansTamil.ttf');
  });

  it('returns Noto Sans for Latin text without document font', () => {
    const result = resolveFont('Hello world');
    expect(result.source).toBe('bundled-noto');
    expect(result.family).toBe('Noto Sans');
    expect(result.notoFile).toBe('NotoSans.ttf');
  });

  it('never returns Helvetica for non-Latin text', () => {
    const indicTexts = [
      'नमस्ते',      // Hindi
      'বাংলা',       // Bengali
      'தமிழ்',        // Tamil
      'తెలుగు',      // Telugu
      'ગુજરાતી',     // Gujarati
      'ಕನ್ನಡ',       // Kannada
      'മലയാളം',      // Malayalam
      'ਪੰਜਾਬੀ',      // Punjabi
      'ଓଡ଼ିଆ',       // Oriya
    ];

    for (const text of indicTexts) {
      const result = resolveFont(text);
      expect(result.source).not.toBe('helvetica');
      expect(result.family).not.toBe('Helvetica');
    }
  });
});

// ─── resolveFontForScript ─────────────────────────────────────────────────

describe('resolveFontForScript', () => {
  it('returns Noto Sans for latin', () => {
    const result = resolveFontForScript('latin');
    expect(result.family).toBe('Noto Sans');
    expect(result.source).toBe('bundled-noto');
  });

  it('returns correct Noto font for each Indic script', () => {
    const expectations: Array<[string, string]> = [
      ['devanagari', 'Noto Sans Devanagari'],
      ['bengali', 'Noto Sans Bengali'],
      ['tamil', 'Noto Sans Tamil'],
      ['telugu', 'Noto Sans Telugu'],
      ['gujarati', 'Noto Sans Gujarati'],
      ['kannada', 'Noto Sans Kannada'],
      ['malayalam', 'Noto Sans Malayalam'],
      ['gurmukhi', 'Noto Sans Gurmukhi'],
      ['oriya', 'Noto Sans Oriya'],
    ];

    for (const [script, expectedFamily] of expectations) {
      const result = resolveFontForScript(script as any);
      expect(result.family).toBe(expectedFamily);
      expect(result.source).toBe('bundled-noto');
    }
  });
});

// ─── isIndicScript ────────────────────────────────────────────────────────

describe('isIndicScript', () => {
  it('returns false for latin', () => {
    expect(isIndicScript('latin')).toBe(false);
  });

  it('returns true for all Indic scripts', () => {
    const indicScripts = [
      'devanagari', 'bengali', 'tamil', 'telugu',
      'gujarati', 'kannada', 'malayalam', 'gurmukhi', 'oriya',
    ] as const;
    for (const s of indicScripts) {
      expect(isIndicScript(s)).toBe(true);
    }
  });
});

// ─── buildFontFamilyStack ─────────────────────────────────────────────────

describe('buildFontFamilyStack', () => {
  it('includes document font for Latin text', () => {
    const stack = buildFontFamilyStack('Hello', 'Arial');
    expect(stack).toContain("'Arial'");
    expect(stack).toContain("'Noto Sans'");
    expect(stack).toContain('sans-serif');
  });

  it('includes script-specific Noto for Devanagari text', () => {
    const stack = buildFontFamilyStack('नमस्ते', 'Arial');
    expect(stack).toContain("'Noto Sans Devanagari'");
    expect(stack).toContain("'Noto Sans'");
  });

  it('works without document font', () => {
    const stack = buildFontFamilyStack('Hello');
    expect(stack).toContain("'Noto Sans'");
    expect(stack).toContain('sans-serif');
  });
});

// ─── getNotoFontFile / getNotoFamilyName ──────────────────────────────────

describe('font file mapping', () => {
  it('returns correct TTF filenames for all scripts', () => {
    for (const script of getAllScripts()) {
      const file = getNotoFontFile(script);
      expect(file).toMatch(/^NotoSans.*\.ttf$/);
    }
  });

  it('returns human-readable family names for all scripts', () => {
    for (const script of getAllScripts()) {
      const name = getNotoFamilyName(script);
      expect(name).toMatch(/^Noto Sans/);
    }
  });
});
