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
import katex from 'katex';

export interface HtmlConversionOptions {
  removeHeadersFooters: boolean;
  removeMetadata: boolean;
  joinBrokenPages: boolean;
  pageRange?: { start: number; end: number };
  formulaDisplay?: 'rendered' | 'image';
  tableDisplay?: 'rendered' | 'image';
  includeFigures?: boolean;
  figureDisplay?: 'image' | 'text';
}

interface RegionRenderOptions {
  joinWithPrevious: boolean;
  formulaDisplay: 'rendered' | 'image';
  tableDisplay: 'rendered' | 'image';
  includeFigures: boolean;
  figureDisplay: 'image' | 'text';
}

export function mineruToHtml(output: MineruOutput, options: HtmlConversionOptions): string {
  const pages = filterPages(output.pages, options.pageRange);
  const htmlParts: string[] = [];

  htmlParts.push('<!DOCTYPE html>');
  htmlParts.push('<html lang="en">');
  htmlParts.push('<head>');
  htmlParts.push('<meta charset="UTF-8">');
  htmlParts.push(`<title>${escapeHtml(output.metadata.file_name || 'Document')}</title>`);
  htmlParts.push('<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.44/dist/katex.min.css">');
  htmlParts.push('<style>');
  htmlParts.push(getDefaultStyles());
  htmlParts.push('</style>');
  htmlParts.push('</head>');
  htmlParts.push('<body>');

  let previousPageEndedMidSentence = false;
  const formulaDisplay = options.formulaDisplay ?? 'image';
  const tableDisplay = options.tableDisplay ?? 'rendered';
  const includeFigures = options.includeFigures ?? true;
  const figureDisplay = options.figureDisplay ?? 'image';

  for (const page of pages) {
    const regions = filterRegions(page.regions, options);

    // Sort regions by reading order (top-to-bottom, left-to-right)
    // This flattens multi-column layouts into single-column
    const sorted = sortByReadingOrder(regions);

    for (const region of sorted) {
      const html = regionToHtml(region, { joinWithPrevious: previousPageEndedMidSentence, formulaDisplay, tableDisplay, includeFigures, figureDisplay });
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

function mineruToHtmlBody(output: MineruOutput, options: HtmlConversionOptions): string {
  const pages = filterPages(output.pages, options.pageRange);
  const htmlParts: string[] = [];
  const formulaDisplay = options.formulaDisplay ?? 'image';
  const tableDisplay = options.tableDisplay ?? 'rendered';
  const includeFigures = options.includeFigures ?? true;
  const figureDisplay = options.figureDisplay ?? 'image';

  for (const page of pages) {
    const regions = filterRegions(page.regions, options);
    const sorted = sortByReadingOrder(regions);

    for (const region of sorted) {
      const html = regionToHtml(region, { joinWithPrevious: false, formulaDisplay, tableDisplay, includeFigures, figureDisplay });
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

export function regionToHtml(region: MineruRegion, options: RegionRenderOptions): string {
  const formulaOpts: FormulaRenderOptions = {
    formulaDisplay: options.formulaDisplay,
    inlineEquations: region.inline_equations,
  };

  switch (region.type) {
    case 'title': {
      const level = region.level && region.level >= 1 && region.level <= 6 ? region.level : 1;
      return `<h${level}>${sanitizeFormattedText(region.content, formulaOpts)}</h${level}>`;
    }

    case 'text':
      if (options.joinWithPrevious) {
        return sanitizeFormattedText(region.content, formulaOpts);
      }
      return `<p>${sanitizeFormattedText(region.content, formulaOpts)}</p>`;

    case 'table': {
      if (options.tableDisplay === 'image' && region.img_data && region.img_mime) {
        return `<div class="table-image"><img src="data:${region.img_mime};base64,${region.img_data}" alt="Table" style="max-width:100%"></div>`;
      }
      const tableHtml = convertTable(region);
      return tableHtml;
    }

    case 'formula': {
      const hasImage = region.img_data && region.img_mime;
      if (options.formulaDisplay === 'image' && hasImage) {
        return `<div class="math-block"><img src="data:${region.img_mime};base64,${region.img_data}" alt="Formula" style="max-width:100%"></div>`;
      }
      // Use region.latex if available, otherwise fall back to region.content
      const latexSource = region.latex || region.content;
      if (latexSource) {
        try {
          const html = katex.renderToString(latexSource, {
            throwOnError: true,
            displayMode: true,
            output: 'html',
          });
          return `<div class="math-block">${html}</div>`;
        } catch {
          // KaTeX failed — fall back to image if available, never plain text
          if (hasImage) {
            return `<div class="math-block"><img src="data:${region.img_mime};base64,${region.img_data}" alt="Formula" style="max-width:100%"></div>`;
          }
          return `<div class="math-block"><code>${escapeHtml(latexSource)}</code></div>`;
        }
      }
      return '';
    }

    case 'figure': {
      if (!options.includeFigures) return '';
      if (options.figureDisplay === 'text') {
        const caption = region.content ? sanitizeFormattedText(region.content, formulaOpts) : '[Image]';
        return `<p>${caption}</p>`;
      }
      // Image mode: only render if we have actual image data
      if (region.img_data && region.img_mime) {
        const imgTag = `<img src="data:${region.img_mime};base64,${region.img_data}" alt="${escapeHtml(region.content)}" style="max-width:100%">`;
        const caption = region.content ? `<figcaption>${sanitizeFormattedText(region.content, formulaOpts)}</figcaption>` : '';
        return `<figure>${imgTag}${caption}</figure>`;
      }
      // No image data available — skip rather than showing text in image mode
      return '';
    }

    case 'list':
      return convertList(region.content, formulaOpts);

    case 'caption':
      return `<figcaption>${sanitizeFormattedText(region.content, formulaOpts)}</figcaption>`;

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
    'colgroup', 'col', 'strong', 'em', 'u', 'b', 'i', 'sup', 'sub',
  ]);
  sanitized = sanitized.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/gi, (match, tagName) => {
    return TABLE_ALLOWED_TAGS.has(tagName.toLowerCase()) ? match : '';
  });

  return sanitized;
}

/**
 * Classify a line's list marker type and nesting level.
 *
 * Marker hierarchy (outer → inner):
 *   Level 0: Arabic numbers — 1. / 1) / (1)
 *   Level 1: Roman numerals — (i) / (ii) / i. / ii)
 *   Level 2: Letters — (a) / (b) / a. / a)
 *   Level 0: Bullets — •, -, *
 *   Level -1: No marker (continuation text)
 */
function classifyListLine(line: string): { level: number; text: string } {
  const trimmed = line.trim();

  // Arabic numbered: 1. / 1) / (1) / [1] / 1.1. / 3.2.1. (multi-level)
  if (/^(\d+\.)+\s/.test(trimmed) || /^\d+\)\s/.test(trimmed) || /^\(\d+\)\s/.test(trimmed) || /^\[\d+\]\s/.test(trimmed)) {
    return { level: 0, text: trimmed };
  }

  // Roman numerals: (i) / (ii) / (iii) / (iv) / i) / ii. etc.
  // Valid roman sequences only (not single letters that could be alphabetical)
  const romanParenMatch = trimmed.match(/^\(([ivxlcdm]+)\)\s/i);
  const romanBareMatch = trimmed.match(/^([ivxlcdm]{2,})[.)]\s/i); // 2+ chars = definitely roman
  const romanSingleMatch = trimmed.match(/^([ivx])[.)]\s/i); // single i/v/x could be roman

  if (romanParenMatch) {
    const val = romanParenMatch[1].toLowerCase();
    // Disambiguate: (a)-(h), (j)-(z) are always alphabetical
    // (i), (v), (x) etc. that are valid roman → treat as roman
    if (isValidRoman(val)) {
      return { level: 1, text: trimmed };
    }
    // Fall through to alpha check
  }
  if (romanBareMatch) {
    const val = romanBareMatch[1].toLowerCase();
    if (isValidRoman(val)) {
      return { level: 1, text: trimmed };
    }
  }

  // Uppercase Roman: (I) / (II) / I. / II)
  const upperRomanParenMatch = trimmed.match(/^\(([IVXLCDM]+)\)\s/);
  const upperRomanBareMatch = trimmed.match(/^([IVXLCDM]{2,})[.)]\s/);
  if (upperRomanParenMatch && isValidRoman(upperRomanParenMatch[1].toLowerCase())) {
    return { level: 1, text: trimmed };
  }
  if (upperRomanBareMatch && isValidRoman(upperRomanBareMatch[1].toLowerCase())) {
    return { level: 1, text: trimmed };
  }

  // Letters: (a) / (b) / a. / a) / [a]
  if (/^\([a-zA-Z]\)\s/.test(trimmed) || /^[a-zA-Z][.)]\s/.test(trimmed) || /^\[[a-zA-Z]\]\s/.test(trimmed)) {
    return { level: 2, text: trimmed };
  }

  // Bullets
  if (/^[\-\u2022\u25CF\u25CB\u25AA\u25AB\u2013\u2014\u27A4\u2023\u203A\u25B6\u25BA\u2219\u2605\u2606*]\s/.test(trimmed)) {
    return { level: 0, text: trimmed };
  }

  // Section/Article/Step/Appendix/References prefixes
  if (/^(?:Section|Article|Part|Chapter|Item|Note|Step|Appendix|References)\b/i.test(trimmed)) {
    return { level: 0, text: trimmed };
  }

  // No marker — continuation text, keep at previous level
  return { level: -1, text: trimmed };
}

/**
 * Check if a string is a valid Roman numeral.
 */
function isValidRoman(s: string): boolean {
  // Match valid roman numeral patterns (i through xxxix covers most list usage)
  return /^(?:x{0,3})(?:ix|iv|v?i{0,3})$/.test(s) && s.length > 0;
}

export function convertList(content: string, formulaOpts?: FormulaRenderOptions): string {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return '';

  // Classify each line
  const classified = lines.map(l => classifyListLine(l));

  // Find the minimum level present (for base indentation)
  const levels = classified.filter(c => c.level >= 0).map(c => c.level);
  const minLevel = levels.length > 0 ? Math.min(...levels) : 0;

  // Render as a div with preserved markers and indentation
  let html = '<div class="list-block">\n';
  let prevLevel = minLevel;
  for (const { level, text } of classified) {
    const effectiveLevel = level >= 0 ? level : prevLevel; // continuation uses prev level
    const indent = Math.max(0, effectiveLevel - minLevel);
    const marginLeft = indent * 1.5; // 1.5em per nesting level
    const style = marginLeft > 0 ? ` style="margin-left:${marginLeft}em"` : '';
    html += `<p${style}>${sanitizeFormattedText(text, formulaOpts)}</p>\n`;
    if (level >= 0) prevLevel = level;
  }
  html += '</div>';

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

const ALLOWED_TAGS = ['strong', 'em', 'u', 's', 'b', 'i', 'sup', 'sub'] as const;

interface InlineEquation {
  latex: string;
  display: string;
  img_data?: string;
  img_mime?: string;
}

export interface FormulaRenderOptions {
  formulaDisplay?: 'rendered' | 'image';
  inlineEquations?: InlineEquation[];
}

export function sanitizeFormattedText(text: string, options?: FormulaRenderOptions): string {
  const formulaDisplay = options?.formulaDisplay ?? 'image';
  const inlineEquations = options?.inlineEquations;

  // Use placeholders to protect rendered HTML from the escape step.
  const placeholders: string[] = [];
  function placeholder(html: string): string {
    const idx = placeholders.length;
    placeholders.push(html);
    return `\x00KATEX${idx}\x00`;
  }

  let result = text;

  // Step 1: Handle {{EQ:index}} placeholders from server (inline equations with image data)
  if (inlineEquations && inlineEquations.length > 0) {
    result = result.replace(/\{\{EQ:(\d+)\}\}/g, (_match, idxStr) => {
      const idx = parseInt(idxStr, 10);
      const eq = inlineEquations[idx];
      if (!eq) return _match;
      return placeholder(renderEquation(eq, formulaDisplay));
    });
  }

  // Step 2: Handle legacy $...$ LaTeX in text (for content without inline_equations data)
  // Display LaTeX ($$...$$)
  result = result.replace(/\$\$([^$]+?)\$\$/g, (_match, latex) => {
    return placeholder(renderLatex(latex.trim(), true, formulaDisplay));
  });
  // Inline LaTeX ($...$)
  result = result.replace(/\$([^$]+)\$/g, (_match, latex) => {
    return placeholder(renderLatex(latex, false, formulaDisplay));
  });

  // Step 3: Escape ALL remaining HTML (rendered content is safely in placeholders)
  result = escapeHtml(result);

  // Step 4: Unescape ONLY the allowed tags (opening and closing, stripping any attributes)
  for (const tag of ALLOWED_TAGS) {
    result = result.replace(
      new RegExp(`&lt;${tag}(\\s.*?)?&gt;`, 'gi'),
      `<${tag}>`
    );
    result = result.replace(
      new RegExp(`&lt;/${tag}&gt;`, 'gi'),
      `</${tag}>`
    );
  }

  // Step 5: Restore placeholders
  result = result.replace(/\x00KATEX(\d+)\x00/g, (_match, idx) => {
    return placeholders[parseInt(idx, 10)];
  });

  return result;
}

/**
 * Render an inline equation that has image data from the server.
 * Priority: image when formulaDisplay='image', KaTeX when 'rendered' (with image fallback).
 * NEVER returns plain text.
 */
function renderEquation(eq: InlineEquation, formulaDisplay: 'rendered' | 'image'): string {
  const isBlock = eq.display === 'block';
  const hasImage = eq.img_data && eq.img_mime;

  if (formulaDisplay === 'image' && hasImage) {
    const imgTag = `<img src="data:${eq.img_mime};base64,${eq.img_data}" alt="Formula" style="max-height:1.2em;vertical-align:middle">`;
    return isBlock ? `<div class="math-block">${imgTag}</div>` : imgTag;
  }

  // Try KaTeX rendering
  try {
    const html = katex.renderToString(eq.latex, {
      throwOnError: true,
      displayMode: isBlock,
      output: 'html',
    });
    return isBlock ? `<div class="math-block">${html}</div>` : html;
  } catch {
    // KaTeX failed — fall back to image if available, NEVER plain text
    if (hasImage) {
      const imgTag = `<img src="data:${eq.img_mime};base64,${eq.img_data}" alt="Formula" style="max-height:1.2em;vertical-align:middle">`;
      return isBlock ? `<div class="math-block">${imgTag}</div>` : imgTag;
    }
    // Last resort: render as code block (not plain text)
    const codeHtml = isBlock
      ? `<div class="math-block"><code>${escapeHtml(eq.latex)}</code></div>`
      : `<code class="math-inline">${escapeHtml(eq.latex)}</code>`;
    return codeHtml;
  }
}

/**
 * Render LaTeX from legacy $...$ markup (no image data available).
 * Used for backward compatibility with content that doesn't have inline_equations.
 */
function renderLatex(latex: string, isBlock: boolean, formulaDisplay: 'rendered' | 'image'): string {
  // Without image data, always try KaTeX regardless of formulaDisplay
  try {
    const html = katex.renderToString(latex, {
      throwOnError: false,
      displayMode: isBlock,
      output: 'html',
    });
    return isBlock ? `<div class="math-block">${html}</div>` : html;
  } catch {
    const codeHtml = isBlock
      ? `<div class="math-block"><code>${escapeHtml(latex)}</code></div>`
      : `<code class="math-inline">${escapeHtml(latex)}</code>`;
    return codeHtml;
  }
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
      overflow-x: auto;
    }
    .math-block code {
      font-family: "JetBrains Mono", monospace;
      font-size: 0.95em;
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
    .list-block {
      margin: 0.5em 0 0.5em 1em;
    }
    .list-block p {
      margin: 0.15em 0;
    }
  `;
}
