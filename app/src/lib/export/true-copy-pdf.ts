/**
 * True-Copy PDF: reconstructed PDF with visible text at exact bbox positions.
 *
 * Coordinate system: PDF origin is bottom-left, Y increases upward.
 * MinerU bboxes use top-left origin, Y increases downward.
 * Transform: pdf_y = pageHeight - bbox_y1 - fontSize
 */
import { PDFDocument, PDFFont, PDFImage, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { MineruOutput, MineruRegion } from '@/types';
import { detectSourcePage } from './page-size';
import { fitTextToBox, clearPositioningCache } from './positioning-core';
import { fetchTtf, fetchBundledTtf, clearFontCache } from './font-loader';
import { getPageImage } from '@/lib/mineru/client';
import { parseHtmlToRuns, runsToPlainText, parseTableHtml, StyledRun, TableData } from './html-content-parser';
import { detectScript, isIndicScript, type Script, getAllScripts } from './font-resolver';

const FONT_SIZE_MIN = 1;
const FONT_SIZE_MAX = 200;
const LINE_HEIGHT_RATIO = 1.2;

interface FontSet {
  regular: PDFFont;
  bold: PDFFont;
  custom: Map<string, PDFFont>;
  ttfDataMap: Map<string, ArrayBuffer>;
  /** Bundled Noto Sans fonts keyed by Script name */
  noto: Map<Script, PDFFont>;
  notoTtfData: Map<Script, ArrayBuffer>;
}

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

  const customFonts = new Map<string, PDFFont>();
  const ttfDataMap = new Map<string, ArrayBuffer>();
  if (mineruOutput.used_fonts) {
    for (const [filename, family] of Object.entries(mineruOutput.used_fonts)) {
      try {
        const ttfData = await fetchTtf(filename);
        if (ttfData) {
          // subset: false — subsetting strips GSUB/GPOS tables needed for
          // complex scripts (Devanagari conjuncts, Arabic shaping, CJK ligatures)
          const font = await doc.embedFont(new Uint8Array(ttfData), { subset: false });
          customFonts.set(family, font);
          ttfDataMap.set(family, ttfData);
        }
      } catch (err) {
        console.warn(`[TrueCopyPDF] Failed to embed font ${filename}:`, err);
      }
    }
  }

  const fallbackRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fallbackBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Pre-load bundled Noto Sans fonts for Indic scripts on demand.
  // We scan all page text to determine which scripts are present,
  // then embed only the needed Noto fonts.
  const notoFonts = new Map<Script, PDFFont>();
  const notoTtfData = new Map<Script, ArrayBuffer>();
  const scriptsNeeded = new Set<Script>();
  for (const page of mineruOutput.pages) {
    for (const region of page.regions) {
      const text = (region.content_per_page ?? region.content ?? '').replace(/<[^>]*>/g, '');
      if (text.trim()) {
        const script = detectScript(text);
        if (script !== 'latin') scriptsNeeded.add(script);
      }
    }
  }
  // Always load Noto Sans Latin as a safe non-Latin fallback stack base
  scriptsNeeded.add('latin' as Script);
  for (const script of scriptsNeeded) {
    try {
      const ttfData = await fetchBundledTtf(script);
      if (ttfData) {
        const font = await doc.embedFont(new Uint8Array(ttfData), { subset: false });
        notoFonts.set(script, font);
        notoTtfData.set(script, ttfData);
      }
    } catch (err) {
      console.warn(`[TrueCopyPDF] Failed to embed Noto Sans for ${script}:`, err);
    }
  }

  const fonts: FontSet = { regular: fallbackRegular, bold: fallbackBold, custom: customFonts, ttfDataMap, noto: notoFonts, notoTtfData };

  for (let i = 0; i < mineruOutput.pages.length; i++) {
    const mineruPage = mineruOutput.pages[i];
    const source = detectSourcePage(mineruPage);
    const page = doc.addPage([source.width_pt, source.height_pt]);

    if (options?.includeImages !== false) {
      try {
        const imgBuffer = await getPageImage(taskId, i);
        const pngImage = await doc.embedPng(imgBuffer);
        page.drawImage(pngImage, { x: 0, y: 0, width: source.width_pt, height: source.height_pt });
      } catch { /* continue */ }
    }

    for (const region of mineruPage.regions) {
      if (options?.removeHeadersFooters && (region.type === 'header' || region.type === 'footer')) continue;

      if ((region.type === 'figure' || region.type === 'formula') && region.img_data) {
        try {
          const imgBytes = Buffer.from(region.img_data, 'base64');
          const mime = region.img_mime || 'image/png';
          const img = mime.includes('jpeg') || mime.includes('jpg')
            ? await doc.embedJpg(imgBytes) : await doc.embedPng(imgBytes);
          const [bx1, by1, bx2, by2] = region.bbox;
          page.drawImage(img, { x: bx1, y: source.height_pt - by2, width: bx2 - bx1, height: by2 - by1 });
        } catch { /* skip */ }
        continue;
      }

      if (region.type === 'table') {
        await drawTableRegion(page, doc, region, source.height_pt, fonts);
        continue;
      }

      await drawTextRegion(page, doc, region, source.height_pt, fonts);
    }
  }

  const pdfBytes = await doc.save();
  clearFontCache();
  clearPositioningCache();
  return pdfBytes.buffer as ArrayBuffer;
}

// ─── Text Region Drawing ───────────────────────────────────────────────────

async function drawTextRegion(
  page: ReturnType<PDFDocument['addPage']>,
  doc: PDFDocument,
  region: MineruRegion,
  pageHeight: number,
  fonts: FontSet,
): Promise<void> {
  const effectiveContent = region.content_per_page ?? region.content;
  if (!effectiveContent || effectiveContent.trim() === '') return;

  const [x1, y1, x2, y2] = region.bbox;
  const regionWidth = x2 - x1;
  const regionHeight = y2 - y1;
  if (regionWidth <= 0 || regionHeight <= 0) return;

  // Parse HTML to get styled runs
  const runs = parseHtmlToRuns(effectiveContent);
  const plainText = runsToPlainText(runs);
  if (!plainText.trim()) return;

  // Get fonts — script-aware selection
  const textScript = detectScript(plainText);
  const customFont = region.font_family ? fonts.custom.get(region.font_family) : undefined;
  let regularFont: PDFFont;
  let boldFont: PDFFont;
  let ttfData: ArrayBuffer | undefined;

  if (customFont && !isIndicScript(textScript)) {
    // Document font works for Latin text
    regularFont = customFont;
    boldFont = fonts.bold;
    ttfData = region.font_family ? fonts.ttfDataMap.get(region.font_family) : undefined;
  } else if (isIndicScript(textScript)) {
    // Indic text: use Noto Sans for the detected script
    const notoFont = fonts.noto.get(textScript);
    regularFont = notoFont || fonts.noto.get('latin' as Script) || fonts.regular;
    boldFont = regularFont; // Noto variable fonts include bold weight
    ttfData = fonts.notoTtfData.get(textScript);
  } else {
    // Latin text without document font: try Noto Sans Latin, then Helvetica
    regularFont = fonts.noto.get('latin' as Script) || customFont || fonts.regular;
    boldFont = fonts.bold;
    ttfData = fonts.notoTtfData.get('latin' as Script);
  }

  // Compute font size
  const fontFamily = region.font_family
    ? `'${region.font_family}', 'Inter', sans-serif`
    : "'Inter', sans-serif";
  const fit = fitTextToBox(plainText, regionWidth, regionHeight, fontFamily, false, null, plainText.includes('\n'), ttfData);
  const fontSize = Math.max(FONT_SIZE_MIN, Math.min(fit.fontSize, FONT_SIZE_MAX));
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;

  // Handle inline equations
  const effectiveEquations = region.inline_equations_per_page ?? region.inline_equations;
  const eqImages: Map<number, PDFImage> = new Map();
  if (effectiveEquations?.length) {
    for (let ei = 0; ei < effectiveEquations.length; ei++) {
      const eq = effectiveEquations[ei];
      if (eq.img_data) {
        try {
          const imgBytes = Buffer.from(eq.img_data, 'base64');
          const mime = eq.img_mime || 'image/jpeg';
          const img = mime.includes('png') ? await doc.embedPng(imgBytes) : await doc.embedJpg(imgBytes);
          eqImages.set(ei, img);
        } catch { /* skip */ }
      }
    }
  }

  // Word-wrap into lines, preserving formatting
  const wrappedLines = wrapStyledRuns(runs, regularFont, boldFont, fontSize, regionWidth, eqImages, effectiveEquations || []);

  // Draw each line
  for (let li = 0; li < wrappedLines.length; li++) {
    const pdfY = pageHeight - y1 - fontSize - li * lineHeight;
    if (pdfY < pageHeight - y2 - lineHeight) break;

    let cursorX = x1;
    for (const segment of wrappedLines[li]) {
      if (segment.type === 'equation' && segment.image) {
        const eqH = lineHeight * 0.9;
        const eq = effectiveEquations?.[segment.eqIndex!];
        let eqW = eqH;
        if (eq?.bbox) {
          const bw = eq.bbox[2] - eq.bbox[0];
          const bh = eq.bbox[3] - eq.bbox[1];
          if (bh > 0) eqW = eqH * (bw / bh);
        }
        try {
          page.drawImage(segment.image, { x: cursorX, y: pdfY, width: eqW, height: eqH });
        } catch { /* skip */ }
        cursorX += eqW;
      } else if (segment.text) {
        const font = segment.bold ? boldFont : regularFont;
        try {
          page.drawText(segment.text, {
            x: cursorX,
            y: pdfY,
            size: fontSize,
            font,
            color: rgb(0, 0, 0),
          });
          cursorX += font.widthOfTextAtSize(segment.text, fontSize);
        } catch { /* skip unsupported glyphs */ }
      }
    }
  }
}

// ─── Styled Line Wrapping ──────────────────────────────────────────────────

interface LineSegment {
  type: 'text' | 'equation';
  text: string;
  bold: boolean;
  italic: boolean;
  image?: PDFImage;
  eqIndex?: number;
}

/**
 * Word-wrap styled runs into lines, handling inline equations.
 * Returns an array of lines, each line being an array of segments.
 */
function wrapStyledRuns(
  runs: StyledRun[],
  regularFont: PDFFont,
  boldFont: PDFFont,
  fontSize: number,
  maxWidth: number,
  eqImages: Map<number, PDFImage>,
  equations: Array<{ img_data?: string; bbox?: number[]; img_mime?: string }>,
): LineSegment[][] {
  const lines: LineSegment[][] = [];
  let currentLine: LineSegment[] = [];
  let currentLineWidth = 0;

  // Flatten runs into a sequence of words and line breaks
  for (const run of runs) {
    if (run.lineBreak) {
      lines.push(currentLine.length > 0 ? currentLine : [{ type: 'text', text: '', bold: false, italic: false }]);
      currentLine = [];
      currentLineWidth = 0;
      continue;
    }

    if (!run.text) continue;

    // Check for equation placeholder
    const eqMatch = run.text.match(/^\{\{EQ:(\d+)\}\}$/);
    if (eqMatch) {
      const eqIdx = parseInt(eqMatch[1], 10);
      const eqImg = eqImages.get(eqIdx);
      if (eqImg) {
        const eq = equations[eqIdx];
        const eqH = fontSize * LINE_HEIGHT_RATIO * 0.9;
        let eqW = eqH;
        if (eq?.bbox) {
          const bw = eq.bbox[2] - eq.bbox[0];
          const bh = eq.bbox[3] - eq.bbox[1];
          if (bh > 0) eqW = eqH * (bw / bh);
        }
        if (currentLineWidth + eqW > maxWidth && currentLine.length > 0) {
          lines.push(currentLine);
          currentLine = [];
          currentLineWidth = 0;
        }
        currentLine.push({ type: 'equation', text: '', bold: false, italic: false, image: eqImg, eqIndex: eqIdx });
        currentLineWidth += eqW;
      }
      continue;
    }

    // Split text by equation placeholders within the run
    const parts = run.text.split(/(\{\{EQ:\d+\}\})/);
    for (const part of parts) {
      const innerEqMatch = part.match(/^\{\{EQ:(\d+)\}\}$/);
      if (innerEqMatch) {
        const eqIdx = parseInt(innerEqMatch[1], 10);
        const eqImg = eqImages.get(eqIdx);
        if (eqImg) {
          const eq = equations[eqIdx];
          const eqH = fontSize * LINE_HEIGHT_RATIO * 0.9;
          let eqW = eqH;
          if (eq?.bbox) {
            const bw = eq.bbox[2] - eq.bbox[0];
            const bh = eq.bbox[3] - eq.bbox[1];
            if (bh > 0) eqW = eqH * (bw / bh);
          }
          if (currentLineWidth + eqW > maxWidth && currentLine.length > 0) {
            lines.push(currentLine);
            currentLine = [];
            currentLineWidth = 0;
          }
          currentLine.push({ type: 'equation', text: '', bold: false, italic: false, image: eqImg, eqIndex: eqIdx });
          currentLineWidth += eqW;
        }
        continue;
      }

      // Regular text: word-wrap
      const font = run.bold ? boldFont : regularFont;
      const words = part.split(/( +)/); // preserve spaces

      for (const word of words) {
        if (!word) continue;
        let wordWidth: number;
        try {
          wordWidth = font.widthOfTextAtSize(word, fontSize);
        } catch {
          wordWidth = word.length * fontSize * 0.5;
        }

        if (currentLineWidth + wordWidth > maxWidth && currentLine.length > 0 && word.trim()) {
          lines.push(currentLine);
          currentLine = [];
          currentLineWidth = 0;
        }

        currentLine.push({ type: 'text', text: word, bold: run.bold, italic: run.italic });
        currentLineWidth += wordWidth;
      }
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

// ─── Table Region Drawing ──────────────────────────────────────────────────

async function drawTableRegion(
  page: ReturnType<PDFDocument['addPage']>,
  doc: PDFDocument,
  region: MineruRegion,
  pageHeight: number,
  fonts: FontSet,
): Promise<void> {
  if (!region.table_html) return;

  const [x1, y1, x2, y2] = region.bbox;
  const tableW = x2 - x1;
  const tableH = y2 - y1;
  if (tableW <= 0 || tableH <= 0) return;

  const table = parseTableHtml(region.table_html);
  if (table.rows.length === 0) return;

  const totalRows = table.rows.length;
  const padding = 2;

  // Use CSS width percentages from HTML if available, else content-proportional
  let colWidths: number[];
  if (table.colWidthPcts.length === table.maxCols) {
    const totalPct = table.colWidthPcts.reduce((s, p) => s + p, 0) || 100;
    colWidths = table.colWidthPcts.map(p => (p / totalPct) * tableW);
  } else {
    const colMaxLens: number[] = new Array(table.maxCols).fill(0);
    for (const row of table.rows) {
      let colIdx = 0;
      for (const cell of row) {
        const span = cell.colspan || 1;
        const lenPerCol = cell.text.length / span;
        for (let c = 0; c < span && colIdx + c < table.maxCols; c++) {
          colMaxLens[colIdx + c] = Math.max(colMaxLens[colIdx + c], lenPerCol);
        }
        colIdx += span;
      }
    }
    const totalLen = colMaxLens.reduce((s, l) => s + Math.max(l, 1), 0);
    colWidths = colMaxLens.map(l => (Math.max(l, 1) / totalLen) * tableW);
  }

  const cellH = tableH / totalRows;

  // Compute font size: must fit within cell height minus padding
  // Each cell has padding top + bottom, so available text height = cellH - 2*padding
  const availableTextH = cellH - padding * 2;
  // Font size = available height / line height ratio, capped to reasonable range
  let fontSize = Math.max(FONT_SIZE_MIN, Math.min(availableTextH / LINE_HEIGHT_RATIO, 24));
  console.log(`[TrueCopyPDF] Table: rows=${totalRows} cols=${table.maxCols} W=${tableW.toFixed(1)} H=${tableH.toFixed(1)} cellH=${cellH.toFixed(1)} fontSize=${fontSize.toFixed(2)} pcts=[${table.colWidthPcts}] sample="${table.rows[0]?.[0]?.text?.slice(0,20)}"`);

  let currentY = y1;
  for (const row of table.rows) {
    let currentX = x1;
    let colIdx = 0;
    for (const cell of row) {
      const span = cell.colspan || 1;
      let cw = 0;
      for (let c = 0; c < span && colIdx + c < colWidths.length; c++) {
        cw += colWidths[colIdx + c];
      }
      colIdx += span;
      const ch = cellH * (cell.rowspan || 1);
      const pdfCellY = pageHeight - currentY - ch;

      // Draw cell background if specified
      const bgHex = cell.bgColor;
      if (bgHex) {
        const bgRgb = hexToRgb(bgHex);
        page.drawRectangle({
          x: currentX, y: pdfCellY, width: cw, height: ch,
          color: rgb(bgRgb.r, bgRgb.g, bgRgb.b),
        });
      }

      // Draw cell border using color from HTML
      const borderHex = cell.borderColor;
      const borderRgb = borderHex ? hexToRgb(borderHex) : { r: 0.6, g: 0.6, b: 0.6 };
      page.drawRectangle({
        x: currentX, y: pdfCellY, width: cw, height: ch,
        borderColor: rgb(borderRgb.r, borderRgb.g, borderRgb.b), borderWidth: 0.5,
      });

      // Draw cell text with formatting
      if (cell.text.trim()) {
        const cellFontSize = cell.isHeader ? Math.min(fontSize * 1.05, 24) : fontSize;
        // Script-aware font for table cells — Indic text needs Noto, not Helvetica
        const cellScript = detectScript(cell.text);
        let cellFont: PDFFont;
        if (isIndicScript(cellScript) && fonts.noto.has(cellScript)) {
          cellFont = fonts.noto.get(cellScript)!;
        } else {
          cellFont = cell.isHeader ? fonts.bold : fonts.regular;
        }

        const lines = wrapTextForPdf(cell.text, cellFont, cellFontSize, cw - padding * 2);
        console.log(`[TrueCopyPDF] Cell: "${cell.text.slice(0,20)}" fs=${cellFontSize.toFixed(2)} cw=${cw.toFixed(1)} lines=${lines.length} textY=${(pageHeight - currentY - padding - cellFontSize).toFixed(1)} cellBot=${pdfCellY.toFixed(1)}`);

        for (let li = 0; li < lines.length; li++) {
          if (!lines[li]) continue;
          const textY = pageHeight - currentY - padding - cellFontSize - li * (cellFontSize * LINE_HEIGHT_RATIO);
          if (textY < pdfCellY) break;
          try {
            page.drawText(lines[li], {
              x: currentX + padding, y: textY, size: cellFontSize,
              font: cellFont, color: rgb(0, 0, 0),
            });
          } catch { /* skip unsupported glyphs */ }
        }
      }
      currentX += cw;
    }
    currentY += cellH;
  }
}

/** Parse a CSS hex color (e.g. '#f4d9a0', '#000', 'f4d9a0') into 0-1 RGB. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (isNaN(n)) return { r: 0.6, g: 0.6, b: 0.6 };
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function wrapTextForPdf(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const paragraphs = text.split('\n');
  const result: string[] = [];
  for (const para of paragraphs) {
    if (!para.trim()) { result.push(''); continue; }
    const words = para.split(/\s+/);
    let currentLine = '';
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      let testWidth: number;
      try { testWidth = font.widthOfTextAtSize(testLine, fontSize); }
      catch { currentLine = testLine; continue; }
      if (testWidth <= maxWidth || !currentLine) { currentLine = testLine; }
      else { result.push(currentLine); currentLine = word; }
    }
    if (currentLine) result.push(currentLine);
  }
  return result;
}
