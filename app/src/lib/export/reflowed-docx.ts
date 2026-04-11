/**
 * Reflowed DOCX: semantic, editable Word document with proper styles.
 *
 * Uses MinerU's structured output (headings, paragraphs, tables, lists, figures)
 * in reading order with document styles. Content reflows within standard margins.
 *
 * NOT a visual replica — this is a clean, editable document.
 * For visual fidelity, use true-copy-docx.ts.
 *
 * Mapping:
 * - title regions → Heading 1-6 (from _assign_heading_levels)
 * - text regions → Normal paragraphs
 * - list regions → Bullet/numbered paragraphs
 * - table regions → DOCX tables (parsed from table_html)
 * - figure regions → Inline images
 * - formula regions → Inline images (equation rendering)
 */
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  LevelFormat,
  SectionType,
} from 'docx';
import { MineruOutput, MineruPage, MineruRegion } from '@/types';
import { detectSourcePage, computeReflowedDimensions } from './page-size';

const HEADING_MAP: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

/**
 * Create a reflowed DOCX from MinerU output.
 * Produces a clean, editable Word document with proper semantic structure.
 */
export async function createReflowedDocx(
  mineruOutput: MineruOutput,
  options?: {
    removeHeadersFooters?: boolean;
  },
): Promise<ArrayBuffer> {
  const { pages } = mineruOutput;
  const sections = [];

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    const source = detectSourcePage(page);
    const dims = computeReflowedDimensions(source);
    const children: (Paragraph | Table)[] = [];

    for (const region of page.regions) {
      if (options?.removeHeadersFooters && (region.type === 'header' || region.type === 'footer')) continue;

      const elements = renderReflowedRegion(region, dims.docx.width_dxa - dims.docx.margin_dxa.left - dims.docx.margin_dxa.right);
      children.push(...elements);
    }

    if (children.length === 0) {
      children.push(new Paragraph({ children: [] }));
    }

    sections.push({
      properties: {
        page: {
          size: {
            width: dims.docx.width_dxa,
            height: dims.docx.height_dxa,
          },
          margin: dims.docx.margin_dxa,
        },
        ...(pi > 0 ? { type: SectionType.NEXT_PAGE } : {}),
      },
      children,
    });
  }

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: 'bullets',
          levels: [{
            level: 0,
            format: LevelFormat.BULLET,
            text: '\u2022',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          }],
        },
        {
          reference: 'numbers',
          levels: [{
            level: 0,
            format: LevelFormat.DECIMAL,
            text: '%1.',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          }],
        },
      ],
    },
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 22 }, // 11pt
        },
      },
      paragraphStyles: [
        {
          id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 32, bold: true, font: 'Calibri' },
          paragraph: { spacing: { before: 240, after: 120 } },
        },
        {
          id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 28, bold: true, font: 'Calibri' },
          paragraph: { spacing: { before: 200, after: 100 } },
        },
        {
          id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 24, bold: true, font: 'Calibri' },
          paragraph: { spacing: { before: 160, after: 80 } },
        },
      ],
    },
    sections,
  });

  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer).buffer as ArrayBuffer;
}

/**
 * Convert a MinerU region to reflowed DOCX elements.
 */
/**
 * Strip HTML and equation placeholders from content.
 */
function cleanContent(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\{\{EQ:\d+\}\}/g, '')
    .trim();
}

/**
 * Render equation images from a region's inline_equations array.
 */
function renderEquationImages(region: MineruRegion): Paragraph[] {
  const equations = region.inline_equations || [];
  const result: Paragraph[] = [];
  for (const eq of equations) {
    if (!eq.img_data || eq.display !== 'block') continue;
    try {
      const imgData = Buffer.from(eq.img_data, 'base64');
      let w = 300;
      let h = 40;
      if (eq.bbox) {
        w = Math.round((eq.bbox[2] - eq.bbox[0]) * 1.33); // pt to px approx
        h = Math.round((eq.bbox[3] - eq.bbox[1]) * 1.33);
      }
      if (w > 600) { const s = 600 / w; w = 600; h = Math.round(h * s); }
      result.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({ data: imgData, transformation: { width: w, height: h }, type: 'jpg' })],
        spacing: { before: 80, after: 80 },
      }));
    } catch { /* skip */ }
  }
  return result;
}

function renderReflowedRegion(
  region: MineruRegion,
  contentWidth_dxa: number,
): (Paragraph | Table)[] {
  const text = region.content || '';
  if (!cleanContent(text) && region.type !== 'figure' && region.type !== 'formula' && region.type !== 'table') {
    return [];
  }

  // Collect equation images for this region
  const eqImages = renderEquationImages(region);

  switch (region.type) {
    case 'title':
      return [renderHeading(text, region.level), ...eqImages];

    case 'text':
      return [...renderTextParagraphs(text), ...eqImages];

    case 'list':
      return [...renderList(text), ...eqImages];

    case 'table':
      if (region.table_html) {
        return [renderTable(region.table_html, contentWidth_dxa)];
      }
      return renderTextParagraphs(text);

    case 'figure':
    case 'formula':
      if (region.img_data) {
        return [renderImage(region)];
      }
      if (text.trim()) return renderTextParagraphs(text);
      return [];

    case 'caption':
      return [new Paragraph({
        children: [new TextRun({ text: text.trim(), italics: true, size: 20 })],
        spacing: { after: 120 },
      })];

    default:
      if (text.trim()) return renderTextParagraphs(text);
      return [];
  }
}

function renderHeading(text: string, level?: number): Paragraph {
  const headingLevel = HEADING_MAP[level || 1] || HeadingLevel.HEADING_1;
  return new Paragraph({
    heading: headingLevel,
    children: [new TextRun({ text: cleanContent(text) })],
  });
}

function renderTextParagraphs(text: string): Paragraph[] {
  const cleaned = cleanContent(text);
  const lines = cleaned.split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];

  return lines.map(line => new Paragraph({
    children: [new TextRun({ text: line.trim() })],
    spacing: { after: 80 },
  }));
}

function renderList(text: string): Paragraph[] {
  const cleanText = cleanContent(text);
  const lines = cleanText.split('\n').filter(l => l.trim());

  return lines.map(line => {
    // Detect if numbered (starts with digit or (digit))
    const isNumbered = /^\s*(\d+[.)\]]|\(\d+\))/.test(line);
    // Strip the bullet/number prefix for clean rendering
    const cleanLine = line.replace(/^\s*(?:[\u2022\u25E6\u25AA\u25B8\-\u2013\u2014*]\s*|\d+[.)\]]\s*|\(\d+\)\s*|\([a-z]\)\s*|\([ivxlcdm]+\)\s*)/i, '').trim();

    return new Paragraph({
      numbering: {
        reference: isNumbered ? 'numbers' : 'bullets',
        level: 0,
      },
      children: [new TextRun({ text: cleanLine || line.trim() })],
    });
  });
}

function renderTable(tableHtml: string, contentWidth_dxa: number): Table {
  // Parse table HTML to extract rows and cells
  // Simple regex-based parser for <tr>/<td>/<th> (jsdom would be cleaner but heavier)
  const rows: string[][] = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(tableHtml)) !== null) {
    const cells: string[] = [];
    let tdMatch;
    tdRegex.lastIndex = 0;
    while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
      cells.push(tdMatch[1].replace(/<[^>]*>/g, '').trim());
    }
    if (cells.length > 0) rows.push(cells);
  }

  if (rows.length === 0) {
    // Fallback: single cell with raw text
    return new Table({
      width: { size: contentWidth_dxa, type: WidthType.DXA },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: tableHtml.replace(/<[^>]*>/g, '').trim() })] })],
              width: { size: contentWidth_dxa, type: WidthType.DXA },
            }),
          ],
        }),
      ],
    });
  }

  const maxCols = Math.max(...rows.map(r => r.length));
  const colWidth = Math.floor(contentWidth_dxa / maxCols);
  const border = { style: BorderStyle.SINGLE, size: 1, color: '999999' };
  const borders = { top: border, bottom: border, left: border, right: border };

  return new Table({
    width: { size: contentWidth_dxa, type: WidthType.DXA },
    columnWidths: Array(maxCols).fill(colWidth),
    rows: rows.map(row =>
      new TableRow({
        children: Array(maxCols).fill(null).map((_, ci) =>
          new TableCell({
            borders,
            width: { size: colWidth, type: WidthType.DXA },
            margins: { top: 40, bottom: 40, left: 80, right: 80 },
            children: [new Paragraph({
              children: [new TextRun({ text: row[ci] || '', size: 20 })],
            })],
          }),
        ),
      }),
    ),
  });
}

function renderImage(region: MineruRegion): Paragraph {
  if (!region.img_data) return new Paragraph({ children: [] });

  const [x1, y1, x2, y2] = region.bbox;
  const width = x2 - x1;
  const height = y2 - y1;

  // Cap image size to max 6 inches wide, preserving aspect ratio
  const maxWidth = 432; // 6 inches in points
  let imgW = width;
  let imgH = height;
  if (imgW > maxWidth) {
    const scale = maxWidth / imgW;
    imgW = maxWidth;
    imgH = height * scale;
  }

  const mime = region.img_mime || 'image/png';
  const imgType = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';

  try {
    const imgBuffer = Buffer.from(region.img_data, 'base64');
    return new Paragraph({
      children: [
        new ImageRun({
          type: imgType as 'png' | 'jpg',
          data: imgBuffer,
          transformation: { width: imgW, height: imgH },
        }),
      ],
      spacing: { before: 120, after: 120 },
    });
  } catch {
    return new Paragraph({ children: [] });
  }
}
