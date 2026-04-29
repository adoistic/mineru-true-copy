# Help Wanted

Five concrete ways to contribute at v0.1. Each ask has enough context to scope
the work before opening a PR — read the relevant files first.

## Index

1. [Windows and Linux builds](#1-windows-and-linux-builds)
2. [Discarded block recovery for styled headers](#2-discarded-block-recovery-for-styled-headers)
3. [`mineru_server.py` module split](#3-mineru_serverpy-module-split)
4. [Document the Python dependency manifest](#4-document-the-python-dependency-manifest)
5. [Memory budget on 16 GB MacBook Air](#5-memory-budget-on-16-gb-macbook-air)
6. [Fix pre-existing lint errors so CI lint can be tightened](#6-fix-pre-existing-lint-errors-so-ci-lint-can-be-tightened)

---

### 1. Windows and Linux builds

**Difficulty:** intermediate

**The problem:** MinerU True Copy ships macOS-only at v0.1, and the `.dmg` is
arm64-only (built on the `macos-latest` runner's host arch). There is no Intel
build, no Windows installer, and no Linux package — which blocks the majority
of potential users entirely.

**Where to start:**
- `.github/workflows/ci.yml` — the Windows and Linux jobs belong in this file
  alongside the existing `macos-latest` job in the `test` matrix and the `release` job.
- `src-tauri/tauri.conf.json` — Tauri's `bundle` targets config.
- `scripts/build-mineru.sh` — the MinerU venv build script; Linux requires
  different PaddleOCR wheels; Windows requires a different env setup.

**Acceptance criteria:**
- A PR adds Windows and Linux matrix jobs to `.github/workflows/ci.yml`.
- On tag push: a `.msi` (Windows) and both `.deb` and `.AppImage` (Linux) are
  produced and uploaded to the GitHub release.
- The MinerU Python sidecar builds and launches correctly on each target platform.
- macOS builds are not regressed.

**Discuss first if:** the MinerU Linux dependency story turns out to be more
involved than expected — Paddle wheel availability and OpenCV system deps on
Ubuntu/Debian have been moving targets historically.

---

### 2. Discarded block recovery for styled headers

**Difficulty:** advanced

**The problem:** MinerU's layout model classifies some real content as `Abandon`
(category 2). Large styled section headers — e.g. the word "EXERCISE" on a colored
background — are silently dropped from OCR output. The current heuristic in
`_recover_discarded_blocks()` recovers many of these, but the classification of
which blocks are genuinely decorative vs. genuine content is fragile and has
known failure modes on PDFs with prominent section headers.

**Where to start:**
- `mineru_server.py` `_recover_discarded_blocks()` — line 1349. This is the
  full recovery pipeline: Phase 1 collects discarded blocks, Phase 2 counts
  repetition, Phase 3 classifies and re-inserts.
- `mineru_server.py` `_is_decorative_block()` — line 1989. The classification
  heuristic that currently gates recovery.
- `mineru_server.py` `_content_x_union()` — line 1972. Content-bounds helper
  used by both the main pipeline and the discarded block path.
- `lib/tests/test_pangram_hallucination.py` — existing test that exercises the
  Abandon path; any fix must not regress it.

**Acceptance criteria:**
- A content-bounds heuristic (using the page's measured content x-range and
  typical line height) recovers headers that fall within normal content bounds
  but are currently misclassified as decorative.
- All existing tests in `lib/tests/` still pass.
- A new test fixture (one real-world PDF or a synthetic stand-in) demonstrates
  that the offending header class is correctly recovered.

**Discuss first if:** you plan to change the Abandon classifier threshold rather
than post-processing recovered blocks — that touches MinerU internals in a way
that may break upstream compatibility.

---

### 3. `mineru_server.py` module split

**Difficulty:** good-first-issue

**The problem:** `mineru_server.py` is 3,247 lines. It contains HTTP routing,
MinerU invocation, per-task cleanup, and font handling all in one file. It is
hard to read, hard to review, and slow to navigate. The split is filed as
GitHub issue #1.

**Where to start:**
- `mineru_server.py` — the whole file. Proposed split:
  - `server.py` — HTTP layer (`BaseHTTPRequestHandler` subclass, routing,
    request/response serialization)
  - `processing.py` — MinerU invocation, per-page work, `_recover_discarded_blocks`
  - `cleanup.py` — `/tmp/mineru_*` sweep, disk-space guard, task eviction
  - `fonts.py` — font loading, font classifier, `_typical_line_height` helpers
- `lib/tests/test_*.py` — the full test suite; it runs against the current
  import surface and must pass after the split with no behavior changes.

**Acceptance criteria:**
- Each new module has a single clear responsibility.
- All tests in `lib/tests/` still pass without modification.
- No observable behavior change: the same HTTP endpoints respond identically.
- `mineru_server.py` either becomes a thin entry-point shim or is removed and
  replaced by `server.py`.

**Discuss first if:** you want to reorganize the internal function groupings
beyond the four proposed modules — do that in a separate follow-up PR so the
mechanical split stays reviewable.

---

### 4. Document the Python dependency manifest

**Difficulty:** good-first-issue

**The problem:** There is no `requirements.txt` at v0.1. Python dependencies are
implied by `scripts/bundle-mineru.spec` (the PyInstaller hidden-imports list),
the imports at the top of `mineru_server.py`, and institutional memory. A new
contributor cannot recreate a working `mineru-venv/` from scratch without reading
three files and guessing version constraints.

**Where to start:**
- `scripts/bundle-mineru.spec` — the canonical list of packages that must be
  present in the bundle (lines 22–46 enumerate the `collect_submodules` calls).
- `mineru_server.py` — top-level imports; cross-reference against the spec.
- `lib/translation.py` and `translation_server.py` — translation sidecar deps
  (IndicTrans2, psutil, torch) are a separate surface from the MinerU deps.
- `CONTRIBUTING.md` — add a "Setting up the Python environment" section.

**Acceptance criteria:**
- A `requirements.txt` at repo root (or `pyproject.toml` with optional-deps) that
  recreates a working `mineru-venv/` from scratch on a clean macOS install.
- The contributor has actually tested venv recreation: `python -m venv test-venv2 &&
  test-venv2/bin/pip install -r requirements.txt` then run the existing test suite.
- `CONTRIBUTING.md` is updated to reference the new file with setup instructions.

**Discuss first if:** you find version conflicts between MinerU's pinned deps and
the IndicTrans2 deps — propose a split (`requirements-mineru.txt` /
`requirements-translation.txt`) before opening the PR.

---

### 5. Memory budget on 16 GB MacBook Air

**Difficulty:** intermediate

**The problem:** On a 16 GB MacBook Air, MinerU OCR and the browser together
consume most of the unified memory budget before translation starts. The
IndicTrans2 batch tuning is deliberately conservative (batch size 4, greedy
decoding), but users on 32 GB+ machines are bottlenecked by the same conservative
defaults and cannot easily override them without reading source.

**Where to start:**
- `lib/translation.py` `_auto_tune()` — line 197. This function picks
  `(batch_size, num_beams)` from a tiered table based on total system RAM. It
  already supports `TRANSLATION_BATCH_SIZE` and `TRANSLATION_NUM_BEAMS` env
  var overrides, but those overrides are not documented in the UI or README.
- `app/src/lib/pipelines/translation.ts` — the TypeScript pipeline that invokes
  the translation sidecar; the env vars would need to be surfaced here or in
  the Settings panel if you go the UI route.
- `app/src/lib/pipelines/queue.ts` `calcOcrSlots()` — line 25. Related: the OCR
  concurrency budget uses a similar heuristic and has the same documentation gap.

**Acceptance criteria:**
Either of the following is acceptable — discuss which you want to attempt before
starting:

- **Option A (dynamic negotiation):** implement available-MPS-memory probing
  in `_auto_tune()` (using `torch.mps.current_allocated_memory()` or equivalent)
  and grow batch size dynamically when memory is available, with a safe fallback.
- **Option B (documented overrides):** add a Settings UI field (or README section
  with clear instructions) that lets users set `TRANSLATION_BATCH_SIZE` and
  `TRANSLATION_NUM_BEAMS` without editing source, and document the recommended
  values for 16 GB vs. 32 GB vs. 64 GB machines.

All existing tests in `lib/tests/test_translation.py` must still pass.

**Discuss first if:** you want to tackle MPS memory probing — the
`torch.mps` memory API is under-documented and behavior varies across
PyTorch versions; confirm your approach on both 2.x and 2.5+ first.

---

## 6. Fix pre-existing lint errors so CI lint can be tightened

**Difficulty:** good-first-issue

**The problem:** The CI lint step is set to `continue-on-error: true` at v0.1
because the codebase has 9 pre-existing lint errors that accumulated before
CI enforcement existed. Lint output is visible on every PR, but it does not
gate merges. Once the errors are fixed, the `continue-on-error` line in
`.github/workflows/ci.yml` can be removed and lint becomes a real gate.

**Where to start:** these are the 9 errors as of v0.1 (run `cd app && npm run lint`
to confirm the current list):

| File | Line | Rule | Fix shape |
|---|---|---|---|
| `app/src/components/processing/JobProgress.tsx` | 29 | `react-hooks/refs` (ref-during-render) | Move `callbacksRef.current = …` into a `useEffect` |
| `app/src/components/tools/TranslationTool.tsx` | 845 | `react/no-unescaped-entities` | Replace `'` with `&apos;` |
| `app/src/lib/env.ts` | 5, 8 | `@typescript-eslint/no-require-imports` | Convert `require('dotenv')` to `import` |
| `app/src/lib/export/__tests__/font-resolver.test.ts` | 162 | `@typescript-eslint/no-explicit-any` | Replace `as any` with the actual `Script` type, or add a per-line `eslint-disable-next-line` with rationale (this is a test exercising an out-of-domain script) |
| `app/src/lib/export/searchable-pdf.ts` | 1 | `@typescript-eslint/ban-ts-comment` | The `@ts-nocheck` is justified (`pdf-lib` internal APIs); replace with `@ts-expect-error` per-line or add a per-rule `eslint-disable` with rationale |
| `app/src/lib/export/true-copy-docx.ts` | 235 | `prefer-const` | `let eqH` → `const eqH` |
| `app/src/lib/export/true-copy-pdf.ts` | 425 | `prefer-const` | `let fontSize` → `const fontSize` |
| `app/src/lib/pipelines/extraction.ts` | 147 | `@typescript-eslint/no-require-imports` | Hoist `require('os')` to a top-level `import os from 'os'` |

**Acceptance criteria:**
- `cd app && npm run lint` returns exit code 0 with zero errors. Warnings are out of scope for this ask.
- Remove the `continue-on-error: true` line from the lint step in
  `.github/workflows/ci.yml` (around line 70). Add a one-line note in the
  PR description that lint is now a hard gate.
- All existing `vitest`, `pytest`, and `cargo check` jobs still pass.

**Discuss first if:** removing `@ts-nocheck` from `searchable-pdf.ts` surfaces
cascading TypeScript errors. The file uses `pdf-lib` internal APIs without
public typings; the right move may be a per-line `@ts-expect-error` rather
than deleting the directive entirely.
