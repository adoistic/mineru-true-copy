"use client";

import { useState, useCallback, useEffect } from "react";
import FileDropZone from "@/components/common/FileDropZone";
import JobProgress from "@/components/processing/JobProgress";
import type { SchemaTemplate } from "@/types";

const DEFAULT_SCHEMA = `{
  "fields": [
    {
      "name": "example_field",
      "type": "string",
      "description": "Description of what to extract"
    }
  ]
}`;

export default function ExtractionTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [schema, setSchema] = useState(DEFAULT_SCHEMA);
  const [prompt, setPrompt] = useState("");
  const [outputFolder, setOutputFolder] = useState(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("default_output_folder") ?? ""
      : ""
  );
  const [outputFormats, setOutputFormats] = useState<Set<"json" | "csv">>(
    new Set(["json"])
  );
  const [templates, setTemplates] = useState<SchemaTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [jobFileNames, setJobFileNames] = useState<string[]>([]);
  const [processing, setProcessing] = useState(false);
  const [completedCount, setCompletedCount] = useState(0);
  const [allOutputFiles, setAllOutputFiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);

  const allComplete = jobIds.length > 0 && completedCount >= jobIds.length;

  useEffect(() => {
    try {
      const saved = localStorage.getItem("extraction_templates");
      if (saved) setTemplates(JSON.parse(saved));
    } catch {
      // ignore
    }
  }, []);

  const handleSchemaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setSchema(e.target.value);
      setSchemaError(null);
      try {
        JSON.parse(e.target.value);
      } catch {
        setSchemaError("Invalid JSON");
      }
    },
    []
  );

  const handleTemplateSelect = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const id = e.target.value;
      setSelectedTemplate(id);
      const tmpl = templates.find((t) => t.id === id);
      if (tmpl) {
        setSchema(JSON.stringify(tmpl.schema, null, 2));
        setPrompt(tmpl.prompt);
        setSchemaError(null);
      }
    },
    [templates]
  );

  const handleSaveTemplate = useCallback(() => {
    if (!templateName.trim()) return;
    try {
      const parsed = JSON.parse(schema);
      const newTemplate: SchemaTemplate = {
        id: crypto.randomUUID(),
        name: templateName.trim(),
        description: "",
        schema: parsed,
        prompt,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const updated = [...templates, newTemplate];
      setTemplates(updated);
      localStorage.setItem("extraction_templates", JSON.stringify(updated));
      setTemplateName("");
      setShowSaveTemplate(false);
      setSelectedTemplate(newTemplate.id);
    } catch {
      setSchemaError("Fix JSON errors before saving as template.");
    }
  }, [templateName, schema, prompt, templates]);

  const toggleFormat = useCallback((fmt: "json" | "csv") => {
    setOutputFormats((prev) => {
      const next = new Set(prev);
      if (next.has(fmt)) next.delete(fmt);
      else next.add(fmt);
      return next;
    });
  }, []);

  const handleProcess = useCallback(async () => {
    if (files.length === 0) return;
    try {
      JSON.parse(schema);
    } catch {
      setSchemaError("Fix JSON errors before processing.");
      return;
    }

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
            job_type: "extract",
            schema: JSON.parse(schema),
            prompt,
            output_formats: Array.from(outputFormats),
            output_folder: outputFolder,
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
            data?.error ?? `Failed to start extraction for ${file.name}.`
          );
        }

        const data = await res.json();
        ids.push(data.job_id ?? data.id);
        names.push(file.name);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to start extraction."
        );
      }
    }

    if (ids.length === 0) {
      setProcessing(false);
      return;
    }

    setJobIds(ids);
    setJobFileNames(names);
  }, [files, schema, prompt, outputFormats, outputFolder]);

  const handleJobComplete = useCallback((outputFiles: string[]) => {
    setAllOutputFiles((prev) => [...prev, ...outputFiles]);
    setCompletedCount((prev) => prev + 1);
  }, []);

  const handleJobError = useCallback((msg: string) => {
    setError((prev) => (prev ? `${prev}\n${msg}` : msg));
    setCompletedCount((prev) => prev + 1);
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

  const handleReset = useCallback(() => {
    setFiles([]);
    setJobIds([]);
    setJobFileNames([]);
    setProcessing(false);
    setCompletedCount(0);
    setAllOutputFiles([]);
    setError(null);
  }, []);

  if (jobIds.length > 0 && processing && !allComplete) {
    return (
      <div className="space-y-4">
        <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          Extracting Data
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

  if (allComplete) {
    return (
      <div className="space-y-4">
        <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          Extraction Complete
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
              {jobIds.length} file{jobIds.length !== 1 ? "s" : ""} extracted successfully
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
        Data Extraction
      </h2>

      <FileDropZone onFilesSelected={setFiles} disabled={processing} />

      <div
        className="space-y-4 rounded p-5"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
      >
        <label
          className="block text-[11px] font-medium uppercase tracking-[0.05em]"
          style={{ color: 'var(--text-secondary)' }}
        >
          Extraction Schema
        </label>

        {/* Template selector */}
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="mb-1 block text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              Template
            </label>
            <select
              value={selectedTemplate}
              onChange={handleTemplateSelect}
              className="w-full rounded-sm px-2 py-1.5 text-[13px] outline-none"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-primary)',
              }}
            >
              <option value="">Custom Schema</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={() => setShowSaveTemplate(!showSaveTemplate)}
            className="rounded px-3 py-1.5 text-[13px] transition-colors"
            style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          >
            Save as Template
          </button>
        </div>

        {showSaveTemplate && (
          <div className="flex gap-2">
            <input
              type="text"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="Template name"
              className="flex-1 rounded-sm px-2 py-1.5 text-[13px] outline-none"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-primary)',
              }}
            />
            <button
              onClick={handleSaveTemplate}
              disabled={!templateName.trim()}
              className="rounded px-3 py-1.5 text-[13px] font-semibold transition-colors disabled:opacity-40"
              style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
            >
              Save
            </button>
          </div>
        )}

        {/* Schema editor */}
        <div>
          <label className="mb-1 block text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            JSON Schema
          </label>
          <textarea
            value={schema}
            onChange={handleSchemaChange}
            rows={10}
            spellCheck={false}
            className="w-full rounded-sm px-3 py-2 font-mono text-[13px] outline-none"
            style={{
              background: 'var(--bg-input)',
              border: `1px solid ${schemaError ? 'var(--error)' : 'var(--border-default)'}`,
              color: 'var(--text-primary)',
            }}
          />
          {schemaError && (
            <p className="mt-1 text-[11px]" style={{ color: 'var(--error)' }}>
              {schemaError}
            </p>
          )}
        </div>

        {/* Prompt */}
        <div>
          <label className="mb-1 block text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            Custom Instruction (optional)
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="E.g., Extract all invoice line items including quantities and unit prices..."
            className="w-full rounded-sm px-3 py-2 text-[13px] outline-none"
            style={{
              background: 'var(--bg-input)',
              border: '1px solid var(--border-default)',
              color: 'var(--text-primary)',
            }}
          />
        </div>

        {/* Output formats */}
        <div>
          <label
            className="mb-2 block text-[11px] font-medium uppercase tracking-[0.05em]"
            style={{ color: 'var(--text-secondary)' }}
          >
            Output Formats
          </label>
          <div className="flex gap-4">
            {(["json", "csv"] as const).map((fmt) => (
              <label
                key={fmt}
                className="flex items-center gap-2 text-[13px] cursor-pointer"
                style={{ color: 'var(--text-primary)' }}
              >
                <input
                  type="checkbox"
                  checked={outputFormats.has(fmt)}
                  onChange={() => toggleFormat(fmt)}
                  className="h-4 w-4 rounded-sm"
                />
                {fmt.toUpperCase()}
              </label>
            ))}
          </div>
        </div>

        {/* Output folder */}
        <div>
          <label
            className="mb-1 block text-[11px] font-medium uppercase tracking-[0.05em]"
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
      </div>

      {error && (
        <p
          className="rounded p-3 text-[13px]"
          style={{ background: 'var(--error-muted)', color: 'var(--error)' }}
        >
          {error}
        </p>
      )}

      <button
        onClick={handleProcess}
        disabled={files.length === 0 || outputFormats.size === 0 || !!schemaError}
        className="w-full rounded py-2 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
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
