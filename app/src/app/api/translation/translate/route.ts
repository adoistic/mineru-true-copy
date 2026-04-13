import { submitTranslation } from '@/lib/mineru/client';
import { NextRequest } from 'next/server';
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
    } = body;

    if (!json_data) {
      return Response.json({ error: 'json_data is required' }, { status: 400 });
    }
    if (!tgt_lang) {
      return Response.json({ error: 'tgt_lang is required' }, { status: 400 });
    }

    const result = await submitTranslation(json_data, src_lang, tgt_lang, model_variant);

    // Save output file if output_folder is specified
    let outputFile: string | undefined;
    if (output_folder && file_name) {
      const baseName = path.parse(file_name).name;
      outputFile = path.join(output_folder, `${baseName}_${tgt_lang}.json`);
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, JSON.stringify(result.translated_json, null, 2));
    }

    return Response.json({
      translated_json: result.translated_json,
      duration_ms: result.duration_ms,
      output_file: outputFile,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Translation failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
