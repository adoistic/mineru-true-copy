"use client";

import { useState, useCallback } from "react";

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
        className="relative z-10 w-full max-w-lg rounded-md p-6"
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
