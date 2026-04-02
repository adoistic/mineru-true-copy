import { getJob } from '@/lib/db/sqlite';
import { runPipeline } from '@/lib/pipelines/runner';
import { headingCorrectionPipeline } from '@/lib/pipelines/heading-correction';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { job_id, key_id } = body;

    if (!job_id) {
      return Response.json(
        { error: 'Missing required field: job_id' },
        { status: 400 }
      );
    }

    const originalJob = getJob(job_id);
    if (!originalJob) {
      return Response.json({ error: 'Original job not found' }, { status: 404 });
    }

    if (originalJob.status !== 'completed') {
      return Response.json(
        { error: 'Original OCR job must be completed before heading correction' },
        { status: 409 }
      );
    }

    const effectiveKeyId = key_id || request.headers.get('x-key-id') || '';

    const { job, result } = await runPipeline({
      pipeline: headingCorrectionPipeline,
      filePath: originalJob.file_path,
      fileName: originalJob.file_name,
      jobType: 'heading_correction',
      toolConfig: originalJob.tool_config,
      totalPages: originalJob.total_pages,
      keyId: effectiveKeyId,
      outputFolder: originalJob.output_folder,
    });

    return Response.json({
      job_id: job.id,
      status: job.status,
      output_files: result.outputFiles || [],
      headings_corrected: result.completedPages > 0,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Heading correction failed',
      },
      { status: 500 }
    );
  }
}
