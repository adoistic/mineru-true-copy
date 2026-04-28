"use client";

import { useState, useEffect } from "react";
import SplashScreen from "@/components/layout/SplashScreen";
import SettingsOverlay from "@/components/settings/SettingsOverlay";
import OcrTool from "@/components/tools/OcrTool";
import ExtractionTool from "@/components/tools/ExtractionTool";
import TranslationTool from "@/components/tools/TranslationTool";

type ToolId = "ocr" | "extraction" | "translation";

interface ToolDef {
  id: ToolId;
  label: string;
  badge?: string;
  icon: React.ReactNode;
}

const TOOLS: ToolDef[] = [
  {
    id: "ocr",
    label: "OCR",
    icon: (
      <svg
        className="h-5 w-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m5.231 13.481L15 17.25m-4.5-15H5.625c-.621 0-1.125.504-1.125 1.125v16.5c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9zm3.75 11.625a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
        />
      </svg>
    ),
  },
  {
    id: "extraction",
    label: "Extract",
    icon: (
      <svg
        className="h-5 w-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0112 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0h7.5c.621 0 1.125.504 1.125 1.125M3.375 8.25c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m17.25-3.75h-7.5c-.621 0-1.125.504-1.125 1.125m8.625-1.125c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M12 10.875v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M12 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125M10.875 12h-1.5m1.5 0c.621 0 1.125.504 1.125 1.125M12 12h7.5m-7.5 0c0 .621-.504 1.125-1.125 1.125M20.625 12c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-1.5m1.5 0c.621 0 1.125.504 1.125 1.125"
        />
      </svg>
    ),
  },
  {
    id: "translation",
    label: "Translate",
    icon: (
      <svg
        className="h-5 w-5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M10.5 21l5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 016-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364C11.176 10.658 7.69 15.08 3 17.502m9.334-12.138c.896.061 1.785.147 2.666.257m-4.589 8.495a18.023 18.023 0 01-3.827-5.802"
        />
      </svg>
    ),
  },
];

export default function Home() {
  const [enginesReady, setEnginesReady] = useState(false);
  const [activeTool, setActiveTool] = useState<ToolId>("ocr");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mineruStatus, setMineruStatus] = useState<"green" | "yellow" | "red">(
    "yellow"
  );
  const [translationStatus, setTranslationStatus] = useState<"green" | "red">("red");
  const [activeJobs, setActiveJobs] = useState(0);

  // Poll MinerU status and active jobs
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch("/api/status");
        if (res.ok) {
          const data = await res.json();
          setMineruStatus(data.mineru_status ?? "yellow");
          setActiveJobs(data.active_jobs ?? 0);
        }
      } catch {
        setMineruStatus("red");
      }

      try {
        const tRes = await fetch("/api/translation/health");
        setTranslationStatus(tRes.ok ? "green" : "red");
      } catch {
        setTranslationStatus("red");
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  if (!enginesReady) {
    return <SplashScreen onReady={() => setEnginesReady(true)} />;
  }

  const statusDotColor =
    mineruStatus === "green"
      ? "bg-ok"
      : mineruStatus === "yellow"
        ? "bg-warn"
        : "bg-err";

  return (
    <div className="flex h-screen flex-col" style={{ background: 'var(--bg-app)' }}>
      {/* Header — h-10, bg-surface, border-b */}
      <header
        className="flex h-10 shrink-0 items-center justify-between border-b px-4"
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-default)' }}
      >
        <div className="flex items-center gap-2">
          <div
            className="flex h-6 w-6 items-center justify-center rounded text-[10px] font-bold"
            style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
          >
            DT
          </div>
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            DocTransform
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Settings gear */}
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded p-1 transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            aria-label="Settings"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar — w-16 icon rail */}
        <aside
          className="flex w-16 shrink-0 flex-col items-center border-r py-3 gap-1"
          style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-default)' }}
        >
          {TOOLS.map((tool) => {
            const isActive = activeTool === tool.id;
            return (
              <button
                key={tool.id}
                onClick={() => setActiveTool(tool.id)}
                className="relative flex w-12 flex-col items-center gap-0.5 rounded py-2 transition-colors"
                style={{
                  background: isActive ? 'var(--accent-muted)' : 'transparent',
                  color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'var(--bg-elevated)';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'transparent';
                }}
              >
                {tool.icon}
                <span className="text-[10px] font-medium leading-tight">{tool.label}</span>
                {tool.badge && (
                  <span
                    className="absolute -top-0.5 -right-0.5 rounded-full px-1 text-[8px] font-medium"
                    style={{ background: 'var(--warning-muted)', color: 'var(--warning)' }}
                  >
                    {tool.badge}
                  </span>
                )}
              </button>
            );
          })}
        </aside>

        {/* Center content — flex-1, darkest bg */}
        <main className="flex-1 overflow-y-auto p-6" style={{ background: 'var(--bg-app)' }}>
          <div className="mx-auto max-w-2xl">
            {activeTool === "ocr" && <OcrTool />}
            {activeTool === "extraction" && <ExtractionTool />}
            {activeTool === "translation" && <TranslationTool />}
          </div>
        </main>
      </div>

      {/* Status bar — h-6, bg-surface, border-t */}
      <footer
        className="flex h-6 shrink-0 items-center justify-between border-t px-4"
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-default)' }}
      >
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2 w-2 rounded-full ${statusDotColor}`} />
            <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              OCR {mineruStatus === "green"
                ? "Ready"
                : mineruStatus === "yellow"
                  ? "Starting..."
                  : "Offline"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2 w-2 rounded-full ${translationStatus === "green" ? "bg-ok" : "bg-err"}`} />
            <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              Translation {translationStatus === "green" ? "Ready" : "Offline"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {activeJobs > 0
              ? `${activeJobs} job${activeJobs !== 1 ? "s" : ""}`
              : "No jobs"}
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            v1.0.0
          </span>
        </div>
      </footer>

      {/* Settings overlay */}
      <SettingsOverlay
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
