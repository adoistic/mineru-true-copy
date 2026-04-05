/**
 * Job queue with adaptive concurrency control.
 * OCR slots scale with system RAM: ~3GB base + ~2GB per slot, capped at 5.
 * LLM jobs (extract/wizard): max 30 concurrent (API-bound, can parallel)
 */
import os from 'os';
import { runPipeline, cleanupOldTempFiles } from './runner';
import { resetStuckJobs } from '@/lib/db/sqlite';

type RunPipelineParams = Parameters<typeof runPipeline>[0];

interface QueuedJob {
  id: string;
  jobType: string;
  totalPages: number;
  params: RunPipelineParams;
}

/**
 * Calculate OCR concurrency slots based on system memory.
 * Reserve 4GB for OS, 3GB for MinerU models at rest, ~4GB per concurrent job
 * (inference tensors + rasterized pages + base64 images + output buffers).
 * 8GB → 1, 16GB → 2, 24GB → 3, 32GB → 4, 48GB+ → 5 (capped, MPS serializes)
 */
function calcOcrSlots(): number {
  const totalGb = os.totalmem() / (1024 ** 3);
  const slots = Math.max(1, Math.floor((totalGb - 4 - 3) / 4));
  console.log(`[Queue] System RAM: ${totalGb.toFixed(0)}GB → OCR concurrency: ${slots}`);
  return slots;
}

class JobQueue {
  private queue: QueuedJob[] = [];
  private runningOcr = 0;
  private runningLlm = 0;
  private readonly maxConcurrentOcr = calcOcrSlots();
  private readonly maxConcurrentLlm = 30;

  enqueue(params: RunPipelineParams): void {
    const job: QueuedJob = {
      id: params.existingJobId || crypto.randomUUID(),
      jobType: params.jobType,
      totalPages: params.totalPages,
      params,
    };

    // Insert sorted by page count ascending (small jobs first for better throughput)
    const insertIdx = this.queue.findIndex((q) => q.totalPages > job.totalPages);
    if (insertIdx === -1) {
      this.queue.push(job);
    } else {
      this.queue.splice(insertIdx, 0, job);
    }

    console.log(
      `[Queue] Enqueued job ${job.id} (${job.jobType}, ${job.totalPages} pages). Queue depth: ${this.queue.length}`
    );
    this.processNext();
  }

  private isOcrType(jobType: string): boolean {
    return jobType === 'ocr' || jobType === 'heading_correction';
  }

  private canRun(jobType: string): boolean {
    if (this.isOcrType(jobType)) {
      return this.runningOcr < this.maxConcurrentOcr;
    }
    return this.runningLlm < this.maxConcurrentLlm;
  }

  private processNext(): void {
    // Find first queued job that can run given current concurrency limits
    const idx = this.queue.findIndex((job) => this.canRun(job.jobType));
    if (idx === -1) return;

    const job = this.queue.splice(idx, 1)[0];

    if (this.isOcrType(job.jobType)) {
      this.runningOcr++;
    } else {
      this.runningLlm++;
    }

    console.log(
      `[Queue] Starting job ${job.id} (${job.jobType}). Running: OCR=${this.runningOcr} LLM=${this.runningLlm} Queued=${this.queue.length}`
    );

    runPipeline(job.params)
      .catch((err) => {
        console.error(`[Queue] Pipeline error for job ${job.id}:`, err);
      })
      .finally(() => {
        if (this.isOcrType(job.jobType)) {
          this.runningOcr--;
        } else {
          this.runningLlm--;
        }
        console.log(
          `[Queue] Finished job ${job.id}. Running: OCR=${this.runningOcr} LLM=${this.runningLlm} Queued=${this.queue.length}`
        );
        this.processNext();
      });
  }

  getStatus(): { queueLength: number; runningOcr: number; runningLlm: number } {
    return {
      queueLength: this.queue.length,
      runningOcr: this.runningOcr,
      runningLlm: this.runningLlm,
    };
  }
}

export const jobQueue = new JobQueue();

// Recover jobs that were stuck in 'processing' when the server last shut down
(function recoverOnStartup() {
  try {
    const recovered = resetStuckJobs();
    if (recovered > 0) {
      console.log(`[Queue] Startup recovery: reset ${recovered} stuck job(s) back to 'queued'`);
    }
  } catch (err) {
    console.error('[Queue] Startup recovery failed:', err);
  }
  cleanupOldTempFiles();
})();
