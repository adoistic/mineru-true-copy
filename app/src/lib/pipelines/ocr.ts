/**
 * OCR Pipeline: PDF → MinerU → structured JSON → HTML
 * Handles MinerU interaction, progress tracking, and output generation.
 */
import { Job, PipelineProgress, MineruOutput, ProcessingOptions } from '@/types';
import { Pipeline, PipelineResult } from './types';
import { submitFile, pollForCompletion } from '@/lib/mineru/client';
import { mineruToHtml, mineruToHtmlBody } from '@/lib/mineru/html-converter';
import { exportAll } from '@/lib/export';
import fs from 'fs';
import path from 'path';

export class OcrPipeline implements Pipeline {
  name = 'OCR';

  async execute(
    job: Job,
    onProgress: (progress: PipelineProgress) => void
  ): Promise<PipelineResult> {
    const config = job.tool_config as unknown as ProcessingOptions;

    // Step 1: Submit file to MinerU
    onProgress({
      job_id: job.id,
      current_page: 0,
      total_pages: job.total_pages,
      status: 'processing',
      message: 'Submitting to OCR engine...',
    });

    const taskId = await submitFile(job.file_path);

    // Step 2: Poll for completion
    onProgress({
      job_id: job.id,
      current_page: 0,
      total_pages: job.total_pages,
      status: 'processing',
      message: 'Processing pages...',
    });

    const mineruOutput = await pollForCompletion(taskId, (pagesCompleted) => {
      onProgress({
        job_id: job.id,
        current_page: pagesCompleted,
        total_pages: job.total_pages,
        status: 'processing',
        message: `Processing page ${pagesCompleted} of ${job.total_pages}`,
      });
    });

    // Update total pages from actual MinerU output
    const actualPages = mineruOutput.pages.length;
    mineruOutput.metadata.file_name = job.file_name;

    // Step 3: Convert to HTML
    onProgress({
      job_id: job.id,
      current_page: actualPages,
      total_pages: actualPages,
      status: 'processing',
      message: 'Generating output files...',
    });

    const htmlOptions = {
      removeHeadersFooters: config.remove_headers_footers ?? false,
      removeMetadata: config.remove_metadata ?? false,
      joinBrokenPages: config.join_broken_pages ?? false,
      pageRange: config.page_range,
      formulaDisplay: config.formula_display ?? 'rendered' as const,
      tableDisplay: config.table_display ?? 'rendered' as const,
    };

    // Step 4: Export to selected formats
    const baseName = `${path.parse(job.file_name).name}_${job.id.slice(0, 8)}`;

    const outputFiles = await exportAll({
      mineruOutput,
      htmlOptions,
      formats: config.output_formats,
      outputFolder: config.output_folder,
      baseName,
      originalPdfPath: job.file_path,
    });

    // Save raw MinerU JSON for reference
    const jsonPath = path.join(config.output_folder, `${baseName}_mineru.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(mineruOutput, null, 2));

    return {
      success: true,
      completedPages: actualPages,
      totalPages: actualPages,
      creditsCharged: actualPages, // 1 credit per page
      outputFiles,
    };
  }
}

export const ocrPipeline = new OcrPipeline();
