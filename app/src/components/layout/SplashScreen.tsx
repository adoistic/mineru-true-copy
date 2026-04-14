"use client";

import { useEffect, useState } from "react";

interface EngineStatus {
  label: string;
  state: "waiting" | "loading" | "ready" | "error";
  detail?: string;
}

interface SplashScreenProps {
  onReady: () => void;
}

/**
 * Splash screen shown at app startup while OCR + Translation engines
 * warm up their models. Blocks the main UI until both report ready.
 */
export default function SplashScreen({ onReady }: SplashScreenProps) {
  const [engines, setEngines] = useState<{
    ocr: EngineStatus;
    translation: EngineStatus;
  }>({
    ocr: { label: "OCR engine", state: "waiting" },
    translation: { label: "Translation engine", state: "waiting" },
  });
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    let cancelled = false;

    const tick = setInterval(() => {
      if (!cancelled) setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);

    async function poll() {
      let ocrReady = false;
      let translationReady = false;

      try {
        const res = await fetch("/api/status");
        if (res.ok) {
          const data = await res.json();
          const s = data.mineru_status ?? "yellow";
          ocrReady = s === "green";
          setEngines((prev) => ({
            ...prev,
            ocr: {
              label: "OCR engine",
              state: s === "green" ? "ready" : s === "red" ? "error" : "loading",
              detail: s === "green" ? "Ready" : s === "red" ? "Offline" : "Loading models...",
            },
          }));
        } else {
          setEngines((prev) => ({
            ...prev,
            ocr: { ...prev.ocr, state: "loading", detail: "Starting..." },
          }));
        }
      } catch {
        setEngines((prev) => ({
          ...prev,
          ocr: { ...prev.ocr, state: "loading", detail: "Starting..." },
        }));
      }

      try {
        const res = await fetch("/api/translation/health");
        if (res.ok) {
          const data = await res.json();
          translationReady = Boolean(data.ready);
          setEngines((prev) => ({
            ...prev,
            translation: {
              label: "Translation engine",
              state: data.ready ? "ready" : "loading",
              detail: data.ready
                ? "Ready"
                : data.available
                  ? "Loading model..."
                  : "Starting...",
            },
          }));
        } else {
          setEngines((prev) => ({
            ...prev,
            translation: {
              ...prev.translation,
              state: "loading",
              detail: "Starting...",
            },
          }));
        }
      } catch {
        setEngines((prev) => ({
          ...prev,
          translation: {
            ...prev.translation,
            state: "loading",
            detail: "Starting...",
          },
        }));
      }

      if (!cancelled && ocrReady && translationReady) {
        clearInterval(tick);
        clearInterval(interval);
        onReady();
      }
    }

    poll();
    const interval = setInterval(poll, 1500);

    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(tick);
    };
  }, [onReady]);

  return (
    <div
      className="flex min-h-screen items-center justify-center"
      style={{ background: "var(--bg-app)" }}
    >
      <div className="w-full max-w-md px-8">
        {/* Logo */}
        <div className="mb-8 flex items-center justify-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-[6px] text-[13px] font-bold"
            style={{ background: "var(--accent)", color: "var(--text-inverse)" }}
          >
            DT
          </div>
          <div className="text-[16px] font-semibold" style={{ color: "var(--text-primary)" }}>
            DocTransform
          </div>
        </div>

        {/* Engines */}
        <div
          className="rounded p-5 space-y-3"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--border-default)" }}
        >
          <div
            className="mb-1 text-[11px] font-medium uppercase tracking-[0.05em]"
            style={{ color: "var(--text-secondary)" }}
          >
            Starting Engines
          </div>

          <EngineRow status={engines.ocr} />
          <EngineRow status={engines.translation} />

          <div
            className="mt-3 pt-3 text-[11px]"
            style={{
              color: "var(--text-tertiary)",
              borderTop: "1px solid var(--border-subtle)",
            }}
          >
            {elapsed}s elapsed. First launch takes longer while models warm up.
          </div>
        </div>
      </div>
    </div>
  );
}

function EngineRow({ status }: { status: EngineStatus }) {
  const iconColor =
    status.state === "ready"
      ? "var(--success)"
      : status.state === "error"
        ? "var(--error)"
        : "var(--warning)";

  return (
    <div className="flex items-center gap-3">
      <div className="flex h-5 w-5 shrink-0 items-center justify-center">
        {status.state === "ready" ? (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke={iconColor} strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : status.state === "error" ? (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke={iconColor} strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <span
            className="inline-block h-3 w-3 animate-spin rounded-full border-2"
            style={{ borderColor: "var(--border-default)", borderTopColor: "var(--accent)" }}
          />
        )}
      </div>
      <div className="flex-1">
        <div className="text-[13px]" style={{ color: "var(--text-primary)" }}>
          {status.label}
        </div>
        {status.detail && (
          <div className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
            {status.detail}
          </div>
        )}
      </div>
    </div>
  );
}
