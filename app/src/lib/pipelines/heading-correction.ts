/**
 * Heading Correction Pipeline: Two-pass LLM process to fix heading hierarchy.
 *
 * Pass 1: Detect table of contents and extract reference hierarchy.
 * Pass 2: Assign proper heading levels (h1-h6) to ALL title regions in a single LLM call.
 *
 * Reads and updates the MinerU JSON, then re-exports output formats.
 */
import { Job, PipelineProgress, MineruOutput, MineruRegion, ProcessingOptions } from '@/types';
import { Pipeline, PipelineResult, classifyError } from './types';
import { callLLM } from '@/lib/llm/client';
import { exportAll } from '@/lib/export';
import fs from 'fs';
import path from 'path';

interface TocEntry {
  title: string;
  level: number;
  children?: TocEntry[];
}

interface TocDetectionResult {
  has_toc: boolean;
  hierarchy: TocEntry[];
}

interface HeadingCorrection {
  original_text: string;
  level: number;
  corrected_text?: string;
}

interface HeadingCorrectionResult {
  headings: HeadingCorrection[];
}

interface HeadingInput {
  text: string;
  page: number;
}

// ---------------------------------------------------------------------------
// Pass 1: TOC Detection
// ---------------------------------------------------------------------------

function extractFirstWords(output: MineruOutput, wordLimit: number): string {
  const parts: string[] = [];
  let wordCount = 0;

  for (const page of output.pages) {
    if (wordCount >= wordLimit) break;

    for (const region of page.regions) {
      if (wordCount >= wordLimit) break;
      if (!region.content?.trim()) continue;

      const text = region.content.trim();
      const words = text.split(/\s+/);

      if (wordCount + words.length > wordLimit) {
        const remaining = wordLimit - wordCount;
        parts.push(words.slice(0, remaining).join(' '));
        wordCount = wordLimit;
      } else {
        parts.push(text);
        wordCount += words.length;
      }
    }
  }

  return parts.join('\n');
}

async function detectTableOfContents(
  mineruOutput: MineruOutput,
): Promise<TocDetectionResult> {
  const firstChunk = extractFirstWords(mineruOutput, 6000);

  if (!firstChunk.trim()) {
    return { has_toc: false, hierarchy: [] };
  }

  const response = await callLLM({
    messages: [
      {
        role: 'system',
        content: `You are a document structure analyst. Analyze the beginning of a document and determine whether it contains a Table of Contents (TOC). If a TOC is present, extract the heading hierarchy from it.

Respond with JSON in this exact format:
{
  "has_toc": true/false,
  "hierarchy": [
    { "title": "Chapter 1 Title", "level": 1, "children": [
      { "title": "Section 1.1", "level": 2, "children": [] }
    ]}
  ]
}

Rules:
- Only set has_toc to true if you find an actual table of contents section
- The hierarchy should reflect the nesting structure from the TOC
- Use levels 1-6 matching the depth of nesting
- If no TOC is found, return has_toc: false and an empty hierarchy array`,
      },
      {
        role: 'user',
        content: `Analyze the beginning of this document for a table of contents:\n\n${firstChunk}`,
      },
    ],
    temperature: 0.1,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  });

  try {
    const parsed = JSON.parse(response.content) as TocDetectionResult;
    return {
      has_toc: Boolean(parsed.has_toc),
      hierarchy: Array.isArray(parsed.hierarchy) ? parsed.hierarchy : [],
    };
  } catch {
    console.warn('[HeadingCorrection] Failed to parse TOC detection response, assuming no TOC');
    return { has_toc: false, hierarchy: [] };
  }
}

// ---------------------------------------------------------------------------
// Pass 2: Heading Level Assignment
// ---------------------------------------------------------------------------

function collectHeadings(mineruOutput: MineruOutput): HeadingInput[] {
  const headings: HeadingInput[] = [];

  for (const page of mineruOutput.pages) {
    for (const region of page.regions) {
      if (region.type === 'title' && region.content?.trim()) {
        headings.push({
          text: region.content.trim(),
          page: page.page_number,
        });
      }
    }
  }

  return headings;
}

function flattenTocHierarchy(entries: TocEntry[], result: { title: string; level: number }[] = []): { title: string; level: number }[] {
  for (const entry of entries) {
    result.push({ title: entry.title, level: entry.level });
    if (entry.children?.length) {
      flattenTocHierarchy(entry.children, result);
    }
  }
  return result;
}

async function assignHeadingLevels(
  headings: HeadingInput[],
  tocResult: TocDetectionResult,
): Promise<HeadingCorrection[]> {
  if (headings.length === 0) return [];

  const tocContext = tocResult.has_toc
    ? `\nThe document has a table of contents. Here is the heading hierarchy extracted from it:\n${JSON.stringify(flattenTocHierarchy(tocResult.hierarchy), null, 2)}\n\nUse this hierarchy as a reference when assigning heading levels. Match headings to TOC entries where possible.`
    : '\nNo table of contents was found in this document. Infer the heading hierarchy from context, position, and formatting patterns.';

  const headingList = headings
    .map((h, i) => `${i + 1}. [Page ${h.page}] "${h.text}"`)
    .join('\n');

  const response = await callLLM({
    messages: [
      {
        role: 'system',
        content: `You are a document structure expert. Assign proper heading levels (h1 through h6) to each heading in the document.

Respond with JSON in this exact format:
{
  "headings": [
    { "original_text": "...", "level": 1 },
    { "original_text": "...", "level": 2, "corrected_text": "..." }
  ]
}

Rules:
- Return one entry per heading, in the same order as the input
- "level" must be an integer from 1 to 6
- "original_text" must match the input text exactly
- Only include "corrected_text" if you need to fix an obvious OCR error in the heading text (e.g., broken characters, missing spaces). Otherwise omit it.
- Use the document's logical structure: main title is h1, major sections are h2, subsections h3, etc.
- There should typically be only one h1 (the document title), but some documents may have multiple top-level sections
- Maintain consistent hierarchy: do not skip levels (e.g., h1 -> h3 without h2)${tocContext}`,
      },
      {
        role: 'user',
        content: `Assign heading levels to these ${headings.length} headings:\n\n${headingList}`,
      },
    ],
    temperature: 0.1,
    max_tokens: 16384,
    response_format: { type: 'json_object' },
  });

  try {
    const parsed = JSON.parse(response.content) as HeadingCorrectionResult;
    if (!Array.isArray(parsed.headings)) {
      throw new Error('Response missing headings array');
    }
    return parsed.headings;
  } catch {
    console.error('[HeadingCorrection] Failed to parse heading correction response');
    throw new Error('Failed to parse heading level assignments from LLM response');
  }
}

// ---------------------------------------------------------------------------
// Apply corrections to MinerU output
// ---------------------------------------------------------------------------

function applyCorrections(
  mineruOutput: MineruOutput,
  corrections: HeadingCorrection[],
): void {
  // Build a lookup map from original_text to correction
  const correctionMap = new Map<string, HeadingCorrection>();
  for (const correction of corrections) {
    correctionMap.set(correction.original_text.trim(), correction);
  }

  for (const page of mineruOutput.pages) {
    for (const region of page.regions) {
      if (region.type !== 'title' || !region.content?.trim()) continue;

      const key = region.content.trim();
      const correction = correctionMap.get(key);

      if (correction) {
        region.level = correction.level;
        if (correction.corrected_text) {
          region.content = correction.corrected_text;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class HeadingCorrectionPipeline implements Pipeline {
  name = 'Heading Correction';

  async execute(
    job: Job,
    onProgress: (progress: PipelineProgress) => void,
  ): Promise<PipelineResult> {
    const config = job.tool_config as unknown as ProcessingOptions;
    const baseName = path.parse(job.file_name).name;
    // Look for OCR data in new subfolder structure first, fall back to legacy flat path
    const newJsonPath = path.join(config.output_folder, baseName, 'Data', `${baseName}_ocr_data.json`);
    const legacyJsonPath = path.join(config.output_folder, `${baseName}_ocr_data.json`);
    const jsonPath = fs.existsSync(newJsonPath) ? newJsonPath : legacyJsonPath;

    try {
      // Step 1: Read MinerU JSON
      onProgress({
        job_id: job.id,
        current_page: 0,
        total_pages: job.total_pages,
        status: 'processing',
        message: 'Reading document structure...',
      });

      if (!fs.existsSync(jsonPath)) {
        throw new Error(`OCR data not found at ${jsonPath}. Run OCR pipeline first.`);
      }

      const mineruOutput: MineruOutput = JSON.parse(
        fs.readFileSync(jsonPath, 'utf-8'),
      );

      // Step 2: Pass 1 - TOC detection
      onProgress({
        job_id: job.id,
        current_page: 0,
        total_pages: job.total_pages,
        status: 'processing',
        message: 'Analyzing document for table of contents...',
      });

      const tocResult = await detectTableOfContents(mineruOutput);

      console.log(
        `[HeadingCorrection] TOC detected: ${tocResult.has_toc}, entries: ${tocResult.hierarchy.length}`,
      );

      // Step 3: Pass 2 - Heading level assignment (ALL headings, single call)
      const headings = collectHeadings(mineruOutput);

      if (headings.length === 0) {
        onProgress({
          job_id: job.id,
          current_page: job.total_pages,
          total_pages: job.total_pages,
          status: 'processing',
          message: 'No headings found in document.',
        });

        return {
          success: true,
          completedPages: job.total_pages,
          totalPages: job.total_pages,
          creditsCharged: 0,
          outputFiles: [],
        };
      }

      onProgress({
        job_id: job.id,
        current_page: 0,
        total_pages: job.total_pages,
        status: 'processing',
        message: `Correcting heading levels for ${headings.length} headings...`,
      });

      const corrections = await assignHeadingLevels(headings, tocResult);

      // Step 4: Apply corrections to MinerU JSON
      applyCorrections(mineruOutput, corrections);

      // Save updated MinerU JSON
      fs.writeFileSync(jsonPath, JSON.stringify(mineruOutput, null, 2));

      // Step 5: Re-export formats with corrected headings
      onProgress({
        job_id: job.id,
        current_page: job.total_pages,
        total_pages: job.total_pages,
        status: 'processing',
        message: 'Re-exporting with corrected headings...',
      });

      const outputFiles = await exportAll({
        mineruOutput,
        formats: config.output_formats,
        outputFolder: config.output_folder,
        baseName,
        originalPdfPath: job.file_path,
        removeHeadersFooters: config.remove_headers_footers ?? false,
        formulaDisplay: config.formula_display === 'image' ? 'image' : 'rendered',
        tableDisplay: config.table_display === 'image' ? 'image' : 'rendered',
        includeFigures: config.include_figures ?? true,
        figureDisplay: config.figure_display ?? 'image',
        includeBenchmarkImages: config.include_benchmark_images ?? false,
        htmlOptions: {
          removeHeadersFooters: config.remove_headers_footers ?? false,
          removeMetadata: config.remove_metadata ?? false,
          joinBrokenPages: config.join_broken_pages ?? false,
          pageRange: config.page_range,
          formulaDisplay: config.formula_display === 'image' ? 'image' : 'rendered',
          tableDisplay: config.table_display === 'image' ? 'image' : 'rendered',
          includeFigures: config.include_figures ?? true,
          figureDisplay: config.figure_display ?? 'image',
        },
      });

      return {
        success: true,
        completedPages: job.total_pages,
        totalPages: job.total_pages,
        creditsCharged: 0, // Heading correction is part of OCR, no extra credits
        outputFiles,
      };
    } catch (error) {
      const pipelineError = classifyError(error as Error);
      return {
        success: false,
        completedPages: 0,
        totalPages: job.total_pages,
        creditsCharged: 0,
        error: pipelineError,
      };
    }
  }
}

export const headingCorrectionPipeline = new HeadingCorrectionPipeline();
