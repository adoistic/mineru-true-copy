import { runPipeline } from '@/lib/pipelines/runner';
import { extractionPipeline } from '@/lib/pipelines/extraction';
import path from 'path';
import fs from 'fs';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { file_path, key_id, schema, prompt, output_formats, output_folder } = body;

    const headerKeyId = request.headers.get('x-key-id');
    const resolvedKeyId = key_id || headerKeyId;

    if (!file_path) {
      return Response.json({ error: 'Missing required field: file_path' }, { status: 400 });
    }

    if (!resolvedKeyId) {
      return Response.json({ error: 'Missing required field: key_id' }, { status: 400 });
    }

    if (!schema) {
      return Response.json({ error: 'Missing required field: schema' }, { status: 400 });
    }

    if (!output_folder) {
      return Response.json({ error: 'Missing required field: output_folder' }, { status: 400 });
    }

    // Get page count from PDF
    let totalPages = 1;
    try {
      const { PDFDocument } = await import('pdf-lib');
      const pdfBytes = fs.readFileSync(file_path);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      totalPages = pdfDoc.getPageCount();
    } catch {
      // Default to 1 page if we can't read the PDF
    }

    const toolConfig = {
      schema,
      prompt: prompt || '',
      output_formats: output_formats || ['json'],
      output_folder,
    };

    const { job, result } = await runPipeline({
      pipeline: extractionPipeline,
      filePath: file_path,
      fileName: path.basename(file_path),
      jobType: 'extract',
      toolConfig,
      totalPages,
      keyId: resolvedKeyId,
      outputFolder: output_folder,
    });

    return Response.json(
      { job_id: job.id, status: job.status, output_files: result.outputFiles || [] },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : 'Extraction processing failed' },
      { status: 500 }
    );
  }
}
