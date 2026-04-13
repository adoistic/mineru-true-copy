/**
 * Font loader: fetches fonts from the MinerU sidecar and bundled Noto Sans assets.
 *
 * Two font sources:
 * 1. MinerU sidecar: document-embedded fonts extracted during OCR
 *    - WOFF2: used for HTML exports (base64 @font-face)
 *    - TTF: used for DOCX/PPTX/PDF exports (binary embedding)
 * 2. Bundled Noto Sans: local assets in /fonts/noto/ for Indic script support
 *    - Loaded from public/ directory (works in both browser and Node contexts)
 *
 * Caches fetched fonts in memory for the duration of the export session.
 */
import { getMineruUrl } from '@/lib/mineru/client';
import { type Script, getNotoFontFile } from './font-resolver';
import fs from 'fs';
import path from 'path';

const woff2Cache = new Map<string, ArrayBuffer>();
const ttfCache = new Map<string, ArrayBuffer>();
const bundledTtfCache = new Map<string, ArrayBuffer>();

/**
 * Fetch a font file from the MinerU sidecar as WOFF2.
 * Used for HTML true-copy export (@font-face base64 inlining).
 */
export async function fetchWoff2(filename: string): Promise<ArrayBuffer | null> {
  const cached = woff2Cache.get(filename);
  if (cached) return cached;

  const url = `${getMineruUrl()}/fonts/${filename}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    woff2Cache.set(filename, buf);
    return buf;
  } catch {
    return null;
  }
}

/**
 * Fetch a font file from the MinerU sidecar as TTF (converted from WOFF2).
 * Used for DOCX, PPTX, and PDF exports that require TTF binary embedding.
 */
export async function fetchTtf(filename: string): Promise<ArrayBuffer | null> {
  const cached = ttfCache.get(filename);
  if (cached) return cached;

  const url = `${getMineruUrl()}/fonts/${filename}?format=ttf`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    ttfCache.set(filename, buf);
    return buf;
  } catch {
    return null;
  }
}

/**
 * Fetch all used fonts as TTF for a document.
 * Returns a map of family name → TTF ArrayBuffer.
 */
export async function fetchAllTtf(
  usedFonts: Record<string, string>,
): Promise<Map<string, { family: string; ttfData: ArrayBuffer }>> {
  const result = new Map<string, { family: string; ttfData: ArrayBuffer }>();

  for (const [filename, family] of Object.entries(usedFonts)) {
    const ttf = await fetchTtf(filename);
    if (ttf) {
      result.set(filename, { family, ttfData: ttf });
    }
  }

  return result;
}

// ─── Bundled Noto Sans Fonts ──────────────────────────────────────────────

/**
 * Fetch a bundled Noto Sans font as TTF for a given script.
 * Reads from the public/fonts/noto/ directory.
 * Used by all PDF export paths for Indic script rendering.
 */
export async function fetchBundledTtf(script: Script): Promise<ArrayBuffer | null> {
  const filename = getNotoFontFile(script);
  const cached = bundledTtfCache.get(filename);
  if (cached) return cached;

  try {
    // In Node.js / API route context: read directly from filesystem
    const fontsDir = path.join(process.cwd(), 'public', 'fonts', 'noto');
    const filePath = path.join(fontsDir, filename);
    const buf = fs.readFileSync(filePath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    bundledTtfCache.set(filename, ab);
    return ab;
  } catch {
    // Fallback: try fetching via HTTP (browser context or dev server)
    try {
      const res = await fetch(`/fonts/noto/${filename}`);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      bundledTtfCache.set(filename, buf);
      return buf;
    } catch {
      return null;
    }
  }
}

/**
 * Fetch a bundled Noto Sans font as a base64 data URL for @font-face embedding.
 * Used by HTML true-copy export.
 */
export async function fetchBundledFontBase64(script: Script): Promise<string | null> {
  const ttf = await fetchBundledTtf(script);
  if (!ttf) return null;
  const b64 = Buffer.from(ttf).toString('base64');
  return `data:font/ttf;base64,${b64}`;
}

/**
 * Clear all cached fonts. Call after export session completes.
 */
export function clearFontCache(): void {
  woff2Cache.clear();
  ttfCache.clear();
  bundledTtfCache.clear();
}
