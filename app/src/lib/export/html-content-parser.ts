/**
 * HTML Content Parser: extracts styled text runs from HTML content.
 *
 * Parses inline formatting tags (<strong>, <b>, <em>, <i>, <br>) and
 * produces an array of StyledRun objects that each serializer can consume.
 *
 * Also parses table HTML into structured TableData for rendering.
 */

// ─── Styled Text Runs ──────────────────────────────────────────────────────

export interface StyledRun {
  text: string;
  bold: boolean;
  italic: boolean;
  /** Line break before this run */
  lineBreak: boolean;
}

/**
 * Parse HTML content into styled text runs.
 * Handles <strong>, <b>, <em>, <i>, <br>, and newlines.
 */
export function parseHtmlToRuns(html: string): StyledRun[] {
  if (!html) return [];

  const runs: StyledRun[] = [];
  let pos = 0;
  let bold = false;
  let italic = false;

  while (pos < html.length) {
    // Check for HTML tags
    if (html[pos] === '<') {
      const tagEnd = html.indexOf('>', pos);
      if (tagEnd === -1) {
        // Malformed, treat rest as text
        runs.push({ text: html.slice(pos), bold, italic, lineBreak: false });
        break;
      }

      const tag = html.slice(pos, tagEnd + 1).toLowerCase();

      if (tag === '<strong>' || tag === '<b>') {
        bold = true;
      } else if (tag === '</strong>' || tag === '</b>') {
        bold = false;
      } else if (tag === '<em>' || tag === '<i>') {
        italic = true;
      } else if (tag === '</em>' || tag === '</i>') {
        italic = false;
      } else if (tag === '<br>' || tag === '<br/>' || tag === '<br />') {
        runs.push({ text: '', bold, italic, lineBreak: true });
      }
      // Skip all other tags (images, spans, divs, etc.)

      pos = tagEnd + 1;
      continue;
    }

    // Collect text until next tag or end
    let textEnd = html.indexOf('<', pos);
    if (textEnd === -1) textEnd = html.length;

    const text = html.slice(pos, textEnd);
    if (text) {
      // Split on newlines
      const parts = text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          runs.push({ text: '', bold, italic, lineBreak: true });
        }
        if (parts[i]) {
          // Decode HTML entities
          const decoded = decodeEntities(parts[i]);
          runs.push({ text: decoded, bold, italic, lineBreak: false });
        }
      }
    }

    pos = textEnd;
  }

  return runs;
}

/**
 * Get plain text from styled runs (for sizing calculations).
 */
export function runsToPlainText(runs: StyledRun[]): string {
  let result = '';
  for (const run of runs) {
    if (run.lineBreak) result += '\n';
    result += run.text;
  }
  return result;
}

// ─── Table Parsing ──────────────────────────────────────────────────────────

export interface TableCellData {
  /** Styled runs within the cell */
  runs: StyledRun[];
  /** Plain text content */
  text: string;
  /** Whether this is a header cell (<th>) */
  isHeader: boolean;
  colspan: number;
  rowspan: number;
  /** Text alignment from style attribute */
  align: 'left' | 'center' | 'right';
  /** Background color if specified */
  bgColor?: string;
  /** Border color from style (e.g., '#000') */
  borderColor?: string;
  /** Width percentage from style (e.g., 35 for '35%') */
  widthPct?: number;
}

export interface TableRowData {
  cells: TableCellData[];
  /** Row background color from style */
  bgColor?: string;
}

export interface TableData {
  rows: TableCellData[][];
  /** Structured rows with row-level styling */
  styledRows: TableRowData[];
  /** Maximum number of effective columns */
  maxCols: number;
  /** Column width percentages extracted from first row's style attributes */
  colWidthPcts: number[];
}

/**
 * Parse table HTML into structured TableData.
 * Extracts all styling from the HTML (borders, backgrounds, widths, padding)
 * so serializers can reproduce the exact same look as the browser renders.
 */
export function parseTableHtml(html: string): TableData {
  const rows: TableCellData[][] = [];
  const styledRows: TableRowData[] = [];

  const trRegex = /<tr([^>]*)>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const trAttrs = trMatch[1];
    const rowHtml = trMatch[2];
    const cells: TableCellData[] = [];

    // Extract row-level background color
    const rowBgMatch = trAttrs.match(/background-color:\s*([^;"]+)/i);

    const cellRegex = /<(td|th)([^>]*)>([\s\S]*?)<\/\1>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      const tag = cellMatch[1].toLowerCase();
      const attrs = cellMatch[2];
      const content = cellMatch[3];

      // Extract attributes
      const colspanMatch = attrs.match(/colspan\s*=\s*["']?(\d+)/i);
      const rowspanMatch = attrs.match(/rowspan\s*=\s*["']?(\d+)/i);
      const alignMatch = attrs.match(/text-align:\s*(left|center|right)/i);
      const cellBgMatch = attrs.match(/background-color:\s*([^;"]+)/i);
      const borderMatch = attrs.match(/border:\s*[^;]*solid\s+([^;"]+)/i);
      const widthMatch = attrs.match(/width:\s*(\d+)%/i);

      // Parse cell content into styled runs
      const runs = parseHtmlToRuns(content);
      const text = runsToPlainText(runs).trim();

      cells.push({
        runs,
        text,
        isHeader: tag === 'th',
        colspan: colspanMatch ? parseInt(colspanMatch[1], 10) : 1,
        rowspan: rowspanMatch ? parseInt(rowspanMatch[1], 10) : 1,
        align: (alignMatch?.[1] as 'left' | 'center' | 'right') || 'left',
        bgColor: cellBgMatch?.[1]?.trim() || rowBgMatch?.[1]?.trim(),
        borderColor: borderMatch?.[1]?.trim(),
        widthPct: widthMatch ? parseInt(widthMatch[1], 10) : undefined,
      });
    }
    if (cells.length > 0) {
      rows.push(cells);
      styledRows.push({
        cells,
        bgColor: rowBgMatch?.[1]?.trim(),
      });
    }
  }

  const maxCols = Math.max(1, ...rows.map(r =>
    r.reduce((sum, c) => sum + (c.colspan || 1), 0),
  ));

  // Extract column width percentages from first row's style attributes
  const colWidthPcts: number[] = [];
  if (rows.length > 0) {
    for (const cell of rows[0]) {
      if (cell.widthPct) {
        colWidthPcts.push(cell.widthPct);
      }
    }
  }

  return { rows, styledRows, maxCols, colWidthPcts };
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
