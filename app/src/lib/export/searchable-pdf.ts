/**
 * Searchable PDF: overlays invisible text at exact bounding box positions
 * on top of the original scanned page images.
 * This is the ONLY format that preserves spatial layout (multi-column).
 */
import { MineruOutput } from '@/types';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs';

export async function createSearchablePdf(
  mineruOutput: MineruOutput,
  originalPdfPath: string,
  outputPath: string
): Promise<void> {
  // Load the original PDF
  const originalBytes = fs.readFileSync(originalPdfPath);
  const pdfDoc = await PDFDocument.load(originalBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const pages = pdfDoc.getPages();

  for (const mineruPage of mineruOutput.pages) {
    const pageIdx = mineruPage.page_number - 1;
    if (pageIdx >= pages.length) continue;

    const page = pages[pageIdx];
    const { width: pageWidth, height: pageHeight } = page.getSize();

    // Scale factors: MinerU coordinates → PDF coordinates
    const scaleX = pageWidth / (mineruPage.width || 612);
    const scaleY = pageHeight / (mineruPage.height || 792);

    for (const region of mineruPage.regions) {
      if (!region.content || region.content.trim() === '') continue;
      if (region.type === 'figure') continue; // Don't overlay text on images

      const [x1, y1, x2, y2] = region.bbox;

      // Convert MinerU coordinates (top-left origin) to PDF coordinates (bottom-left origin)
      const pdfX = x1 * scaleX;
      const pdfY = pageHeight - (y2 * scaleY); // Flip Y axis
      const regionWidth = (x2 - x1) * scaleX;
      const regionHeight = (y2 - y1) * scaleY;

      // Calculate font size to fit text in the region
      const text = region.content.replace(/\n/g, ' ').trim();
      if (!text) continue;

      // Estimate font size based on region height
      let fontSize = Math.min(12, regionHeight * 0.8);
      fontSize = Math.max(4, fontSize);

      try {
        // Draw invisible text (transparent, but searchable/selectable)
        page.drawText(text, {
          x: pdfX,
          y: pdfY,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
          opacity: 0, // Invisible overlay
          maxWidth: regionWidth,
        });
      } catch {
        // Skip text that can't be rendered (non-Latin characters with Helvetica)
        // TODO: Non-Latin font support in MVP
      }
    }
  }

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, pdfBytes);
}
