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

  // GFM tables support — parse from innerHTML since Node.js DOM is limited
  turndown.addRule('table', {
    filter: ['table'],
    replacement: function (_content, node) {
      return convertTableToGfm(node);
    },
  });

  // Handle underline (no Markdown equivalent)
  turndown.addRule('underline', {
    filter: ['u'],
    replacement: function (content) {
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

function convertTableToGfm(node: TurndownService.Node): string {
  // Use innerHTML/outerHTML to extract table structure
  const html = (node as unknown as Element).outerHTML || (node as unknown as Element).innerHTML || '';
  if (!html) return '';

  const rows: string[][] = [];
  let hasHeader = false;

  // Parse rows with regex since we don't have full DOM in Node.js
  const trMatches = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];

  for (const trHtml of trMatches) {
    const cells: string[] = [];
    const cellMatches = trHtml.match(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi) || [];

    for (const cellHtml of cellMatches) {
      const isHeader = cellHtml.startsWith('<th');
      if (isHeader) hasHeader = true;
      // Strip HTML tags to get text content
      const text = cellHtml
        .replace(/<[^>]*>/g, '')
        .trim()
        .replace(/\|/g, '\\|')
        .replace(/\n/g, ' ');
      cells.push(text);
    }

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

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
