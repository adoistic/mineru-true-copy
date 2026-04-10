/**
 * True-Copy DOCX: pixel-perfect Word document with text at exact bbox positions.
 *
 * Each PDF page becomes a DOCX section with:
 * - Exact page dimensions (zero margins) matching the source PDF
 * - Page image as a floating background image (behind text)
 * - Text boxes (framePr) positioned at computed DXA coordinates
 * - Font sizes computed via Pretext binary search (shared positioning core)
 *
 * Architecture:
 *   MineruOutput → page-size → positioning-core → docx-js → Packer.toBuffer()
 *
 * MUST run in the Tauri WebView renderer (Pretext needs canvas context).
 */
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  SectionType,
  FrameAnchorType,
  FrameWrap,
} from 'docx';
import { MineruOutput, MineruPage, MineruRegion } from '@/types';
import { detectSourcePage, computeTargetDimensions } from './page-size';
import { fitTextToBox } from './positioning-core';
import { getPageImage, getMineruUrl } from '@/lib/mineru/client';
import { fetchAllTtf, clearFontCache } from './font-loader';

/**
 * Create a true-copy DOCX document from MinerU output.
 *
 * @param mineruOutput Structured OCR output with pages, regions, and fonts
 * @param taskId MinerU task ID (for fetching page images)
 * @param options Export options
 * @returns DOCX file as ArrayBuffer
 */
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

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const source = detectSourcePage(page);
    const target = computeTargetDimensions(source);
    const { width_dxa, height_dxa } = target.docx;

    // Fetch page image for background
    let pageImageBuffer: Buffer | null = null;
    if (options?.includeImages !== false) {
      try {
        pageImageBuffer = await getPageImage(taskId, i);
      } catch {
        // Continue without background image
      }
    }

    const children: Paragraph[] = [];

    // Add page background image as a floating image behind text
    if (pageImageBuffer) {
      children.push(
        new Paragraph({
          frame: {
            type: 'absolute' as const,
            position: { x: 0, y: 0 },
            width: width_dxa,
            height: height_dxa,
            anchor: {
              horizontal: FrameAnchorType.PAGE,
              vertical: FrameAnchorType.PAGE,
            },
            wrap: FrameWrap.NONE,
          },
          children: [
            new ImageRun({
              type: 'png',
              data: pageImageBuffer,
              transformation: {
                width: source.width_pt,   // docx-js interprets as pixels ≈ points
                height: source.height_pt,
              },
              floating: {
                horizontalPosition: { offset: 0 },
                verticalPosition: { offset: 0 },
                behindDocument: true,
                wrap: { type: 0 /* None */ },
              },
            }),
          ],
        }),
      );
    }

    // Process each region
    for (const region of page.regions) {
      const para = renderRegionToDocx(region, target.docx, options?.removeHeadersFooters ?? false);
      if (para) children.push(para);
    }

    // If no children, add an empty paragraph (DOCX requires at least one)
    if (children.length === 0) {
      children.push(new Paragraph({ children: [] }));
    }

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
  return new Uint8Array(buffer).buffer as ArrayBuffer;
}

/**
 * Convert a MinerU region to a positioned DOCX paragraph with framePr.
 */
function renderRegionToDocx(
  region: MineruRegion,
  docxDims: { width_dxa: number; height_dxa: number },
  removeHeadersFooters: boolean,
): Paragraph | null {
  // Skip empty regions
  const effectiveText = region.content_per_page ?? region.content;
  const hasContent =
    (effectiveText && effectiveText.trim() !== '') ||
    (region.type === 'table' && region.table_html) ||
    ((region.type === 'figure' || region.type === 'formula') && region.img_data);
  if (!hasContent) return null;
  if (removeHeadersFooters && (region.type === 'header' || region.type === 'footer')) return null;

  const [x1, y1, x2, y2] = region.bbox;
  const regionWidth = x2 - x1;
  const regionHeight = y2 - y1;
  if (regionWidth <= 0 || regionHeight <= 0) return null;

  // Convert bbox to DXA
  const x_dxa = Math.round(x1 * 20);
  const y_dxa = Math.round(y1 * 20);
  const w_dxa = Math.round(regionWidth * 20);
  const h_dxa = Math.round(regionHeight * 20);

  // Handle figures and formulas as images
  if ((region.type === 'figure' || region.type === 'formula') && region.img_data) {
    try {
      const imgBuffer = Buffer.from(region.img_data, 'base64');
      const mime = region.img_mime || 'image/png';
      const imgType = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';

      return new Paragraph({
        frame: {
          type: 'absolute' as const,
          position: { x: x_dxa, y: y_dxa },
          width: w_dxa,
          height: h_dxa,
          anchor: {
            horizontal: FrameAnchorType.PAGE,
            vertical: FrameAnchorType.PAGE,
          },
          wrap: FrameWrap.NONE,
        },
        children: [
          new ImageRun({
            type: imgType as 'png' | 'jpg',
            data: imgBuffer,
            transformation: {
              width: regionWidth,
              height: regionHeight,
            },
          }),
        ],
      });
    } catch {
      return null;
    }
  }

  // For text/title/list/table regions: fit text to bbox
  const rawText = (effectiveText || '').replace(/<[^>]*>/g, '');
  if (!rawText.trim()) return null;

  const isBold = region.type === 'title';
  const hasBreaks = rawText.includes('\n');
  const fontFamily = region.font_family
    ? `'${region.font_family}', 'Inter', sans-serif`
    : "'Inter', sans-serif";

  // Parse equation info for positioning core
  let eqInfo: Array<{ charOffset: number; aspectRatio: number; heightRatio: number }> | null = null;
  const effectiveEquations = region.inline_equations_per_page ?? region.inline_equations;
  if (effectiveEquations?.length) {
    eqInfo = [];
    for (const eq of effectiveEquations) {
      if (eq.bbox && eq.display !== 'block' && eq.line_bbox) {
        const eqW = eq.bbox[2] - eq.bbox[0];
        const eqH = eq.bbox[3] - eq.bbox[1];
        const lineH = eq.line_bbox[3] - eq.line_bbox[1];
        if (eqH > 0 && lineH > 0) {
          eqInfo.push({
            charOffset: 0,
            aspectRatio: Math.round((eqW / eqH) * 100) / 100,
            heightRatio: Math.round((eqH / lineH) * 100) / 100,
          });
        }
      }
    }
    // Find character offsets of {{EQ:N}} placeholders
    const eqRegex = /\{\{EQ:(\d+)\}\}/g;
    let match;
    while ((match = eqRegex.exec(rawText)) !== null) {
      const idx = parseInt(match[1], 10);
      if (eqInfo && idx < eqInfo.length) {
        eqInfo[idx].charOffset = match.index;
      }
    }
    if (eqInfo.length === 0) eqInfo = null;
  }

  // Compute font size via Pretext binary search
  const fit = fitTextToBox(
    rawText,
    regionWidth,
    regionHeight,
    fontFamily,
    isBold,
    eqInfo,
    hasBreaks,
  );

  // OOXML uses half-points for font size
  const fontSize_halfPt = Math.round(fit.fontSize * 2);

  // Split text into lines for multi-line content
  const lines = hasBreaks ? rawText.split('\n') : [rawText];

  const textRuns: TextRun[] = [];
  for (let li = 0; li < lines.length; li++) {
    if (li > 0) {
      textRuns.push(new TextRun({ break: 1, text: '' }));
    }
    textRuns.push(
      new TextRun({
        text: lines[li],
        size: fontSize_halfPt,
        bold: isBold,
        font: region.font_family || 'Inter',
      }),
    );
  }

  return new Paragraph({
    frame: {
      type: 'absolute' as const,
      position: { x: x_dxa, y: y_dxa },
      width: w_dxa,
      height: h_dxa,
      anchor: {
        horizontal: FrameAnchorType.PAGE,
        vertical: FrameAnchorType.PAGE,
      },
      wrap: FrameWrap.NONE,
    },
    children: textRuns,
  });
}
