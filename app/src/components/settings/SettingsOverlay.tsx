"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import ApiKeysPanel from "./ApiKeysPanel";
import AboutSection from "./AboutSection";

interface SettingsOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Optional anchor to auto-scroll into view when the overlay mounts.
   * Currently the only supported value is `'about'`, used by the
   * status-bar AGPL link to deep-link into the About / Credits section.
   */
  scrollTo?: "about";
}

export default function SettingsOverlay({
  isOpen,
  onClose,
  scrollTo,
}: SettingsOverlayProps) {
  const [outputFolder, setOutputFolder] = useState(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("default_output_folder") ?? ""
      : ""
  );

  const aboutRef = useRef<HTMLDivElement>(null);

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

  // Escape closes the overlay
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // Deep-link auto-scroll: when the overlay opens with a `scrollTo` anchor,
  // jump the relevant section into view. Re-runs if the caller toggles the
  // anchor between opens (so a user clicking "About" twice still works).
  useEffect(() => {
    if (!isOpen) return;
    if (scrollTo !== "about") return;
    const el = aboutRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "instant", block: "start" });
  }, [isOpen, scrollTo]);

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

          {/* API Keys */}
          <ApiKeysPanel />

          {/* About / Credits — subsumes the old Version line */}
          <AboutSection ref={aboutRef} />
        </div>
      </div>
    </div>
  );
}
