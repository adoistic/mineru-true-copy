/**
 * True-Copy PPTX: pixel-perfect PowerPoint with text at exact bbox positions.
 *
 * Each PDF page becomes one slide with:
 * - Page image as background
 * - Text frames with inline formatting (bold, italic)
 * - Tables using PptxGenJS native table API
 * - Inline equations as images at original positions
 */
import PptxGenJS from 'pptxgenjs';
import { MineruOutput, MineruRegion } from '@/types';
import { detectSourcePage } from './page-size';
import { fitTextToBox, clearPositioningCache } from './positioning-core';
import { getPageImage } from '@/lib/mineru/client';
import { fetchTtf, clearFontCache } from './font-loader';
import { parseHtmlToRuns, runsToPlainText, parseTableHtml, StyledRun } from './html-content-parser';

const SYSTEM_FONT_MAP: Record<string, string> = {
  Arimo: 'Arial', Tinos: 'Times New Roman', Cousine: 'Courier New',
  Gelasio: 'Georgia', Inter: 'Calibri',
};

/** Convert CSS hex color to 6-char uppercase hex for PptxGenJS. */
function pptxHex(hex: string): string {
  let h = hex.replace(/^#/, '').toUpperCase();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return h.length === 6 ? h : '999999';
}

function getSystemFontName(bundledFamily: string | undefined): string {
  if (!bundledFamily) return 'Calibri';
  return SYSTEM_FONT_MAP[bundledFamily] || bundledFamily;
}

export async function createTrueCopyPptx(
  mineruOutput: MineruOutput,
  taskId: string,
  options?: { removeHeadersFooters?: boolean; includeImages?: boolean },
): Promise<ArrayBuffer> {
  const pres = new PptxGenJS();
  const { pages } = mineruOutput;

  const ttfDataMap = new Map<string, ArrayBuffer>();
  if (mineruOutput.used_fonts) {
    for (const [filename, family] of Object.entries(mineruOutput.used_fonts)) {
      const ttfData = await fetchTtf(filename);
      if (ttfData) ttfDataMap.set(family, ttfData);
    }
  }

  if (pages.length > 0) {
    const firstSource = detectSourcePage(pages[0]);
    pres.defineLayout({ name: 'CUSTOM', width: firstSource.width_pt / 72, height: firstSource.height_pt / 72 });
    pres.layout = 'CUSTOM';
  }

  for (let i = 0; i < pages.length; i++) {
    const mineruPage = pages[i];
    const source = detectSourcePage(mineruPage);
    const slide = pres.addSlide();

    if (options?.includeImages !== false) {
      try {
        const imgBuffer = await getPageImage(taskId, i);
        const b64 = imgBuffer.toString('base64');
        slide.addImage({
          data: `image/png;base64,${b64}`,
          x: 0, y: 0, w: source.width_pt / 72, h: source.height_pt / 72,
        });
      } catch { /* continue */ }
    }

    for (const region of mineruPage.regions) {
      if (options?.removeHeadersFooters && (region.type === 'header' || region.type === 'footer')) continue;
      addRegionToSlide(slide, region, source.width_pt / 72, source.height_pt / 72, ttfDataMap);
    }
  }

  const buffer = await pres.write({ outputType: 'arraybuffer' }) as ArrayBuffer;
  clearFontCache();
  clearPositioningCache();
  return buffer;
}

function addRegionToSlide(
  slide: PptxGenJS.Slide,
  region: MineruRegion,
  slideW_in: number, slideH_in: number,
  ttfDataMap: Map<string, ArrayBuffer>,
): void {
  const effectiveContent = region.content_per_page ?? region.content;

  // Figures/formulas as images
  if ((region.type === 'figure' || region.type === 'formula') && region.img_data) {
    const [x1, y1, x2, y2] = region.bbox;
    const w = x2 - x1; const h = y2 - y1;
    if (w <= 0 || h <= 0) return;
    const mime = region.img_mime || 'image/png';
    slide.addImage({ data: `${mime};base64,${region.img_data}`, x: x1 / 72, y: y1 / 72, w: w / 72, h: h / 72 });
    return;
  }

  // Tables
  if (region.type === 'table' && region.table_html) {
    addTableToSlide(slide, region, ttfDataMap);
    return;
  }

  if (!effectiveContent || effectiveContent.trim() === '') return;

  const [x1, y1, x2, y2] = region.bbox;
  const regionWidth = x2 - x1;
  const regionHeight = y2 - y1;
  if (regionWidth <= 0 || regionHeight <= 0) return;

  // Parse HTML to get formatted runs
  const runs = parseHtmlToRuns(effectiveContent);
  const plainText = runsToPlainText(runs);
  if (!plainText.trim()) return;

  const systemFont = getSystemFontName(region.font_family);
  const ttfData = region.font_family ? ttfDataMap.get(region.font_family) : undefined;
  const fontFamily = `'${systemFont}', 'Calibri', sans-serif`;
  const fit = fitTextToBox(plainText, regionWidth, regionHeight, fontFamily, false, null, plainText.includes('\n'), ttfData);

  // Handle inline equations: add as overlay images
  const effectiveEquations = region.inline_equations_per_page ?? region.inline_equations;
  if (effectiveEquations?.length) {
    for (const eq of effectiveEquations) {
      if (eq.img_data && eq.bbox) {
        const eqW = eq.bbox[2] - eq.bbox[0];
        const eqH = eq.bbox[3] - eq.bbox[1];
        if (eqW > 0 && eqH > 0) {
          const mime = eq.img_mime || 'image/jpeg';
          slide.addImage({
            data: `${mime};base64,${eq.img_data}`,
            x: eq.bbox[0] / 72, y: eq.bbox[1] / 72, w: eqW / 72, h: eqH / 72,
          });
        }
      }
    }
  }

  // Build text parts with formatting
  const textParts: PptxGenJS.TextProps[] = [];
  for (const run of runs) {
    if (run.lineBreak) {
      textParts.push({ text: '\n', options: { fontSize: Math.round(fit.fontSize * 10) / 10, fontFace: systemFont } });
      continue;
    }
    if (!run.text) continue;

    // Strip equation placeholders from displayed text
    const cleaned = run.text.replace(/\{\{EQ:\d+\}\}/g, '');
    if (!cleaned) continue;

    textParts.push({
      text: cleaned,
      options: {
        fontSize: Math.round(fit.fontSize * 10) / 10,
        fontFace: systemFont,
        bold: run.bold,
        italic: run.italic,
        color: '000000',
      },
    });
  }

  if (textParts.length > 0) {
    slide.addText(textParts, {
      x: x1 / 72, y: y1 / 72, w: regionWidth / 72, h: regionHeight / 72,
      valign: 'top', wrap: true, margin: 0,
    });
  }
}

function addTableToSlide(
  slide: PptxGenJS.Slide,
  region: MineruRegion,
  ttfDataMap: Map<string, ArrayBuffer>,
): void {
  if (!region.table_html) return;

  const [x1, y1, x2, y2] = region.bbox;
  const tableW = x2 - x1;
  const tableH = y2 - y1;
  if (tableW <= 0 || tableH <= 0) return;

  const table = parseTableHtml(region.table_html);
  if (table.rows.length === 0) return;

  // Compute font size from cell height — each row gets equal share of table height
  // PowerPoint adds internal spacing, so account for overhead
  const rowH = tableH / Math.max(table.rows.length, 1);
  const pptxOverhead = 3;
  const availH = rowH - pptxOverhead;
  const fontSize = Math.max(2, Math.min(availH / 1.2, 24));
  const systemFont = getSystemFontName(region.font_family);

  // Use CSS width percentages from HTML if available, else content-proportional
  let colWidths_in: number[];
  if (table.colWidthPcts.length === table.maxCols) {
    const totalPct = table.colWidthPcts.reduce((s, p) => s + p, 0) || 100;
    colWidths_in = table.colWidthPcts.map(p => (p / totalPct) * (tableW / 72));
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
    colWidths_in = colMaxLens.map(l => (Math.max(l, 1) / totalLen) * (tableW / 72));
  }

  // Build PptxGenJS table rows with formatting
  const tableRows: PptxGenJS.TableRow[] = table.rows.map(row => {
    return row.map(cell => {
      // Build formatted text parts for cell
      const cellParts: PptxGenJS.TextProps[] = [];
      for (const run of cell.runs) {
        if (run.lineBreak) {
          cellParts.push({ text: '\n', options: {} });
          continue;
        }
        if (run.text) {
          cellParts.push({
            text: run.text,
            options: {
              fontSize: Math.round(fontSize * 10) / 10,
              fontFace: systemFont,
              bold: run.bold || cell.isHeader,
              italic: run.italic,
              color: '000000',
            },
          });
        }
      }

      if (cellParts.length === 0) {
        cellParts.push({ text: '', options: { fontSize: Math.round(fontSize * 10) / 10, fontFace: systemFont } });
      }

      // Use border color from HTML, fallback to default
      const cellBorderColor = cell.borderColor ? cell.borderColor.replace(/^#/, '') : '999999';
      // Ensure 6-char hex
      const borderHex = cellBorderColor.length === 3
        ? cellBorderColor[0] + cellBorderColor[0] + cellBorderColor[1] + cellBorderColor[1] + cellBorderColor[2] + cellBorderColor[2]
        : cellBorderColor;

      const cellResult: PptxGenJS.TableCell = {
        text: cellParts,
        options: {
          border: { type: 'solid' as const, pt: 0.5, color: borderHex },
          valign: 'middle' as const,
          margin: [1, 2, 1, 2] as [number, number, number, number],
          align: cell.align === 'center' ? 'center' : cell.align === 'right' ? 'right' : 'left',
          colspan: cell.colspan > 1 ? cell.colspan : undefined,
          rowspan: cell.rowspan > 1 ? cell.rowspan : undefined,
          // Background color from HTML
          ...(cell.bgColor ? { fill: { color: pptxHex(cell.bgColor) } } : {}),
        },
      };
      return cellResult;
    });
  });

  slide.addTable(tableRows, {
    x: x1 / 72, y: y1 / 72, w: tableW / 72, h: tableH / 72,
    colW: colWidths_in,
    fontSize: Math.round(fontSize * 10) / 10, fontFace: systemFont,
    margin: 0, autoPage: false,
  });
}
