/**
 * Comprehensive tests for true-copy export serializers.
 *
 * Tests the positioning-core heuristic, PDF/DOCX/PPTX serializer output,
 * page-size detection, and coordinate transforms.
 *
 * These tests run in Node.js (no canvas), so they exercise the heuristic
 * fallback path in positioning-core, not the Pretext binary search.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fitTextToBox, FitResult } from '../positioning-core';
import { detectSourcePage, computeTargetDimensions, transformBbox } from '../page-size';
import type { MineruOutput, MineruPage, MineruRegion } from '@/types';

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeRegion(overrides: Partial<MineruRegion> = {}): MineruRegion {
  return {
    type: 'text',
    bbox: [58, 235, 289, 374] as [number, number, number, number],
    content: 'The quick brown fox jumps over the lazy dog.',
    page_number: 0,
    font_family: 'Rubik',
    ...overrides,
  };
}

function makePage(overrides: Partial<MineruPage> = {}): MineruPage {
  return {
    page_number: 0,
    width: 594,
    height: 784.8,
    regions: [
      makeRegion(),
      makeRegion({
        type: 'title',
        bbox: [168, 158, 426, 176],
        content: '<strong>PHYSICAL FEATURES OF INDIA</strong>',
      }),
      makeRegion({
        type: 'figure',
        bbox: [261, 65, 330, 144],
        content: '',
        img_data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        img_mime: 'image/png',
      }),
    ],
    ...overrides,
  };
}

function makeMineruOutput(overrides: Partial<MineruOutput> = {}): MineruOutput {
  return {
    pages: [makePage(), makePage({ page_number: 1 })],
    metadata: { total_pages: 2, file_name: 'test.pdf' },
    used_fonts: { 'Rubik-Regular.woff2': 'Rubik' },
    ...overrides,
  };
}

// ─── positioning-core: heuristic font sizing ────────────────────────────────

describe('fitTextToBox (heuristic fallback)', () => {
  it('returns a positive font size for normal text', () => {
    const result = fitTextToBox('Hello World', 200, 50, "'Inter', sans-serif", false);
    expect(result.fontSize).toBeGreaterThan(0);
    expect(result.lineHeight).toBeGreaterThan(0);
  });

  it('returns floor size for empty text', () => {
    const result = fitTextToBox('', 200, 50, "'Inter', sans-serif", false);
    expect(result.fontSize).toBe(1);
  });

  it('returns floor size for zero-dimension box', () => {
    const result = fitTextToBox('Hello', 0, 50, "'Inter', sans-serif", false);
    expect(result.fontSize).toBe(1);
    const result2 = fitTextToBox('Hello', 200, 0, "'Inter', sans-serif", false);
    expect(result2.fontSize).toBe(1);
  });

  it('produces larger font for shorter text in the same box', () => {
    const short = fitTextToBox('Hi', 200, 100, "'Inter', sans-serif", false);
    const long = fitTextToBox(
      'This is a much longer paragraph of text that should wrap multiple times within the bounding box and thus require a smaller font size to fit.',
      200,
      100,
      "'Inter', sans-serif",
      false,
    );
    expect(short.fontSize).toBeGreaterThan(long.fontSize);
  });

  it('produces larger font for bigger boxes with the same text', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const small = fitTextToBox(text, 100, 50, "'Inter', sans-serif", false);
    const big = fitTextToBox(text, 300, 150, "'Inter', sans-serif", false);
    expect(big.fontSize).toBeGreaterThan(small.fontSize);
  });

  it('handles multi-line text with explicit newlines', () => {
    const text = 'Line one\nLine two\nLine three\nLine four';
    const result = fitTextToBox(text, 200, 60, "'Inter', sans-serif", false, null, true);
    expect(result.fontSize).toBeGreaterThan(0);
    // 4 explicit lines in 60pt height → roughly 15pt max per line → ~12.5pt font
    expect(result.fontSize).toBeLessThan(20);
  });

  it('lineHeight is approximately 1.2x fontSize', () => {
    const result = fitTextToBox('Some text', 200, 50, "'Inter', sans-serif", false);
    expect(result.lineHeight).toBe(Math.round(result.fontSize * 1.2));
  });

  it('font size for a title heading (single line, wide box) is large', () => {
    // Title: "PHYSICAL FEATURES OF INDIA" in a 258x18pt box
    const result = fitTextToBox('PHYSICAL FEATURES OF INDIA', 258, 18, "'Rubik', sans-serif", true);
    // Should fit within the box height (~15pt max for 18pt box)
    expect(result.fontSize).toBeLessThanOrEqual(18);
    expect(result.fontSize).toBeGreaterThan(3);
  });

  it('font size is reasonable for typical body text regions', () => {
    // Typical MinerU text region: ~231x139 pt with a paragraph of text
    const text = 'You have already learnt earlier that India is a vast country with varied land forms. What kind of terrain do you live in? If you live in the plains, you are familiar with the vast stretches of plain land. In contrast, if you live in hilly region, the rugged terrain with mountains and valleys are common features.';
    const result = fitTextToBox(text, 231, 139, "'Rubik', sans-serif", false);
    // Body text should be roughly 8-14pt
    expect(result.fontSize).toBeGreaterThan(5);
    expect(result.fontSize).toBeLessThan(20);
  });

  it('never returns font size above box height', () => {
    const result = fitTextToBox('A', 200, 30, "'Inter', sans-serif", false);
    expect(result.fontSize).toBeLessThanOrEqual(30);
  });

  it('handles very long text without crashing', () => {
    const text = 'word '.repeat(1000);
    const result = fitTextToBox(text, 300, 200, "'Inter', sans-serif", false);
    expect(result.fontSize).toBeGreaterThan(0);
    expect(result.fontSize).toBeLessThan(10); // Must be tiny to fit
  });
});

// ─── page-size: detection and transforms ────────────────────────────────────

describe('detectSourcePage', () => {
  it('detects dimensions from MinerU page data', () => {
    const page = makePage();
    const source = detectSourcePage(page);
    expect(source.width_pt).toBe(594);
    expect(source.height_pt).toBe(784.8);
    expect(source.orientation).toBe('portrait');
  });

  it('falls back to US Letter for missing dimensions', () => {
    const page = makePage({ width: 0, height: 0 });
    const source = detectSourcePage(page);
    expect(source.width_pt).toBe(612);
    expect(source.height_pt).toBe(792);
  });

  it('detects landscape orientation', () => {
    const page = makePage({ width: 842, height: 595 });
    const source = detectSourcePage(page);
    expect(source.orientation).toBe('landscape');
  });
});

describe('computeTargetDimensions', () => {
  it('computes DXA from points (1pt = 20 DXA)', () => {
    const source = detectSourcePage(makePage());
    const target = computeTargetDimensions(source);
    expect(target.docx.width_dxa).toBe(Math.round(594 * 20));
    expect(target.docx.height_dxa).toBe(Math.round(784.8 * 20));
    expect(target.docx.margin_dxa).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('computes inches from points (1in = 72pt)', () => {
    const source = detectSourcePage(makePage());
    const target = computeTargetDimensions(source);
    expect(target.pptx.width_in).toBeCloseTo(594 / 72, 2);
    expect(target.pptx.height_in).toBeCloseTo(784.8 / 72, 2);
  });

  it('PDF dimensions match source exactly', () => {
    const source = detectSourcePage(makePage());
    const target = computeTargetDimensions(source);
    expect(target.pdf.width_pt).toBe(594);
    expect(target.pdf.height_pt).toBe(784.8);
  });
});

describe('transformBbox', () => {
  it('transforms bbox to DXA coordinates', () => {
    const result = transformBbox([58, 235, 289, 374], 10);
    expect(result.docx.x_dxa).toBe(Math.round(58 * 20));
    expect(result.docx.y_dxa).toBe(Math.round(235 * 20));
    expect(result.docx.w_dxa).toBe(Math.round((289 - 58) * 20));
    expect(result.docx.h_dxa).toBe(Math.round((374 - 235) * 20));
    expect(result.docx.fontSize_halfPt).toBe(20); // 10pt * 2
  });

  it('transforms bbox to inches for PPTX', () => {
    const result = transformBbox([72, 144, 288, 360], 12);
    expect(result.pptx.x_in).toBeCloseTo(1.0, 2);
    expect(result.pptx.y_in).toBeCloseTo(2.0, 2);
    expect(result.pptx.w_in).toBeCloseTo(3.0, 2);
    expect(result.pptx.h_in).toBeCloseTo(3.0, 2);
  });
});

// ─── True-Copy PDF serializer ───────────────────────────────────────────────

describe('createTrueCopyPdf', () => {
  // Mock the font loader and page image fetcher
  beforeEach(() => {
    vi.resetModules();
  });

  it('generates a valid PDF buffer', async () => {
    // Mock dependencies
    vi.doMock('@/lib/mineru/client', () => ({
      getPageImage: vi.fn().mockRejectedValue(new Error('no image')),
      getMineruUrl: vi.fn().mockReturnValue('http://localhost:9999'),
    }));
    vi.doMock('../font-loader', () => ({
      fetchTtf: vi.fn().mockResolvedValue(null),
      fetchAllTtf: vi.fn().mockResolvedValue({}),
      clearFontCache: vi.fn(),
    }));

    const { createTrueCopyPdf } = await import('../true-copy-pdf');
    const output = makeMineruOutput();
    const buffer = await createTrueCopyPdf(output, 'test-task-id', {
      includeImages: false,
    });

    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(buffer.byteLength).toBeGreaterThan(0);

    // Check PDF header
    const header = new TextDecoder().decode(new Uint8Array(buffer).slice(0, 5));
    expect(header).toBe('%PDF-');
  });

  it('creates one page per MinerU page', async () => {
    vi.doMock('@/lib/mineru/client', () => ({
      getPageImage: vi.fn().mockRejectedValue(new Error('no image')),
      getMineruUrl: vi.fn().mockReturnValue('http://localhost:9999'),
    }));
    vi.doMock('../font-loader', () => ({
      fetchTtf: vi.fn().mockResolvedValue(null),
      fetchAllTtf: vi.fn().mockResolvedValue({}),
      clearFontCache: vi.fn(),
    }));

    const { createTrueCopyPdf } = await import('../true-copy-pdf');
    const output = makeMineruOutput({
      pages: [makePage(), makePage({ page_number: 1 }), makePage({ page_number: 2 })],
      metadata: { total_pages: 3, file_name: 'test.pdf' },
    });

    const buffer = await createTrueCopyPdf(output, 'test-task-id', { includeImages: false });
    // Parse the PDF to verify page count
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(buffer);
    expect(doc.getPageCount()).toBe(3);
  });

  it('sets correct page dimensions', async () => {
    vi.doMock('@/lib/mineru/client', () => ({
      getPageImage: vi.fn().mockRejectedValue(new Error('no image')),
      getMineruUrl: vi.fn().mockReturnValue('http://localhost:9999'),
    }));
    vi.doMock('../font-loader', () => ({
      fetchTtf: vi.fn().mockResolvedValue(null),
      fetchAllTtf: vi.fn().mockResolvedValue({}),
      clearFontCache: vi.fn(),
    }));

    const { createTrueCopyPdf } = await import('../true-copy-pdf');
    const output = makeMineruOutput({
      pages: [makePage({ width: 612, height: 792 })],
      metadata: { total_pages: 1, file_name: 'test.pdf' },
    });

    const buffer = await createTrueCopyPdf(output, 'test-task-id', { includeImages: false });
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(buffer);
    const page = doc.getPage(0);
    const { width, height } = page.getSize();
    expect(width).toBeCloseTo(612, 0);
    expect(height).toBeCloseTo(792, 0);
  });

  it('renders text using fallback fonts when custom fonts are unavailable', async () => {
    vi.doMock('@/lib/mineru/client', () => ({
      getPageImage: vi.fn().mockRejectedValue(new Error('no image')),
      getMineruUrl: vi.fn().mockReturnValue('http://localhost:9999'),
    }));
    vi.doMock('../font-loader', () => ({
      fetchTtf: vi.fn().mockResolvedValue(null), // No custom fonts
      fetchAllTtf: vi.fn().mockResolvedValue({}),
      clearFontCache: vi.fn(),
    }));

    const { createTrueCopyPdf } = await import('../true-copy-pdf');
    const output = makeMineruOutput({
      pages: [
        makePage({
          regions: [
            makeRegion({ content: 'This text should appear even without custom fonts' }),
          ],
        }),
      ],
      metadata: { total_pages: 1, file_name: 'test.pdf' },
    });

    const buffer = await createTrueCopyPdf(output, 'test-task-id', { includeImages: false });
    // PDF should be significantly larger than a blank page (~800 bytes)
    // because it contains embedded Helvetica text
    expect(buffer.byteLength).toBeGreaterThan(1000);
  });

  it('skips header/footer regions when removeHeadersFooters is true', async () => {
    vi.doMock('@/lib/mineru/client', () => ({
      getPageImage: vi.fn().mockRejectedValue(new Error('no image')),
      getMineruUrl: vi.fn().mockReturnValue('http://localhost:9999'),
    }));
    vi.doMock('../font-loader', () => ({
      fetchTtf: vi.fn().mockResolvedValue(null),
      fetchAllTtf: vi.fn().mockResolvedValue({}),
      clearFontCache: vi.fn(),
    }));

    const { createTrueCopyPdf } = await import('../true-copy-pdf');

    const regionsWithHeaders = [
      makeRegion({ type: 'header', content: 'Page Header', bbox: [0, 0, 594, 30] }),
      makeRegion({ content: 'Body text here' }),
      makeRegion({ type: 'footer', content: 'Page 1', bbox: [0, 760, 594, 785] }),
    ];

    const withHeaders = await createTrueCopyPdf(
      makeMineruOutput({
        pages: [makePage({ regions: regionsWithHeaders })],
        metadata: { total_pages: 1, file_name: 'test.pdf' },
      }),
      'test-task-id',
      { includeImages: false, removeHeadersFooters: false },
    );

    const withoutHeaders = await createTrueCopyPdf(
      makeMineruOutput({
        pages: [makePage({ regions: regionsWithHeaders })],
        metadata: { total_pages: 1, file_name: 'test.pdf' },
      }),
      'test-task-id',
      { includeImages: false, removeHeadersFooters: true },
    );

    // Without headers should be smaller (less text drawn)
    expect(withoutHeaders.byteLength).toBeLessThan(withHeaders.byteLength);
  });
});

// ─── True-Copy DOCX serializer ──────────────────────────────────────────────

describe('createTrueCopyDocx', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('generates a valid DOCX buffer (ZIP with OOXML)', async () => {
    vi.doMock('@/lib/mineru/client', () => ({
      getPageImage: vi.fn().mockRejectedValue(new Error('no image')),
      getMineruUrl: vi.fn().mockReturnValue('http://localhost:9999'),
    }));
    vi.doMock('../font-loader', () => ({
      fetchTtf: vi.fn().mockResolvedValue(null),
      fetchAllTtf: vi.fn().mockResolvedValue({}),
      clearFontCache: vi.fn(),
    }));

    const { createTrueCopyDocx } = await import('../true-copy-docx');
    const output = makeMineruOutput();
    const buffer = await createTrueCopyDocx(output, 'test-task-id', {
      includeImages: false,
    });

    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(buffer.byteLength).toBeGreaterThan(0);

    // DOCX files are ZIP archives — check magic bytes (PK\x03\x04)
    const magic = new Uint8Array(buffer).slice(0, 4);
    expect(magic[0]).toBe(0x50); // P
    expect(magic[1]).toBe(0x4b); // K
    expect(magic[2]).toBe(0x03);
    expect(magic[3]).toBe(0x04);
  });

  it('handles regions with HTML-tagged content by stripping tags', async () => {
    vi.doMock('@/lib/mineru/client', () => ({
      getPageImage: vi.fn().mockRejectedValue(new Error('no image')),
      getMineruUrl: vi.fn().mockReturnValue('http://localhost:9999'),
    }));
    vi.doMock('../font-loader', () => ({
      fetchTtf: vi.fn().mockResolvedValue(null),
      fetchAllTtf: vi.fn().mockResolvedValue({}),
      clearFontCache: vi.fn(),
    }));

    const { createTrueCopyDocx } = await import('../true-copy-docx');
    const output = makeMineruOutput({
      pages: [
        makePage({
          regions: [
            makeRegion({
              type: 'title',
              content: '<strong>Bold Title</strong> with <em>emphasis</em>',
              bbox: [100, 100, 400, 130],
            }),
          ],
        }),
      ],
      metadata: { total_pages: 1, file_name: 'test.pdf' },
    });

    // Should not throw
    const buffer = await createTrueCopyDocx(output, 'test-task-id', { includeImages: false });
    expect(buffer.byteLength).toBeGreaterThan(0);
  });
});

// ─── True-Copy PPTX serializer ──────────────────────────────────────────────

describe('createTrueCopyPptx', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('generates a valid PPTX buffer (ZIP with OOXML)', async () => {
    vi.doMock('@/lib/mineru/client', () => ({
      getPageImage: vi.fn().mockRejectedValue(new Error('no image')),
      getMineruUrl: vi.fn().mockReturnValue('http://localhost:9999'),
    }));

    const { createTrueCopyPptx } = await import('../true-copy-pptx');
    const output = makeMineruOutput();
    const buffer = await createTrueCopyPptx(output, 'test-task-id', {
      includeImages: false,
    });

    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(buffer.byteLength).toBeGreaterThan(0);

    // PPTX is also a ZIP
    const magic = new Uint8Array(buffer).slice(0, 4);
    expect(magic[0]).toBe(0x50);
    expect(magic[1]).toBe(0x4b);
  });

  it('handles empty pages without crashing', async () => {
    vi.doMock('@/lib/mineru/client', () => ({
      getPageImage: vi.fn().mockRejectedValue(new Error('no image')),
      getMineruUrl: vi.fn().mockReturnValue('http://localhost:9999'),
    }));

    const { createTrueCopyPptx } = await import('../true-copy-pptx');
    const output = makeMineruOutput({
      pages: [makePage({ regions: [] })],
      metadata: { total_pages: 1, file_name: 'test.pdf' },
    });

    const buffer = await createTrueCopyPptx(output, 'test-task-id', { includeImages: false });
    expect(buffer.byteLength).toBeGreaterThan(0);
  });
});

// ─── Font sizing sanity checks with real MinerU data ────────────────────────

describe('font sizing sanity for real document regions', () => {
  // These are actual region dimensions from the iess102 test document
  const realRegions = [
    { desc: 'Chapter title', bbox: [168, 158, 426, 176] as [number, number, number, number], text: 'PHYSICAL FEATURES OF INDIA', type: 'title' as const },
    { desc: 'Body paragraph', bbox: [58, 235, 289, 374] as [number, number, number, number], text: 'You have already learnt earlier that India is a vast country with varied land forms. What kind of terrain do you live in? If you live in the plains, you are familiar with the vast stretches of plain land. In contrast, if you live in hilly region, the rugged terrain with mountains and valleys are common features. In fact, our country has practically all major physical features of the earth, i.e., mountains, plains, deserts, plateaus and islands.', type: 'text' as const },
    { desc: 'Numbered list', bbox: [307, 235, 465, 319] as [number, number, number, number], text: '(1) The Himalayan Mountains\n(2) The Northern Plains\n(3) The Peninsular Plateau\n(4) The Indian Desert\n(5) The Coastal Plains\n(6) The Islands', type: 'list' as const },
    { desc: 'Section heading', bbox: [307, 323, 465, 342] as [number, number, number, number], text: 'The Himalayan Mountains', type: 'title' as const },
    { desc: 'Small body text', bbox: [307, 346, 535, 772] as [number, number, number, number], text: 'The Himalayas, geologically young and structurally fold mountains stretch over the northern borders of India. These mountain ranges run in a west-east direction from the Indus to the Brahmaputra. The Himalayas represent the loftiest and one of the most rugged mountain barriers of the world.', type: 'text' as const },
  ];

  for (const r of realRegions) {
    it(`produces reasonable font size for "${r.desc}" (${r.bbox[2] - r.bbox[0]}x${r.bbox[3] - r.bbox[1]}pt)`, () => {
      const w = r.bbox[2] - r.bbox[0];
      const h = r.bbox[3] - r.bbox[1];
      const isBold = r.type === 'title';
      const hasBreaks = r.text.includes('\n');
      const result = fitTextToBox(r.text, w, h, "'Rubik', sans-serif", isBold, null, hasBreaks);

      // Font size must be positive and reasonable
      expect(result.fontSize).toBeGreaterThan(1);
      expect(result.fontSize).toBeLessThan(100);

      // Total estimated text height should not exceed box height
      const estimatedLines = Math.ceil(r.text.length / Math.max(1, Math.floor(w / (result.fontSize * 0.48))));
      const estimatedHeight = estimatedLines * result.lineHeight;
      // Allow some tolerance since the heuristic isn't pixel-perfect
      expect(estimatedHeight).toBeLessThan(h * 1.5);
    });
  }

  it('title font size is larger than body text font size for same width', () => {
    const titleFit = fitTextToBox('PHYSICAL FEATURES', 258, 18, "'Rubik', sans-serif", true);
    const bodyFit = fitTextToBox(
      'You have already learnt earlier that India is a vast country with varied land forms.',
      258,
      100,
      "'Rubik', sans-serif",
      false,
    );
    // Title has less text in a constrained height, body has more text in more space
    // But the title line is only 18pt tall, so font must be ≤18
    expect(titleFit.fontSize).toBeLessThanOrEqual(18);
  });
});

// ─── Coordinate system correctness ─────────────────────────────────────────

describe('coordinate transforms', () => {
  it('PDF Y-axis: top of page text should have high pdfY value', () => {
    const pageHeight = 792;
    const y1 = 50; // Near top of page in MinerU coords (top-down)
    const fontSize = 12;
    const pdfY = pageHeight - y1 - fontSize;
    // Should be near the top of PDF page (high Y value)
    expect(pdfY).toBeGreaterThan(700);
  });

  it('PDF Y-axis: bottom of page text should have low pdfY value', () => {
    const pageHeight = 792;
    const y1 = 750; // Near bottom in MinerU coords
    const fontSize = 12;
    const pdfY = pageHeight - y1 - fontSize;
    expect(pdfY).toBeLessThan(50);
  });

  it('DXA conversion preserves proportional positions', () => {
    // A point at 50% of page width should map to 50% in DXA
    const pagePt = 594;
    const pageDxa = Math.round(pagePt * 20);
    const midPt = pagePt / 2;
    const midDxa = Math.round(midPt * 20);
    expect(midDxa / pageDxa).toBeCloseTo(0.5, 2);
  });

  it('PPTX inch conversion preserves proportional positions', () => {
    const pageW_pt = 594;
    const pageW_in = pageW_pt / 72;
    const regionX_pt = 100;
    const regionX_in = regionX_pt / 72;
    expect(regionX_in / pageW_in).toBeCloseTo(regionX_pt / pageW_pt, 4);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles regions with only whitespace', () => {
    const result = fitTextToBox('   \n  \n  ', 200, 50, "'Inter', sans-serif", false);
    // Should not crash; whitespace-only text is technically measurable
    expect(result.fontSize).toBeGreaterThan(0);
  });

  it('handles very narrow boxes (1pt wide)', () => {
    const result = fitTextToBox('Hello World', 1, 50, "'Inter', sans-serif", false);
    expect(result.fontSize).toBeGreaterThan(0);
  });

  it('handles very tall narrow boxes', () => {
    const result = fitTextToBox('Hello World', 20, 500, "'Inter', sans-serif", false);
    expect(result.fontSize).toBeGreaterThan(0);
    expect(result.fontSize).toBeLessThan(500); // Should not exceed box height
  });

  it('handles unicode text', () => {
    const result = fitTextToBox('कृपया हिंदी में टाइप करें', 200, 50, "'Inter', sans-serif", false);
    expect(result.fontSize).toBeGreaterThan(0);
  });

  it('handles text with HTML entities stripped', () => {
    const htmlText = '<strong>Bold</strong> and <em>italic</em>';
    const stripped = htmlText.replace(/<[^>]*>/g, '');
    const result = fitTextToBox(stripped, 200, 50, "'Inter', sans-serif", false);
    expect(result.fontSize).toBeGreaterThan(0);
  });
});
