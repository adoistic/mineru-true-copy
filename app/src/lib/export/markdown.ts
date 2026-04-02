/**
 * HTML-to-Markdown converter using Turndown.
 * Used by both OCR and Translation pipelines.
 */
import TurndownService from 'turndown';

let turndown: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (turndown) return turndown;

  turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
  });

  // GFM tables support
  turndown.addRule('table', {
    filter: ['table'],
    replacement: function (content, node) {
      const table = node as HTMLTableElement;
      return convertTableToGfm(table);
    },
  });

  // Handle underline (no Markdown equivalent)
  turndown.addRule('underline', {
    filter: ['u'],
    replacement: function (content) {
      // Underline has no MD equivalent — preserve content, drop formatting
      return content;
    },
  });

  // Handle math/LaTeX
  turndown.addRule('math', {
    filter: function (node) {
      return node.classList?.contains('math') || node.classList?.contains('math-block') || false;
    },
    replacement: function (content, node) {
      const isBlock = (node as Element).classList?.contains('math-block');
      if (isBlock) {
        return `\n\n$$${content}$$\n\n`;
      }
      return `$${content}$`;
    },
  });

  // Skip page headers/footers
  turndown.addRule('pageHeaderFooter', {
    filter: function (node) {
      return node.classList?.contains('page-header') || node.classList?.contains('page-footer') || false;
    },
    replacement: function () {
      return '';
    },
  });

  return turndown;
}

function convertTableToGfm(table: HTMLTableElement): string {
  const rows: string[][] = [];
  let hasHeader = false;

  // Extract rows
  const tableRows = table.querySelectorAll('tr');
  tableRows.forEach((tr, rowIdx) => {
    const cells: string[] = [];
    const tds = tr.querySelectorAll('td, th');
    tds.forEach(td => {
      // For merged cells, GFM can't represent colspan/rowspan
      // Just include the content
      cells.push((td.textContent || '').trim().replace(/\|/g, '\\|').replace(/\n/g, ' '));
    });
    if (cells.length > 0) {
      rows.push(cells);
    }
    if (tr.querySelector('th')) {
      hasHeader = true;
    }
  });

  if (rows.length === 0) return '';

  // Normalize column count
  const maxCols = Math.max(...rows.map(r => r.length));
  const normalized = rows.map(r => {
    while (r.length < maxCols) r.push('');
    return r;
  });

  // Build GFM table
  const lines: string[] = [];

  if (hasHeader && normalized.length > 0) {
    lines.push('| ' + normalized[0].join(' | ') + ' |');
    lines.push('| ' + normalized[0].map(() => '---').join(' | ') + ' |');
    for (let i = 1; i < normalized.length; i++) {
      lines.push('| ' + normalized[i].join(' | ') + ' |');
    }
  } else {
    // No header row — add empty header
    lines.push('| ' + normalized[0].map(() => ' ').join(' | ') + ' |');
    lines.push('| ' + normalized[0].map(() => '---').join(' | ') + ' |');
    for (const row of normalized) {
      lines.push('| ' + row.join(' | ') + ' |');
    }
  }

  return '\n\n' + lines.join('\n') + '\n\n';
}

export function htmlToMarkdown(html: string): string {
  const td = getTurndown();

  // Extract just the body content if it's a full HTML document
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const content = bodyMatch ? bodyMatch[1] : html;

  return td.turndown(content).trim() + '\n';
}
