/**
 * True-Copy PPTX: pixel-perfect PowerPoint with text at exact bbox positions.
 *
 * Each PDF page becomes one slide:
 * - Slide dimensions match exact source PDF page dimensions (in inches)
 * - Page image as slide background
 * - Text frames positioned at computed inch coordinates
 *
 * PptxGenJS uses inches for all positioning.
 * Font embedding: PptxGenJS doesn't embed fonts — it references system font names.
 * Pretext re-measures using the target system font name for PPTX positions.
 *
 * MUST run in the Tauri WebView renderer (Pretext needs canvas context).
 */
import PptxGenJS from 'pptxgenjs';
import { MineruOutput, MineruRegion } from '@/types';
import { detectSourcePage } from './page-size';
import { fitTextToBox } from './positioning-core';
import { getPageImage } from '@/lib/mineru/client';

// Map bundled font families to their system-installed equivalents.
// Croscore → system: Arimo→Arial, Tinos→Times New Roman, Cousine→Courier New
const SYSTEM_FONT_MAP: Record<string, string> = {
  Arimo: 'Arial',
  Tinos: 'Times New Roman',
  Cousine: 'Courier New',
  Gelasio: 'Georgia',
  Inter: 'Calibri',
};

function getSystemFontName(bundledFamily: string | undefined): string {
  if (!bundledFamily) return 'Calibri';
  return SYSTEM_FONT_MAP[bundledFamily] || bundledFamily;
}

/**
 * Create a true-copy PPTX from MinerU output.
 *
 * @param mineruOutput Structured OCR output
 * @param taskId MinerU task ID (for page images)
 * @param options Export options
 * @returns PPTX file as ArrayBuffer
 */
export async function createTrueCopyPptx(
  mineruOutput: MineruOutput,
  taskId: string,
  options?: {
    removeHeadersFooters?: boolean;
    includeImages?: boolean;
  },
): Promise<ArrayBuffer> {
  const pres = new PptxGenJS();
  const { pages } = mineruOutput;

  // Use the first page's dimensions as the layout
  // (PptxGenJS supports one layout for all slides)
  if (pages.length > 0) {
    const firstSource = detectSourcePage(pages[0]);
    pres.defineLayout({
      name: 'CUSTOM',
      width: firstSource.width_pt / 72,
      height: firstSource.height_pt / 72,
    });
    pres.layout = 'CUSTOM';
  }

  for (let i = 0; i < pages.length; i++) {
    const mineruPage = pages[i];
    const source = detectSourcePage(mineruPage);
    const slide = pres.addSlide();

    // Add page image as slide background
    if (options?.includeImages !== false) {
      try {
        const imgBuffer = await getPageImage(taskId, i);
        const b64 = imgBuffer.toString('base64');
        slide.addImage({
          data: `image/png;base64,${b64}`,
          x: 0,
          y: 0,
          w: source.width_pt / 72,
          h: source.height_pt / 72,
        });
      } catch {
        // Continue without background
      }
    }

    // Add text frames for each region
    for (const region of mineruPage.regions) {
      if (options?.removeHeadersFooters && (region.type === 'header' || region.type === 'footer')) continue;
      addRegionToSlide(slide, region, source.width_pt / 72, source.height_pt / 72);
    }
  }

  const buffer = await pres.write({ outputType: 'arraybuffer' }) as ArrayBuffer;
  return buffer;
}

/**
 * Add a text region to a PPTX slide as a positioned text frame.
 */
function addRegionToSlide(
  slide: PptxGenJS.Slide,
  region: MineruRegion,
  slideW_in: number,
  slideH_in: number,
): void {
  const effectiveText = region.content_per_page ?? region.content;

  // Handle figures/formulas as images
  if ((region.type === 'figure' || region.type === 'formula') && region.img_data) {
    const [x1, y1, x2, y2] = region.bbox;
    const w = x2 - x1;
    const h = y2 - y1;
    if (w <= 0 || h <= 0) return;

    const mime = region.img_mime || 'image/png';
    slide.addImage({
      data: `${mime};base64,${region.img_data}`,
      x: x1 / 72,
      y: y1 / 72,
      w: w / 72,
      h: h / 72,
    });
    return;
  }

  if (!effectiveText || effectiveText.trim() === '') return;
  if (region.type === 'table') return; // Tables handled separately (as images for MVP)

  const [x1, y1, x2, y2] = region.bbox;
  const regionWidth = x2 - x1;
  const regionHeight = y2 - y1;
  if (regionWidth <= 0 || regionHeight <= 0) return;

  const rawText = effectiveText.replace(/<[^>]*>/g, '');
  if (!rawText.trim()) return;

  const isBold = region.type === 'title';
  const hasBreaks = rawText.includes('\n');
  const systemFont = getSystemFontName(region.font_family);

  // Re-measure with the system font for PPTX (different from HTML/PDF WOFF2 measurement)
  const fontFamily = `'${systemFont}', 'Calibri', sans-serif`;
  const fit = fitTextToBox(rawText, regionWidth, regionHeight, fontFamily, isBold, null, hasBreaks);

  slide.addText(rawText, {
    x: x1 / 72,
    y: y1 / 72,
    w: regionWidth / 72,
    h: regionHeight / 72,
    fontSize: Math.round(fit.fontSize * 10) / 10,
    fontFace: systemFont,
    bold: isBold,
    color: '000000',
    valign: 'top',
    wrap: true,
    margin: 0,
  });
}
