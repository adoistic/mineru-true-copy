"use client";

export default function TranslationTool() {
  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
        Translation
      </h2>

      {/* Under construction banner */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-center dark:border-amber-900/50 dark:bg-amber-950/20">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
          <svg
            className="h-7 w-7 text-amber-600 dark:text-amber-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z"
            />
          </svg>
        </div>
        <h3 className="mb-2 text-lg font-semibold text-amber-800 dark:text-amber-300">
          Under Construction
        </h3>
        <p className="mx-auto max-w-md text-sm text-amber-700 dark:text-amber-400">
          Document translation is coming soon. This feature will allow you to
          translate PDF documents while preserving their original layout and
          formatting. Stay tuned for updates.
        </p>
      </div>

      {/* Grayed-out mockup */}
      <div className="pointer-events-none select-none opacity-40">
        <div className="space-y-4">
          {/* Mock file drop */}
          <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 p-8 dark:border-slate-600">
            <svg
              className="h-10 w-10 text-slate-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z"
              />
            </svg>
            <p className="mt-2 text-sm text-slate-500">
              Drop a PDF to translate
            </p>
          </div>

          {/* Mock options */}
          <div className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-800">
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-sm text-slate-600">
                  Source Language
                </label>
                <div className="h-9 rounded-lg border border-slate-300 bg-slate-50 dark:border-slate-600" />
              </div>
              <div>
                <label className="mb-1 block text-sm text-slate-600">
                  Target Language
                </label>
                <div className="h-9 rounded-lg border border-slate-300 bg-slate-50 dark:border-slate-600" />
              </div>
              <div>
                <label className="mb-1 block text-sm text-slate-600">
                  Output Folder
                </label>
                <div className="h-9 rounded-lg border border-slate-300 bg-slate-50 dark:border-slate-600" />
              </div>
            </div>
          </div>

          <button
            disabled
            className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white opacity-50"
          >
            Translate
          </button>
        </div>
      </div>
    </div>
  );
}
