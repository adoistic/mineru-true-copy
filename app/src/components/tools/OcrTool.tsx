"use client";

import { useState, useCallback } from "react";
import FileDropZone from "@/components/common/FileDropZone";
import JobProgress from "@/components/processing/JobProgress";
import type { ExportFormat } from "@/types";

interface FormatGroup {
  label: string;
  description: string;
  formats: { key: ExportFormat; label: string; tooltip?: string }[];
}

const FORMAT_GROUPS: FormatGroup[] = [
  {
    label: "True Copy",
    description: "Pixel-perfect replica preserving exact layout and positions",
    formats: [
      { key: "true_copy_html", label: "HTML", tooltip: "Self-contained HTML with text at exact positions" },
      { key: "true_copy_docx", label: "Word (.docx)", tooltip: "Word document with positioned text boxes" },
      { key: "true_copy_pdf", label: "PDF", tooltip: "Reconstructed PDF with visible text at exact positions" },
      { key: "true_copy_pptx", label: "PowerPoint (.pptx)", tooltip: "Slides with positioned text boxes" },
    ],
  },
  {
    label: "Reflowed",
    description: "Clean, editable documents with proper paragraph flow",
    formats: [
      { key: "html", label: "HTML", tooltip: "Semantic HTML with headings, paragraphs, and tables" },
      { key: "reflowed_docx", label: "Word (.docx)", tooltip: "Editable Word document with proper styles" },
      { key: "reflowed_pdf", label: "PDF", tooltip: "Readable PDF with paragraph flow and page breaks" },
      { key: "markdown", label: "Markdown", tooltip: "Plain text with Markdown formatting" },
      { key: "epub", label: "EPUB", tooltip: "E-book format for readers" },
    ],
  },
  {
    label: "Data",
    description: "Structured output for downstream processing",
    formats: [
      { key: "searchable_pdf", label: "Searchable PDF", tooltip: "Original PDF with invisible OCR text layer" },
      { key: "json", label: "JSON", tooltip: "Structured OCR data with regions, bboxes, and metadata" },
    ],
  },
];

// Default selection: all formats selected
const DEFAULT_FORMATS: ExportFormat[] = FORMAT_GROUPS.flatMap(g => g.formats.map(f => f.key));

export default function OcrTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [outputFolder, setOutputFolder] = useState(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("default_output_folder") ?? ""
      : ""
  );
  const [selectedFormats, setSelectedFormats] = useState<Set<ExportFormat>>(
    new Set(DEFAULT_FORMATS)
  );
  const [includeBenchmarkHtml, setIncludeBenchmarkHtml] = useState(false);
  const [removeHeaders, setRemoveHeaders] = useState(false);
  const [includeFigures, setIncludeFigures] = useState(true);
  const [formulaDisplay, setFormulaDisplay] = useState<'rendered' | 'image'>('image');
  const [tableDisplay, setTableDisplay] = useState<'rendered' | 'image'>('rendered');
  const [figureDisplay, setFigureDisplay] = useState<'image' | 'text'>('image');
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [jobFileNames, setJobFileNames] = useState<string[]>([]);
  const [processing, setProcessing] = useState(false);
  const [completedCount, setCompletedCount] = useState(0);
  const [allOutputFiles, setAllOutputFiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const allComplete = jobIds.length > 0 && completedCount >= jobIds.length;

  const toggleFormat = useCallback((fmt: ExportFormat) => {
    setSelectedFormats((prev) => {
      const next = new Set(prev);
      if (next.has(fmt)) next.delete(fmt);
      else next.add(fmt);
      return next;
    });
  }, []);

  const handleProcess = useCallback(async () => {
    if (files.length === 0) return;
    setProcessing(true);
    setError(null);
    setCompletedCount(0);
    setAllOutputFiles([]);
    setJobIds([]);
    setJobFileNames([]);

    const keyId = localStorage.getItem("key_id") ?? "";
    const ids: string[] = [];
    const names: string[] = [];

    for (const file of files) {
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append(
          "config",
          JSON.stringify({
            output_formats: Array.from(selectedFormats),
            output_folder: outputFolder,
            remove_headers_footers: removeHeaders,
            formula_display: formulaDisplay,
            table_display: tableDisplay,
            include_figures: includeFigures,
            figure_display: figureDisplay,
            include_benchmark_images: includeBenchmarkHtml,
          })
        );

        const res = await fetch("/api/jobs", {
          method: "POST",
          headers: { "x-key-id": keyId },
          body: formData,
        });

        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(
            data?.error ?? `Failed to start processing for ${file.name}.`
          );
        }

        const data = await res.json();
        ids.push(data.job_id ?? data.id);
        names.push(file.name);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to start processing."
        );
        // Continue with remaining files
      }
    }

    if (ids.length === 0) {
      setProcessing(false);
      return;
    }

    setJobIds(ids);
    setJobFileNames(names);
  }, [files, selectedFormats, includeBenchmarkHtml, outputFolder, removeHeaders, formulaDisplay, tableDisplay, includeFigures, figureDisplay]);

  const handleJobComplete = useCallback((outputFiles: string[]) => {
    setAllOutputFiles((prev) => [...prev, ...outputFiles]);
    setCompletedCount((prev) => prev + 1);
  }, []);

  const handleJobError = useCallback((msg: string) => {
    setError((prev) => (prev ? `${prev}\n${msg}` : msg));
    setCompletedCount((prev) => prev + 1);
  }, []);

  const handleReset = useCallback(() => {
    setFiles([]);
    setJobIds([]);
    setJobFileNames([]);
    setProcessing(false);
    setCompletedCount(0);
    setAllOutputFiles([]);
    setError(null);
  }, []);

  const handleBrowse = useCallback(async () => {
    try {
      const res = await fetch("/api/browse", { method: "POST" });
      const data = await res.json();
      if (data.path) {
        setOutputFolder(data.path);
        localStorage.setItem("default_output_folder", data.path);
      }
    } catch {
      // User cancelled or error
    }
  }, []);

  const handleOpenOutputFolder = useCallback(async () => {
    const folder =
      outputFolder ||
      allOutputFiles[0]?.split("/").slice(0, -1).join("/");
    if (!folder) return;
    await fetch("/api/open-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: folder }),
    });
  }, [outputFolder, allOutputFiles]);

  // Show job progress if we have jobIds and are still processing
  if (jobIds.length > 0 && processing && !allComplete) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
          Processing OCR
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {completedCount} of {jobIds.length} file{jobIds.length !== 1 ? "s" : ""} complete
        </p>
        {jobIds.map((id, i) => (
          <div key={id}>
            <p className="mb-1 text-xs font-medium text-slate-600 dark:text-slate-400">
              {jobFileNames[i]}
            </p>
            <JobProgress
              jobId={id}
              onComplete={handleJobComplete}
              onError={handleJobError}
            />
          </div>
        ))}
      </div>
    );
  }

  // Show results after all jobs complete
  if (allComplete) {
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
              {jobIds.length} file{jobIds.length !== 1 ? "s" : ""} processed successfully
            </span>
          </div>

          {allOutputFiles.length > 0 && (
            <ul className="mb-4 space-y-1">
              {allOutputFiles.map((f, i) => (
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
            <button
              onClick={handleOpenOutputFolder}
              className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
            >
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

        {error && (
          <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
        OCR Processing
      </h2>

      {/* File drop zone */}
      <FileDropZone onFilesSelected={setFiles} disabled={processing} />

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
            <button
              onClick={handleBrowse}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              Browse
            </button>
          </div>
        </div>

        {/* Output formats — grouped by category */}
        <div>
          <label className="mb-3 block text-sm text-slate-600 dark:text-slate-400">
            Output Formats
          </label>
          <div className="space-y-4">
            {FORMAT_GROUPS.map((group) => {
              const groupKeys = group.formats.map(f => f.key);
              const allSelected = groupKeys.every(k => selectedFormats.has(k));
              const noneSelected = groupKeys.every(k => !selectedFormats.has(k));

              return (
                <div
                  key={group.label}
                  className="rounded-lg border border-slate-200 bg-slate-50/50 p-3 dark:border-slate-600 dark:bg-slate-700/30"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <div>
                      <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                        {group.label}
                      </span>
                      <p className="text-xs text-slate-400 dark:text-slate-500">
                        {group.description}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedFormats(prev => {
                          const next = new Set(prev);
                          if (allSelected) {
                            groupKeys.forEach(k => next.delete(k));
                          } else {
                            groupKeys.forEach(k => next.add(k));
                          }
                          return next;
                        });
                      }}
                      className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                    >
                      {allSelected ? "Deselect all" : noneSelected ? "Select all" : "Select all"}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {group.formats.map(({ key, label, tooltip }) => (
                      <label
                        key={key}
                        className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"
                        title={tooltip}
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
              );
            })}
          </div>
          {/* ZIP bundle option */}
          <label className="mt-3 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={selectedFormats.has("zip")}
              onChange={() => toggleFormat("zip")}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600"
            />
            Bundle all outputs into a ZIP file
          </label>
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

          {/* Include decorative items */}
          <div>
            <label className="flex items-center justify-between">
              <span className="text-sm text-slate-700 dark:text-slate-300">
                Include decorative items
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={includeFigures}
                onClick={() => setIncludeFigures(!includeFigures)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                  includeFigures ? "bg-blue-600" : "bg-slate-300 dark:bg-slate-600"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform ${
                    includeFigures ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </label>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Images, diagrams, and illustrations. Sometimes actual content can be classified as decorative, so we recommend keeping this on.
            </p>
            {includeFigures && (
              <div className="mt-2">
                <select
                  value={figureDisplay}
                  onChange={(e) => setFigureDisplay(e.target.value as 'image' | 'text')}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                >
                  <option value="image">Include as image</option>
                  <option value="text">Include as text placeholder</option>
                </select>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {figureDisplay === 'image'
                    ? "Embeds the original cropped image from the document."
                    : "Shows a text placeholder where the image was detected."}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Benchmark image overlay — visible when any true-copy format is selected */}
        {(selectedFormats.has("true_copy_html") || selectedFormats.has("true_copy_docx") || selectedFormats.has("true_copy_pdf") || selectedFormats.has("true_copy_pptx")) && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-600 dark:bg-slate-700/50">
            <label className="flex items-center justify-between">
              <span className="text-sm text-slate-700 dark:text-slate-300">
                Include page images in true-copy exports
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={includeBenchmarkHtml}
                onClick={() => setIncludeBenchmarkHtml(!includeBenchmarkHtml)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                  includeBenchmarkHtml ? "bg-blue-600" : "bg-slate-300 dark:bg-slate-600"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform ${
                    includeBenchmarkHtml ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </label>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Overlays OCR text on original page images for visual verification. Useful for benchmarking accuracy. Increases file size significantly.
            </p>
          </div>
        )}

        {/* Display mode selects */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm text-slate-600 dark:text-slate-400">
              Formula Display
            </label>
            <select
              value={formulaDisplay}
              onChange={(e) => setFormulaDisplay(e.target.value as 'rendered' | 'image')}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            >
              <option value="image">Original Image (recommended)</option>
              <option value="rendered">Rendered Text</option>
            </select>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {formulaDisplay === 'image'
                ? "Shows the original formula as it appears in the document."
                : "Attempts to reconstruct formulas as rendered text. Extraction can sometimes be inaccurate for complex equations."}
            </p>
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-600 dark:text-slate-400">
              Table Display
            </label>
            <select
              value={tableDisplay}
              onChange={(e) => setTableDisplay(e.target.value as 'rendered' | 'image')}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            >
              <option value="rendered">Rendered Table</option>
              <option value="image">Original Image</option>
            </select>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {tableDisplay === 'image'
                ? "Shows the original table as it appears in the document."
                : "Reconstructs tables as editable HTML. Structure extraction may vary for complex layouts."}
            </p>
          </div>
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
        disabled={files.length === 0 || selectedFormats.size === 0}
        className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Process{files.length > 1 ? ` ${files.length} Files` : ""}
      </button>
    </div>
  );
}
