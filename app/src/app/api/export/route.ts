import { getJob } from '@/lib/db/sqlite';
import { exportAll } from '@/lib/export';
import fs from 'fs';
import path from 'path';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { job_id, formats, output_folder } = body;

    if (!job_id) {
      return Response.json(
        { error: 'Missing required field: job_id' },
        { status: 400 }
      );
    }

    if (!formats || !Array.isArray(formats) || formats.length === 0) {
      return Response.json(
        { error: 'Missing or invalid field: formats (must be a non-empty array)' },
        { status: 400 }
      );
    }

    if (!output_folder) {
      return Response.json(
        { error: 'Missing required field: output_folder' },
        { status: 400 }
      );
    }

    const job = getJob(job_id);

    if (!job) {
      return Response.json({ error: 'Job not found' }, { status: 404 });
    }

    if (job.status !== 'completed') {
      return Response.json(
        { error: 'Job has not completed yet' },
        { status: 409 }
      );
    }

    const baseName = path.parse(job.file_name).name;
    const ocrDataPath = path.join(job.output_folder, `${baseName}_ocr_data.json`);

    if (!fs.existsSync(ocrDataPath)) {
      return Response.json(
        { error: 'OCR data not found for this job' },
        { status: 404 }
      );
    }

    const mineruOutput = JSON.parse(fs.readFileSync(ocrDataPath, 'utf-8'));
    const config = job.tool_config as Record<string, unknown>;

    const outputFiles = await exportAll({
      mineruOutput,
      formats,
      outputFolder: output_folder,
      baseName,
      originalPdfPath: job.file_path,
      htmlOptions: {
        removeHeadersFooters: (config.remove_headers_footers as boolean) ?? false,
        removeMetadata: (config.remove_metadata as boolean) ?? false,
        joinBrokenPages: (config.join_broken_pages as boolean) ?? false,
        formulaDisplay: (config.formula_display as string) === 'image' ? 'image' : 'rendered',
        tableDisplay: (config.table_display as string) === 'image' ? 'image' : 'rendered',
        includeFigures: (config.include_figures as boolean) ?? true,
        figureDisplay: ((config.figure_display as string) === 'text' ? 'text' : 'image') as 'image' | 'text',
      },
    });

    return Response.json({ success: true, output_files: outputFiles });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Export failed',
      },
      { status: 500 }
    );
  }
}
