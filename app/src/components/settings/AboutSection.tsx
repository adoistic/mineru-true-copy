"use client";

/**
 * About / Credits section for the Settings overlay.
 *
 * AGPL §5 obligation: the running application must expose a license / notice
 * surface to its users. This section satisfies that by:
 *  - Naming the app (MinerU True Copy v0.1.0).
 *  - Linking to the AGPL-3.0 LICENSE on the public mirror.
 *  - Linking to the upstream source repository.
 *  - Attributing the third-party components MinerU True Copy is built on,
 *    with their respective licenses.
 *
 * All external links route through `@tauri-apps/plugin-shell`'s `open()` so
 * they hit the system browser instead of opening inside the Tauri WebView.
 */

import { forwardRef } from "react";
import { open } from "@tauri-apps/plugin-shell";

const REPO_URL = "https://github.com/adoistic/mineru-true-copy";
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

interface Attribution {
  name: string;
  license: string;
  url: string;
}

const ATTRIBUTIONS: Attribution[] = [
  { name: "MinerU", license: "AGPL-3.0", url: "https://github.com/opendatalab/MinerU" },
  { name: "IndicTrans2", license: "Apache-2.0", url: "https://github.com/AI4Bharat/IndicTrans2" },
  { name: "PaddleOCR", license: "Apache-2.0", url: "https://github.com/PaddlePaddle/PaddleOCR" },
  { name: "font_classifier", license: "MIT", url: "https://github.com/gaborcselle/font-identifier" },
  { name: "Noto Sans", license: "OFL-1.1", url: "https://fonts.google.com/noto" },
  { name: "Geist", license: "OFL-1.1", url: "https://vercel.com/font" },
];

const sectionHeaderClass =
  "text-[11px] font-medium uppercase tracking-[0.05em]";

const AboutSection = forwardRef<HTMLDivElement>(function AboutSection(_, ref) {
  const handleOpen = (url: string) => {
    // Fire-and-forget; if Tauri shell isn't available (e.g. during browser
    // dev outside Tauri), this just rejects silently. Wrap in Promise.resolve
    // so a non-thenable return from a test mock doesn't blow up.
    try {
      Promise.resolve(open(url)).catch(() => {
        /* swallow — user-facing failure is acceptable for a link-out */
      });
    } catch {
      /* swallow synchronous throw too */
    }
  };

  return (
    <div ref={ref}>
      <div
        className={`mb-1 ${sectionHeaderClass}`}
        style={{ color: "var(--text-secondary)" }}
      >
        About
      </div>

      <p
        className="text-[14px] font-semibold"
        style={{ color: "var(--text-primary)" }}
      >
        MinerU True Copy v0.1.0
      </p>

      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px]">
        <span style={{ color: "var(--text-secondary)" }}>AGPL-3.0</span>
        <span style={{ color: "var(--text-tertiary)" }}>·</span>
        <button
          type="button"
          onClick={() => handleOpen(LICENSE_URL)}
          className="rounded-sm transition-colors hover:underline"
          style={{ color: "var(--accent)", background: "transparent" }}
        >
          View license
        </button>
        <span style={{ color: "var(--text-tertiary)" }}>·</span>
        <button
          type="button"
          onClick={() => handleOpen(REPO_URL)}
          className="rounded-sm transition-colors hover:underline"
          style={{ color: "var(--accent)", background: "transparent" }}
        >
          View source
        </button>
      </div>

      <div
        className={`mt-3 mb-2 ${sectionHeaderClass}`}
        style={{ color: "var(--text-secondary)" }}
      >
        Built on
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th
              scope="col"
              className={`${sectionHeaderClass} pb-1.5 text-left`}
              style={{ color: "var(--text-secondary)" }}
            >
              Component
            </th>
            <th
              scope="col"
              className={`${sectionHeaderClass} pb-1.5 text-left`}
              style={{ color: "var(--text-secondary)" }}
            >
              License
            </th>
          </tr>
        </thead>
        <tbody>
          {ATTRIBUTIONS.map((attr, idx) => (
            <tr
              key={attr.name}
              style={
                idx === 0
                  ? undefined
                  : { borderTop: "1px solid var(--border-default)" }
              }
            >
              <td className="py-1.5 text-[12px]">
                <button
                  type="button"
                  onClick={() => handleOpen(attr.url)}
                  className="rounded-sm transition-colors hover:underline"
                  style={{ color: "var(--accent)", background: "transparent" }}
                >
                  {attr.name}
                </button>
              </td>
              <td
                className="py-1.5 text-[12px]"
                style={{ color: "var(--text-secondary)" }}
              >
                {attr.license}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

export default AboutSection;
