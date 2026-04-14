"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { ModelVariant, TranslationViewMode, ConfidenceLevel, Language, LanguageGroup, ExportFormat } from "@/types";

// ---------------------------------------------------------------------------
// Export formats — mirrors OcrTool FORMAT_GROUPS minus `searchable_pdf`.
// Searchable PDF overlays OCR text on the ORIGINAL PDF pages; it can't render
// translated Devanagari on English glyph boxes, so we exclude it for translation.
// ---------------------------------------------------------------------------

const TRANSLATION_FORMAT_GROUPS: {
  label: string;
  description: string;
  formats: { key: ExportFormat; label: string; tooltip?: string }[];
}[] = [
  {
    label: "True Copy",
    description: "Pixel-perfect layout preserving original positioning",
    formats: [
      { key: "true_copy_html", label: "HTML", tooltip: "Self-contained HTML with translated text at original bboxes" },
      { key: "true_copy_docx", label: "Word (.docx)", tooltip: "Word document preserving original layout with translated text" },
      { key: "true_copy_pdf", label: "PDF", tooltip: "PDF with translated text positioned at original bboxes" },
      { key: "true_copy_pptx", label: "PowerPoint (.pptx)", tooltip: "Slide-per-page with translated text boxes" },
    ],
  },
  {
    label: "Reflowed",
    description: "Semantic, editable output",
    formats: [
      { key: "reflowed_docx", label: "Word (.docx)", tooltip: "Editable Word document with translated paragraphs" },
      { key: "reflowed_pdf", label: "PDF", tooltip: "Readable PDF of translated text with paragraph flow" },
      { key: "markdown", label: "Markdown", tooltip: "Plain text with Markdown formatting" },
      { key: "epub", label: "EPUB", tooltip: "E-book format for readers" },
    ],
  },
  {
    label: "Data",
    description: "Structured output for downstream processing",
    formats: [
      { key: "json", label: "JSON", tooltip: "Translated JSON with regions, bboxes, and metadata" },
    ],
  },
];

const DEFAULT_TRANSLATION_FORMATS: ExportFormat[] = TRANSLATION_FORMAT_GROUPS.flatMap((g) =>
  g.formats.map((f) => f.key),
);

// ---------------------------------------------------------------------------
// Language data — grouped by script family
// ---------------------------------------------------------------------------

const LANGUAGE_GROUPS: LanguageGroup[] = [
  {
    name: "Devanagari",
    languages: [
      { code: "hin_Deva", label: "Hindi", script: "Devanagari" },
      { code: "mar_Deva", label: "Marathi", script: "Devanagari" },
      { code: "san_Deva", label: "Sanskrit", script: "Devanagari" },
      { code: "npi_Deva", label: "Nepali", script: "Devanagari" },
      { code: "kok_Deva", label: "Konkani", script: "Devanagari" },
      { code: "brx_Deva", label: "Bodo", script: "Devanagari" },
      { code: "doi_Deva", label: "Dogri", script: "Devanagari" },
      { code: "mai_Deva", label: "Maithili", script: "Devanagari" },
    ],
  },
  {
    name: "Dravidian",
    languages: [
      { code: "tam_Taml", label: "Tamil", script: "Tamil" },
      { code: "tel_Telu", label: "Telugu", script: "Telugu" },
      { code: "kan_Knda", label: "Kannada", script: "Kannada" },
      { code: "mal_Mlym", label: "Malayalam", script: "Malayalam" },
    ],
  },
  {
    name: "Eastern",
    languages: [
      { code: "ben_Beng", label: "Bengali", script: "Bengali" },
      { code: "asm_Beng", label: "Assamese", script: "Bengali" },
      { code: "ory_Orya", label: "Odia", script: "Odia" },
      { code: "mni_Mtei", label: "Manipuri", script: "Meitei" },
      { code: "sat_Olck", label: "Santali", script: "Ol Chiki" },
    ],
  },
  {
    name: "Other",
    languages: [
      { code: "guj_Gujr", label: "Gujarati", script: "Gujarati" },
      { code: "pan_Guru", label: "Punjabi", script: "Gurmukhi" },
      { code: "kas_Deva", label: "Kashmiri", script: "Devanagari" },
      { code: "snd_Deva", label: "Sindhi", script: "Devanagari" },
      { code: "urd_Arab", label: "Urdu", script: "Arabic", disabled: true, disabledReason: "RTL coming soon" },
    ],
  },
];

const SOURCE_LANGUAGES: Language[] = [
  { code: "eng_Latn", label: "English", script: "Latin" },
  ...LANGUAGE_GROUPS.flatMap((g) => g.languages).filter((l) => !l.disabled),
];

// All target language codes for quick lookup
const ALL_LANG_CODES = LANGUAGE_GROUPS.flatMap((g) => g.languages.map((l) => l.code));

// Map code → label
const LANG_LABELS: Record<string, string> = Object.fromEntries([
  ["eng_Latn", "English"],
  ...LANGUAGE_GROUPS.flatMap((g) => g.languages.map((l) => [l.code, l.label])),
]);

// ---------------------------------------------------------------------------
// TranslationTool component
// ---------------------------------------------------------------------------

export default function TranslationTool() {
  // --- File state ---
  const [jsonFile, setJsonFile] = useState<File | null>(null);
  const [jsonData, setJsonData] = useState<Record<string, unknown> | null>(null);
  const [pageCount, setPageCount] = useState<number>(0);
  const [fileName, setFileName] = useState<string>("");
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // --- Translation config ---
  const [srcLang, setSrcLang] = useState("eng_Latn");
  const [selectedLangs, setSelectedLangs] = useState<Set<string>>(new Set());
  const [modelVariant, setModelVariant] = useState<ModelVariant>("200M");
  const [selectedFormats, setSelectedFormats] = useState<Set<ExportFormat>>(
    () => new Set(DEFAULT_TRANSLATION_FORMATS),
  );
  const toggleFormat = useCallback((fmt: ExportFormat) => {
    setSelectedFormats((prev) => {
      const next = new Set(prev);
      if (next.has(fmt)) next.delete(fmt);
      else next.add(fmt);
      return next;
    });
  }, []);
  const [outputFolder, setOutputFolder] = useState(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("default_output_folder") ?? ""
      : ""
  );

  // --- Credits ---
  const [creditBalance, setCreditBalance] = useState(0);

  // --- Processing state ---
  const [processing, setProcessing] = useState(false);
  const [progressMessage, setProgressMessage] = useState("");
  const [progressCurrent, setProgressCurrent] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // --- Results ---
  const [completed, setCompleted] = useState(false);
  const [outputFiles, setOutputFiles] = useState<string[]>([]);
  const [translatedResults, setTranslatedResults] = useState<
    Array<{ lang: string; data: Record<string, unknown> }>
  >([]);

  // --- Preview ---
  const [viewMode, setViewMode] = useState<TranslationViewMode>("side-by-side");
  const [previewLang, setPreviewLang] = useState<string>("");

  // --- Server status ---
  const [serverAvailable, setServerAvailable] = useState<boolean | null>(null);
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [loadedVariant, setLoadedVariant] = useState<string | null>(null);

  // Check translation server health + model status
  useEffect(() => {
    async function checkServer() {
      try {
        const res = await fetch("/api/translation/health");
        setServerAvailable(res.ok);
      } catch {
        setServerAvailable(false);
      }
    }

    async function checkModels() {
      try {
        const res = await fetch("/api/translation/models");
        if (!res.ok) {
          setModelReady(false);
          setLoadedVariant(null);
          return;
        }
        const data = await res.json();
        if (data.loaded?.variant) {
          setModelReady(true);
          setLoadedVariant(data.loaded.variant);
        } else {
          setModelReady(false);
          setLoadedVariant(null);
        }
      } catch {
        setModelReady(false);
        setLoadedVariant(null);
      }
    }

    checkServer();
    checkModels();
    const interval = setInterval(() => {
      checkServer();
      checkModels();
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // Track which variant is currently loaded in the server (informational
  // only). DO NOT trigger a model reload on variant switch — the server
  // handles the swap transparently when Translate is pressed, and preloading
  // on every click wastes ~15s per click when users just want to read the
  // High Accuracy warning. As long as SOME variant is loaded, translation
  // is available; the server reloads if the requested variant differs.
  useEffect(() => {
    let cancelled = false;

    async function checkLoadedVariant() {
      try {
        const res = await fetch("/api/translation/models");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;

        const loadedVar: string | null = data.loaded?.variant ?? null;
        setLoadedVariant(loadedVar);
        // Ready if any variant is loaded. The server reloads the requested
        // variant on-demand inside _handle_translate when Translate fires.
        setModelReady(loadedVar !== null);
      } catch {
        if (!cancelled) setModelReady(false);
      }
    }

    checkLoadedVariant();
    return () => {
      cancelled = true;
    };
  }, [modelVariant]);

  // Fetch credit balance
  useEffect(() => {
    async function fetchCredits() {
      const keyId = typeof window !== "undefined" ? localStorage.getItem("key_id") : null;
      if (!keyId) return;
      try {
        const res = await fetch(`/api/credits?key_id=${keyId}`);
        if (res.ok) {
          const data = await res.json();
          setCreditBalance(data.balance?.balance ?? 0);
        }
      } catch {}
    }
    fetchCredits();
  }, []);

  // --- File handling ---
  const processFile = useCallback(async (file: File) => {
    setFileError(null);
    setJsonData(null);
    setJsonFile(null);
    setPageCount(0);
    setFileName("");

    if (!file.name.toLowerCase().endsWith(".json")) {
      setFileError("Only JSON files are accepted. Use the OCR tool first to process PDFs.");
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      // Detect page count from OCR JSON structure
      let pages = 0;
      if (parsed.pages && Array.isArray(parsed.pages)) {
        pages = parsed.pages.length;
      } else if (parsed.pdf_info && Array.isArray(parsed.pdf_info)) {
        pages = parsed.pdf_info.length;
      } else if (parsed.metadata?.total_pages) {
        pages = parsed.metadata.total_pages;
      } else {
        pages = 1;
      }

      setJsonFile(file);
      setJsonData(parsed);
      setPageCount(pages);
      setFileName(file.name);
    } catch {
      setFileError("Invalid JSON file. Please provide a valid OCR output JSON.");
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        processFile(e.dataTransfer.files[0]);
      }
    },
    [processFile]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        processFile(e.target.files[0]);
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [processFile]
  );

  // --- Language selection ---
  const toggleLang = useCallback((code: string) => {
    setSelectedLangs((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }, []);

  // --- Credit estimate ---
  const creditEstimate = useMemo(() => {
    if (pageCount === 0 || selectedLangs.size === 0) return null;
    return pageCount * selectedLangs.size * 2; // 2 credits/page/language
  }, [pageCount, selectedLangs.size]);

  const insufficientCredits = creditEstimate !== null && creditEstimate > creditBalance;

  // --- Selected language labels for button ---
  const selectedLangLabels = useMemo(() => {
    return Array.from(selectedLangs)
      .map((code) => LANG_LABELS[code] || code)
      .join(", ");
  }, [selectedLangs]);

  // --- Translate ---
  const handleTranslate = useCallback(async () => {
    if (!jsonData || selectedLangs.size === 0) return;

    setProcessing(true);
    setError(null);
    setCompleted(false);
    setOutputFiles([]);
    setTranslatedResults([]);

    const langs = Array.from(selectedLangs);
    setProgressTotal(langs.length);
    setProgressCurrent(0);

    const results: Array<{ lang: string; data: Record<string, unknown> }> = [];
    const files: string[] = [];

    for (let i = 0; i < langs.length; i++) {
      const tgtLang = langs[i];
      setProgressCurrent(i);
      setProgressMessage(`Translating to ${LANG_LABELS[tgtLang] || tgtLang} (${i + 1}/${langs.length})`);

      try {
        const res = await fetch("/api/translation/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            json_data: jsonData,
            src_lang: srcLang,
            tgt_lang: tgtLang,
            model_variant: modelVariant,
            output_folder: outputFolder,
            file_name: fileName,
            output_formats: Array.from(selectedFormats),
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error ?? `Translation failed for ${LANG_LABELS[tgtLang]}`);
        }

        const data = await res.json();
        results.push({ lang: tgtLang, data: data.translated_json });
        if (Array.isArray(data.output_files) && data.output_files.length) {
          files.push(...data.output_files);
        } else if (data.output_file) {
          files.push(data.output_file);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Translation failed.");
        break;
      }
    }

    setProgressCurrent(langs.length);
    setTranslatedResults(results);
    setOutputFiles(files);
    setCompleted(true);
    setProcessing(false);
    if (results.length > 0 && !previewLang) {
      setPreviewLang(results[0].lang);
    }
  }, [jsonData, selectedLangs, srcLang, modelVariant, outputFolder, fileName, previewLang, selectedFormats]);

  // --- Folder browse ---
  const handleBrowse = useCallback(async () => {
    try {
      const res = await fetch("/api/browse", { method: "POST" });
      const data = await res.json();
      if (data.path) {
        setOutputFolder(data.path);
        localStorage.setItem("default_output_folder", data.path);
      }
    } catch {}
  }, []);

  const handleOpenOutputFolder = useCallback(async () => {
    if (!outputFolder) return;
    await fetch("/api/open-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: outputFolder }),
    });
  }, [outputFolder]);

  // --- Reset ---
  const handleReset = useCallback(() => {
    setJsonFile(null);
    setJsonData(null);
    setPageCount(0);
    setFileName("");
    setFileError(null);
    setProcessing(false);
    setProgressMessage("");
    setProgressCurrent(0);
    setProgressTotal(0);
    setError(null);
    setCompleted(false);
    setOutputFiles([]);
    setTranslatedResults([]);
  }, []);

  // ---------------------------------------------------------------------------
  // RENDER: Processing state
  // ---------------------------------------------------------------------------
  if (processing) {
    const pct = progressTotal > 0 ? (progressCurrent / progressTotal) * 100 : 0;
    return (
      <div className="space-y-4">
        <h2 className="text-[16px] font-semibold" style={{ color: "var(--text-primary)" }}>
          Translating
        </h2>
        <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
          {progressMessage}
        </p>
        {/* Progress bar */}
        <div
          className="h-1.5 w-full overflow-hidden rounded-full"
          style={{ background: "var(--bg-elevated)" }}
        >
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, background: "var(--accent)" }}
          />
        </div>
        <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
          {progressCurrent} of {progressTotal} language{progressTotal !== 1 ? "s" : ""} complete
        </p>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // RENDER: Completed state
  // ---------------------------------------------------------------------------
  if (completed) {
    const allFailed = translatedResults.length === 0;
    const partialFailure = !allFailed && error !== null;

    return (
      <div className="space-y-4">
        <h2 className="text-[16px] font-semibold" style={{ color: "var(--text-primary)" }}>
          {allFailed ? "Translation Failed" : partialFailure ? "Translation Partially Complete" : "Translation Complete"}
        </h2>

        {allFailed ? (
          <div
            className="rounded p-5"
            style={{ background: "var(--error-muted)", border: "1px solid rgba(244,63,94,0.2)" }}
          >
            <div className="mb-3 flex items-center gap-2">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: "var(--error)" }}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M4.93 4.93l14.14 14.14M12 3a9 9 0 100 18 9 9 0 000-18z" />
              </svg>
              <span className="text-[13px] font-medium" style={{ color: "var(--error)" }}>
                {error || "Translation failed for all selected languages."}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleReset}
                className="rounded px-3 py-1.5 text-[13px] font-semibold transition-colors"
                style={{ background: "var(--accent)", color: "var(--text-inverse)" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--accent-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "var(--accent)"; }}
              >
                Try Again
              </button>
            </div>
          </div>
        ) : (
        <div
          className="rounded p-5"
          style={{ background: partialFailure ? "var(--warning-muted)" : "var(--success-muted)", border: partialFailure ? "1px solid rgba(245,158,11,0.2)" : "1px solid rgba(16,185,129,0.2)" }}
        >
          <div className="mb-3 flex items-center gap-2">
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              style={{ color: partialFailure ? "var(--warning)" : "var(--success)" }}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-[13px] font-medium" style={{ color: partialFailure ? "var(--warning)" : "var(--success)" }}>
              Translated to {translatedResults.length} language{translatedResults.length !== 1 ? "s" : ""} successfully
              {partialFailure && ` (${progressTotal - translatedResults.length} failed)`}
            </span>
          </div>

          {outputFiles.length > 0 && (
            <ul className="mb-4 space-y-1">
              {outputFiles.map((f, i) => (
                <li key={i} className="text-[11px]" style={{ color: "var(--success)" }}>
                  {f.split("/").pop()}
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleOpenOutputFolder}
              className="rounded px-3 py-1.5 text-[13px] font-semibold transition-colors"
              style={{ background: "var(--accent)", color: "var(--text-inverse)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--accent-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "var(--accent)"; }}
            >
              Open Output Folder
            </button>
            <button
              onClick={handleReset}
              className="rounded px-3 py-1.5 text-[13px] transition-colors"
              style={{ background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border-default)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-elevated)"; e.currentTarget.style.color = "var(--text-primary)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-secondary)"; }}
            >
              Translate Another File
            </button>
          </div>
        </div>
        )}

        {/* Preview section */}
        {translatedResults.length > 0 && (
          <div className="space-y-3">
            {/* View toggle */}
            <div className="flex items-center gap-2">
              <label
                className="text-[11px] font-medium uppercase tracking-[0.05em]"
                style={{ color: "var(--text-secondary)" }}
              >
                Preview
              </label>
              <div
                className="inline-flex rounded p-0.5"
                style={{ background: "var(--bg-elevated)" }}
              >
                {(["side-by-side", "translated-only", "diff"] as TranslationViewMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setViewMode(mode)}
                    className="rounded px-3 py-1 text-[11px] font-medium transition-colors"
                    style={{
                      background: viewMode === mode ? "var(--accent)" : "transparent",
                      color: viewMode === mode ? "var(--text-inverse)" : "var(--text-secondary)",
                    }}
                  >
                    {mode === "side-by-side" ? "Side by Side" : mode === "translated-only" ? "Translated Only" : "Diff"}
                  </button>
                ))}
              </div>
            </div>

            {/* Language selector for preview */}
            {translatedResults.length > 1 && (
              <select
                value={previewLang}
                onChange={(e) => setPreviewLang(e.target.value)}
                className="rounded-sm px-2 py-1.5 text-[13px] outline-none"
                style={{
                  background: "var(--bg-input)",
                  border: "1px solid var(--border-default)",
                  color: "var(--text-primary)",
                }}
              >
                {translatedResults.map((r) => (
                  <option key={r.lang} value={r.lang}>
                    {LANG_LABELS[r.lang] || r.lang}
                  </option>
                ))}
              </select>
            )}

            {/* Preview content */}
            <PreviewPanel
              viewMode={viewMode}
              original={jsonData}
              translated={translatedResults.find((r) => r.lang === previewLang)?.data ?? null}
              langLabel={LANG_LABELS[previewLang] || previewLang}
            />
          </div>
        )}

        {/* Partial-failure error hint (only when some succeeded but some failed) */}
        {!allFailed && error && (
          <p
            className="rounded p-3 text-[13px]"
            style={{ background: "var(--error-muted)", color: "var(--error)" }}
          >
            {error}
          </p>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // RENDER: Main form
  // ---------------------------------------------------------------------------
  const modelNotInstalled = modelReady === false && serverAvailable === true;

  const canTranslate =
    jsonData !== null &&
    selectedLangs.size > 0 &&
    !insufficientCredits &&
    !modelNotInstalled &&
    outputFolder.length > 0;

  return (
    <div className="space-y-6">
      <h2 className="text-[16px] font-semibold" style={{ color: "var(--text-primary)" }}>
        Translation
      </h2>

      {/* Server offline warning */}
      {serverAvailable === false && (
        <div
          className="rounded p-3 text-[13px]"
          style={{ background: "var(--warning-muted)", color: "var(--warning)" }}
        >
          Translation engine is offline. Start the translation server to enable this feature.
        </div>
      )}

      {/* File drop zone — JSON only */}
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className="relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors cursor-pointer"
        style={{
          borderColor: fileError
            ? "var(--error)"
            : isDragging
              ? "var(--accent)"
              : jsonFile
                ? "var(--success)"
                : "var(--border-default)",
          background: isDragging
            ? "var(--accent-muted)"
            : jsonFile
              ? "var(--success-muted)"
              : "var(--bg-input)",
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileInput}
          className="hidden"
        />

        {jsonFile ? (
          <div className="flex w-full flex-col items-center gap-2">
            <div className="flex items-center gap-2">
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                style={{ color: "var(--success)" }}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <span className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
                {fileName}
              </span>
            </div>
            <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
              {pageCount} page{pageCount !== 1 ? "s" : ""} detected
            </p>
            <button
              onClick={(e) => { e.stopPropagation(); handleReset(); }}
              className="text-[11px] transition-colors"
              style={{ color: "var(--error)" }}
            >
              Remove
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-center">
            <svg
              className="h-10 w-10"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              style={{ color: "var(--text-tertiary)" }}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z"
              />
            </svg>
            <p className="text-[13px] font-medium" style={{ color: "var(--text-secondary)" }}>
              Drop an OCR JSON file to translate
            </p>
            <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
              For PDFs, use the OCR tool first to generate JSON output
            </p>
          </div>
        )}

        {fileError && (
          <p className="mt-2 text-[11px] font-medium" style={{ color: "var(--error)" }}>
            {fileError}
          </p>
        )}
      </div>

      {/* Options panel */}
      <div
        className="space-y-4 rounded p-5"
        style={{ background: "var(--bg-surface)", border: "1px solid var(--border-default)" }}
      >
        {/* SECTION: Source Language */}
        <div>
          <label
            className="mb-2 block text-[11px] font-medium uppercase tracking-[0.05em]"
            style={{ color: "var(--text-secondary)" }}
          >
            Source Language
          </label>
          <select
            value={srcLang}
            onChange={(e) => setSrcLang(e.target.value)}
            className="w-full rounded-sm px-2 py-1.5 text-[13px] outline-none"
            style={{
              background: "var(--bg-input)",
              border: "1px solid var(--border-default)",
              color: "var(--text-primary)",
            }}
          >
            {SOURCE_LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
              </option>
            ))}
          </select>
        </div>

        {/* SECTION: Target Languages */}
        <div style={{ borderTop: "1px solid var(--border-default)", paddingTop: "16px" }}>
          <div className="mb-3 flex items-center justify-between">
            <label
              className="text-[11px] font-medium uppercase tracking-[0.05em]"
              style={{ color: "var(--text-secondary)" }}
            >
              Target Languages
            </label>
            {selectedLangs.size > 0 && (
              <button
                onClick={() => setSelectedLangs(new Set())}
                className="text-[11px] transition-colors"
                style={{ color: "var(--accent-text)" }}
              >
                Clear all
              </button>
            )}
          </div>

          <div className="space-y-3">
            {LANGUAGE_GROUPS.map((group) => (
              <div
                key={group.name}
                className="rounded p-3"
                style={{ background: "var(--bg-input)", border: "1px solid var(--border-subtle)" }}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span
                    className="text-[11px] font-semibold uppercase tracking-[0.05em]"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {group.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const groupCodes = group.languages
                        .filter((l) => !l.disabled)
                        .map((l) => l.code);
                      setSelectedLangs((prev) => {
                        const next = new Set(prev);
                        const allSelected = groupCodes.every((c) => next.has(c));
                        if (allSelected) {
                          groupCodes.forEach((c) => next.delete(c));
                        } else {
                          groupCodes.forEach((c) => next.add(c));
                        }
                        return next;
                      });
                    }}
                    className="text-[11px] transition-colors"
                    style={{ color: "var(--accent-text)" }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--accent-text)"; }}
                  >
                    {group.languages.filter((l) => !l.disabled).every((l) => selectedLangs.has(l.code))
                      ? "Deselect all"
                      : "Select all"}
                  </button>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {group.languages.map((lang) => (
                    <label
                      key={lang.code}
                      className="flex items-center gap-2 text-[13px] cursor-pointer"
                      style={{
                        color: lang.disabled ? "var(--text-tertiary)" : "var(--text-primary)",
                        opacity: lang.disabled ? 0.5 : 1,
                      }}
                      title={lang.disabled ? lang.disabledReason : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={selectedLangs.has(lang.code)}
                        onChange={() => !lang.disabled && toggleLang(lang.code)}
                        disabled={lang.disabled}
                        className="h-4 w-4 rounded-sm"
                      />
                      {lang.label}
                      {lang.disabled && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[8px] font-medium"
                          style={{ background: "var(--warning-muted)", color: "var(--warning)" }}
                        >
                          {lang.disabledReason}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* SECTION: Model Variant */}
        <div style={{ borderTop: "1px solid var(--border-default)", paddingTop: "16px" }}>
          <label
            className="mb-3 block text-[11px] font-medium uppercase tracking-[0.05em]"
            style={{ color: "var(--text-secondary)" }}
          >
            Translation Quality
          </label>

          <div
            className="mb-3 inline-flex rounded p-0.5"
            style={{ background: "var(--bg-elevated)" }}
          >
            <button
              type="button"
              onClick={() => setModelVariant("200M")}
              className="rounded px-4 py-1.5 text-[13px] font-medium transition-colors"
              style={{
                background: modelVariant === "200M" ? "var(--accent)" : "transparent",
                color: modelVariant === "200M" ? "var(--text-inverse)" : "var(--text-secondary)",
              }}
            >
              Standard
            </button>
            <button
              type="button"
              onClick={() => setModelVariant("1B")}
              className="rounded px-4 py-1.5 text-[13px] font-medium transition-colors"
              style={{
                background: modelVariant === "1B" ? "var(--accent)" : "transparent",
                color: modelVariant === "1B" ? "var(--text-inverse)" : "var(--text-secondary)",
              }}
            >
              High Accuracy
            </button>
          </div>

          <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
            {modelVariant === "200M"
              ? "Fast and accurate. Recommended for most documents."
              : "Marginally higher accuracy. Requires a powerful machine (16GB+ RAM, GPU recommended); translation will be noticeably slower."}
          </p>

          {modelVariant === "1B" && (
            <div
              className="mt-3 rounded p-3 text-[11px] flex items-start gap-2"
              style={{ background: "var(--warning-muted)", color: "var(--warning)" }}
            >
              <svg className="h-4 w-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M4.93 4.93l14.14 14.14M12 3a9 9 0 100 18 9 9 0 000-18z" />
              </svg>
              <span>
                High Accuracy mode needs significant memory and will be slow on modest hardware. Use Standard for everyday work.
              </span>
            </div>
          )}

          {/* Inform when selected variant differs from what's loaded — shows
              user there will be a ~15s swap on first translate. Non-blocking. */}
          {loadedVariant !== null && loadedVariant !== modelVariant && (
            <p className="mt-2 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
              First translation will take ~15s while the model switches.
            </p>
          )}

          {/* Only show when engine has no model loaded at all (extremely rare). */}
          {modelNotInstalled && (
            <div
              className="mt-3 rounded p-3 text-[11px]"
              style={{ background: "var(--warning-muted)", color: "var(--warning)" }}
            >
              Translation engine is starting up...
            </div>
          )}
        </div>

        {/* SECTION: Export Formats */}
        <div style={{ borderTop: "1px solid var(--border-default)", paddingTop: "16px" }}>
          <label
            className="mb-2 block text-[11px] font-medium uppercase tracking-[0.05em]"
            style={{ color: "var(--text-secondary)" }}
          >
            Export Formats
          </label>
          <p className="mb-3 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
            Translated output is written to{" "}
            <code style={{ color: "var(--text-secondary)" }}>output/{"{doc}"}/{"{language}"}/</code>{" "}
            with True Copy, Reflowed, and Data subfolders. Figures and formulas
            are embedded inline from the OCR JSON.
          </p>
          <div className="space-y-3">
            {TRANSLATION_FORMAT_GROUPS.map((group) => (
              <div key={group.label} role="group" aria-label={group.label}>
                <div
                  className="mb-1.5 text-[11px] font-medium"
                  style={{ color: "var(--text-primary)" }}
                >
                  {group.label}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {group.formats.map((f) => {
                    const checked = selectedFormats.has(f.key);
                    return (
                      <label
                        key={f.key}
                        className="flex cursor-pointer items-center gap-2 text-[13px]"
                        title={f.tooltip}
                        style={{ color: "var(--text-primary)" }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleFormat(f.key)}
                          className="h-4 w-4 cursor-pointer"
                          style={{ accentColor: "var(--accent)" }}
                          aria-label={`${group.label} — ${f.label}`}
                        />
                        <span>{f.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* SECTION: Output Folder */}
        <div style={{ borderTop: "1px solid var(--border-default)", paddingTop: "16px" }}>
          <label
            className="mb-2 block text-[11px] font-medium uppercase tracking-[0.05em]"
            style={{ color: "var(--text-secondary)" }}
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
                background: "var(--bg-input)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "var(--border-focus)"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-default)"; }}
            />
            <button
              onClick={handleBrowse}
              className="rounded px-3 py-1.5 text-[13px] transition-colors"
              style={{ background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border-default)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-elevated)"; e.currentTarget.style.color = "var(--text-primary)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-secondary)"; }}
            >
              Browse
            </button>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <p
          className="rounded p-3 text-[13px]"
          style={{ background: "var(--error-muted)", color: "var(--error)" }}
        >
          {error}
        </p>
      )}

      {/* Credit estimate */}
      {creditEstimate !== null && jsonData && (
        <div
          className="flex items-center justify-between text-[11px]"
          style={{ color: insufficientCredits ? "var(--error)" : "var(--text-secondary)" }}
        >
          <span>
            2 credits/page/language &middot; Est. {creditEstimate} credit{creditEstimate !== 1 ? "s" : ""} for {pageCount} page{pageCount !== 1 ? "s" : ""} &times; {selectedLangs.size} language{selectedLangs.size !== 1 ? "s" : ""}
          </span>
          {insufficientCredits && (
            <span style={{ color: "var(--error)" }}>Insufficient credits</span>
          )}
        </div>
      )}

      {/* Translate button */}
      <button
        onClick={handleTranslate}
        disabled={!canTranslate}
        className="w-full rounded py-2 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        style={{
          background: "var(--accent)",
          color: "var(--text-inverse)",
        }}
        onMouseEnter={(e) => {
          if (!e.currentTarget.disabled) e.currentTarget.style.background = "var(--accent-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--accent)";
        }}
      >
        {selectedLangs.size > 0
          ? `Translate to ${selectedLangLabels}`
          : "Select target languages"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview panel sub-component
// ---------------------------------------------------------------------------

function PreviewPanel({
  viewMode,
  original,
  translated,
  langLabel,
}: {
  viewMode: TranslationViewMode;
  original: Record<string, unknown> | null;
  translated: Record<string, unknown> | null;
  langLabel: string;
}) {
  // Extract text blocks for preview
  const originalBlocks = useMemo(() => extractTextBlocks(original), [original]);
  const translatedBlocks = useMemo(() => extractTextBlocks(translated), [translated]);

  if (!translated) {
    return (
      <p className="text-[13px]" style={{ color: "var(--text-tertiary)" }}>
        No preview available.
      </p>
    );
  }

  if (viewMode === "translated-only") {
    return (
      <div
        className="max-h-96 overflow-y-auto rounded p-4 space-y-3"
        style={{ background: "var(--bg-input)", border: "1px solid var(--border-default)" }}
      >
        <div
          className="mb-2 text-[11px] font-medium uppercase tracking-[0.05em]"
          style={{ color: "var(--text-secondary)" }}
        >
          {langLabel}
        </div>
        {translatedBlocks.map((block, i) => (
          <div key={i} className="flex items-start gap-2">
            <ConfidenceDot level={block.confidence} />
            <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-primary)" }}>
              {block.text}
            </p>
          </div>
        ))}
      </div>
    );
  }

  if (viewMode === "diff") {
    return (
      <div
        className="max-h-96 overflow-y-auto rounded p-4 space-y-3"
        style={{ background: "var(--bg-input)", border: "1px solid var(--border-default)" }}
      >
        {originalBlocks.map((block, i) => {
          const trans = translatedBlocks[i];
          return (
            <div key={i} className="space-y-1 pb-2" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
              <p className="text-[13px] line-through" style={{ color: "var(--text-tertiary)" }}>
                {block.text}
              </p>
              {trans && (
                <div className="flex items-start gap-2">
                  <ConfidenceDot level={trans.confidence} />
                  <p className="text-[13px]" style={{ color: "var(--success)" }}>
                    {trans.text}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // Side-by-side (default)
  return (
    <div
      className="grid max-h-96 grid-cols-2 gap-4 overflow-y-auto rounded p-4"
      style={{ background: "var(--bg-input)", border: "1px solid var(--border-default)" }}
    >
      <div>
        <div
          className="mb-2 text-[11px] font-medium uppercase tracking-[0.05em]"
          style={{ color: "var(--text-secondary)" }}
        >
          Original
        </div>
        <div className="space-y-2">
          {originalBlocks.map((block, i) => (
            <p key={i} className="text-[13px] leading-relaxed" style={{ color: "var(--text-primary)" }}>
              {block.text}
            </p>
          ))}
        </div>
      </div>
      <div>
        <div
          className="mb-2 text-[11px] font-medium uppercase tracking-[0.05em]"
          style={{ color: "var(--text-secondary)" }}
        >
          {langLabel}
        </div>
        <div className="space-y-2">
          {translatedBlocks.map((block, i) => (
            <div key={i} className="flex items-start gap-2">
              <ConfidenceDot level={block.confidence} />
              <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-primary)" }}>
                {block.text}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confidence dot indicator
// ---------------------------------------------------------------------------

function ConfidenceDot({ level }: { level: ConfidenceLevel }) {
  const config: Record<ConfidenceLevel, { color: string; label: string }> = {
    high: { color: "var(--success)", label: "High" },
    medium: { color: "var(--warning)", label: "Med" },
    low: { color: "var(--error)", label: "Low" },
  };
  const { color, label } = config[level];

  return (
    <span className="mt-1 flex shrink-0 items-center gap-1" title={`Confidence: ${label}`}>
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: color }}
      />
      <span className="text-[10px]" style={{ color }}>
        {label}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Extract text blocks from OCR JSON for preview
// ---------------------------------------------------------------------------

interface TextBlock {
  text: string;
  confidence: ConfidenceLevel;
}

function extractTextBlocks(data: Record<string, unknown> | null): TextBlock[] {
  if (!data) return [];

  const blocks: TextBlock[] = [];

  // Translation JSON uses content_list (flat array of blocks)
  const contentList = data.content_list as Array<Record<string, unknown>> | undefined;
  if (contentList && Array.isArray(contentList)) {
    for (const item of contentList) {
      const blockType = (item.type || "") as string;
      if (blockType !== "text" && blockType !== "title") continue;
      const text = (item.text || "") as string;
      if (!text.trim()) continue;

      let confidence: ConfidenceLevel = "high";
      if (item.confidence !== undefined) {
        const c = item.confidence as number;
        if (c < 0.5) confidence = "low";
        else if (c < 0.8) confidence = "medium";
      } else {
        if (text.length < 10) confidence = "medium";
      }

      blocks.push({ text, confidence });
    }
    return blocks;
  }

  // MinerU output format uses pages > regions (fallback for original doc preview)
  const pages = (data.pages || data.pdf_info || []) as Array<Record<string, unknown>>;
  for (const page of pages) {
    const regions = (page.regions || page.preproc_blocks || page.blocks || page.para_blocks || []) as Array<Record<string, unknown>>;
    for (const region of regions) {
      const text = (region.content || region.text || "") as string;
      if (!text.trim()) continue;

      let confidence: ConfidenceLevel = "high";
      if (region.confidence !== undefined) {
        const c = region.confidence as number;
        if (c < 0.5) confidence = "low";
        else if (c < 0.8) confidence = "medium";
      } else {
        if (text.length < 10) confidence = "medium";
      }

      blocks.push({ text, confidence });
    }
  }

  return blocks;
}
