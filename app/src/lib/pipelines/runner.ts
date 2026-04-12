/**
 * Shared PipelineRunner: handles job lifecycle, credit reservation/refund,
 * progress events, retry logic, and error classification.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
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
  existingJobId?: string;
}): Promise<{ job: Job; result: PipelineResult }> {
  const { pipeline, filePath, fileName, jobType, toolConfig, totalPages, keyId, outputFolder, languageCount, existingJobId } = params;

  // Calculate and reserve credits
  const creditsNeeded = calculateCredits(jobType, totalPages, { languageCount });
  const reservation = await reserveCredits(keyId, creditsNeeded, '');

  if (!reservation.success) {
    if (existingJobId) {
      updateJobStatus(existingJobId, 'failed', {
        error_message: reservation.error || 'Failed to reserve credits',
      });
    }
    throw new Error(reservation.error || 'Failed to reserve credits');
  }

  // Use existing job or create new one
  let job: Job;
  if (existingJobId) {
    updateJobStatus(existingJobId, 'queued', { credits_reserved: creditsNeeded });
    job = getJob(existingJobId)!;
  } else {
    job = createJob({
      file_path: filePath,
      file_name: fileName,
      job_type: jobType,
      tool_config: toolConfig,
      total_pages: totalPages,
      credits_reserved: creditsNeeded,
      output_folder: outputFolder,
    });
  }

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

  // Update job final status (including output file paths)
  const jobStatus = result.success ? 'completed' : result.completedPages > 0 ? 'completed' : 'failed';
  updateJobStatus(job.id, jobStatus as Job['status'], {
    completed_pages: result.completedPages,
    credits_charged: result.creditsCharged,
    error_message: result.error?.message ?? null,
    error_type: result.error?.type ?? null,
    output_files: result.outputFiles ?? [],
  } as Partial<Job>);

  emitProgress({
    job_id: job.id,
    current_page: result.completedPages,
    total_pages: totalPages,
    status: jobStatus as Job['status'],
    message: result.success ? 'Complete' : result.error?.message || 'Failed',
  });

  // Clean up temp upload file
  try {
    if (filePath.includes('doctransform-uploads') && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (cleanupErr) {
    console.warn('[Runner] Failed to clean up temp file:', cleanupErr);
  }

  const finalJob = getJob(job.id) || job;
  return { job: finalJob, result };
}

/**
 * Safety-net cleanup: removes any files in the doctransform-uploads temp dir
 * that are older than 24 hours (covers crashed/abandoned jobs).
 */
export function cleanupOldTempFiles(): void {
  try {
    const tmpDir = path.join(os.tmpdir(), 'doctransform-uploads');
    if (!fs.existsSync(tmpDir)) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(tmpDir)) {
      const fp = path.join(tmpDir, file);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        console.log('[Runner] Cleaned up old temp file:', file);
      }
    }
  } catch (err) {
    console.warn('[Runner] Temp cleanup error:', err);
  }
}
