/**
 * Font loader: fetches fonts from the MinerU sidecar in WOFF2 or TTF format.
 *
 * - WOFF2: used for HTML exports (base64 @font-face)
 * - TTF: used for DOCX/PPTX/PDF exports (binary embedding)
 *
 * Caches fetched fonts in memory for the duration of the export session.
 */
import { getMineruUrl } from '@/lib/mineru/client';

const woff2Cache = new Map<string, ArrayBuffer>();
const ttfCache = new Map<string, ArrayBuffer>();

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

/**
 * Clear all cached fonts. Call after export session completes.
 */
export function clearFontCache(): void {
  woff2Cache.clear();
  ttfCache.clear();
}
