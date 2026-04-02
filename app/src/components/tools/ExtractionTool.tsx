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
  const [file, setFile] = useState<File | null>(null);
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
  const [jobId, setJobId] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [outputFiles, setOutputFiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);

  // Load saved templates from localStorage
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
    if (!file) return;
    try {
      JSON.parse(schema);
    } catch {
      setSchemaError("Fix JSON errors before processing.");
      return;
    }

    setProcessing(true);
    setError(null);
    setCompleted(false);

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

      const keyId = localStorage.getItem("key_id") ?? "";
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "x-key-id": keyId },
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Failed to start extraction.");
      }

      const data = await res.json();
      setJobId(data.job_id ?? data.id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to start extraction."
      );
      setProcessing(false);
    }
  }, [file, schema, prompt, outputFormats, outputFolder]);

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

  if (jobId && processing) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
          Extracting Data
        </h2>
        <JobProgress
          jobId={jobId}
          onComplete={handleComplete}
          onError={handleJobError}
        />
      </div>
    );
  }

  if (completed) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
          Extraction Complete
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
              Data extraction completed successfully
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
        Data Extraction
      </h2>

      <FileDropZone onFileSelected={setFile} disabled={processing} />

      <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-800">
        <h3 className="text-sm font-medium text-slate-900 dark:text-white">
          Extraction Schema
        </h3>

        {/* Template selector */}
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="mb-1 block text-sm text-slate-600 dark:text-slate-400">
              Template
            </label>
            <select
              value={selectedTemplate}
              onChange={handleTemplateSelect}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
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
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800"
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
              className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            />
            <button
              onClick={handleSaveTemplate}
              disabled={!templateName.trim()}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        )}

        {/* Schema editor */}
        <div>
          <label className="mb-1 block text-sm text-slate-600 dark:text-slate-400">
            JSON Schema
          </label>
          <textarea
            value={schema}
            onChange={handleSchemaChange}
            rows={10}
            spellCheck={false}
            className={`w-full rounded-lg border bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 dark:bg-slate-900 dark:text-white ${
              schemaError
                ? "border-red-400 focus:ring-red-500/20"
                : "border-slate-300 focus:border-blue-500 focus:ring-blue-500/20 dark:border-slate-600"
            }`}
          />
          {schemaError && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              {schemaError}
            </p>
          )}
        </div>

        {/* Prompt */}
        <div>
          <label className="mb-1 block text-sm text-slate-600 dark:text-slate-400">
            Custom Instruction (optional)
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="E.g., Extract all invoice line items including quantities and unit prices..."
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:placeholder:text-slate-500"
          />
        </div>

        {/* Output formats */}
        <div>
          <label className="mb-2 block text-sm text-slate-600 dark:text-slate-400">
            Output Formats
          </label>
          <div className="flex gap-4">
            {(["json", "csv"] as const).map((fmt) => (
              <label
                key={fmt}
                className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"
              >
                <input
                  type="checkbox"
                  checked={outputFormats.has(fmt)}
                  onChange={() => toggleFormat(fmt)}
                  className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600"
                />
                {fmt.toUpperCase()}
              </label>
            ))}
          </div>
        </div>

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
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-400">
          {error}
        </p>
      )}

      <button
        onClick={handleProcess}
        disabled={!file || outputFormats.size === 0 || !!schemaError}
        className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Process
      </button>
    </div>
  );
}
