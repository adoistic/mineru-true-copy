"use client";

import { useState, useCallback, useEffect } from "react";

interface ModelInfo {
  id: string;
  variant: string;
  label: string;
  size: string;
  description: string;
}

const MODELS: ModelInfo[] = [
  {
    id: "quality",
    variant: "1B",
    label: "Quality",
    size: "~2.2 GB",
    description: "Best for government documents",
  },
  {
    id: "speed",
    variant: "200M",
    label: "Speed",
    size: "~400 MB",
    description: "Faster, good for batch processing",
  },
];

type ModelStatus = "not_downloaded" | "downloading" | "ready" | "error";

interface SettingsOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  creditBalance: number;
  onDeactivate: () => void;
}

export default function SettingsOverlay({
  isOpen,
  onClose,
  creditBalance,
  onDeactivate,
}: SettingsOverlayProps) {
  const [outputFolder, setOutputFolder] = useState(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("default_output_folder") ?? ""
      : ""
  );
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  // --- Model download state ---
  const [modelStatuses, setModelStatuses] = useState<Record<string, ModelStatus>>({
    "1B": "not_downloaded",
    "200M": "not_downloaded",
  });
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({});
  const [translationServerOnline, setTranslationServerOnline] = useState(false);

  // Fetch model status from translation server
  useEffect(() => {
    if (!isOpen) return;

    async function fetchModelStatus() {
      try {
        const res = await fetch("/api/translation/models");
        if (!res.ok) {
          setTranslationServerOnline(false);
          return;
        }
        const data = await res.json();
        setTranslationServerOnline(data.available ?? false);

        if (data.available) {
          // If a model is loaded, mark it as ready
          const newStatuses: Record<string, ModelStatus> = {
            "1B": "not_downloaded",
            "200M": "not_downloaded",
          };
          if (data.loaded?.variant) {
            newStatuses[data.loaded.variant] = "ready";
          }
          // Merge with current statuses (preserve "downloading" state)
          setModelStatuses((prev) => {
            const merged = { ...newStatuses };
            for (const key of Object.keys(prev)) {
              if (prev[key] === "downloading") {
                merged[key] = "downloading";
              }
            }
            return merged;
          });
        }
      } catch {
        setTranslationServerOnline(false);
      }
    }

    fetchModelStatus();
    const interval = setInterval(fetchModelStatus, 5000);
    return () => clearInterval(interval);
  }, [isOpen]);

  const handleModelDownload = useCallback(async (variant: string) => {
    setModelStatuses((prev) => ({ ...prev, [variant]: "downloading" }));
    setModelErrors((prev) => {
      const next = { ...prev };
      delete next[variant];
      return next;
    });

    try {
      const res = await fetch("/api/translation/model/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "en-indic", variant }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Download failed" }));
        throw new Error(data.error || "Download failed");
      }

      setModelStatuses((prev) => ({ ...prev, [variant]: "ready" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Download failed";
      setModelStatuses((prev) => ({ ...prev, [variant]: "error" }));
      setModelErrors((prev) => ({ ...prev, [variant]: msg }));
    }
  }, []);

  const maskedKey = useCallback(() => {
    const keyId = typeof window !== "undefined" ? localStorage.getItem("key_id") : null;
    if (!keyId) return "----";
    const clean = keyId.replace(/-/g, "");
    return "****-****-****-" + clean.slice(-4).toUpperCase();
  }, []);

  const handleOutputFolderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setOutputFolder(val);
      localStorage.setItem("default_output_folder", val);
    },
    []
  );

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

  const handleDeactivate = useCallback(() => {
    if (!confirmDeactivate) {
      setConfirmDeactivate(true);
      return;
    }
    localStorage.removeItem("key_id");
    onDeactivate();
  }, [confirmDeactivate, onDeactivate]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className="relative z-10 w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-md p-6"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
      >
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            Settings
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1.5 transition-colors"
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-tertiary)'; }}
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-5">
          {/* Activation Key */}
          <div>
            <label
              className="mb-1 block text-[11px] font-medium uppercase tracking-[0.05em]"
              style={{ color: 'var(--text-secondary)' }}
            >
              Activation Key
            </label>
            <p className="font-mono text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              {maskedKey()}
            </p>
          </div>

          {/* Credit Balance */}
          <div>
            <label
              className="mb-1 block text-[11px] font-medium uppercase tracking-[0.05em]"
              style={{ color: 'var(--text-secondary)' }}
            >
              Credit Balance
            </label>
            <p className="text-[20px] font-semibold" style={{ color: 'var(--accent)' }}>
              {creditBalance.toLocaleString()}
            </p>
          </div>

          {/* Default Output Folder */}
          <div>
            <label
              className="mb-1 block text-[11px] font-medium uppercase tracking-[0.05em]"
              style={{ color: 'var(--text-secondary)' }}
            >
              Default Output Folder
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={outputFolder}
                onChange={handleOutputFolderChange}
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

          {/* Translation Models */}
          <div style={{ borderTop: '1px solid var(--border-default)', paddingTop: '16px' }}>
            <label
              className="mb-3 block text-[11px] font-medium uppercase tracking-[0.05em]"
              style={{ color: 'var(--text-secondary)' }}
            >
              Translation Models
            </label>

            {!translationServerOnline && (
              <p className="mb-3 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                Translation engine is offline. Models will be checked when the engine starts.
              </p>
            )}

            <div className="space-y-3">
              {MODELS.map((model) => {
                const status = modelStatuses[model.variant] ?? "not_downloaded";
                const errorMsg = modelErrors[model.variant];

                return (
                  <div
                    key={model.id}
                    className="flex items-center justify-between rounded p-3"
                    style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                          {model.label} Model
                        </span>
                        {status === "ready" && (
                          <span
                            className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{ background: 'var(--success-muted)', color: 'var(--success)' }}
                          >
                            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                            Ready
                          </span>
                        )}
                      </div>
                      <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        {model.size} &middot; {model.description}
                      </p>
                      {status === "downloading" && (
                        <div className="mt-2">
                          <div
                            className="h-1.5 w-full overflow-hidden rounded-full"
                            style={{ background: 'var(--bg-elevated)' }}
                          >
                            <div
                              className="h-full rounded-full animate-pulse"
                              style={{ width: '60%', background: 'var(--accent)' }}
                            />
                          </div>
                          <p className="mt-1 text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                            Downloading model files...
                          </p>
                        </div>
                      )}
                      {status === "error" && errorMsg && (
                        <p className="mt-1 text-[11px]" style={{ color: 'var(--error)' }}>
                          {errorMsg}
                        </p>
                      )}
                    </div>

                    <div className="ml-3 shrink-0">
                      {status === "not_downloaded" && (
                        <button
                          onClick={() => handleModelDownload(model.variant)}
                          disabled={!translationServerOnline}
                          className="rounded px-3 py-1.5 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                          style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
                          onMouseEnter={(e) => {
                            if (!e.currentTarget.disabled) e.currentTarget.style.background = 'var(--accent-hover)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'var(--accent)';
                          }}
                        >
                          Download
                        </button>
                      )}
                      {status === "error" && (
                        <button
                          onClick={() => handleModelDownload(model.variant)}
                          disabled={!translationServerOnline}
                          className="rounded px-3 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                          style={{ background: 'transparent', color: 'var(--accent-text)', border: '1px solid var(--border-default)' }}
                          onMouseEnter={(e) => {
                            if (!e.currentTarget.disabled) {
                              e.currentTarget.style.background = 'var(--bg-elevated)';
                              e.currentTarget.style.color = 'var(--text-primary)';
                            }
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                            e.currentTarget.style.color = 'var(--accent-text)';
                          }}
                        >
                          Retry
                        </button>
                      )}
                      {status === "downloading" && (
                        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                          Loading...
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="mt-3 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              For air-gapped deployment, place model files in: <code className="font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>~/.doctransform/models/</code>
            </p>
          </div>

          {/* App Version */}
          <div>
            <label
              className="mb-1 block text-[11px] font-medium uppercase tracking-[0.05em]"
              style={{ color: 'var(--text-secondary)' }}
            >
              Version
            </label>
            <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
              DocTransform v1.0.0
            </p>
          </div>

          {/* Deactivate */}
          <div style={{ borderTop: '1px solid var(--border-default)', paddingTop: '16px' }}>
            <button
              onClick={handleDeactivate}
              className="rounded px-4 py-2 text-[13px] font-medium transition-colors"
              style={{
                background: confirmDeactivate ? 'var(--error)' : 'transparent',
                color: confirmDeactivate ? '#fff' : 'var(--error)',
                border: confirmDeactivate ? 'none' : '1px solid rgba(244,63,94,0.3)',
              }}
            >
              {confirmDeactivate
                ? "Confirm Deactivation"
                : "Deactivate This Device"}
            </button>
            {confirmDeactivate && (
              <p className="mt-2 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                This will remove your activation key from this device. You can reactivate later.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
