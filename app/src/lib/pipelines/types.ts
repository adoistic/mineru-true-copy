import { Job, JobStatus, PipelineErrorType, PipelineProgress } from '@/types';

export interface PipelineResult {
  success: boolean;
  completedPages: number;
  totalPages: number;
  creditsCharged: number;
  error?: PipelineError;
  outputFiles?: string[];
}

export interface PipelineError {
  type: PipelineErrorType;
  message: string;
  page?: number;
  retryable: boolean;
}

export interface Pipeline {
  name: string;
  execute(job: Job, onProgress: (progress: PipelineProgress) => void): Promise<PipelineResult>;
}

export function classifyError(error: Error): PipelineError {
  const msg = error.message.toLowerCase();

  if (msg.includes('mineru') || msg.includes('ocr engine')) {
    return { type: 'mineru_crash', message: error.message, retryable: true };
  }
  if (msg.includes('rate limit') || msg.includes('429')) {
    return { type: 'rate_limited', message: error.message, retryable: true };
  }
  if (msg.includes('insufficient credits')) {
    return { type: 'insufficient_credits', message: error.message, retryable: false };
  }
  if (msg.includes('key') && (msg.includes('expired') || msg.includes('revoked'))) {
    return { type: 'key_expired', message: error.message, retryable: false };
  }
  if (msg.includes('network') || msg.includes('econnreset') || msg.includes('timeout') || msg.includes('fetch failed')) {
    return { type: 'network_error', message: error.message, retryable: true };
  }
  if (msg.includes('partial')) {
    return { type: 'partial_failure', message: error.message, retryable: true };
  }

  return { type: 'llm_api_error', message: error.message, retryable: true };
}
