"use client";

import { useState, useEffect, useRef } from "react";
import type { JobStatus } from "@/types";

interface JobProgressProps {
  jobId: string;
  onComplete?: (outputFiles: string[]) => void;
  onError?: (message: string) => void;
}

interface JobData {
  id: string;
  status: JobStatus;
  completed_pages: number;
  total_pages: number;
  message?: string;
  output_files?: string[];
  error_message?: string;
}

export default function JobProgress({
  jobId,
  onComplete,
  onError,
}: JobProgressProps) {
  const [job, setJob] = useState<JobData | null>(null);
  const callbacksRef = useRef({ onComplete, onError });
  callbacksRef.current = { onComplete, onError };
  const settledRef = useRef(false);

  useEffect(() => {
    settledRef.current = false;
  }, [jobId]);

  useEffect(() => {
    let active = true;

    async function fetchJob() {
      try {
        const res = await fetch(`/api/jobs?id=${jobId}`);
        if (!res.ok || !active) return;
        const data: JobData = await res.json();
        if (!active) return;
        setJob(data);

        if (settledRef.current) return;

        if (data.status === "completed") {
          settledRef.current = true;
          callbacksRef.current.onComplete?.(data.output_files ?? []);
        } else if (
          data.status === "failed" ||
          data.status === "permanently_failed"
        ) {
          settledRef.current = true;
          callbacksRef.current.onError?.(data.error_message ?? "Processing failed.");
        }
      } catch {
        // Silently retry on network errors
      }
    }

    fetchJob();
    const interval = setInterval(fetchJob, 2000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [jobId]);

  const progress =
    job && job.total_pages > 0
      ? Math.round((job.completed_pages / job.total_pages) * 100)
      : 0;

  const isComplete = job?.status === "completed";
  const isFailed = job?.status === "failed" || job?.status === "permanently_failed";

  const statusColor = isComplete
    ? 'var(--success)'
    : isFailed
      ? 'var(--error)'
      : 'var(--accent)';

  const barColor = isComplete
    ? 'var(--success)'
    : isFailed
      ? 'var(--error)'
      : 'var(--accent)';

  return (
    <div
      className="rounded p-4"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[13px] font-medium capitalize" style={{ color: statusColor }}>
          {job?.status?.replace("_", " ") ?? "Loading..."}
        </span>
        {job && job.total_pages > 0 && (
          <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            Page {job.completed_pages} / {job.total_pages}
          </span>
        )}
      </div>

      <div
        className="h-1.5 w-full overflow-hidden rounded-full"
        style={{ background: 'var(--bg-elevated)' }}
      >
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${progress}%`, background: barColor }}
        />
      </div>

      {job?.message && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          {job.message}
        </p>
      )}

      {isComplete && job.output_files && (
        <div className="mt-4">
          <h4 className="mb-2 text-[11px] font-medium uppercase tracking-[0.05em]" style={{ color: 'var(--text-secondary)' }}>
            Output Files
          </h4>
          <ul className="space-y-1">
            {job.output_files.map((file, i) => (
              <li
                key={i}
                className="flex items-center gap-2 text-[11px]"
                style={{ color: 'var(--text-secondary)' }}
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  style={{ color: 'var(--success)' }}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                {file.split("/").pop()}
              </li>
            ))}
          </ul>
        </div>
      )}

      {isFailed && job.error_message && (
        <p
          className="mt-3 rounded p-2 text-[11px]"
          style={{ background: 'var(--error-muted)', color: 'var(--error)' }}
        >
          {job.error_message}
        </p>
      )}
    </div>
  );
}
