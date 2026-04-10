/**
 * Reflowed PDF: clean, readable PDF with proper paragraph flow.
 *
 * NOT a scan overlay, NOT a visual replica.
 * Uses a top-down cursor layout engine with automatic page breaks.
 *
 * Layout approach:
 * - Each region in reading order
 * - Text measured via pdf-lib font metrics (widthOfTextAtSize, heightAtSize)
 * - Cursor advances by content height + spacing
 * - Page break when cursor exceeds bottom margin
 * - Headings: larger font, bold, extra spacing
 * - Tables: bordered cells with positioned text
 * - Images: embedded with aspect ratio preservation
 */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { MineruOutput, MineruRegion } from '@/types';
import { detectSourcePage, computeReflowedDimensions } from './page-size';
import { fetchTtf, clearFontCache } from './font-loader';

const MARGIN_PT = 72; // 1 inch
const LINE_HEIGHT_RATIO = 1.4;
const PARAGRAPH_SPACING = 8;
const HEADING_SPACING_BEFORE = 16;
const HEADING_SPACING_AFTER = 8;

const HEADING_SIZES: Record<number, number> = {
  1: 20, 2: 17, 3: 14, 4: 12, 5: 11, 6: 10,
};

interface LayoutState {
  page: PDFPage;
  cursorY: number; // top-down cursor in PDF coords (decreasing Y)
  bottomMargin: number;
  leftMargin: number;
  contentWidth: number;
  pageHeight: number;
}

/**
 * Create a reflowed PDF from MinerU output.
 */
export async function createReflowedPdf(
  mineruOutput: MineruOutput,
  options?: {
    removeHeadersFooters?: boolean;
  },
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  // Try to embed a body font, fall back to Helvetica
  let bodyFont: PDFFont;
  let boldFont: PDFFont;
  try {
    const usedFonts = mineruOutput.used_fonts || {};
    const firstFontFile = Object.keys(usedFonts)[0];
    if (firstFontFile) {
      const ttfData = await fetchTtf(firstFontFile);
      if (ttfData) {
        bodyFont = await doc.embedFont(new Uint8Array(ttfData));
        boldFont = bodyFont; // Same font for now (bold variant would need separate file)
      } else {
        bodyFont = await doc.embedFont(StandardFonts.Helvetica);
        boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
      }
    } else {
      bodyFont = await doc.embedFont(StandardFonts.Helvetica);
      boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
    }
  } catch {
    bodyFont = await doc.embedFont(StandardFonts.Helvetica);
    boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  }

  const fontSize = 11;

  // Use first page dimensions for all pages (reflowed doesn't need per-page sizing)
  const firstPage = mineruOutput.pages[0];
  const source = firstPage ? detectSourcePage(firstPage) : { width_pt: 612, height_pt: 792, orientation: 'portrait' as const };
  const dims = computeReflowedDimensions(source);

  let state = newPage(doc, dims.pdf.width_pt, dims.pdf.height_pt);

  for (const mineruPage of mineruOutput.pages) {
    for (const region of mineruPage.regions) {
      if (options?.removeHeadersFooters && (region.type === 'header' || region.type === 'footer')) continue;

      state = await drawReflowedRegion(doc, state, region, bodyFont, boldFont, fontSize, dims.pdf.width_pt, dims.pdf.height_pt);
    }
  }

  const pdfBytes = await doc.save();
  clearFontCache();
  return pdfBytes.buffer as ArrayBuffer;
}

function newPage(doc: PDFDocument, width: number, height: number): LayoutState {
  const page = doc.addPage([width, height]);
  return {
    page,
    cursorY: height - MARGIN_PT,
    bottomMargin: MARGIN_PT,
    leftMargin: MARGIN_PT,
    contentWidth: width - 2 * MARGIN_PT,
    pageHeight: height,
  };
}

function ensureSpace(doc: PDFDocument, state: LayoutState, needed: number, width: number, height: number): LayoutState {
  if (state.cursorY - needed < state.bottomMargin) {
    return newPage(doc, width, height);
  }
  return state;
}

async function drawReflowedRegion(
  doc: PDFDocument,
  state: LayoutState,
  region: MineruRegion,
  bodyFont: PDFFont,
  boldFont: PDFFont,
  baseFontSize: number,
  pageWidth: number,
  pageHeight: number,
): Promise<LayoutState> {
  const text = (region.content || '').replace(/<[^>]*>/g, '').trim();
  if (!text && region.type !== 'figure' && region.type !== 'formula') return state;

  switch (region.type) {
    case 'title': {
      const level = region.level || 1;
      const headingSize = HEADING_SIZES[level] || baseFontSize;
      const lineH = headingSize * LINE_HEIGHT_RATIO;
      const lines = wrapText(text, boldFont, headingSize, state.contentWidth);
      const totalHeight = lines.length * lineH + HEADING_SPACING_BEFORE + HEADING_SPACING_AFTER;

      state = ensureSpace(doc, state, totalHeight, pageWidth, pageHeight);
      state.cursorY -= HEADING_SPACING_BEFORE;

      for (const line of lines) {
        state.cursorY -= lineH;
        try {
          state.page.drawText(line, {
            x: state.leftMargin,
            y: state.cursorY,
            size: headingSize,
            font: boldFont,
            color: rgb(0, 0, 0),
          });
        } catch { /* skip unsupported chars */ }
      }
      state.cursorY -= HEADING_SPACING_AFTER;
      return state;
    }

    case 'text':
    case 'caption': {
      const size = region.type === 'caption' ? baseFontSize - 1 : baseFontSize;
      const lineH = size * LINE_HEIGHT_RATIO;
      const paragraphs = text.split('\n').filter(p => p.trim());

      for (const para of paragraphs) {
        const lines = wrapText(para, bodyFont, size, state.contentWidth);
        const totalHeight = lines.length * lineH + PARAGRAPH_SPACING;
        state = ensureSpace(doc, state, totalHeight, pageWidth, pageHeight);

        for (const line of lines) {
          state.cursorY -= lineH;
          try {
            state.page.drawText(line, {
              x: state.leftMargin,
              y: state.cursorY,
              size,
              font: bodyFont,
              color: rgb(0, 0, 0),
            });
          } catch { /* skip unsupported chars */ }
        }
        state.cursorY -= PARAGRAPH_SPACING;
      }
      return state;
    }

    case 'list': {
      const lineH = baseFontSize * LINE_HEIGHT_RATIO;
      const items = text.split('\n').filter(l => l.trim());

      for (const item of items) {
        // Strip bullet/number prefix and add a bullet
        const cleanItem = item.replace(/^\s*(?:[\u2022\u25E6\u25AA\u25B8\-\u2013\u2014*]\s*|\d+[.)\]]\s*|\(\d+\)\s*|\([a-z]\)\s*)/i, '').trim();
        const bulletText = `\u2022  ${cleanItem || item.trim()}`;
        const lines = wrapText(bulletText, bodyFont, baseFontSize, state.contentWidth - 20);
        const totalHeight = lines.length * lineH + 4;
        state = ensureSpace(doc, state, totalHeight, pageWidth, pageHeight);

        for (let li = 0; li < lines.length; li++) {
          state.cursorY -= lineH;
          try {
            state.page.drawText(lines[li], {
              x: state.leftMargin + (li === 0 ? 0 : 20),
              y: state.cursorY,
              size: baseFontSize,
              font: bodyFont,
              color: rgb(0, 0, 0),
            });
          } catch { /* skip */ }
        }
        state.cursorY -= 4;
      }
      return state;
    }

    case 'figure':
    case 'formula': {
      if (region.img_data) {
        try {
          const imgBuffer = Buffer.from(region.img_data, 'base64');
          const [x1, y1, x2, y2] = region.bbox;
          let imgW = x2 - x1;
          let imgH = y2 - y1;

          // Cap to content width
          if (imgW > state.contentWidth) {
            const scale = state.contentWidth / imgW;
            imgW = state.contentWidth;
            imgH *= scale;
          }

          state = ensureSpace(doc, state, imgH + 16, pageWidth, pageHeight);

          const mime = region.img_mime || 'image/png';
          const pdfImage = mime.includes('jpeg') || mime.includes('jpg')
            ? await doc.embedJpg(imgBuffer)
            : await doc.embedPng(imgBuffer);

          state.cursorY -= imgH;
          state.page.drawImage(pdfImage, {
            x: state.leftMargin,
            y: state.cursorY,
            width: imgW,
            height: imgH,
          });
          state.cursorY -= 16;
        } catch {
          // Skip image on error
        }
      }
      return state;
    }

    case 'table': {
      // Simple table rendering: draw text content as paragraphs
      // (Full table rendering with borders is a follow-up)
      const lineH = baseFontSize * LINE_HEIGHT_RATIO;
      const tableText = (region.table_html || text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!tableText) return state;

      const lines = wrapText(tableText, bodyFont, baseFontSize - 1, state.contentWidth);
      const totalHeight = lines.length * lineH + PARAGRAPH_SPACING;
      state = ensureSpace(doc, state, totalHeight, pageWidth, pageHeight);

      for (const line of lines) {
        state.cursorY -= lineH;
        try {
          state.page.drawText(line, {
            x: state.leftMargin,
            y: state.cursorY,
            size: baseFontSize - 1,
            font: bodyFont,
            color: rgb(0.2, 0.2, 0.2),
          });
        } catch { /* skip */ }
      }
      state.cursorY -= PARAGRAPH_SPACING;
      return state;
    }

    default:
      return state;
  }
}

/**
 * Word-wrap text to fit within a given width using font metrics.
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
      // Character encoding issue — push current line and skip word
      lines.push(currentLine);
      currentLine = words[i];
    }
  }
  lines.push(currentLine);
  return lines;
}
