"use client";

import { useState, useCallback } from "react";
import FileDropZone from "@/components/common/FileDropZone";
import JobProgress from "@/components/processing/JobProgress";
import type { ExportFormat } from "@/types";

const OUTPUT_FORMATS: { key: ExportFormat; label: string }[] = [
  { key: "html", label: "HTML" },
  { key: "markdown", label: "Markdown" },
  { key: "searchable_pdf", label: "Searchable PDF" },
  { key: "epub", label: "EPUB" },
  { key: "json", label: "JSON" },
  { key: "zip", label: "ZIP" },
];

export default function OcrTool() {
  const [file, setFile] = useState<File | null>(null);
  const [outputFolder, setOutputFolder] = useState(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("default_output_folder") ?? ""
      : ""
  );
  const [selectedFormats, setSelectedFormats] = useState<Set<ExportFormat>>(
    new Set(["markdown"])
  );
  const [removeHeaders, setRemoveHeaders] = useState(false);
  const [fixHeadings, setFixHeadings] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [outputFiles, setOutputFiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const toggleFormat = useCallback((fmt: ExportFormat) => {
    setSelectedFormats((prev) => {
      const next = new Set(prev);
      if (next.has(fmt)) next.delete(fmt);
      else next.add(fmt);
      return next;
    });
  }, []);

  const handleProcess = useCallback(async () => {
    if (!file) return;
    setProcessing(true);
    setError(null);
    setCompleted(false);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append(
        "config",
        JSON.stringify({
          output_formats: Array.from(selectedFormats),
          output_folder: outputFolder,
          remove_headers_footers: removeHeaders,
          fix_headings: fixHeadings,
        })
      );

      const keyId = localStorage.getItem("key_id") ?? "";
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "x-key-id": keyId },
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Failed to start processing.");
      }

      const data = await res.json();
      setJobId(data.job_id ?? data.id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to start processing."
      );
      setProcessing(false);
    }
  }, [file, selectedFormats, outputFolder, removeHeaders, fixHeadings]);

  const handleComplete = useCallback((files: string[]) => {
    setOutputFiles(files);
    setCompleted(true);
    setProcessing(false);
  }, []);

  const handleJobError = useCallback((msg: string) => {
    setError(msg);
    setProcessing(false);
  }, []);

  const handleReset = useCallback(() => {
    setFile(null);
    setJobId(null);
    setProcessing(false);
    setCompleted(false);
    setOutputFiles([]);
    setError(null);
  }, []);

  // Show job progress if we have a jobId
  if (jobId && processing) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
          Processing OCR
        </h2>
        <JobProgress
          jobId={jobId}
          onComplete={handleComplete}
          onError={handleJobError}
        />
      </div>
    );
  }

  // Show results after completion
  if (completed) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
          OCR Complete
        </h2>
        <div className="rounded-lg border border-green-200 bg-green-50 p-5 dark:border-green-900 dark:bg-green-950/20">
          <div className="mb-3 flex items-center gap-2">
            <svg
              className="h-5 w-5 text-green-600 dark:text-green-400"
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
            <span className="text-sm font-medium text-green-800 dark:text-green-300">
              Processing completed successfully
            </span>
          </div>

          {outputFiles.length > 0 && (
            <ul className="mb-4 space-y-1">
              {outputFiles.map((f, i) => (
                <li
                  key={i}
                  className="text-xs text-green-700 dark:text-green-400"
                >
                  {f.split("/").pop()}
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2">
            <button className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">
              Open Output Folder
            </button>
            <button
              onClick={handleReset}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              Process Another File
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
        OCR Processing
      </h2>

      {/* File drop zone */}
      <FileDropZone onFileSelected={setFile} disabled={processing} />

      {/* Options */}
      <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-800">
        <h3 className="text-sm font-medium text-slate-900 dark:text-white">
          Options
        </h3>

        {/* Output folder */}
        <div>
          <label className="mb-1 block text-sm text-slate-600 dark:text-slate-400">
            Output Folder
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={outputFolder}
              onChange={(e) => setOutputFolder(e.target.value)}
              placeholder="/path/to/output"
              className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:placeholder:text-slate-500"
            />
            <button className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800">
              Browse
            </button>
          </div>
        </div>

        {/* Output formats */}
        <div>
          <label className="mb-2 block text-sm text-slate-600 dark:text-slate-400">
            Output Formats
          </label>
          <div className="flex flex-wrap gap-3">
            {OUTPUT_FORMATS.map(({ key, label }) => (
              <label
                key={key}
                className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"
              >
                <input
                  type="checkbox"
                  checked={selectedFormats.has(key)}
                  onChange={() => toggleFormat(key)}
                  className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600"
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        {/* Toggles */}
        <div className="space-y-3">
          <label className="flex items-center justify-between">
            <span className="text-sm text-slate-700 dark:text-slate-300">
              Remove Headers/Footers
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={removeHeaders}
              onClick={() => setRemoveHeaders(!removeHeaders)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                removeHeaders ? "bg-blue-600" : "bg-slate-300 dark:bg-slate-600"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform ${
                  removeHeaders ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </label>

          <label className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              Fix Heading Hierarchy
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                Coming Soon
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={fixHeadings}
              onClick={() => setFixHeadings(!fixHeadings)}
              disabled
              className="relative inline-flex h-6 w-11 shrink-0 cursor-not-allowed rounded-full border-2 border-transparent bg-slate-200 opacity-50 dark:bg-slate-700"
            >
              <span className="pointer-events-none inline-block h-5 w-5 translate-x-0 rounded-full bg-white shadow ring-0" />
            </button>
          </label>
        </div>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-400">
          {error}
        </p>
      )}

      {/* Process button */}
      <button
        onClick={handleProcess}
        disabled={!file || selectedFormats.size === 0}
        className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Process
      </button>
    </div>
  );
}
