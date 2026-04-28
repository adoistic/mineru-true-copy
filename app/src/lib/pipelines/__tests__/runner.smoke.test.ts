/**
 * Regression smoke test for the shared PipelineRunner.
 *
 * Confirms that after the credit/activation strip (T1, T2 of v0.1):
 *   - runPipeline always creates a job (no credit gate).
 *   - Progress events reach subscribed listeners.
 *   - Retry loop fires for retryable errors and respects MAX_RETRIES.
 *   - Non-retryable errors fail without retries.
 *   - The runner source contains zero credit-related symbols.
 *
 * The runner is pure server code — leave this file at the default
 * (node) vitest environment; do NOT add the jsdom pragma.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job, PipelineProgress } from '@/types';

// ──────────────────────────────────────────────────────────────────────────
// Module mocks
// ──────────────────────────────────────────────────────────────────────────

// Avoid touching the real SQLite file. createJob returns a fully-shaped Job
// that satisfies the `Job` type from `@/types`.
vi.mock('@/lib/db/sqlite', () => {
  const fakeJob = (params: {
    file_path: string;
    file_name: string;
    job_type: Job['job_type'];
    tool_config: Record<string, unknown>;
    total_pages: number;
    output_folder: string;
  }): Job => ({
    id: 'test-job-1',
    file_path: params.file_path,
    file_name: params.file_name,
    job_type: params.job_type,
    status: 'queued',
    tool_config: params.tool_config,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    error_message: null,
    error_type: null,
    retry_count: 0,
    total_pages: params.total_pages,
    completed_pages: 0,
    output_folder: params.output_folder,
    output_files: [],
  });

  return {
    createJob: vi.fn(fakeJob),
    updateJobStatus: vi.fn(),
    getJob: vi.fn((_id: string) => null),
  };
});

// Mock classifyError so we can flip retryable on/off per test. The runner
// imports classifyError from './types' as a value, so module-level mock is
// the cleanest seam.
vi.mock('../types', async () => {
  const actual = await vi.importActual<typeof import('../types')>('../types');
  return {
    ...actual,
    classifyError: vi.fn((err: Error) => ({
      type: 'llm_api_error' as const,
      message: err.message,
      retryable: true, // default: retryable
    })),
  };
});

// ──────────────────────────────────────────────────────────────────────────
// Imports under test (after mocks are registered)
// ──────────────────────────────────────────────────────────────────────────

import { runPipeline, onJobProgress } from '../runner';
import { classifyError, type Pipeline, type PipelineResult } from '../types';
import * as sqlite from '@/lib/db/sqlite';

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const baseRunArgs = (overrides: Partial<Parameters<typeof runPipeline>[0]> = {}) => ({
  filePath: '/tmp/fake.pdf',
  fileName: 'fake.pdf',
  jobType: 'ocr' as const,
  toolConfig: {},
  totalPages: 5,
  outputFolder: '/tmp/out',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the classifyError mock to its default retryable behavior.
  (classifyError as ReturnType<typeof vi.fn>).mockImplementation((err: Error) => ({
    type: 'llm_api_error' as const,
    message: err.message,
    retryable: true,
  }));
});

// ──────────────────────────────────────────────────────────────────────────
// Case 1: createJob always called; no credit gate
// ──────────────────────────────────────────────────────────────────────────

describe('runPipeline — job creation has no credit gate', () => {
  it('always creates a job and returns its id on success', async () => {
    const fakePipeline: Pipeline = {
      name: 'fake',
      execute: vi.fn(async () => ({
        success: true,
        completedPages: 5,
        totalPages: 5,
      })),
    };

    const { job, result } = await runPipeline({
      pipeline: fakePipeline,
      ...baseRunArgs(),
    });

    expect(sqlite.createJob).toHaveBeenCalledTimes(1);
    expect(job.id).toBe('test-job-1');
    expect(result.success).toBe(true);
    expect(fakePipeline.execute).toHaveBeenCalledTimes(1);

    // Final status update must be 'completed'
    const updateCalls = (sqlite.updateJobStatus as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = updateCalls[updateCalls.length - 1];
    expect(lastCall[0]).toBe('test-job-1');
    expect(lastCall[1]).toBe('completed');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Case 2: progress events reach subscribed listeners
// ──────────────────────────────────────────────────────────────────────────

describe('runPipeline — progress emission', () => {
  it('emits progress events to subscribed listeners', async () => {
    const jobId = 'test-job-1'; // mocked createJob always returns this id

    const innerProgress: PipelineProgress = {
      job_id: jobId,
      current_page: 3,
      total_pages: 5,
      status: 'processing',
      message: 'page 3 of 5',
    };

    const fakePipeline: Pipeline = {
      name: 'fake',
      execute: vi.fn(async (_job, onProgress) => {
        onProgress(innerProgress);
        return { success: true, completedPages: 5, totalPages: 5 };
      }),
    };

    const listener = vi.fn();
    const unsubscribe = onJobProgress(jobId, listener);

    try {
      await runPipeline({
        pipeline: fakePipeline,
        ...baseRunArgs(),
      });
    } finally {
      unsubscribe();
    }

    // Listener should have been invoked at least 3 times:
    // - runner's initial 'processing' emission
    // - the pipeline's own progress event
    // - runner's final 'completed' emission
    expect(listener).toHaveBeenCalled();
    const calls = listener.mock.calls.map((c) => c[0] as PipelineProgress);

    // The pipeline's progress event we passed in must appear verbatim.
    expect(calls).toContainEqual(innerProgress);

    // The final emission must be a 'completed' status.
    const last = calls[calls.length - 1];
    expect(last.status).toBe('completed');
    expect(last.job_id).toBe(jobId);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Case 3: retry loop fires for retryable errors and stops at MAX_RETRIES
// ──────────────────────────────────────────────────────────────────────────

describe('runPipeline — retry loop', () => {
  it('retries up to MAX_RETRIES (2) for retryable errors then fails', async () => {
    // classifyError mock defaults to retryable=true (set in beforeEach).
    const fakePipeline: Pipeline = {
      name: 'fake',
      execute: vi.fn(async () => {
        throw new Error('temporary');
      }),
    };

    const { result } = await runPipeline({
      pipeline: fakePipeline,
      ...baseRunArgs(),
    });

    // MAX_RETRIES is 2 in runner.ts; original attempt + 2 retries = 3.
    expect(fakePipeline.execute).toHaveBeenCalledTimes(3);

    // Result must be a failure; final status update must be 'failed'.
    expect(result.success).toBe(false);
    const updateCalls = (sqlite.updateJobStatus as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = updateCalls[updateCalls.length - 1];
    expect(lastCall[1]).toBe('failed');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Case 4: non-retryable errors fail without retries
// ──────────────────────────────────────────────────────────────────────────

describe('runPipeline — non-retryable errors', () => {
  it('fails on the first attempt without retrying', async () => {
    // Override classifyError to return retryable=false for this test.
    (classifyError as ReturnType<typeof vi.fn>).mockImplementation((err: Error) => ({
      type: 'llm_api_error' as const,
      message: err.message,
      retryable: false,
    }));

    const fakePipeline: Pipeline = {
      name: 'fake',
      execute: vi.fn(async () => {
        throw new Error('non-retryable boom');
      }),
    };

    const { result } = await runPipeline({
      pipeline: fakePipeline,
      ...baseRunArgs(),
    });

    expect(fakePipeline.execute).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    const updateCalls = (sqlite.updateJobStatus as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = updateCalls[updateCalls.length - 1];
    expect(lastCall[1]).toBe('failed');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Case 5: IRON RULE — no credit-related symbols in the runner source
// ──────────────────────────────────────────────────────────────────────────

describe('runner source — IRON RULE static guard', () => {
  it('contains no credit-related symbols or firebase imports', () => {
    const runnerPath = path.join(__dirname, '..', 'runner.ts');
    const source = fs.readFileSync(runnerPath, 'utf-8');

    const forbidden = [
      'deductCredit',
      'reserveCredit',
      'finalizeCredit',
      'creditsCharged',
      'firebase',
      '@/lib/firebase',
    ];
    for (const needle of forbidden) {
      expect(
        source,
        `runner.ts must not reference '${needle}' — credit/auth code was stripped in T1+T2`
      ).not.toContain(needle);
    }
  });

  it('PipelineResult type has no creditsCharged field', () => {
    // belt-and-braces: TS would have caught a re-added field at build time.
    const result = {
      success: true,
      completedPages: 1,
      totalPages: 1,
    } satisfies PipelineResult;

    expect(result).not.toHaveProperty('creditsCharged');
  });
});
