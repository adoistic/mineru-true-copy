"use client";

import { useState, useEffect, useCallback } from "react";
import type { JobStatus } from "@/types";

interface JobProgressProps {
  jobId: string;
  onComplete?: (outputFiles: string[]) => void;
  onError?: (message: string) => void;
}

interface JobData {
  id: string;
  status: JobStatus;
  current_page: number;
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
  const [polling, setPolling] = useState(true);

  const fetchJob = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs?id=${jobId}`);
      if (!res.ok) throw new Error("Failed to fetch job status");
      const data: JobData = await res.json();
      setJob(data);

      if (data.status === "completed") {
        setPolling(false);
        onComplete?.(data.output_files ?? []);
      } else if (
        data.status === "failed" ||
        data.status === "permanently_failed"
      ) {
        setPolling(false);
        onError?.(data.error_message ?? "Processing failed.");
      }
    } catch {
      // Silently retry on network errors
    }
  }, [jobId, onComplete, onError]);

  useEffect(() => {
    fetchJob();
    if (!polling) return;
    const interval = setInterval(fetchJob, 2000);
    return () => clearInterval(interval);
  }, [fetchJob, polling]);

  const progress =
    job && job.total_pages > 0
      ? Math.round((job.current_page / job.total_pages) * 100)
      : 0;

  const statusColor =
    job?.status === "completed"
      ? "text-green-600 dark:text-green-400"
      : job?.status === "failed" || job?.status === "permanently_failed"
        ? "text-red-600 dark:text-red-400"
        : "text-blue-600 dark:text-blue-400";

  const barColor =
    job?.status === "completed"
      ? "bg-green-500"
      : job?.status === "failed" || job?.status === "permanently_failed"
        ? "bg-red-500"
        : "bg-blue-600";

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-800">
      <div className="mb-3 flex items-center justify-between">
        <span className={`text-sm font-medium capitalize ${statusColor}`}>
          {job?.status?.replace("_", " ") ?? "Loading..."}
        </span>
        {job && job.total_pages > 0 && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Page {job.current_page} / {job.total_pages}
          </span>
        )}
      </div>

      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${progress}%` }}
        />
      </div>

      {job?.message && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {job.message}
        </p>
      )}

      {job?.status === "completed" && job.output_files && (
        <div className="mt-4">
          <h4 className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">
            Output Files
          </h4>
          <ul className="space-y-1">
            {job.output_files.map((file, i) => (
              <li
                key={i}
                className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400"
              >
                <svg
                  className="h-3.5 w-3.5 text-green-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                {file.split("/").pop()}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(job?.status === "failed" || job?.status === "permanently_failed") &&
        job.error_message && (
          <p className="mt-3 rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
            {job.error_message}
          </p>
        )}
    </div>
  );
}
