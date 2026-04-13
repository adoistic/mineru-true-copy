/**
 * Translation Pipeline: OCR JSON → Translation Server → translated JSON
 * Handles translation submission, progress tracking, and credit deduction.
 */
import { Job, PipelineProgress } from '@/types';
import { Pipeline, PipelineResult } from './types';
import { submitTranslation } from '@/lib/mineru/client';
import fs from 'fs';
import path from 'path';

export class TranslationPipeline implements Pipeline {
  name = 'Translation';

  async execute(
    job: Job,
    onProgress: (progress: PipelineProgress) => void
  ): Promise<PipelineResult> {
    const config = job.tool_config as {
      src_lang: string;
      tgt_langs: string[];
      model_variant: string;
      output_folder: string;
      json_data?: Record<string, unknown>;
    };

    // Step 1: Read the JSON input
    onProgress({
      job_id: job.id,
      current_page: 0,
      total_pages: config.tgt_langs.length,
      status: 'processing',
      message: 'Loading OCR data...',
    });

    let jsonData = config.json_data;
    if (!jsonData) {
      const raw = fs.readFileSync(job.file_path, 'utf-8');
      jsonData = JSON.parse(raw);
    }

    const totalLangs = config.tgt_langs.length;
    const outputFiles: string[] = [];
    let completedLangs = 0;

    // Step 2: Translate to each target language
    for (const tgtLang of config.tgt_langs) {
      onProgress({
        job_id: job.id,
        current_page: completedLangs,
        total_pages: totalLangs,
        status: 'processing',
        message: `Translating to ${tgtLang} (${completedLangs + 1}/${totalLangs})...`,
      });

      const result = await submitTranslation(
        jsonData!,
        config.src_lang,
        tgtLang,
        config.model_variant,
      );

      // Write translated JSON to output folder
      const baseName = path.parse(job.file_name).name;
      const outputPath = path.join(
        config.output_folder,
        `${baseName}_${tgtLang}.json`
      );

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(result.translated_json, null, 2));
      outputFiles.push(outputPath);

      completedLangs++;
    }

    // Step 3: Report completion
    onProgress({
      job_id: job.id,
      current_page: totalLangs,
      total_pages: totalLangs,
      status: 'completed',
      message: 'Translation complete',
    });

    // Credits: 2 per page per language
    const pageCount = job.total_pages || 1;
    const creditsCharged = pageCount * totalLangs * 2;

    return {
      success: true,
      completedPages: totalLangs,
      totalPages: totalLangs,
      creditsCharged,
      outputFiles,
    };
  }
}

export const translationPipeline = new TranslationPipeline();
