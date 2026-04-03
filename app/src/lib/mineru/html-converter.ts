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

export function regionToHtml(region: MineruRegion, joinWithPrevious: boolean): string {
  switch (region.type) {
    case 'title': {
      const level = region.level && region.level >= 1 && region.level <= 6 ? region.level : 1;
      return `<h${level}>${sanitizeFormattedText(region.content)}</h${level}>`;
    }

    case 'text':
      if (joinWithPrevious) {
        return sanitizeFormattedText(region.content).replace(/\n/g, '<br>\n');
      }
      return `<p>${sanitizeFormattedText(region.content).replace(/\n/g, '<br>\n')}</p>`;

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

const ALLOWED_CSS_PROPERTIES = new Set([
  'width', 'min-width', 'background-color', 'background',
  'border', 'border-top', 'border-bottom', 'border-left', 'border-right',
  'border-collapse', 'text-align', 'vertical-align', 'padding',
]);

const BLOCKED_CSS_PROPERTIES = new Set([
  'border-image', 'font-family', 'font-size', 'color',
  'position', 'float', 'display', 'margin',
]);

function sanitizeCssValue(value: string): boolean {
  const lower = value.toLowerCase();
  return !lower.includes('url(') && !lower.includes('expression(') && !lower.includes('!important');
}

function sanitizeStyleAttribute(style: string): string {
  const declarations = style.split(';').map(d => d.trim()).filter(Boolean);
  const allowed: string[] = [];

  for (const decl of declarations) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx === -1) continue;
    const prop = decl.substring(0, colonIdx).trim().toLowerCase();
    const value = decl.substring(colonIdx + 1).trim();

    if (BLOCKED_CSS_PROPERTIES.has(prop)) continue;
    if (!ALLOWED_CSS_PROPERTIES.has(prop)) continue;
    if (!sanitizeCssValue(value)) continue;

    // For width, strip px values (LLM prompt asks for percentages), keep % values
    if (prop === 'width') {
      if (/px/i.test(value)) continue;
    }

    allowed.push(`${prop}: ${value}`);
  }

  return allowed.length > 0 ? ` style="${allowed.join('; ')}"` : '';
}

export function sanitizeTableHtml(html: string): string {
  // Strip script tags and event handlers
  let sanitized = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\s*on\w+=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Strip class and id attributes
  sanitized = sanitized.replace(/\s+class="[^"]*"/gi, '');
  sanitized = sanitized.replace(/\s+class='[^']*'/gi, '');
  sanitized = sanitized.replace(/\s+id="[^"]*"/gi, '');
  sanitized = sanitized.replace(/\s+id='[^']*'/gi, '');

  // Process style attributes
  sanitized = sanitized.replace(/\s+style="([^"]*)"/gi, (_match, styleContent) => {
    return sanitizeStyleAttribute(styleContent);
  });
  sanitized = sanitized.replace(/\s+style='([^']*)'/gi, (_match, styleContent) => {
    return sanitizeStyleAttribute(styleContent);
  });

  // Strip disallowed tags (keep their text content)
  const TABLE_ALLOWED_TAGS = new Set([
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
    'colgroup', 'col', 'strong', 'em', 'u', 'b', 'i',
  ]);
  sanitized = sanitized.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/gi, (match, tagName) => {
    return TABLE_ALLOWED_TAGS.has(tagName.toLowerCase()) ? match : '';
  });

  return sanitized;
}

export function convertList(content: string): string {
  // If content already contains HTML list tags, pass through sanitizer instead of re-parsing
  if (/<ul[\s>]|<ol[\s>]|<li[\s>]/i.test(content)) {
    return sanitizeFormattedText(content);
  }

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

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ALLOWED_TAGS = ['strong', 'em', 'u', 'ul', 'ol', 'li', 'b', 'i'] as const;

export function sanitizeFormattedText(text: string): string {
  // Step 1: Escape ALL HTML
  let result = escapeHtml(text);

  // Step 2: Unescape ONLY the allowed tags (opening and closing, stripping any attributes)
  for (const tag of ALLOWED_TAGS) {
    // Opening tags with or without attributes: &lt;strong class=&quot;x&quot;&gt; → <strong>
    result = result.replace(
      new RegExp(`&lt;${tag}(\\s.*?)?&gt;`, 'gi'),
      `<${tag}>`
    );
    // Closing tags: &lt;/strong&gt; → </strong>
    result = result.replace(
      new RegExp(`&lt;/${tag}&gt;`, 'gi'),
      `</${tag}>`
    );
  }

  return result;
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
