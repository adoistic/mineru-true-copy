"use client";

import { useState, useEffect, useCallback, useRef, useId } from "react";
import { load } from "@tauri-apps/plugin-store";
import { toast } from "sonner";

const STORE_FILE = "api-keys.json";
const STORE_KEY = "openrouter_api_key";
const MIN_KEY_LENGTH = 10;

// ─── Cross-component subscription so OcrTool can react to key changes ────

type Listener = (hasKey: boolean) => void;
const listeners = new Set<Listener>();
let cachedHasKey = false;

function emitKeyState(hasKey: boolean) {
  cachedHasKey = hasKey;
  listeners.forEach((fn) => fn(hasKey));
}

/**
 * Hook for components that need to react to "is the OpenRouter key set?".
 * Reads the store on mount and re-renders when the key is added or removed
 * elsewhere in the app (e.g. from the Settings overlay).
 */
export function useOpenRouterKeyStatus(): {
  hasKey: boolean;
  isLoading: boolean;
} {
  const [state, setState] = useState<{ hasKey: boolean; isLoading: boolean }>(
    () => ({ hasKey: cachedHasKey, isLoading: true })
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
        const value = await store.get<string>(STORE_KEY);
        const has = typeof value === "string" && value.length > 0;
        if (!cancelled) {
          cachedHasKey = has;
          setState({ hasKey: has, isLoading: false });
        }
      } catch {
        if (!cancelled) setState({ hasKey: false, isLoading: false });
      }
    })();

    const listener: Listener = (hasKey) => {
      if (!cancelled) setState({ hasKey, isLoading: false });
    };
    listeners.add(listener);

    return () => {
      cancelled = true;
      listeners.delete(listener);
    };
  }, []);

  return state;
}

// ─── Icons ────────────────────────────────────────────────────────────────

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ) : (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.243 4.243L9.88 9.88"
      />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <circle cx="12" cy="12" r="9" strokeOpacity="0.25" />
      <path strokeLinecap="round" d="M21 12a9 9 0 00-9-9" />
    </svg>
  );
}

// ─── Component ────────────────────────────────────────────────────────────

type Mode = "unset" | "set" | "editing";

export default function ApiKeysPanel() {
  const helperId = useId();
  const statusId = useId();

  const [mode, setMode] = useState<Mode>("unset");
  const [storedKey, setStoredKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [reveal, setReveal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isError, setIsError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const storeRef = useRef<Awaited<ReturnType<typeof load>> | null>(null);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
        storeRef.current = store;
        const value = await store.get<string>(STORE_KEY);
        if (cancelled) return;
        if (typeof value === "string" && value.length > 0) {
          setStoredKey(value);
          setMode("set");
          emitKeyState(true);
        } else {
          emitKeyState(false);
        }
      } catch {
        if (!cancelled) {
          emitKeyState(false);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const stripped = draft.trim();
  const canSave = stripped.length >= MIN_KEY_LENGTH;

  const handleSave = useCallback(async () => {
    if (!canSave || isSaving) return;
    setIsSaving(true);
    setIsError(false);
    try {
      const store = storeRef.current ?? (await load(STORE_FILE, { defaults: {}, autoSave: false }));
      storeRef.current = store;
      await store.set(STORE_KEY, stripped);
      await store.save();
      setStoredKey(stripped);
      setDraft("");
      setReveal(false);
      setMode("set");
      emitKeyState(true);
      toast.success("API key saved");
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Unknown error";
      setIsError(true);
      toast.error(`Could not save key: ${reason}`);
    } finally {
      setIsSaving(false);
    }
  }, [canSave, isSaving, stripped]);

  const handleEdit = useCallback(() => {
    setMode("editing");
    setDraft("");
    setIsError(false);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setMode(storedKey ? "set" : "unset");
    setDraft("");
    setReveal(false);
    setIsError(false);
  }, [storedKey]);

  const handleRemove = useCallback(async () => {
    const ok = window.confirm(
      "Remove API key? Cloud OCR will be disabled until you add a new key."
    );
    if (!ok) return;
    try {
      const store = storeRef.current ?? (await load(STORE_FILE, { defaults: {}, autoSave: false }));
      storeRef.current = store;
      await store.delete(STORE_KEY);
      await store.save();
      setStoredKey(null);
      setDraft("");
      setReveal(false);
      setMode("unset");
      emitKeyState(false);
      toast.success("API key removed");
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Could not remove key: ${reason}`);
    }
  }, []);

  // Mask: show last 4 chars
  const masked = storedKey ? maskKey(storedKey) : "";

  // Status text + color
  let statusDot = "○";
  let statusLabel = "Not set";
  let statusColor: string = "var(--text-secondary)";

  if (isError) {
    statusDot = "○";
    statusLabel = "Not set";
    statusColor = "var(--error)";
  } else if (mode === "editing") {
    statusDot = "●";
    statusLabel = "Set (editing)";
    statusColor = "var(--warning)";
  } else if (mode === "set") {
    statusDot = "●";
    statusLabel = "Set";
    statusColor = "var(--success)";
  }

  const showHelper = mode === "unset" || mode === "editing";
  const helperText =
    mode === "editing"
      ? "Save will replace the existing key"
      : "Used for cloud OCR. Get a key at openrouter.ai/keys";

  return (
    <div>
      <label
        className="mb-1 block text-[11px] font-medium uppercase tracking-[0.05em]"
        style={{ color: "var(--text-secondary)" }}
      >
        API Keys
      </label>

      <p className="mb-2 text-[12px]" style={{ color: "var(--text-secondary)" }}>
        OpenRouter key
      </p>

      {/* SET state — masked display + Edit/Remove */}
      {mode === "set" && (
        <div className="flex gap-2">
          <div
            className="flex-1 rounded-sm px-2 py-1.5 text-[13px] font-mono"
            style={{
              background: "var(--bg-input)",
              border: "1px solid var(--border-default)",
              color: "var(--text-primary)",
            }}
          >
            {masked}
          </div>
          <button
            type="button"
            onClick={handleEdit}
            className="rounded px-3 py-1.5 text-[13px] transition-colors"
            style={{
              background: "transparent",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-default)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--bg-elevated)";
              e.currentTarget.style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--text-secondary)";
            }}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={handleRemove}
            className="rounded px-3 py-1.5 text-[13px] transition-colors"
            style={{
              background: "transparent",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-default)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--bg-elevated)";
              e.currentTarget.style.color = "var(--error)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--text-secondary)";
            }}
          >
            Remove
          </button>
        </div>
      )}

      {/* UNSET / EDITING state — input + reveal toggle + save */}
      {(mode === "unset" || mode === "editing") && (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={reveal ? "text" : "password"}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (isError) setIsError(false);
              }}
              placeholder="sk-or-v1-..."
              disabled={isSaving || isLoading}
              aria-label="OpenRouter API key"
              aria-describedby={showHelper ? helperId : undefined}
              className="w-full rounded-sm px-2 py-1.5 pr-8 text-[13px] outline-none"
              style={{
                background: "var(--bg-input)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = "var(--border-focus)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = "var(--border-default)";
              }}
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              disabled={isSaving}
              aria-label={reveal ? "Hide API key" : "Show API key"}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 transition-colors"
              style={{
                background: "transparent",
                color: "var(--text-tertiary)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--text-secondary)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--text-tertiary)";
              }}
            >
              {isSaving ? <Spinner /> : <EyeIcon open={reveal} />}
            </button>
          </div>

          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave || isSaving}
            aria-disabled={!canSave || isSaving}
            className="rounded px-3 py-1.5 text-[13px] font-medium transition-colors"
            style={{
              background: canSave && !isSaving ? "var(--accent)" : "var(--bg-elevated)",
              color:
                canSave && !isSaving ? "var(--text-inverse)" : "var(--text-tertiary)",
              border: "1px solid var(--border-default)",
              opacity: canSave && !isSaving ? 1 : 0.6,
              cursor: canSave && !isSaving ? "pointer" : "not-allowed",
            }}
          >
            {isSaving ? "Saving…" : "Save"}
          </button>

          {mode === "editing" && (
            <button
              type="button"
              onClick={handleCancelEdit}
              disabled={isSaving}
              className="rounded px-3 py-1.5 text-[13px] transition-colors"
              style={{
                background: "transparent",
                color: "var(--text-secondary)",
                border: "1px solid var(--border-default)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-elevated)";
                e.currentTarget.style.color = "var(--text-primary)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--text-secondary)";
              }}
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {/* Status + helper line */}
      <div className="mt-2 flex flex-col gap-1">
        <div
          id={statusId}
          aria-live="polite"
          className="text-[11px]"
          style={{ color: statusColor }}
        >
          {statusDot} {statusLabel}
        </div>
        {showHelper && (
          <p
            id={helperId}
            className="text-[11px]"
            style={{ color: "var(--text-tertiary)" }}
          >
            {helperText}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function maskKey(key: string): string {
  const last4 = key.slice(-4);
  // Show prefix `sk-or-v1-` if present; otherwise just dots + last 4.
  const prefix = key.startsWith("sk-or-v1-") ? "sk-or-v1-" : "";
  return `${prefix}${"•".repeat(12)}${last4}`;
}
