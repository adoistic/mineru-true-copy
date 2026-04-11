/**
 * True-Copy DOCX: pixel-perfect Word document with text at exact bbox positions.
 *
 * Each PDF page becomes a DOCX section with:
 * - Exact page dimensions (zero margins)
 * - Page image as floating background
 * - Text boxes (framePr) positioned at computed DXA coordinates
 * - Tables rendered as actual DOCX Table elements
 * - Inline formatting (bold, italic) preserved
 * - Inline equations as images
 */
import {
  Document, Packer, Paragraph, TextRun, ImageRun,
  SectionType, FrameAnchorType, FrameWrap,
  Table, TableRow, TableCell, WidthType, BorderStyle,
  AlignmentType, TableAnchorType, TableLayoutType, OverlapType, HeightRule, ShadingType,
} from 'docx';
import { MineruOutput, MineruRegion } from '@/types';
import { detectSourcePage, computeTargetDimensions } from './page-size';
import { fitTextToBox, clearPositioningCache } from './positioning-core';
import { getPageImage } from '@/lib/mineru/client';
import { fetchTtf, clearFontCache } from './font-loader';
import { parseHtmlToRuns, runsToPlainText, parseTableHtml, StyledRun } from './html-content-parser';

export async function createTrueCopyDocx(
  mineruOutput: MineruOutput,
  taskId: string,
  options?: {
    removeHeadersFooters?: boolean;
    includeImages?: boolean;
  },
): Promise<ArrayBuffer> {
  const { pages } = mineruOutput;
  const sections = [];

  // Pre-fetch TTF data for font-metric measurement
  const ttfDataMap = new Map<string, ArrayBuffer>();
  if (mineruOutput.used_fonts) {
    for (const [filename, family] of Object.entries(mineruOutput.used_fonts)) {
      const ttfData = await fetchTtf(filename);
      if (ttfData) ttfDataMap.set(family, ttfData);
    }
  }

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const source = detectSourcePage(page);
    const target = computeTargetDimensions(source);
    const { width_dxa, height_dxa } = target.docx;

    let pageImageBuffer: Buffer | null = null;
    if (options?.includeImages !== false) {
      try { pageImageBuffer = await getPageImage(taskId, i); }
      catch { /* continue */ }
    }

    const children: (Paragraph | Table)[] = [];

    // Background image
    if (pageImageBuffer) {
      children.push(
        new Paragraph({
          frame: {
            type: 'absolute' as const,
            position: { x: 0, y: 0 },
            width: width_dxa, height: height_dxa,
            anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE },
            wrap: FrameWrap.NONE,
          },
          children: [
            new ImageRun({
              type: 'png', data: pageImageBuffer,
              transformation: { width: source.width_pt * (96/72), height: source.height_pt * (96/72) },
              floating: {
                horizontalPosition: { offset: 0 }, verticalPosition: { offset: 0 },
                behindDocument: true, wrap: { type: 0 },
              },
            }),
          ],
        }),
      );
    }

    for (const region of page.regions) {
      if (options?.removeHeadersFooters && (region.type === 'header' || region.type === 'footer')) continue;
      const elements = renderRegionToDocx(region, target.docx, ttfDataMap);
      for (const el of elements) children.push(el);
    }

    if (children.length === 0) children.push(new Paragraph({ children: [] }));

    sections.push({
      properties: {
        page: {
          size: { width: width_dxa, height: height_dxa },
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
        },
        ...(i > 0 ? { type: SectionType.NEXT_PAGE } : {}),
      },
      children,
    });
  }

  const doc = new Document({ sections });
  const buffer = await Packer.toBuffer(doc);
  clearFontCache();
  clearPositioningCache();
  return new Uint8Array(buffer).buffer as ArrayBuffer;
}

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };

/** Convert CSS hex color (e.g. '#f4d9a0', '#000') to DOCX 6-char hex (e.g. 'F4D9A0', '000000'). */
function cssHexToDocx(hex: string): string {
  let h = hex.replace(/^#/, '').toUpperCase();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return h.length === 6 ? h : '999999';
}

function makeFrame(x_dxa: number, y_dxa: number, w_dxa: number, h_dxa: number) {
  return {
    type: 'absolute' as const,
    position: { x: x_dxa, y: y_dxa },
    width: w_dxa, height: h_dxa,
    anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE },
    wrap: FrameWrap.NONE,
    border: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
  };
}

function renderRegionToDocx(
  region: MineruRegion,
  docxDims: { width_dxa: number; height_dxa: number },
  ttfDataMap: Map<string, ArrayBuffer>,
): (Paragraph | Table)[] {
  const effectiveContent = region.content_per_page ?? region.content;
  const hasContent =
    (effectiveContent && effectiveContent.trim() !== '') ||
    (region.type === 'table' && region.table_html) ||
    ((region.type === 'figure' || region.type === 'formula') && region.img_data);
  if (!hasContent) return [];

  const [x1, y1, x2, y2] = region.bbox;
  const regionWidth = x2 - x1;
  const regionHeight = y2 - y1;
  if (regionWidth <= 0 || regionHeight <= 0) return [];

  const x_dxa = Math.round(x1 * 20);
  const y_dxa = Math.round(y1 * 20);
  const w_dxa = Math.round(regionWidth * 20);
  const h_dxa = Math.round(regionHeight * 20);

  // Figures and formulas as images
  // docx-js transformation expects pixels (96 DPI), not points (72 DPI)
  const ptToPx = 96 / 72;
  if ((region.type === 'figure' || region.type === 'formula') && region.img_data) {
    try {
      const imgBuffer = Buffer.from(region.img_data, 'base64');
      const mime = region.img_mime || 'image/png';
      const imgType = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';
      return [new Paragraph({
        frame: makeFrame(x_dxa, y_dxa, w_dxa, h_dxa),
        children: [new ImageRun({
          type: imgType as 'png' | 'jpg', data: imgBuffer,
          transformation: { width: regionWidth * ptToPx, height: regionHeight * ptToPx },
        })],
      })];
    } catch { return []; }
  }

  // Tables — render as actual DOCX Table positioned with a wrapping paragraph
  if (region.type === 'table' && region.table_html) {
    return renderTableToDocx(region, x_dxa, y_dxa, w_dxa, h_dxa, regionWidth, regionHeight, ttfDataMap);
  }

  // Text regions with inline formatting
  if (!effectiveContent || effectiveContent.trim() === '') return [];

  const runs = parseHtmlToRuns(effectiveContent);
  const plainText = runsToPlainText(runs);
  if (!plainText.trim()) return [];

  const ttfData = region.font_family ? ttfDataMap.get(region.font_family) : undefined;
  const fontFamily = region.font_family
    ? `'${region.font_family}', 'Inter', sans-serif`
    : "'Inter', sans-serif";

  const fit = fitTextToBox(plainText, regionWidth, regionHeight, fontFamily, false, null, plainText.includes('\n'), ttfData);
  const cappedSize = Math.max(1, Math.min(fit.fontSize, 200));
  const fontSize_halfPt = Math.round(cappedSize * 2);
  const fontName = region.font_family || 'Inter';

  // Build text runs with formatting preserved
  const effectiveEquations = region.inline_equations_per_page ?? region.inline_equations;
  const textRuns = buildFormattedRuns(runs, fontSize_halfPt, fontName, effectiveEquations || [], cappedSize);

  return [new Paragraph({
    frame: makeFrame(x_dxa, y_dxa, w_dxa, h_dxa),
    children: textRuns,
  })];
}

/**
 * Build DOCX TextRun/ImageRun array preserving bold, italic, and inline equations.
 */
function buildFormattedRuns(
  runs: StyledRun[],
  fontSize_halfPt: number,
  fontName: string,
  equations: Array<{ img_data?: string; img_mime?: string; bbox?: number[] }>,
  fontSizePt: number,
): (TextRun | ImageRun)[] {
  const result: (TextRun | ImageRun)[] = [];

  for (const run of runs) {
    if (run.lineBreak) {
      result.push(new TextRun({ break: 1, text: '' }));
      continue;
    }

    if (!run.text) continue;

    // Check for equation placeholders within text
    const parts = run.text.split(/(\{\{EQ:\d+\}\})/);
    for (const part of parts) {
      const eqMatch = part.match(/^\{\{EQ:(\d+)\}\}$/);
      if (eqMatch) {
        const eqIdx = parseInt(eqMatch[1], 10);
        const eq = equations[eqIdx];
        if (eq?.img_data) {
          try {
            const imgBuffer = Buffer.from(eq.img_data, 'base64');
            const mime = eq.img_mime || 'image/jpeg';
            const imgType = mime.includes('png') ? 'png' : 'jpg';
            let eqH = fontSizePt * 1.1;
            let eqW = eqH;
            if (eq.bbox) {
              const bw = eq.bbox[2] - eq.bbox[0];
              const bh = eq.bbox[3] - eq.bbox[1];
              if (bh > 0) eqW = eqH * (bw / bh);
            }
            // docx-js expects pixels (96 DPI), equation sizes are in points
            const pxScale = 96 / 72;
            result.push(new ImageRun({
              type: imgType as 'png' | 'jpg', data: imgBuffer,
              transformation: { width: eqW * pxScale, height: eqH * pxScale },
            }));
            continue;
          } catch { /* fall through to text */ }
        }
      }

      if (part) {
        result.push(new TextRun({
          text: part,
          size: fontSize_halfPt,
          bold: run.bold,
          italics: run.italic,
          font: fontName,
        }));
      }
    }
  }

  return result;
}

/**
 * Render table as a floating DOCX Table positioned at the exact bbox.
 * Uses Table.float for absolute page positioning (no anchor paragraph needed).
 * Matches HTML true-copy styling: 1px solid #999 borders, auto column widths.
 */
function renderTableToDocx(
  region: MineruRegion,
  x_dxa: number, y_dxa: number, w_dxa: number, h_dxa: number,
  regionWidth: number, regionHeight: number,
  ttfDataMap: Map<string, ArrayBuffer>,
): (Paragraph | Table)[] {
  if (!region.table_html) return [];

  const table = parseTableHtml(region.table_html);
  if (table.rows.length === 0) return [];

  // Compute font size from cell height — each row gets equal share of table height
  // Word adds internal line spacing + cell margins + paragraph spacing, account for overhead
  const rowH = regionHeight / Math.max(table.rows.length, 1);
  const wordOverhead = 4; // Word's internal spacing overhead per cell (pts)
  const availH = rowH - wordOverhead;
  const fontSize = Math.max(2, Math.min(availH / 1.2, 24));
  const fontSize_halfPt = Math.round(fontSize * 2);
  const fontName = region.font_family || 'Inter';

  // Use CSS width percentages from HTML if available, else content-proportional
  let colWidths_dxa: number[];
  if (table.colWidthPcts.length === table.maxCols) {
    const totalPct = table.colWidthPcts.reduce((s, p) => s + p, 0) || 100;
    colWidths_dxa = table.colWidthPcts.map(p => Math.round((p / totalPct) * w_dxa));
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
    colWidths_dxa = colMaxLens.map(l => Math.round((Math.max(l, 1) / totalLen) * w_dxa));
  }

  const defaultBorderColor = '999999';

  const tableRows = table.rows.map(row => {
    let colIdx = 0;
    const cells = row.map(cell => {
      const cellRuns: TextRun[] = [];
      for (const run of cell.runs) {
        if (run.lineBreak) {
          cellRuns.push(new TextRun({ break: 1, text: '' }));
          continue;
        }
        if (run.text) {
          cellRuns.push(new TextRun({
            text: run.text,
            size: fontSize_halfPt,
            bold: run.bold || cell.isHeader,
            italics: run.italic,
            font: fontName,
          }));
        }
      }
      if (cellRuns.length === 0) {
        cellRuns.push(new TextRun({ text: '', size: fontSize_halfPt, font: fontName }));
      }

      const alignment = cell.align === 'center' ? AlignmentType.CENTER
        : cell.align === 'right' ? AlignmentType.RIGHT
        : AlignmentType.LEFT;

      // Sum column widths for this cell's span
      const span = cell.colspan || 1;
      let cellWidth = 0;
      for (let c = 0; c < span && colIdx + c < colWidths_dxa.length; c++) {
        cellWidth += colWidths_dxa[colIdx + c];
      }
      colIdx += span;

      // Use border color from HTML, fallback to default
      const cellBorderColor = cell.borderColor ? cssHexToDocx(cell.borderColor) : defaultBorderColor;
      const cellBorder = { style: BorderStyle.SINGLE, size: 1, color: cellBorderColor };

      // Use background color from HTML (cell-level or row-level via bgColor)
      const cellShading = cell.bgColor ? {
        type: ShadingType.CLEAR,
        color: 'auto',
        fill: cssHexToDocx(cell.bgColor),
      } : undefined;

      return new TableCell({
        children: [new Paragraph({ children: cellRuns, alignment, spacing: { before: 0, after: 0, line: 240 } })],
        width: { size: cellWidth, type: WidthType.DXA },
        columnSpan: cell.colspan > 1 ? cell.colspan : undefined,
        rowSpan: cell.rowspan > 1 ? cell.rowspan : undefined,
        borders: {
          top: cellBorder, bottom: cellBorder,
          left: cellBorder, right: cellBorder,
        },
        shading: cellShading,
        margins: {
          top: 0, bottom: 0, left: 20, right: 20,
        },
      });
    });

    // Constrain row height exactly to fit within the table bbox
    const rowH_dxa = Math.round(h_dxa / table.rows.length);
    return new TableRow({
      children: cells,
      height: { value: rowH_dxa, rule: HeightRule.EXACT },
    });
  });

  // Use Table.float for absolute positioning on the page
  const docxTable = new Table({
    rows: tableRows,
    width: { size: w_dxa, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    float: {
      horizontalAnchor: TableAnchorType.PAGE,
      verticalAnchor: TableAnchorType.PAGE,
      absoluteHorizontalPosition: x_dxa,
      absoluteVerticalPosition: y_dxa,
      overlap: OverlapType.OVERLAP,
    },
  });

  return [docxTable];
}
