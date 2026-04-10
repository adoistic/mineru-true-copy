/**
 * True-Copy PDF: reconstructed PDF with visible text at exact bbox positions.
 *
 * Creates a NEW PDF (not an overlay on the original). Each page has:
 * - Exact dimensions matching the source PDF
 * - Optional page image as background
 * - Visible text drawn at computed positions with embedded TTF fonts
 *
 * Key difference from searchable-pdf.ts:
 * - searchable-pdf: invisible text (rendering mode 3) on original scan
 * - true-copy-pdf: visible text (rendering mode 0) on blank/image page
 *
 * Coordinate system: PDF origin is bottom-left, Y increases upward.
 * Transform: pdf_y = pageHeight - bbox_y1 - fontSize
 *
 * MUST run in the Tauri WebView renderer (Pretext needs canvas context).
 */
import { PDFDocument, PDFFont, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { MineruOutput, MineruRegion } from '@/types';
import { detectSourcePage } from './page-size';
import { fitTextToBox } from './positioning-core';
import { fetchTtf, clearFontCache } from './font-loader';
import { getPageImage } from '@/lib/mineru/client';

/**
 * Create a true-copy PDF from MinerU output.
 *
 * @param mineruOutput Structured OCR output
 * @param taskId MinerU task ID (for page images)
 * @param options Export options
 * @returns PDF file as ArrayBuffer
 */
export async function createTrueCopyPdf(
  mineruOutput: MineruOutput,
  taskId: string,
  options?: {
    removeHeadersFooters?: boolean;
    includeImages?: boolean;
  },
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  // Embed fonts used in the document
  const embeddedFonts = new Map<string, Awaited<ReturnType<typeof doc.embedFont>>>();
  if (mineruOutput.used_fonts) {
    for (const [filename, family] of Object.entries(mineruOutput.used_fonts)) {
      try {
        const ttfData = await fetchTtf(filename);
        if (ttfData) {
          const font = await doc.embedFont(new Uint8Array(ttfData));
          embeddedFonts.set(family, font);
        }
      } catch {
        // Skip — region falls back to default font
      }
    }
  }

  for (let i = 0; i < mineruOutput.pages.length; i++) {
    const mineruPage = mineruOutput.pages[i];
    const source = detectSourcePage(mineruPage);
    const page = doc.addPage([source.width_pt, source.height_pt]);

    // Add page image as background
    if (options?.includeImages !== false) {
      try {
        const imgBuffer = await getPageImage(taskId, i);
        const pngImage = await doc.embedPng(imgBuffer);
        page.drawImage(pngImage, {
          x: 0,
          y: 0,
          width: source.width_pt,
          height: source.height_pt,
        });
      } catch {
        // Continue without background
      }
    }

    // Draw each text region
    for (const region of mineruPage.regions) {
      if (options?.removeHeadersFooters && (region.type === 'header' || region.type === 'footer')) continue;

      drawRegion(page, region, source.height_pt, embeddedFonts);
    }
  }

  const pdfBytes = await doc.save();
  clearFontCache();
  return pdfBytes.buffer as ArrayBuffer;
}

/**
 * Draw a single region onto a PDF page.
 */
function drawRegion(
  page: ReturnType<PDFDocument['addPage']>,
  region: MineruRegion,
  pageHeight: number,
  embeddedFonts: Map<string, PDFFont>,
): void {
  const effectiveText = region.content_per_page ?? region.content;

  // Skip empty, figure, formula, and table regions for now
  // (figures/formulas would need image embedding; tables need cell-level parsing)
  if (!effectiveText || effectiveText.trim() === '') return;
  if (region.type === 'figure' || region.type === 'formula' || region.type === 'table') return;

  const [x1, y1, x2, y2] = region.bbox;
  const regionWidth = x2 - x1;
  const regionHeight = y2 - y1;
  if (regionWidth <= 0 || regionHeight <= 0) return;

  const rawText = effectiveText.replace(/<[^>]*>/g, '');
  if (!rawText.trim()) return;

  const isBold = region.type === 'title';
  const hasBreaks = rawText.includes('\n');
  const fontFamily = region.font_family
    ? `'${region.font_family}', 'Inter', sans-serif`
    : "'Inter', sans-serif";

  // Compute font size via Pretext binary search
  const fit = fitTextToBox(rawText, regionWidth, regionHeight, fontFamily, isBold, null, hasBreaks);

  // Get the embedded font (or skip if none available)
  const font = region.font_family ? embeddedFonts.get(region.font_family) : undefined;
  if (!font) return; // Can't draw without an embedded font

  // Split into lines and draw each one
  const lines = hasBreaks ? rawText.split('\n') : [rawText];
  const lineHeight = fit.lineHeight;

  for (let li = 0; li < lines.length; li++) {
    const lineText = lines[li];
    if (!lineText.trim()) continue;

    // PDF Y: origin bottom-left, Y increases upward
    // bbox_y1 is the top of the region (top-down coords)
    // First line baseline: pageHeight - y1 - fontSize
    // Subsequent lines: subtract lineHeight per line
    const pdfY = pageHeight - y1 - fit.fontSize - li * lineHeight;

    try {
      page.drawText(lineText, {
        x: x1,
        y: pdfY,
        size: fit.fontSize,
        font,
        color: rgb(0, 0, 0),
        maxWidth: regionWidth,
      });
    } catch {
      // Skip lines with unsupported characters
    }
  }
}
