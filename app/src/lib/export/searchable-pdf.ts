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
    const testWidth = font.widthOfTextAtSize(testLine, fontSize);
    if (testWidth <= maxWidth) {
      currentLine = testLine;
    } else {
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
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const pages = pdfDoc.getPages();

  for (const mineruPage of mineruOutput.pages) {
    const pageIdx = mineruPage.page_number - 1;
    if (pageIdx >= pages.length) continue;

    const page = pages[pageIdx];
    const { width: pageWidth, height: pageHeight } = page.getSize();

    // Register font on page and get its PDF resource name
    page.setFont(font);
    const [, fontPdfName] = page.getFont() as [PDFFont, PDFName];

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
        const naturalWidth = font.widthOfTextAtSize(line, fontSize);
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
  fs.writeFileSync(outputPath, pdfBytes);
}
