/**
 * OCR Pipeline: PDF → MinerU → structured JSON → exports
 * Handles MinerU interaction, progress tracking, and output generation.
 */
import { Job, PipelineProgress, ProcessingOptions } from '@/types';
import { Pipeline, PipelineResult } from './types';
import { submitFile, pollForCompletion, deleteTask } from '@/lib/mineru/client';
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

    const taskId = await submitFile(job.file_path, {
      formulaDisplay: config.formula_display,
      tableDisplay: config.table_display,
      includeFigures: config.include_figures,
      figureDisplay: config.figure_display,
      processingMode: config.processing_mode,
      tableMode: config.table_mode,
    });

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

    // Step 3: Export to selected formats
    onProgress({
      job_id: job.id,
      current_page: actualPages,
      total_pages: actualPages,
      status: 'processing',
      message: 'Generating output files...',
    });

    const baseName = `${path.parse(job.file_name).name}_${job.id.slice(0, 8)}`;

    const outputFiles = await exportAll({
      mineruOutput,
      taskId,
      formats: config.output_formats,
      outputFolder: config.output_folder,
      baseName,
      originalPdfPath: job.file_path,
      removeHeadersFooters: config.remove_headers_footers,
      formulaDisplay: config.formula_display,
      tableDisplay: config.table_display,
      includeFigures: config.include_figures,
      figureDisplay: config.figure_display,
      includeBenchmarkImages: config.include_benchmark_images,
    });

    // Cleanup: signal server to free heavy resources (PDF bytes, pipe_result, img_dir)
    await deleteTask(taskId);

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
