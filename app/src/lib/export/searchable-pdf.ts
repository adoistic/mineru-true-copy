// @ts-nocheck — pdf-lib internal APIs used for raw operator access
/**
 * Searchable PDF: overlays invisible text at exact bounding box positions
 * on top of the original scanned page images.
 * Uses raw PDF operators with horizontal scaling (Tz) to stretch each line
 * to exactly fill its region width, pixel-perfect.
 */
import { MineruOutput } from '@/types';
import {
  PDFDocument,
  StandardFonts,
  PDFFont,
  PDFOperator,
  PDFOperatorNames,
  PDFName,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { fetchTtf, fetchBundledTtf, clearFontCache } from './font-loader';
import { detectScript, isIndicScript, type Script } from './font-resolver';
import fs from 'fs';

/**
 * Word-wrap text to fit within a given width using actual font metrics.
 */
function wrapText(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let currentLine = words[0];

  for (let i = 1; i < words.length; i++) {
    const testLine = currentLine + ' ' + words[i];
    try {
      const testWidth = font.widthOfTextAtSize(testLine, fontSize);
      if (testWidth <= maxWidth) {
        currentLine = testLine;
      } else {
        lines.push(currentLine);
        currentLine = words[i];
      }
    } catch {
      lines.push(currentLine);
      currentLine = words[i];
    }
  }
  lines.push(currentLine);
  return lines;
}

export async function createSearchablePdf(
  mineruOutput: MineruOutput,
  originalPdfPath: string,
  outputPath: string
): Promise<void> {
  const originalBytes = fs.readFileSync(originalPdfPath);
  const pdfDoc = await PDFDocument.load(originalBytes);
  pdfDoc.registerFontkit(fontkit);

  // Embed fonts: document font + bundled Noto fonts for Indic scripts.
  // Falls back to Helvetica only for Latin text with no document font.
  let defaultFont: PDFFont;
  const usedFonts = mineruOutput.used_fonts || {};
  const firstFontFile = Object.keys(usedFonts)[0];
  if (firstFontFile) {
    try {
      const ttfData = await fetchTtf(firstFontFile);
      if (ttfData) {
        // subset: false — subsetting strips GSUB/GPOS tables needed for
        // complex scripts (Devanagari conjuncts, Arabic shaping, CJK)
        defaultFont = await pdfDoc.embedFont(new Uint8Array(ttfData), { subset: false });
      } else {
        defaultFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
      }
    } catch (err) {
      console.warn('[SearchablePDF] Font embed failed, falling back to Helvetica:', err);
      defaultFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    }
  } else {
    defaultFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  }

  // Scan for Indic scripts and pre-load their Noto fonts
  const notoFonts = new Map<Script, PDFFont>();
  const scriptsNeeded = new Set<Script>();
  for (const mp of mineruOutput.pages) {
    for (const region of mp.regions) {
      const text = (region.content || '').replace(/<[^>]+>/g, '').trim();
      if (text) {
        const script = detectScript(text);
        if (script !== 'latin') scriptsNeeded.add(script);
      }
    }
  }
  for (const script of scriptsNeeded) {
    try {
      const ttfData = await fetchBundledTtf(script);
      if (ttfData) {
        const notoFont = await pdfDoc.embedFont(new Uint8Array(ttfData), { subset: false });
        notoFonts.set(script, notoFont);
      }
    } catch (err) {
      console.warn(`[SearchablePDF] Failed to embed Noto Sans for ${script}:`, err);
    }
  }

  const pages = pdfDoc.getPages();

  for (const mineruPage of mineruOutput.pages) {
    const pageIdx = mineruPage.page_number - 1;
    if (pageIdx >= pages.length) continue;

    const page = pages[pageIdx];
    const { width: pageWidth, height: pageHeight } = page.getSize();

    // Register the default font on the page. Per-region Indic fonts are
    // registered inline when needed.
    page.setFont(defaultFont);
    const [, defaultFontPdfName] = page.getFont() as [PDFFont, PDFName];

    // Pre-register Noto fonts on this page so they have PDF resource names
    const notoFontPdfNames = new Map<Script, PDFName>();
    for (const [script, notoFont] of notoFonts) {
      page.setFont(notoFont);
      const [, pdfName] = page.getFont() as [PDFFont, PDFName];
      notoFontPdfNames.set(script, pdfName);
    }
    // Restore default
    page.setFont(defaultFont);

    // Scale factors: MinerU coordinates → PDF coordinates
    const scaleX = pageWidth / (mineruPage.width || 612);
    const scaleY = pageHeight / (mineruPage.height || 792);

    const operators: PDFOperator[] = [];

    for (const region of mineruPage.regions) {
      if (!region.content || region.content.trim() === '') continue;
      if (region.type === 'figure') continue;

      const [x1, y1, x2, y2] = region.bbox;

      const pdfX = x1 * scaleX;
      const regionTop = pageHeight - (y1 * scaleY);
      const regionWidth = (x2 - x1) * scaleX;
      const regionHeight = (y2 - y1) * scaleY;

      const text = region.content.replace(/<[^>]+>/g, '').trim();
      if (!text) continue;

      // Script-aware font selection for this region
      const regionScript = detectScript(text);
      const font = (isIndicScript(regionScript) && notoFonts.has(regionScript))
        ? notoFonts.get(regionScript)!
        : defaultFont;
      const fontPdfName = (isIndicScript(regionScript) && notoFontPdfNames.has(regionScript))
        ? notoFontPdfNames.get(regionScript)!
        : defaultFontPdfName;

      // Determine font size so wrapped lines fill the region vertically.
      // Iterate: pick a fontSize, wrap, check if total height fits.
      let fontSize = 11;
      let lines = wrapText(text, font, fontSize, regionWidth);
      const leading = 1.25;

      while (lines.length * fontSize * leading > regionHeight && fontSize > 3) {
        fontSize -= 0.5;
        lines = wrapText(text, font, fontSize, regionWidth);
      }

      if (lines.length === 0) continue;

      // Exact line height to fill the region top-to-bottom
      const lineHeight = lines.length > 1
        ? (regionHeight - fontSize) / (lines.length - 1)
        : regionHeight;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;

        // Y: start from top of region, move down per line
        const lineY = regionTop - fontSize - (i * lineHeight);

        // Calculate horizontal scale to stretch this line to exactly fill regionWidth
        let naturalWidth = 0;
        try { naturalWidth = font.widthOfTextAtSize(line, fontSize); } catch { /* glyph encoding error */ }
        let hScale = 100; // default: no scaling
        if (naturalWidth > 0) {
          hScale = (regionWidth / naturalWidth) * 100;
          // Don't over-stretch short last lines — cap at 150%
          const isLastLine = i === lines.length - 1;
          if (isLastLine && lines.length > 1) {
            hScale = Math.min(hScale, 150);
          }
        }

        try {
          const encoded = font.encodeText(line);

          operators.push(
            PDFOperator.of(PDFOperatorNames.BeginText),
            PDFOperator.of(PDFOperatorNames.SetFontAndSize, [fontPdfName, fontSize]),
            PDFOperator.of(PDFOperatorNames.SetTextRenderingMode, [3]), // invisible
            PDFOperator.of(PDFOperatorNames.SetTextHorizontalScaling, [hScale]),
            PDFOperator.of(PDFOperatorNames.MoveText, [pdfX, lineY]),
            PDFOperator.of(PDFOperatorNames.ShowText, [encoded]),
            PDFOperator.of(PDFOperatorNames.EndText),
          );
        } catch {
          // Skip lines with characters unsupported by Helvetica
        }
      }
    }

    if (operators.length > 0) {
      page.pushOperators(...operators);
    }
  }

  const pdfBytes = await pdfDoc.save();
  clearFontCache();
  fs.writeFileSync(outputPath, pdfBytes);
}
