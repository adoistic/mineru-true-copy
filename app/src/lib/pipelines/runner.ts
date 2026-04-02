/**
 * Shared PipelineRunner: handles job lifecycle, credit reservation/refund,
 * progress events, retry logic, and error classification.
 */
import { Job, PipelineProgress, JobType } from '@/types';
import { createJob, updateJobStatus, getJob } from '@/lib/db/sqlite';
import { reserveCredits, finalizeCredits, calculateCredits } from '@/lib/firebase/credits';
import { Pipeline, PipelineResult, classifyError } from './types';

const MAX_RETRIES = 2;

// Event emitter for progress updates
type ProgressListener = (progress: PipelineProgress) => void;
const progressListeners = new Map<string, Set<ProgressListener>>();

export function onJobProgress(jobId: string, listener: ProgressListener): () => void {
  if (!progressListeners.has(jobId)) {
    progressListeners.set(jobId, new Set());
  }
  progressListeners.get(jobId)!.add(listener);

  return () => {
    progressListeners.get(jobId)?.delete(listener);
    if (progressListeners.get(jobId)?.size === 0) {
      progressListeners.delete(jobId);
    }
  };
}

function emitProgress(progress: PipelineProgress): void {
  const listeners = progressListeners.get(progress.job_id);
  if (listeners) {
    for (const listener of listeners) {
      try {
        listener(progress);
      } catch (err) {
        console.error('[Runner] Progress listener error:', err);
      }
    }
  }
}

export async function runPipeline(params: {
  pipeline: Pipeline;
  filePath: string;
  fileName: string;
  jobType: JobType;
  toolConfig: Record<string, unknown>;
  totalPages: number;
  keyId: string;
  outputFolder: string;
  languageCount?: number;
}): Promise<{ job: Job; result: PipelineResult }> {
  const { pipeline, filePath, fileName, jobType, toolConfig, totalPages, keyId, outputFolder, languageCount } = params;

  // Calculate and reserve credits
  const creditsNeeded = calculateCredits(jobType, totalPages, languageCount);
  const reservation = await reserveCredits(keyId, creditsNeeded, '');

  if (!reservation.success) {
    throw new Error(reservation.error || 'Failed to reserve credits');
  }

  // Create job in SQLite
  const job = createJob({
    file_path: filePath,
    file_name: fileName,
    job_type: jobType,
    tool_config: toolConfig,
    total_pages: totalPages,
    credits_reserved: creditsNeeded,
    output_folder: outputFolder,
  });

  // Execute pipeline with retries
  let result: PipelineResult | null = null;
  let retryCount = 0;

  while (retryCount <= MAX_RETRIES) {
    updateJobStatus(job.id, 'processing');
    emitProgress({
      job_id: job.id,
      current_page: 0,
      total_pages: totalPages,
      status: 'processing',
      message: retryCount > 0 ? `Retrying (attempt ${retryCount + 1})...` : 'Processing...',
    });

    try {
      result = await pipeline.execute(job, (progress) => {
        emitProgress(progress);
        updateJobStatus(job.id, 'processing', {
          completed_pages: progress.current_page,
        });
      });

      break; // Success, exit retry loop
    } catch (err) {
      const pipelineError = classifyError(err as Error);

      if (pipelineError.retryable && retryCount < MAX_RETRIES) {
        retryCount++;
        updateJobStatus(job.id, 'retrying', {
          retry_count: retryCount,
          error_message: pipelineError.message,
          error_type: pipelineError.type,
        });
        console.log(`[Runner] ${pipeline.name} retry ${retryCount}/${MAX_RETRIES}: ${pipelineError.message}`);
        continue;
      }

      // Final failure
      result = {
        success: false,
        completedPages: 0,
        totalPages,
        creditsCharged: 0,
        error: pipelineError,
      };
      break;
    }
  }

  if (!result) {
    result = { success: false, completedPages: 0, totalPages, creditsCharged: 0 };
  }

  // Finalize credits
  const finalStatus = result.success
    ? 'success' as const
    : result.completedPages > 0
      ? 'partial' as const
      : 'failed' as const;

  await finalizeCredits(keyId, {
    jobId: job.id,
    creditsReserved: creditsNeeded,
    creditsCharged: result.creditsCharged,
    jobType,
    fileName,
    pagesProcessed: result.completedPages,
    status: finalStatus,
    errorMessage: result.error?.message,
  });

  // Update job final status
  const jobStatus = result.success ? 'completed' : result.completedPages > 0 ? 'completed' : 'failed';
  updateJobStatus(job.id, jobStatus as Job['status'], {
    completed_pages: result.completedPages,
    credits_charged: result.creditsCharged,
    error_message: result.error?.message ?? null,
    error_type: result.error?.type ?? null,
  });

  emitProgress({
    job_id: job.id,
    current_page: result.completedPages,
    total_pages: totalPages,
    status: jobStatus as Job['status'],
    message: result.success ? 'Complete' : result.error?.message || 'Failed',
  });

  const finalJob = getJob(job.id) || job;
  return { job: finalJob, result };
}
