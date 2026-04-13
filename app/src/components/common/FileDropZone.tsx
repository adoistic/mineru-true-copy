"use client";

import { useState, useRef, useCallback } from "react";

interface FileDropZoneProps {
  onFilesSelected?: (files: File[]) => void;
  onFileSelected?: (file: File) => void;
  accept?: string;
  maxSizeMB?: number;
  disabled?: boolean;
}

export default function FileDropZone({
  onFilesSelected,
  onFileSelected,
  accept = ".pdf",
  maxSizeMB = 100,
  disabled = false,
}: FileDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const validateAndAdd = useCallback(
    (newFiles: FileList | File[]) => {
      setError(null);
      const valid: File[] = [];

      for (const file of Array.from(newFiles)) {
        if (!file.name.toLowerCase().endsWith(".pdf")) {
          setError("Only PDF files are accepted.");
          continue;
        }
        const sizeMB = file.size / (1024 * 1024);
        if (sizeMB > maxSizeMB) {
          setError(`File "${file.name}" exceeds maximum size of ${maxSizeMB} MB.`);
          continue;
        }
        valid.push(file);
      }

      if (valid.length === 0) return;

      setSelectedFiles((prev) => {
        const combined = [...prev, ...valid];
        const seen = new Set<string>();
        const deduped = combined.filter((f) => {
          const key = `${f.name}:${f.size}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        queueMicrotask(() => {
          if (onFilesSelected) {
            onFilesSelected(deduped);
          } else if (onFileSelected && deduped.length > 0) {
            onFileSelected(deduped[deduped.length - 1]);
          }
        });

        return deduped;
      });
    },
    [maxSizeMB, onFilesSelected, onFileSelected]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!disabled) setIsDragging(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (disabled) return;

      validateAndAdd(e.dataTransfer.files);
    },
    [disabled, validateAndAdd]
  );

  const handleClick = useCallback(() => {
    if (!disabled) inputRef.current?.click();
  }, [disabled]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        validateAndAdd(e.target.files);
      }
      if (inputRef.current) inputRef.current.value = "";
    },
    [validateAndAdd]
  );

  const removeFile = useCallback(
    (index: number, e: React.MouseEvent) => {
      e.stopPropagation();
      setSelectedFiles((prev) => {
        const next = prev.filter((_, i) => i !== index);
        queueMicrotask(() => {
          if (onFilesSelected) {
            onFilesSelected(next);
          } else if (onFileSelected) {
            onFileSelected(next.length > 0 ? next[next.length - 1] : null as unknown as File);
          }
        });
        return next;
      });
      setError(null);
    },
    [onFilesSelected, onFileSelected]
  );

  const clearAll = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setSelectedFiles([]);
      setError(null);
      if (inputRef.current) inputRef.current.value = "";
      if (onFilesSelected) onFilesSelected([]);
    },
    [onFilesSelected]
  );

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const hasFiles = selectedFiles.length > 0;

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
      className="relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors cursor-pointer"
      style={{
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        borderColor: error
          ? 'var(--error)'
          : isDragging
            ? 'var(--accent)'
            : hasFiles
              ? 'var(--success)'
              : 'var(--border-default)',
        background: isDragging
          ? 'var(--accent-muted)'
          : hasFiles
            ? 'var(--success-muted)'
            : 'var(--bg-input)',
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        onChange={handleInputChange}
        className="hidden"
        disabled={disabled}
      />

      {hasFiles ? (
        <div className="flex w-full flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                style={{ color: 'var(--success)' }}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {selectedFiles.length} file{selectedFiles.length !== 1 ? "s" : ""} selected
              </span>
            </div>
            <button
              onClick={clearAll}
              className="rounded px-2 py-1 text-[11px] transition-colors"
              style={{ color: 'var(--error)' }}
            >
              Clear All
            </button>
          </div>

          <ul className="space-y-1.5">
            {selectedFiles.map((file, i) => (
              <li
                key={`${file.name}-${file.size}-${i}`}
                className="flex items-center justify-between rounded px-3 py-1.5"
                style={{ background: 'var(--bg-surface)' }}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px]" style={{ color: 'var(--text-primary)' }}>
                    {file.name}
                  </p>
                  <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                    {formatSize(file.size)}
                  </p>
                </div>
                <button
                  onClick={(e) => removeFile(i, e)}
                  className="ml-2 shrink-0 rounded p-1 transition-colors"
                  style={{ color: 'var(--error)' }}
                  aria-label={`Remove ${file.name}`}
                >
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>

          <p className="text-center text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            Drop more files or click to add
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 text-center">
          <svg
            className="h-10 w-10"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
            style={{ color: 'var(--text-tertiary)' }}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z"
            />
          </svg>
          <p className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
            Drop a file to process
          </p>
          <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            PDF files only — Max {maxSizeMB} MB per file
          </p>
        </div>
      )}

      {error && (
        <p className="mt-2 text-[11px] font-medium" style={{ color: 'var(--error)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
