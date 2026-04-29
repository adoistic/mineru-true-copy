import { getActiveJobs, getJob, createJob } from '@/lib/db/sqlite';
import { onJobProgress } from '@/lib/pipelines/runner';
import { ocrPipeline } from '@/lib/pipelines/ocr';
import { extractionPipeline } from '@/lib/pipelines/extraction';
import { jobQueue } from '@/lib/pipelines/queue';
import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import os from 'os';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const configStr = formData.get('config') as string | null;

    if (!file) {
      return Response.json({ error: 'Missing file' }, { status: 400 });
    }

    const config = configStr ? JSON.parse(configStr) : {};
    const jobType = config.job_type || 'ocr';

    // Save uploaded file to temp dir
    const tmpDir = path.join(os.tmpdir(), 'mineru-true-copy-uploads');
    fs.mkdirSync(tmpDir, { recursive: true });
    const uniqueId = crypto.randomUUID().slice(0, 8);
    const filePath = path.join(tmpDir, `${uniqueId}_${file.name}`);
    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    // Count pages
    let totalPages = 1;
    try {
      const pdfDoc = await PDFDocument.load(buffer);
      totalPages = pdfDoc.getPageCount();
    } catch {
      // If we can't read pages, default to 1
    }

    // Ensure output folder exists
    const outputFolder = config.output_folder || path.join(os.homedir(), 'MinerU True Copy Output');
    fs.mkdirSync(outputFolder, { recursive: true });

    // Select pipeline
    const pipeline = jobType === 'extract' ? extractionPipeline : ocrPipeline;

    // Pre-create the job so we can return the ID immediately
    const job = createJob({
      file_path: filePath,
      file_name: file.name,
      job_type: jobType,
      tool_config: { ...config, output_folder: outputFolder },
      total_pages: totalPages,
      output_folder: outputFolder,
    });

    // Enqueue for processing (queue manages concurrency)
    jobQueue.enqueue({
      pipeline,
      filePath,
      fileName: file.name,
      jobType,
      toolConfig: { ...config, output_folder: outputFolder },
      totalPages,
      outputFolder,
      existingJobId: job.id,
    });

    return Response.json({ job_id: job.id, id: job.id });
  } catch (error) {
    console.error('[jobs/POST]', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to create job' },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const stream = searchParams.get('stream');

    if (stream === 'true') {
      if (!id) {
        return Response.json(
          { error: 'Missing required query parameter: id for streaming' },
          { status: 400 }
        );
      }

      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        start(controller) {
          // Send current state immediately to avoid race condition
          // where the job completes before the client connects
          const currentJob = getJob(id);
          if (currentJob) {
            const initialData = `data: ${JSON.stringify({
              job_id: currentJob.id,
              current_page: currentJob.completed_pages,
              total_pages: currentJob.total_pages,
              status: currentJob.status,
              message: currentJob.error_message || currentJob.status,
            })}\n\n`;
            controller.enqueue(encoder.encode(initialData));

            if (
              currentJob.status === 'completed' ||
              currentJob.status === 'failed' ||
              currentJob.status === 'permanently_failed'
            ) {
              controller.close();
              return;
            }
          }

          const unsubscribe = onJobProgress(id, (progress) => {
            const data = `data: ${JSON.stringify(progress)}\n\n`;
            controller.enqueue(encoder.encode(data));

            if (
              progress.status === 'completed' ||
              progress.status === 'failed'
            ) {
              controller.close();
              unsubscribe();
            }
          });

          request.signal.addEventListener('abort', () => {
            unsubscribe();
            controller.close();
          });
        },
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    if (id) {
      const job = await getJob(id);

      if (!job) {
        return Response.json({ error: 'Job not found' }, { status: 404 });
      }

      return Response.json(job);
    }

    const jobs = await getActiveJobs();
    return Response.json({ jobs });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to fetch jobs',
      },
      { status: 500 }
    );
  }
}
