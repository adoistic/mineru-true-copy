"use client";

import { useState, useCallback } from "react";

interface ActivationScreenProps {
  onActivated: (keyId: string) => void;
}

export default function ActivationScreen({
  onActivated,
}: ActivationScreenProps) {
  const [rawInput, setRawInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formatKey = (value: string): string => {
    const digits = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 16);
    const parts: string[] = [];
    for (let i = 0; i < digits.length; i += 4) {
      parts.push(digits.slice(i, i + 4));
    }
    return parts.join("-");
  };

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setError(null);
      const formatted = formatKey(e.target.value);
      setRawInput(formatted);
    },
    []
  );

  const getDeviceId = (): string => {
    let id = localStorage.getItem("device_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("device_id", id);
    }
    return id;
  };

  const handleActivate = useCallback(async () => {
    const clean = rawInput.replace(/-/g, "");
    if (clean.length !== 16) {
      setError("Please enter a valid 16-character activation key.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: rawInput, device_id: getDeviceId() }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Activation failed. Please try again.");
      }

      const data = await res.json();
      localStorage.setItem("key_id", data.key_id ?? data.id ?? rawInput);
      onActivated(data.key_id ?? data.id ?? rawInput);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Activation failed. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }, [rawInput, onActivated]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleActivate();
    },
    [handleActivate]
  );

  return (
    <div
      className="flex min-h-screen items-center justify-center"
      style={{ background: 'var(--bg-app)' }}
    >
      <div
        className="w-full max-w-md rounded-md p-8"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
      >
        <div className="mb-8 text-center">
          <div
            className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-md text-xl font-bold"
            style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
          >
            DT
          </div>
          <h1 className="text-[20px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            DocTransform
          </h1>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            Enter your activation key to get started
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="activation-key"
              className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.05em]"
              style={{ color: 'var(--text-secondary)' }}
            >
              Activation Key
            </label>
            <input
              id="activation-key"
              type="text"
              value={rawInput}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              maxLength={19}
              className="w-full rounded-sm px-4 py-2.5 text-center font-mono text-[16px] tracking-widest outline-none"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-primary)',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--border-focus)'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-default)'; }}
              disabled={loading}
            />
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
            onClick={handleActivate}
            disabled={loading || rawInput.replace(/-/g, "").length !== 16}
            className="w-full rounded py-2.5 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
            onMouseEnter={(e) => {
              if (!e.currentTarget.disabled) e.currentTarget.style.background = 'var(--accent-hover)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--accent)';
            }}
          >
            {loading ? "Activating..." : "Activate"}
          </button>
        </div>
      </div>
    </div>
  );
}
