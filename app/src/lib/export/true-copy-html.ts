/**
 * True-Copy HTML renderer: positions text at exact bbox coordinates over page images.
 *
 * Produces a self-contained HTML file with:
 * - Page images as backgrounds (base64-encoded PNGs)
 * - Text blocks absolutely positioned at their original PDF coordinates
 * - Dynamic font sizing via @chenglou/pretext (embedded inline, ~85KB)
 * - Image toggle button cycling: Overlay → Text Only → Image Only → Overlay
 *
 * Font sizing uses Pretext's DOM-free measurement:
 *   Binary-search for the largest font size where prepare()+layout() says
 *   the text height fits the bbox. No scrollHeight, no reflow — pure arithmetic
 *   after the initial canvas measurement pass.
 */
import { MineruOutput, MineruPage, MineruRegion } from '@/types';
import { getPageImage } from '@/lib/mineru/client';
import { sanitizeTableHtml, sanitizeFormattedText, escapeHtml } from '@/lib/mineru/html-converter';
import fs from 'fs';
import path from 'path';

// Read and cache the pretext IIFE bundle at module load time.
// Built via: npx esbuild @chenglou/pretext --bundle --format=iife --global-name=Pretext --outfile=.cache/pretext-bundle.js
let pretextBundle: string | null = null;
function getPretextBundle(): string {
  if (pretextBundle) return pretextBundle;
  const bundlePath = path.join(process.cwd(), '.cache', 'pretext-bundle.js');
  pretextBundle = fs.readFileSync(bundlePath, 'utf-8');
  return pretextBundle;
}

export async function createTrueCopyHtml(
  mineruOutput: MineruOutput,
  taskId: string,
  title: string,
  options?: { removeHeadersFooters?: boolean; includeImages?: boolean },
): Promise<string> {
  const pages = mineruOutput.pages;
  const pageHtmlParts: string[] = [];
  const includeImages = options?.includeImages ?? false;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];

    // Only fetch page images when benchmark mode is enabled
    let imageBase64 = '';
    if (includeImages) {
      try {
        const imageBuffer = await getPageImage(taskId, i);
        imageBase64 = imageBuffer.toString('base64');
      } catch (err) {
        console.warn(`[TrueCopy] Failed to fetch page image ${i}:`, err);
      }
    }

    pageHtmlParts.push(renderPage(page, imageBase64, i, options?.removeHeadersFooters ?? false));
  }

  return buildDocument(title, pageHtmlParts.join('\n'));
}

function renderPage(page: MineruPage, imageBase64: string, pageIndex: number, removeHeadersFooters: boolean): string {
  const { width, height, regions } = page;
  const pageHtml: string[] = [];

  pageHtml.push(`<div class="tc-page" style="width:${width}px;height:${height}px" data-page="${pageIndex + 1}">`);

  if (imageBase64) {
    pageHtml.push(`<img class="tc-page-image" src="data:image/png;base64,${imageBase64}" alt="Page ${pageIndex + 1}" style="width:${width}px;height:${height}px">`);
  }

  pageHtml.push('<div class="tc-text-layer">');
  for (const region of regions) {
    // Skip empty regions — but tables can have table_html without content text
    const hasContent = (region.content && region.content.trim() !== '') ||
                       (region.type === 'table' && region.table_html);
    if (!hasContent) continue;
    if (removeHeadersFooters && (region.type === 'header' || region.type === 'footer')) continue;

    const html = renderRegion(region);
    if (html) pageHtml.push(html);
  }
  pageHtml.push('</div>');

  pageHtml.push('</div>');
  return pageHtml.join('\n');
}

function renderRegion(region: MineruRegion): string {
  const [x1, y1, x2, y2] = region.bbox;
  const regionWidth = x2 - x1;
  const regionHeight = y2 - y1;

  if (regionWidth <= 0 || regionHeight <= 0) return '';

  // Position the box at exact bbox coordinates — font size will be set dynamically by JS
  const style = `left:${x1}px;top:${y1}px;width:${regionWidth}px;height:${regionHeight}px`;

  let content: string;
  let dataAttrs = '';

  if (region.type === 'table' && region.table_html) {
    content = sanitizeTableHtml(region.table_html);
    // Tables use DOM-based binary search (data-fit-table) since Pretext can't measure HTML tables
    dataAttrs = ` data-fit-table="true"`;
    return `<div class="tc-region tc-region-${region.type}" style="${style}"${dataAttrs}>${content}</div>`;
  } else if (region.type === 'figure' || region.type === 'formula') {
    if (region.img_data && region.img_mime) {
      content = `<img src="data:${region.img_mime};base64,${region.img_data}" alt="${escapeHtml(region.content || 'Formula')}" style="max-width:100%;max-height:100%;object-fit:contain">`;
    } else {
      return '';
    }
  } else {
    // Strip HTML tags for measurement — Pretext measures plain text only
    const rawText = region.content.replace(/<[^>]*>/g, '');
    const isBold = region.type === 'title' || /<strong>/i.test(region.content);
    const hasBreaks = rawText.includes('\n');
    // Use sanitizeFormattedText to preserve <strong>, <em>, etc. and render LaTeX
    // For pre-wrap regions, keep \n as-is (browser renders them); otherwise convert to <br>
    content = sanitizeFormattedText(region.content);
    if (!hasBreaks) content = content.replace(/\n/g, '<br>');
    dataAttrs = ` data-raw-text="${escapeAttr(rawText)}" data-fit="true"${isBold ? ' data-bold="1"' : ''}${hasBreaks ? ' data-prewrap="1"' : ''}`;
  }

  const typeClass = `tc-region-${region.type}`;
  return `<div class="tc-region ${typeClass}" style="${style}"${dataAttrs}>${content}</div>`;
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '&#10;');
}

function buildDocument(title: string, pagesHtml: string): string {
  const measureScript = getPretextBundle();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)} — True Copy</title>
<style>
${getStyles()}
</style>
</head>
<body>
<button id="tc-toggle" class="tc-toggle" title="Toggle view mode">Overlay</button>
<div id="tc-container" class="tc-container tc-mode-overlay">
${pagesHtml}
</div>
<script>
${measureScript}
</script>
<script>
${getFitScript()}
</script>
<script>
${getToggleScript()}
</script>
</body>
</html>`;
}

function getStyles(): string {
  return `* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: #525659;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px 0;
  font-family: "Inter", sans-serif;
}
.tc-toggle {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 1000;
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  background: rgba(0,0,0,0.7);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}
.tc-toggle:hover { background: rgba(0,0,0,0.85); }
.tc-container { display: flex; flex-direction: column; align-items: center; gap: 16px; }
.tc-page {
  position: relative;
  background: #fff;
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  overflow: hidden;
}
.tc-page-image {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}
.tc-text-layer {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
}
.tc-region {
  position: absolute;
  overflow: hidden;
  line-height: 1.2;
  word-break: normal;
  overflow-wrap: break-word;
}
/* Overlay mode: semi-transparent text over image */
.tc-mode-overlay .tc-region {
  color: rgba(0, 0, 0, 0.85);
  background: rgba(255, 255, 255, 0.3);
}
.tc-mode-overlay .tc-page-image { opacity: 1; }
/* Text Only mode */
.tc-mode-text .tc-region {
  color: #000;
  background: transparent;
}
.tc-mode-text .tc-page-image { opacity: 0; }
/* Image Only mode */
.tc-mode-image .tc-region { opacity: 0; }
.tc-mode-image .tc-page-image { opacity: 1; }
/* Table styling within positioned regions */
.tc-region table { border-collapse: collapse; width: 100%; font-size: inherit; }
.tc-region th, .tc-region td { border: 1px solid #999; padding: 1px 2px !important; line-height: 1.2; }
/* Title regions */
.tc-region-title { font-weight: 600; }
/* Figures — remove inline image spacing */
.tc-region-figure img { display: block; }
/* KaTeX rendered math */
.katex { font-size: inherit !important; }`;
}

/**
 * Script that runs at render time to fit text into each region's bbox.
 * Uses Pretext (already loaded as global `Pretext`) for DOM-free measurement:
 *   Binary-search for the largest font size where
 *   layout(prepare(text, font), boxWidth, lineHeight).height <= boxHeight
 *
 * No scrollHeight, no reflow — pure arithmetic after canvas measurement.
 * Pretext targets: white-space:normal, word-break:normal, overflow-wrap:break-word
 */
function getFitScript(): string {
  return `(function() {
  var LINE_HEIGHT_RATIO = 1.2;
  var FONT_FAMILY = '"Inter", sans-serif';
  var FLOOR = 1;
  var regions = document.querySelectorAll('[data-fit="true"]');

  // Measure the text at a given font size. Returns measured height in px.
  function measureAt(rawText, size, boxWidth, isBold, opts) {
    var font = (isBold ? '600 ' : '') + size + 'px ' + FONT_FAMILY;
    var lineH = Math.round(size * LINE_HEIGHT_RATIO);
    if (lineH < 1) lineH = 1;
    var prepared = Pretext.prepare(rawText, font, opts);
    var result = Pretext.layout(prepared, boxWidth, lineH);
    return result.height;
  }

  // Discover dynamic [lo, hi] bounds for the binary search by probing a
  // ladder of candidate sizes derived from the box height. Binary search
  // invariant: lo = largest known-fitting size, hi = smallest known-NOT-fitting
  // size. So the first candidate that fits in the descending ladder becomes
  // lo, and the previous (larger, failed) candidate becomes hi.
  // Falls back to FLOOR if even the smallest candidate doesn't fit.
  function findFontBounds(rawText, boxWidth, boxHeight, isBold, opts) {
    // Descending ladder relative to boxHeight. Always anchored at FLOOR.
    var ladder = [
      boxHeight * 4,
      boxHeight * 2,
      boxHeight,
      boxHeight / 2,
      boxHeight / 4,
      FLOOR
    ];
    // Sanitize: strictly descending, anchored at FLOOR.
    var clean = [];
    for (var k = 0; k < ladder.length; k++) {
      var v = ladder[k];
      if (!isFinite(v) || v <= 0) continue;
      if (v < FLOOR) v = FLOOR;
      if (clean.length === 0 || v < clean[clean.length - 1]) clean.push(v);
    }
    if (clean.length === 0) clean.push(FLOOR);
    if (clean[clean.length - 1] > FLOOR) clean.push(FLOOR);

    var prevFailed = null; // last (larger) candidate that overflowed
    for (var j = 0; j < clean.length; j++) {
      var size = clean[j];
      var h = measureAt(rawText, size, boxWidth, isBold, opts);
      if (h <= boxHeight) {
        // Found a fitting size: lo = this size, hi = last failed (or this size if none failed).
        var hi = prevFailed !== null ? prevFailed : size;
        return { lo: size, hi: hi };
      }
      prevFailed = size;
    }
    // Even FLOOR overflows — clamp to FLOOR.
    return { lo: FLOOR, hi: FLOOR };
  }

  for (var i = 0; i < regions.length; i++) {
    var el = regions[i];
    var boxWidth = parseFloat(el.style.width);
    var boxHeight = parseFloat(el.style.height);
    if (!boxWidth || !boxHeight) continue;

    var rawText = el.getAttribute('data-raw-text') || '';
    if (!rawText) continue;

    var isBold = el.hasAttribute('data-bold');
    var opts = el.hasAttribute('data-prewrap') ? { whiteSpace: 'pre-wrap' } : undefined;

    // Phase 1: probe ladder to discover dynamic [lo, hi] bounds.
    var bounds = findFontBounds(rawText, boxWidth, boxHeight, isBold, opts);
    var lo = bounds.lo;
    var hi = bounds.hi;
    var bestSize = lo;

    // Phase 2: binary search within the discovered window.
    for (var iter = 0; iter < 20; iter++) {
      if (hi - lo < 0.5) break;
      var mid = (lo + hi) / 2;
      var measuredHeight = measureAt(rawText, mid, boxWidth, isBold, opts);
      if (measuredHeight <= boxHeight) {
        bestSize = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    if (bestSize < FLOOR) bestSize = FLOOR;

    el.style.fontSize = bestSize.toFixed(1) + 'px';
    el.style.lineHeight = Math.round(bestSize * LINE_HEIGHT_RATIO) + 'px';
    if (el.hasAttribute('data-prewrap')) el.style.whiteSpace = 'pre-wrap';
  }

  // Second pass: fit tables using DOM scrollHeight (Pretext can't measure HTML tables)
  var tables = document.querySelectorAll('[data-fit-table="true"]');
  for (var t = 0; t < tables.length; t++) {
    var tel = tables[t];
    var tBoxH = parseFloat(tel.style.height);
    if (!tBoxH) continue;

    var tlo = 4;
    var thi = Math.min(tBoxH / 2, 14);
    var tBest = tlo;

    for (var titer = 0; titer < 20; titer++) {
      var tmid = (tlo + thi) / 2;
      tel.style.fontSize = tmid + 'px';
      if (tel.scrollHeight <= tBoxH) {
        tBest = tmid;
        tlo = tmid;
      } else {
        thi = tmid;
      }
      if (thi - tlo < 0.25) break;
    }

    tel.style.fontSize = tBest.toFixed(1) + 'px';
  }
})();`;
}

function getToggleScript(): string {
  return `(function() {
  var modes = ['tc-mode-overlay', 'tc-mode-text', 'tc-mode-image'];
  var labels = ['Overlay', 'Text Only', 'Image Only'];
  var idx = 0;
  var btn = document.getElementById('tc-toggle');
  var container = document.getElementById('tc-container');
  btn.addEventListener('click', function() {
    container.classList.remove(modes[idx]);
    idx = (idx + 1) % modes.length;
    container.classList.add(modes[idx]);
    btn.textContent = labels[idx];
  });
})();`;
}
