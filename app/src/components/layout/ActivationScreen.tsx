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
    <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-lg dark:bg-slate-900">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-600 text-2xl font-bold text-white">
            DT
          </div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-white">
            DocTransform
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Enter your activation key to get started
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="activation-key"
              className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300"
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
              className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-center font-mono text-lg tracking-widest text-slate-900 placeholder:text-slate-300 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:placeholder:text-slate-600"
              disabled={loading}
            />
          </div>

          {error && (
            <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-400">
              {error}
            </p>
          )}

          <button
            onClick={handleActivate}
            disabled={loading || rawInput.replace(/-/g, "").length !== 16}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Activating..." : "Activate"}
          </button>
        </div>
      </div>
    </div>
  );
}
