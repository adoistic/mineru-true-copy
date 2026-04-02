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
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-lg rounded-xl bg-white p-6 shadow-2xl dark:bg-slate-900">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="space-y-5">
          {/* Activation Key */}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Activation Key
            </label>
            <p className="font-mono text-sm text-slate-600 dark:text-slate-400">
              {maskedKey()}
            </p>
          </div>

          {/* Credit Balance */}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Credit Balance
            </label>
            <p className="text-2xl font-semibold text-blue-600 dark:text-blue-400">
              {creditBalance.toLocaleString()}
            </p>
          </div>

          {/* Default Output Folder */}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Default Output Folder
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={outputFolder}
                onChange={handleOutputFolderChange}
                placeholder="/path/to/output"
                className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:placeholder:text-slate-500"
              />
              <button className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800">
                Browse
              </button>
            </div>
          </div>

          {/* App Version */}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Version
            </label>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              DocTransform v1.0.0
            </p>
          </div>

          {/* Deactivate */}
          <div className="border-t border-slate-200 pt-4 dark:border-slate-700">
            <button
              onClick={handleDeactivate}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                confirmDeactivate
                  ? "bg-red-600 text-white hover:bg-red-700"
                  : "border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30"
              }`}
            >
              {confirmDeactivate
                ? "Confirm Deactivation"
                : "Deactivate This Device"}
            </button>
            {confirmDeactivate && (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                This will remove your activation key from this device. You can
                reactivate later.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
