import { submitTranslation } from '@/lib/mineru/client';
import { exportAll } from '@/lib/export';
import { NextRequest } from 'next/server';
import type { ExportFormat, MineruOutput } from '@/types';
import fs from 'fs';
import path from 'path';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      json_data,
      src_lang,
      tgt_lang,
      model_variant = '1B',
      output_folder,
      file_name,
      output_formats,
      remove_headers_footers,
      formula_display,
      table_display,
      include_figures,
      figure_display,
    } = body;

    if (!json_data) {
      return Response.json({ error: 'json_data is required' }, { status: 400 });
    }
    if (!tgt_lang) {
      return Response.json({ error: 'tgt_lang is required' }, { status: 400 });
    }

    const result = await submitTranslation(json_data, src_lang, tgt_lang, model_variant);

    // Always save the translated JSON.
    // Directory layout: {output_folder}/{baseName}/{tgt_lang}/...
    let outputFile: string | undefined;
    let outputFiles: string[] = [];

    if (output_folder && file_name) {
      const baseName = path.parse(file_name).name;
      const docFolder = path.join(output_folder, baseName);
      const langFolder = path.join(docFolder, tgt_lang);
      fs.mkdirSync(langFolder, { recursive: true });

      // Always persist the raw translated JSON (the source of truth)
      outputFile = path.join(langFolder, `${baseName}_${tgt_lang}.json`);
      fs.writeFileSync(outputFile, JSON.stringify(result.translated_json, null, 2));
      outputFiles.push(outputFile);

      // Run the full export pipeline on the translated JSON, minus searchable_pdf
      // (searchable PDF overlays OCR text on the *original* PDF pages — it can't
      // render translated Devanagari on English glyph boxes).
      const requested = Array.isArray(output_formats) ? (output_formats as ExportFormat[]) : [];
      const formats = requested.filter((f) => f !== 'searchable_pdf');

      if (formats.length > 0) {
        try {
          const exported = await exportAll({
            mineruOutput: result.translated_json as unknown as MineruOutput,
            // No live MinerU taskId — translated JSON is standalone. Inline figures
            // (img_data/img_mime) still work because they're embedded in the JSON.
            taskId: undefined,
            formats,
            outputFolder: langFolder,
            baseName: `${baseName}_${tgt_lang}`,
            originalPdfPath: '', // not used by non-searchable formats
            removeHeadersFooters: Boolean(remove_headers_footers),
            formulaDisplay: formula_display === 'image' ? 'image' : 'rendered',
            tableDisplay: table_display === 'image' ? 'image' : 'rendered',
            includeFigures: include_figures !== false,
            figureDisplay: figure_display === 'text' ? 'text' : 'image',
          });
          outputFiles = outputFiles.concat(exported);
        } catch (err) {
          console.error('[Translation] Export pipeline failed:', err);
          // Do not fail the whole request — JSON is already saved.
        }
      }
    }

    return Response.json({
      translated_json: result.translated_json,
      duration_ms: result.duration_ms,
      output_file: outputFile,
      output_files: outputFiles,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Translation failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
