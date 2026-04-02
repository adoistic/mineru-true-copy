import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { runPipeline } from '@/lib/pipelines/runner';
import { ocrPipeline } from '@/lib/pipelines/ocr';

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return Response.json(
        { error: 'Content-Type must be multipart/form-data' },
        { status: 400 }
      );
    }

    const formData = await request.formData();
    const file = formData.get('file') as File;
    const keyId =
      (formData.get('key_id') as string) ||
      request.headers.get('x-key-id');
    const outputFormats = formData.get('output_formats') as string;
    const outputFolder = formData.get('output_folder') as string;
    const removeHeaders = formData.get('remove_headers_footers') === 'true';

    if (!file) {
      return Response.json({ error: 'No file provided' }, { status: 400 });
    }

    if (!keyId) {
      return Response.json({ error: 'Missing key_id' }, { status: 400 });
    }

    if (!outputFolder) {
      return Response.json({ error: 'Missing output_folder' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const { PDFDocument } = await import('pdf-lib');
    const pdfDoc = await PDFDocument.load(buffer);
    const pageCount = pdfDoc.getPageCount();

    const tempDir = join(tmpdir(), 'doctransform', randomUUID());
    await mkdir(tempDir, { recursive: true });
    const tempFilePath = join(tempDir, file.name);
    await writeFile(tempFilePath, buffer);

    const toolConfig = {
      remove_headers_footers: removeHeaders,
      remove_metadata: false,
      join_broken_pages: false,
      output_formats: outputFormats ? JSON.parse(outputFormats) : ['html'],
      output_folder: outputFolder,
    };

    const { job, result } = await runPipeline({
      pipeline: ocrPipeline,
      filePath: tempFilePath,
      fileName: file.name,
      jobType: 'ocr',
      toolConfig,
      totalPages: pageCount,
      keyId,
      outputFolder,
    });

    return Response.json(
      {
        job_id: job.id,
        status: job.status,
        page_count: pageCount,
        file_name: file.name,
        output_files: result.outputFiles || [],
      },
      { status: 201 }
    );
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'OCR processing failed',
      },
      { status: 500 }
    );
  }
}
