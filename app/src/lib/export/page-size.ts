/**
 * Page-size intelligence layer: detects source PDF dimensions and computes
 * coordinate transforms to every target format's native unit system.
 *
 * Runs once per document. All true-copy exports consume the pre-computed
 * dimensions. NEVER snaps to standard sizes — uses exact source dimensions.
 *
 * Unit reference:
 *   1 PDF point  = 1/72 inch
 *   1 DXA        = 1/20 point = 1/1440 inch
 *   1 EMU        = 1/914400 inch (used inside OOXML for images/shapes)
 */
import { MineruPage } from '@/types';

export interface SourcePage {
  width_pt: number;
  height_pt: number;
  orientation: 'portrait' | 'landscape';
}

export interface DocxDimensions {
  width_dxa: number;
  height_dxa: number;
  margin_dxa: { top: number; right: number; bottom: number; left: number };
}

export interface PptxDimensions {
  width_in: number;
  height_in: number;
}

export interface PdfDimensions {
  width_pt: number;
  height_pt: number;
}

export interface HtmlDimensions {
  width_px: number;
  height_px: number;
}

export interface TargetPageDimensions {
  html: HtmlDimensions;
  docx: DocxDimensions;
  pptx: PptxDimensions;
  pdf: PdfDimensions;
}

/**
 * Detect source page dimensions from MinerU page data.
 * Falls back to US Letter (612×792pt) if dimensions are missing.
 */
export function detectSourcePage(mineruPage: MineruPage): SourcePage {
  const width_pt = mineruPage.width || 612;
  const height_pt = mineruPage.height || 792;
  return {
    width_pt,
    height_pt,
    orientation: width_pt > height_pt ? 'landscape' : 'portrait',
  };
}

/**
 * Compute exact target dimensions for every export format.
 * No snapping to standard sizes. Custom dimensions everywhere.
 */
export function computeTargetDimensions(source: SourcePage): TargetPageDimensions {
  return {
    html: {
      width_px: source.width_pt,
      height_px: source.height_pt,
    },
    docx: {
      width_dxa: Math.round(source.width_pt * 20),
      height_dxa: Math.round(source.height_pt * 20),
      margin_dxa: { top: 0, right: 0, bottom: 0, left: 0 },
    },
    pptx: {
      width_in: source.width_pt / 72,
      height_in: source.height_pt / 72,
    },
    pdf: {
      width_pt: source.width_pt,
      height_pt: source.height_pt,
    },
  };
}

/**
 * Compute reflowed page dimensions (with standard 1-inch margins).
 * Used by reflowed DOCX and reflowed PDF.
 */
export function computeReflowedDimensions(source: SourcePage): {
  docx: DocxDimensions;
  pdf: PdfDimensions;
} {
  const marginPt = 72; // 1 inch
  return {
    docx: {
      width_dxa: Math.round(source.width_pt * 20),
      height_dxa: Math.round(source.height_pt * 20),
      margin_dxa: {
        top: Math.round(marginPt * 20),
        right: Math.round(marginPt * 20),
        bottom: Math.round(marginPt * 20),
        left: Math.round(marginPt * 20),
      },
    },
    pdf: {
      width_pt: source.width_pt,
      height_pt: source.height_pt,
    },
  };
}

/**
 * Transform a bbox from PDF points to a target format's coordinate system.
 */
export function transformBbox(
  bbox: [number, number, number, number],
  fontSize_pt: number,
): {
  docx: { x_dxa: number; y_dxa: number; w_dxa: number; h_dxa: number; fontSize_halfPt: number };
  pptx: { x_in: number; y_in: number; w_in: number; h_in: number; fontSize_pt: number };
  pdf: { x_pt: number; y_pt: number; w_pt: number; h_pt: number; fontSize_pt: number };
} {
  const [x1, y1, x2, y2] = bbox;
  const w = x2 - x1;
  const h = y2 - y1;
  return {
    docx: {
      x_dxa: Math.round(x1 * 20),
      y_dxa: Math.round(y1 * 20),
      w_dxa: Math.round(w * 20),
      h_dxa: Math.round(h * 20),
      fontSize_halfPt: Math.round(fontSize_pt * 2),
    },
    pptx: {
      x_in: x1 / 72,
      y_in: y1 / 72,
      w_in: w / 72,
      h_in: h / 72,
      fontSize_pt,
    },
    pdf: {
      x_pt: x1,
      y_pt: y1,
      w_pt: w,
      h_pt: h,
      fontSize_pt,
    },
  };
}
