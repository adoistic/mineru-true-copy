"use client";

import { useState, useCallback, useEffect } from "react";
import FileDropZone from "@/components/common/FileDropZone";
import JobProgress from "@/components/processing/JobProgress";
import type { ExportFormat, ProcessingMode } from "@/types";

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
  const [processingMode, setProcessingMode] = useState<ProcessingMode>(() =>
    (typeof window !== "undefined"
      ? (localStorage.getItem("processing_mode") as ProcessingMode)
      : null) ?? "cloud"
  );
  const [tableMode, setTableMode] = useState<ProcessingMode>(() =>
    (typeof window !== "undefined"
      ? (localStorage.getItem("table_mode") as ProcessingMode)
      : null) ?? "cloud"
  );
  const [ocrLangs, setOcrLangs] = useState<string[]>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("ocr_langs");
      if (stored) try { return JSON.parse(stored); } catch {}
    }
    return ["auto"];
  });
  const [cloudAvailable, setCloudAvailable] = useState(true);
  const [localAvailable, setLocalAvailable] = useState(true);
  const [jobIds, setJobIds] = useState<string[]>([]);

  // Fetch mode availability from server health endpoint
  useEffect(() => {
    async function checkModes() {
      try {
        const res = await fetch("/api/health");
        if (res.ok) {
          const data = await res.json();
          setCloudAvailable(data.cloud_available ?? true);
          setLocalAvailable(data.local_available ?? true);
          // Auto-switch to cloud if local isn't available
          if (!data.local_available && processingMode === "local") {
            if (data.cloud_available) {
              setProcessingMode("cloud");
              localStorage.setItem("processing_mode", "cloud");
            }
          }
          // Auto-switch to local tables if cloud isn't available
          if (!data.cloud_available && tableMode === "cloud") {
            setTableMode("local");
            localStorage.setItem("table_mode", "local");
          }
        }
      } catch {
        // Server not reachable — keep defaults
      }
    }
    checkModes();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
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
            processing_mode: processingMode,
            table_mode: processingMode === 'cloud' ? 'cloud' : tableMode,
            ocr_lang: ocrLangs.join(','),
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
  }, [files, selectedFormats, includeBenchmarkHtml, outputFolder, removeHeaders, formulaDisplay, tableDisplay, includeFigures, figureDisplay, processingMode, tableMode, ocrLangs]);

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

        {/* Processing Mode */}
        <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4 dark:border-slate-600 dark:bg-slate-700/30">
          <h4 className="mb-3 text-sm font-medium text-slate-900 dark:text-white">
            Processing Mode
          </h4>

          {/* Local Processing */}
          <label className={`mb-3 flex cursor-pointer items-start gap-3 ${!localAvailable ? "opacity-50" : ""}`}>
            <input
              type="radio"
              name="processing_mode"
              value="local"
              checked={processingMode === "local"}
              disabled={!localAvailable}
              onChange={() => {
                setProcessingMode("local");
                localStorage.setItem("processing_mode", "local");
              }}
              className="mt-1 h-4 w-4 border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600"
            />
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-900 dark:text-white">
                  Local Processing
                </span>
                {processingMode === "local" && (
                  <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                    default
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Your document is processed entirely on this device.
                No data leaves your computer. Faster for most documents.
              </p>
              <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                Best for: clean prints, typed documents, standard layouts. 0.25 credits per page.
              </p>
            </div>
          </label>

          {/* Cloud Processing */}
          <label className={`flex cursor-pointer items-start gap-3 ${!cloudAvailable ? "opacity-50" : ""}`}>
            <input
              type="radio"
              name="processing_mode"
              value="cloud"
              checked={processingMode === "cloud"}
              disabled={!cloudAvailable}
              onChange={() => {
                setProcessingMode("cloud");
                localStorage.setItem("processing_mode", "cloud");
              }}
              className="mt-1 h-4 w-4 border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600"
            />
            <div className="flex-1">
              <span className="text-sm font-medium text-slate-900 dark:text-white">
                Cloud Processing
              </span>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Your document is sent to a secure cloud service for processing,
                then results are returned to your device. More accurate on degraded
                scans, handwriting, and complex layouts. Requires internet connection.
              </p>
              <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                Best for: old/faded scans, handwritten notes, unusual fonts. 1 credit per page.
              </p>
            </div>
          </label>

          {!cloudAvailable && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              Cloud processing is unavailable. Check your internet connection.
            </p>
          )}
          {!localAvailable && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              Local processing is not available on this installation. Using cloud processing.
            </p>
          )}

          {/* Table Extraction sub-section (only when Local Processing selected) */}
          {processingMode === "local" && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-600 dark:bg-slate-800">
              <h5 className="mb-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                Table Extraction
              </h5>

              <label className={`mb-2 flex cursor-pointer items-start gap-3 ${!cloudAvailable ? "opacity-50" : ""}`}>
                <input
                  type="radio"
                  name="table_mode"
                  value="cloud"
                  checked={tableMode === "cloud"}
                  disabled={!cloudAvailable}
                  onChange={() => {
                    setTableMode("cloud");
                    localStorage.setItem("table_mode", "cloud");
                  }}
                  className="mt-0.5 h-4 w-4 border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-slate-900 dark:text-white">
                      Cloud Tables
                    </span>
                    <span className="text-xs text-slate-400 dark:text-slate-500">recommended</span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    Tables are sent to the cloud for higher accuracy. Complex tables
                    with merged cells, nested headers, and irregular layouts are handled better.
                    +0.5 credits per page that contains a table.
                  </p>
                </div>
              </label>

              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name="table_mode"
                  value="local"
                  checked={tableMode === "local"}
                  onChange={() => {
                    setTableMode("local");
                    localStorage.setItem("table_mode", "local");
                  }}
                  className="mt-0.5 h-4 w-4 border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600"
                />
                <div className="flex-1">
                  <span className="text-xs font-medium text-slate-900 dark:text-white">
                    Local Tables
                  </span>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    Tables are processed locally. No additional credits. Works well for
                    simple, regular tables. May struggle with complex merges or unusual
                    structures. Choose this for fully offline processing.
                  </p>
                </div>
              </label>

              {!cloudAvailable && tableMode === "cloud" && (
                <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                  Cloud tables unavailable. Switching to local tables.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Document Script / Language */}
        <div>
          <label className="mb-2 block text-sm text-slate-600 dark:text-slate-400">
            Document Script
          </label>

          {/* Auto-detect toggle */}
          <label className="mb-2 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={ocrLangs.includes("auto")}
              onChange={(e) => {
                const next = e.target.checked ? ["auto"] : ["en"];
                setOcrLangs(next);
                localStorage.setItem("ocr_langs", JSON.stringify(next));
              }}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600"
            />
            Auto-detect
            {processingMode === "cloud" && (
              <span className="text-xs text-slate-400 dark:text-slate-500">(recommended)</span>
            )}
          </label>
          {ocrLangs.includes("auto") && processingMode === "local" && (
            <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
              Local auto-detect works best for Chinese, English, Japanese, Korean, Arabic, and Russian.
              For Hindi, Tamil, Telugu, Thai, or other scripts, turn off auto-detect and select manually for best results.
            </p>
          )}

          {/* Manual script selection (shown when auto-detect is off) */}
          {!ocrLangs.includes("auto") && (
            <div className="space-y-1">
              <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">
                Select all scripts present in your document. English is included automatically with most scripts.
              </p>
              <div className="flex flex-wrap gap-2">
                {[
                  { value: "en", label: "English" },
                  { value: "ch", label: "Chinese (Simplified)" },
                  { value: "chinese_cht", label: "Chinese (Traditional)" },
                  { value: "devanagari", label: "Hindi / Devanagari" },
                  { value: "arabic", label: "Arabic / Urdu" },
                  { value: "latin", label: "Latin (French, Spanish...)" },
                  { value: "korean", label: "Korean" },
                  { value: "japan", label: "Japanese" },
                  { value: "thai", label: "Thai" },
                  { value: "ta", label: "Tamil" },
                  { value: "te", label: "Telugu" },
                  { value: "cyrillic", label: "Cyrillic (Russian...)" },
                  { value: "greek", label: "Greek" },
                  { value: "eslav", label: "East Slavic" },
                  { value: "ka", label: "Georgian" },
                ].map(({ value, label }) => {
                  const selected = ocrLangs.includes(value);
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => {
                        const next = selected
                          ? ocrLangs.filter((l) => l !== value)
                          : [...ocrLangs, value];
                        const final = next.length === 0 ? ["en"] : next;
                        setOcrLangs(final);
                        localStorage.setItem("ocr_langs", JSON.stringify(final));
                      }}
                      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                        selected
                          ? "bg-blue-600 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {ocrLangs.includes("auto")
              ? processingMode === "cloud"
                ? "Cloud processing auto-detects all scripts in the document."
                : "Auto-detect supports: Chinese, English, Japanese, Korean, Arabic, Russian."
              : processingMode === "cloud"
                ? "Cloud processing handles any script. Your selection is used as a hint."
                : `Local processing will use models for: ${ocrLangs.join(", ")}.`}
          </p>
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
