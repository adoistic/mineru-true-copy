"use client";

import { useState, useCallback, useEffect } from "react";
import FileDropZone from "@/components/common/FileDropZone";
import JobProgress from "@/components/processing/JobProgress";
import { useOpenRouterKeyStatus } from "@/components/settings/ApiKeysPanel";
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
  const [formulaEnable, setFormulaEnable] = useState(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("formula_enable") === "true"
      : false
  );
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
  const [serverCloudAvailable, setServerCloudAvailable] = useState(true);
  const [localAvailable, setLocalAvailable] = useState(true);
  const [jobIds, setJobIds] = useState<string[]>([]);

  // Cloud mode requires both: the server reports cloud capability AND user has an OpenRouter key.
  const { hasKey: hasOpenRouterKey } = useOpenRouterKeyStatus();
  const cloudAvailable = serverCloudAvailable && hasOpenRouterKey;

  // Fetch mode availability from server health endpoint
  useEffect(() => {
    async function checkModes() {
      try {
        const res = await fetch("/api/health");
        if (res.ok) {
          const data = await res.json();
          setServerCloudAvailable(data.cloud_available ?? true);
          setLocalAvailable(data.local_available ?? true);
          if (!data.local_available && processingMode === "local") {
            if (data.cloud_available) {
              setProcessingMode("cloud");
              localStorage.setItem("processing_mode", "cloud");
            }
          }
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

  // When the OpenRouter key disappears, fall back to local. When it appears
  // and local is unavailable, switch to cloud.
  useEffect(() => {
    if (!cloudAvailable && processingMode === "cloud" && localAvailable) {
      setProcessingMode("local");
      localStorage.setItem("processing_mode", "local");
    }
    if (!cloudAvailable && tableMode === "cloud") {
      setTableMode("local");
      localStorage.setItem("table_mode", "local");
    }
  }, [cloudAvailable, localAvailable, processingMode, tableMode]);

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
            formula_enable: formulaEnable,
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
      }
    }

    if (ids.length === 0) {
      setProcessing(false);
      return;
    }

    setJobIds(ids);
    setJobFileNames(names);
  }, [files, selectedFormats, includeBenchmarkHtml, outputFolder, removeHeaders, formulaEnable, formulaDisplay, tableDisplay, includeFigures, figureDisplay, processingMode, tableMode, ocrLangs]);

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
        <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          Processing OCR
        </h2>
        <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          {completedCount} of {jobIds.length} file{jobIds.length !== 1 ? "s" : ""} complete
        </p>
        {jobIds.map((id, i) => (
          <div key={id}>
            <p className="mb-1 text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
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
        <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          OCR Complete
        </h2>
        <div
          className="rounded p-5"
          style={{ background: 'var(--success-muted)', border: '1px solid rgba(16,185,129,0.2)' }}
        >
          <div className="mb-3 flex items-center gap-2">
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              style={{ color: 'var(--success)' }}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-[13px] font-medium" style={{ color: 'var(--success)' }}>
              {jobIds.length} file{jobIds.length !== 1 ? "s" : ""} processed successfully
            </span>
          </div>

          {allOutputFiles.length > 0 && (
            <ul className="mb-4 space-y-1">
              {allOutputFiles.map((f, i) => (
                <li key={i} className="text-[11px]" style={{ color: 'var(--success)' }}>
                  {f.split("/").pop()}
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleOpenOutputFolder}
              className="rounded px-3 py-1.5 text-[13px] font-semibold transition-colors"
              style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--accent)'; }}
            >
              Open Output Folder
            </button>
            <button
              onClick={handleReset}
              className="rounded px-3 py-1.5 text-[13px] transition-colors"
              style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
            >
              Process Another File
            </button>
          </div>
        </div>

        {error && (
          <p
            className="rounded p-3 text-[13px]"
            style={{ background: 'var(--error-muted)', color: 'var(--error)' }}
          >
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
        OCR Processing
      </h2>

      {/* File drop zone */}
      <FileDropZone onFilesSelected={setFiles} disabled={processing} />

      {/* Options */}
      <div
        className="space-y-4 rounded p-5"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
      >
        {/* SECTION: Output Folder */}
        <div>
          <label
            className="mb-2 block text-[11px] font-medium uppercase tracking-[0.05em]"
            style={{ color: 'var(--text-secondary)' }}
          >
            Output Folder
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={outputFolder}
              onChange={(e) => setOutputFolder(e.target.value)}
              placeholder="/path/to/output"
              className="flex-1 rounded-sm px-2 py-1.5 text-[13px] outline-none"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-primary)',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--border-focus)'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)'; }}
            />
            <button
              onClick={handleBrowse}
              className="rounded px-3 py-1.5 text-[13px] transition-colors"
              style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
            >
              Browse
            </button>
          </div>
        </div>

        {/* SECTION: Output Formats */}
        <div>
          <label
            className="mb-3 block text-[11px] font-medium uppercase tracking-[0.05em]"
            style={{ color: 'var(--text-secondary)' }}
          >
            Output Formats
          </label>
          <div className="space-y-3">
            {FORMAT_GROUPS.map((group) => {
              const groupKeys = group.formats.map(f => f.key);
              const allSelected = groupKeys.every(k => selectedFormats.has(k));
              const noneSelected = groupKeys.every(k => !selectedFormats.has(k));

              return (
                <div
                  key={group.label}
                  className="rounded p-3"
                  style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <div>
                      <span
                        className="text-[11px] font-semibold uppercase tracking-[0.05em]"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {group.label}
                      </span>
                      <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
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
                      className="text-[11px] transition-colors"
                      style={{ color: 'var(--accent-text)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--accent-text)'; }}
                    >
                      {allSelected ? "Deselect all" : noneSelected ? "Select all" : "Select all"}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {group.formats.map(({ key, label, tooltip }) => (
                      <label
                        key={key}
                        className="flex items-center gap-2 text-[13px] cursor-pointer"
                        style={{ color: 'var(--text-primary)' }}
                        title={tooltip}
                      >
                        <input
                          type="checkbox"
                          checked={selectedFormats.has(key)}
                          onChange={() => toggleFormat(key)}
                          className="h-4 w-4 rounded-sm"
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
          <label
            className="mt-3 flex items-center gap-2 text-[13px] cursor-pointer"
            style={{ color: 'var(--text-primary)' }}
          >
            <input
              type="checkbox"
              checked={selectedFormats.has("zip")}
              onChange={() => toggleFormat("zip")}
              className="h-4 w-4 rounded-sm"
            />
            Bundle all outputs into a ZIP file
          </label>
        </div>

        {/* SECTION: Processing Mode — segmented control */}
        <div style={{ borderTop: '1px solid var(--border-default)', paddingTop: '16px' }}>
          <label
            className="mb-3 block text-[11px] font-medium uppercase tracking-[0.05em]"
            style={{ color: 'var(--text-secondary)' }}
          >
            Processing Mode
          </label>

          {/* Segmented control — Cloud option only renders when an OpenRouter
              key is set AND the server reports cloud capability. */}
          <div
            className="mb-3 inline-flex rounded p-0.5"
            style={{ background: 'var(--bg-elevated)' }}
          >
            {cloudAvailable && (
              <button
                type="button"
                onClick={() => {
                  setProcessingMode("cloud");
                  localStorage.setItem("processing_mode", "cloud");
                }}
                className="rounded px-4 py-1.5 text-[13px] font-medium transition-colors"
                style={{
                  background: processingMode === "cloud" ? 'var(--accent)' : 'transparent',
                  color: processingMode === "cloud" ? 'var(--text-inverse)' : 'var(--text-secondary)',
                }}
              >
                Cloud
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (localAvailable) {
                  setProcessingMode("local");
                  localStorage.setItem("processing_mode", "local");
                }
              }}
              disabled={!localAvailable}
              className="rounded px-4 py-1.5 text-[13px] font-medium transition-colors"
              style={{
                background: processingMode === "local" ? 'var(--accent)' : 'transparent',
                color: processingMode === "local" ? 'var(--text-inverse)' : 'var(--text-secondary)',
                opacity: !localAvailable ? 0.4 : 1,
              }}
            >
              Local
            </button>
          </div>

          <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {processingMode === "cloud"
              ? "Document sent to secure cloud for processing. Best for degraded scans, handwriting."
              : "Processed on this device. No data leaves your computer."}
          </p>

          {!serverCloudAvailable && (
            <p className="mt-2 text-[11px]" style={{ color: 'var(--warning)' }}>
              Cloud processing is unavailable. Check your internet connection.
            </p>
          )}
          {serverCloudAvailable && !hasOpenRouterKey && (
            <p className="mt-2 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              Add an OpenRouter API key in Settings to enable cloud processing.
            </p>
          )}
          {!localAvailable && (
            <p className="mt-2 text-[11px]" style={{ color: 'var(--warning)' }}>
              Local processing is not available on this installation.
            </p>
          )}

          {/* Table Extraction sub-section (only when Local Processing selected) */}
          {processingMode === "local" && (
            <div
              className="mt-3 rounded p-3"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
            >
              <label
                className="mb-2 block text-[11px] font-medium uppercase tracking-[0.05em]"
                style={{ color: 'var(--text-secondary)' }}
              >
                Table Extraction
              </label>

              <div
                className="mb-2 inline-flex rounded p-0.5"
                style={{ background: 'var(--bg-elevated)' }}
              >
                {cloudAvailable && (
                  <button
                    type="button"
                    onClick={() => {
                      setTableMode("cloud");
                      localStorage.setItem("table_mode", "cloud");
                    }}
                    className="rounded px-3 py-1 text-[11px] font-medium transition-colors"
                    style={{
                      background: tableMode === "cloud" ? 'var(--accent)' : 'transparent',
                      color: tableMode === "cloud" ? 'var(--text-inverse)' : 'var(--text-secondary)',
                    }}
                  >
                    Cloud
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setTableMode("local");
                    localStorage.setItem("table_mode", "local");
                  }}
                  className="rounded px-3 py-1 text-[11px] font-medium transition-colors"
                  style={{
                    background: tableMode === "local" ? 'var(--accent)' : 'transparent',
                    color: tableMode === "local" ? 'var(--text-inverse)' : 'var(--text-secondary)',
                  }}
                >
                  Local
                </button>
              </div>

              <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                {tableMode === "cloud"
                  ? "Tables sent to cloud for higher accuracy."
                  : "Tables processed locally."}
              </p>
            </div>
          )}
        </div>

        {/* SECTION: Document Script / Language — only relevant for local processing */}
        {processingMode === "local" && (
        <div style={{ borderTop: '1px solid var(--border-default)', paddingTop: '16px' }}>
          <label
            className="mb-2 block text-[11px] font-medium uppercase tracking-[0.05em]"
            style={{ color: 'var(--text-secondary)' }}
          >
            Document Script
          </label>

          {/* Auto-detect toggle */}
          <label
            className="mb-2 flex items-center gap-2 text-[13px] cursor-pointer"
            style={{ color: 'var(--text-primary)' }}
          >
            <input
              type="checkbox"
              checked={ocrLangs.includes("auto")}
              onChange={(e) => {
                const next = e.target.checked ? ["auto"] : ["en"];
                setOcrLangs(next);
                localStorage.setItem("ocr_langs", JSON.stringify(next));
              }}
              className="h-4 w-4 rounded-sm"
            />
            Auto-detect
          </label>
          {ocrLangs.includes("auto") && (
            <p className="mb-2 text-[11px]" style={{ color: 'var(--warning)' }}>
              Auto-detect works best for Chinese, English, Japanese, Korean, Arabic, and Russian.
              For Hindi, Tamil, Telugu, Thai, or other scripts, turn off auto-detect and select manually for best results.
            </p>
          )}

          {/* Manual script selection */}
          {!ocrLangs.includes("auto") && (
            <div className="space-y-1">
              <p className="mb-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                Select the primary script in your document. Every model includes English automatically.
              </p>
              <div className="flex flex-wrap gap-2">
                {[
                  { value: "en", label: "English Only" },
                  { value: "ch", label: "Chinese Simplified + English" },
                  { value: "chinese_cht", label: "Chinese Traditional + English" },
                  { value: "devanagari", label: "Hindi / Devanagari + English" },
                  { value: "arabic", label: "Arabic / Urdu + English" },
                  { value: "latin", label: "Latin (French, Spanish...) + English" },
                  { value: "korean", label: "Korean + English" },
                  { value: "japan", label: "Japanese + English" },
                  { value: "thai", label: "Thai + English" },
                  { value: "ta", label: "Tamil + English" },
                  { value: "te", label: "Telugu + English" },
                  { value: "cyrillic", label: "Cyrillic (Russian...) + English" },
                  { value: "greek", label: "Greek + English" },
                  { value: "eslav", label: "East Slavic + English" },
                  { value: "ka", label: "Georgian + English" },
                ].map(({ value, label }) => {
                  const selected = ocrLangs.includes(value);
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => {
                        setOcrLangs([value]);
                        localStorage.setItem("ocr_langs", JSON.stringify([value]));
                      }}
                      className="rounded-full px-3 py-1 text-[11px] font-medium transition-colors"
                      style={{
                        background: selected ? 'var(--accent)' : 'var(--bg-elevated)',
                        color: selected ? 'var(--text-inverse)' : 'var(--text-secondary)',
                      }}
                      onMouseEnter={(e) => {
                        if (!selected) e.currentTarget.style.background = '#333';
                      }}
                      onMouseLeave={(e) => {
                        if (!selected) e.currentTarget.style.background = 'var(--bg-elevated)';
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {ocrLangs.includes("auto")
              ? "Auto-detect supports: Chinese, English, Japanese, Korean, Arabic, Russian."
              : `Local processing will use the ${ocrLangs[0]} model (includes English).`}
          </p>
        </div>
        )}

        {/* SECTION: Toggles */}
        <div className="space-y-3" style={{ borderTop: '1px solid var(--border-default)', paddingTop: '16px' }}>
          <label
            className="mb-2 block text-[11px] font-medium uppercase tracking-[0.05em]"
            style={{ color: 'var(--text-secondary)' }}
          >
            Processing Options
          </label>

          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
              Remove Headers/Footers
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={removeHeaders}
              onClick={() => setRemoveHeaders(!removeHeaders)}
              className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors"
              style={{ background: removeHeaders ? 'var(--accent)' : 'var(--bg-elevated)' }}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow ring-0 transition-transform ${
                  removeHeaders ? "translate-x-4" : "translate-x-0.5"
                }`}
                style={{ marginTop: '2px' }}
              />
            </button>
          </label>

          {/* Include decorative items */}
          <div>
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
                Include decorative items
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={includeFigures}
                onClick={() => setIncludeFigures(!includeFigures)}
                className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors"
                style={{ background: includeFigures ? 'var(--accent)' : 'var(--bg-elevated)' }}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow ring-0 transition-transform ${
                    includeFigures ? "translate-x-4" : "translate-x-0.5"
                  }`}
                  style={{ marginTop: '2px' }}
                />
              </button>
            </label>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              Images, diagrams, and illustrations. Sometimes actual content can be classified as decorative.
            </p>
            {includeFigures && (
              <div className="mt-2">
                <select
                  value={figureDisplay}
                  onChange={(e) => setFigureDisplay(e.target.value as 'image' | 'text')}
                  className="w-full rounded-sm px-2 py-1.5 text-[13px] outline-none"
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <option value="image">Include as image</option>
                  <option value="text">Include as text placeholder</option>
                </select>
              </div>
            )}
          </div>
        </div>

        {/* Benchmark image overlay — visible when any true-copy format is selected */}
        {(selectedFormats.has("true_copy_html") || selectedFormats.has("true_copy_docx") || selectedFormats.has("true_copy_pdf") || selectedFormats.has("true_copy_pptx")) && (
          <div
            className="rounded p-3"
            style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
          >
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
                Include page images in true-copy exports
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={includeBenchmarkHtml}
                onClick={() => setIncludeBenchmarkHtml(!includeBenchmarkHtml)}
                className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors"
                style={{ background: includeBenchmarkHtml ? 'var(--accent)' : 'var(--bg-elevated)' }}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow ring-0 transition-transform ${
                    includeBenchmarkHtml ? "translate-x-4" : "translate-x-0.5"
                  }`}
                  style={{ marginTop: '2px' }}
                />
              </button>
            </label>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              Overlays OCR text on original page images for visual verification. Increases file size significantly.
            </p>
          </div>
        )}

        {/* Display mode selects */}
        <div className="grid grid-cols-2 gap-4" style={{ borderTop: '1px solid var(--border-default)', paddingTop: '16px' }}>
          <div>
            <label className="mb-1 flex items-center justify-between text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              <span>Detect Formulas</span>
              <button
                type="button"
                role="switch"
                aria-checked={formulaEnable}
                onClick={() => {
                  const next = !formulaEnable;
                  setFormulaEnable(next);
                  localStorage.setItem("formula_enable", String(next));
                }}
                className="relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors"
                style={{ background: formulaEnable ? 'var(--accent)' : 'var(--bg-elevated)' }}
              >
                <span
                  className={`pointer-events-none inline-block h-3 w-3 rounded-full bg-white shadow ring-0 transition-transform ${
                    formulaEnable ? "translate-x-3" : "translate-x-0.5"
                  }`}
                  style={{ marginTop: '2px' }}
                />
              </button>
            </label>
            {formulaEnable ? (
              <>
                <select
                  value={formulaDisplay}
                  onChange={(e) => setFormulaDisplay(e.target.value as 'rendered' | 'image')}
                  className="mt-1 w-full rounded-sm px-2 py-1.5 text-[13px] outline-none"
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <option value="image">Original Image (recommended)</option>
                  <option value="rendered">Rendered Text</option>
                </select>
                <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                  {formulaDisplay === 'image'
                    ? "Shows the original formula as it appears in the document."
                    : "Attempts to reconstruct formulas as rendered text."}
                </p>
              </>
            ) : (
              <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                Off. Turn on if your document contains math equations.
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              Table Display
            </label>
            <select
              value={tableDisplay}
              onChange={(e) => setTableDisplay(e.target.value as 'rendered' | 'image')}
              className="w-full rounded-sm px-2 py-1.5 text-[13px] outline-none"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-primary)',
              }}
            >
              <option value="rendered">Rendered Table</option>
              <option value="image">Original Image</option>
            </select>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              {tableDisplay === 'image'
                ? "Shows the original table as it appears in the document."
                : "Reconstructs tables as editable HTML."}
            </p>
          </div>
        </div>
      </div>

      {error && (
        <p
          className="rounded p-3 text-[13px]"
          style={{ background: 'var(--error-muted)', color: 'var(--error)' }}
        >
          {error}
        </p>
      )}

      {/* Process button */}
      <button
        onClick={handleProcess}
        disabled={files.length === 0 || selectedFormats.size === 0}
        className="w-full rounded py-2 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        style={{
          background: 'var(--accent)',
          color: 'var(--text-inverse)',
        }}
        onMouseEnter={(e) => {
          if (!e.currentTarget.disabled) e.currentTarget.style.background = 'var(--accent-hover)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'var(--accent)';
        }}
      >
        Process{files.length > 1 ? ` ${files.length} Files` : ""}
      </button>
    </div>
  );
}
