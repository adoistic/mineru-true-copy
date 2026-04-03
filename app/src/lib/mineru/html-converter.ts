/**
 * Converts MinerU structured JSON output to semantic HTML.
 *
 * MVP-1 (PaddleOCR): Structural HTML only — no bold/italic/underline.
 * MVP (LLM backend): Rich HTML with formatting tags.
 *
 * Multi-column layouts are ALWAYS flattened to single-column reading order
 * (except searchable PDF, which preserves spatial layout).
 */
import { MineruOutput, MineruPage, MineruRegion, ProcessingOptions } from '@/types';

export interface HtmlConversionOptions {
  removeHeadersFooters: boolean;
  removeMetadata: boolean;
  joinBrokenPages: boolean;
  pageRange?: { start: number; end: number };
}

export function mineruToHtml(output: MineruOutput, options: HtmlConversionOptions): string {
  const pages = filterPages(output.pages, options.pageRange);
  const htmlParts: string[] = [];

  htmlParts.push('<!DOCTYPE html>');
  htmlParts.push('<html lang="en">');
  htmlParts.push('<head>');
  htmlParts.push('<meta charset="UTF-8">');
  htmlParts.push(`<title>${escapeHtml(output.metadata.file_name || 'Document')}</title>`);
  htmlParts.push('<style>');
  htmlParts.push(getDefaultStyles());
  htmlParts.push('</style>');
  htmlParts.push('</head>');
  htmlParts.push('<body>');

  let previousPageEndedMidSentence = false;

  for (const page of pages) {
    const regions = filterRegions(page.regions, options);

    // Sort regions by reading order (top-to-bottom, left-to-right)
    // This flattens multi-column layouts into single-column
    const sorted = sortByReadingOrder(regions);

    for (const region of sorted) {
      const html = regionToHtml(region, previousPageEndedMidSentence);
      if (html) {
        htmlParts.push(html);
        previousPageEndedMidSentence = false;
      }
    }

    // Check if page ends mid-sentence (for join broken pages)
    if (options.joinBrokenPages && sorted.length > 0) {
      const lastRegion = sorted[sorted.length - 1];
      if (lastRegion.type === 'text') {
        const text = lastRegion.content.trim();
        previousPageEndedMidSentence = !text.match(/[.!?:]\s*$/);
      }
    }
  }

  htmlParts.push('</body>');
  htmlParts.push('</html>');

  return htmlParts.join('\n');
}

export function mineruToHtmlBody(output: MineruOutput, options: HtmlConversionOptions): string {
  const pages = filterPages(output.pages, options.pageRange);
  const htmlParts: string[] = [];

  for (const page of pages) {
    const regions = filterRegions(page.regions, options);
    const sorted = sortByReadingOrder(regions);

    for (const region of sorted) {
      const html = regionToHtml(region, false);
      if (html) htmlParts.push(html);
    }
  }

  return htmlParts.join('\n');
}

function filterPages(pages: MineruPage[], pageRange?: { start: number; end: number }): MineruPage[] {
  if (!pageRange) return pages;
  return pages.filter(p => p.page_number >= pageRange.start && p.page_number <= pageRange.end);
}

function filterRegions(regions: MineruRegion[], options: HtmlConversionOptions): MineruRegion[] {
  return regions.filter(region => {
    if (options.removeHeadersFooters && (region.type === 'header' || region.type === 'footer')) {
      return false;
    }
    return true;
  });
}

function sortByReadingOrder(regions: MineruRegion[]): MineruRegion[] {
  // Sort by y-position first (top to bottom), then x-position (left to right)
  // This flattens multi-column layouts into reading order
  return [...regions].sort((a, b) => {
    const yThreshold = 20; // Regions within 20px vertically are on the same "line"
    const yDiff = a.bbox[1] - b.bbox[1];
    if (Math.abs(yDiff) > yThreshold) return yDiff;
    return a.bbox[0] - b.bbox[0]; // Same line, sort left to right
  });
}

function regionToHtml(region: MineruRegion, joinWithPrevious: boolean): string {
  switch (region.type) {
    case 'title': {
      const level = region.level && region.level >= 1 && region.level <= 6 ? region.level : 1;
      return `<h${level}>${escapeHtml(region.content)}</h${level}>`;
    }

    case 'text':
      if (joinWithPrevious) {
        return escapeHtml(region.content).replace(/\n/g, '<br>\n');
      }
      return `<p>${escapeHtml(region.content).replace(/\n/g, '<br>\n')}</p>`;

    case 'table': {
      let tableHtml = convertTable(region);
      // If table block also has an embedded image, prepend it
      if (region.img_data && region.img_mime) {
        const imgTag = `<img src="data:${region.img_mime};base64,${region.img_data}" alt="${escapeHtml(region.content)}" style="max-width:100%">`;
        tableHtml = imgTag + '\n' + tableHtml;
      }
      return tableHtml;
    }

    case 'formula':
      if (region.latex) {
        return `<div class="math-block"><span class="math">${escapeHtml(region.latex)}</span></div>`;
      }
      return `<p class="formula">${escapeHtml(region.content)}</p>`;

    case 'figure': {
      const imgTag = region.img_data && region.img_mime
        ? `<img src="data:${region.img_mime};base64,${region.img_data}" alt="${escapeHtml(region.content)}" style="max-width:100%">`
        : '';
      const caption = region.content ? `<figcaption>${escapeHtml(region.content)}</figcaption>` : '';
      return `<figure>${imgTag}${caption}</figure>`;
    }

    case 'list':
      return convertList(region.content);

    case 'caption':
      return `<figcaption>${escapeHtml(region.content)}</figcaption>`;

    case 'header':
    case 'footer':
      // Should be filtered out if removeHeadersFooters is true
      return `<div class="page-${region.type}">${escapeHtml(region.content)}</div>`;

    default:
      return `<p>${escapeHtml(region.content)}</p>`;
  }
}

function convertTable(region: MineruRegion): string {
  // If MinerU provides table_html, use it directly (with sanitization)
  if (region.table_html) {
    return sanitizeTableHtml(region.table_html);
  }

  // Fallback: simple table from text content
  const lines = region.content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return '';

  let html = '<table>\n<tbody>\n';
  for (const line of lines) {
    const cells = line.split(/\t|  +/);
    html += '<tr>';
    for (const cell of cells) {
      html += `<td>${escapeHtml(cell.trim())}</td>`;
    }
    html += '</tr>\n';
  }
  html += '</tbody>\n</table>';

  return html;
}

function sanitizeTableHtml(html: string): string {
  // Basic sanitization: allow only table-related tags and style attributes
  // Strip any script tags or event handlers
  let sanitized = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/on\w+='[^']*'/gi, '');

  // Convert fixed widths to proportional where possible
  sanitized = sanitized.replace(/width:\s*(\d+)px/gi, (match, px) => {
    // Convert pixel widths to percentages based on typical page width
    const pct = Math.round((parseInt(px) / 612) * 100);
    return `width: ${pct}%`;
  });

  return sanitized;
}

function convertList(content: string): string {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return '';

  // Detect ordered vs unordered
  const isOrdered = lines[0].match(/^\d+[.)]/);
  const tag = isOrdered ? 'ol' : 'ul';

  let html = `<${tag}>\n`;
  for (const line of lines) {
    const text = line.replace(/^[\s•\-*]+|^\d+[.)]\s*/, '');
    html += `<li>${escapeHtml(text)}</li>\n`;
  }
  html += `</${tag}>`;

  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getDefaultStyles(): string {
  return `
    body {
      font-family: "Inter", system-ui, -apple-system, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      line-height: 1.6;
      color: #333;
    }
    h1, h2, h3, h4, h5, h6 {
      margin-top: 1.5em;
      margin-bottom: 0.5em;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1em 0;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 8px;
      text-align: left;
    }
    th {
      background-color: #f5f5f5;
      font-weight: 600;
    }
    .math-block {
      text-align: center;
      margin: 1em 0;
      font-family: "JetBrains Mono", monospace;
    }
    .page-header, .page-footer {
      color: #888;
      font-size: 0.85em;
      border-bottom: 1px solid #eee;
      padding-bottom: 4px;
      margin-bottom: 1em;
    }
    .page-footer {
      border-bottom: none;
      border-top: 1px solid #eee;
      padding-top: 4px;
      margin-top: 1em;
    }
    figure {
      margin: 1em 0;
      text-align: center;
    }
    figcaption {
      font-size: 0.9em;
      color: #666;
      font-style: italic;
    }
  `;
}
