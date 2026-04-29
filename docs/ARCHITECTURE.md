# Architecture

This document describes MinerU True Copy as it ships in v0.1. It covers the
process model, the OCR and translation data flows, where state lives, and the
concurrency limits enforced by the job queue. Pointers to source files use
absolute paths from the repository root.

The project is an AGPL-3.0 desktop application. There is no telemetry, no
cloud back end, and no auth layer. Everything described below runs on the
user's machine.

## 1. Process topology

The app is a single Tauri bundle that supervises three processes. The Tauri
shell (Rust) is the parent. It launches two sidecars on free local ports and
then points its WebView at the Node.js sidecar's URL.

```
+----------------------------------------------------------------+
|  Tauri shell  (Rust, src-tauri/src/main.rs)                    |
|  - Spawns sidecars, waits on /health, opens WebView            |
|  - Hosts tauri-plugin-store, tauri-plugin-fs, tauri-plugin-    |
|    dialog, tauri-plugin-shell                                  |
+----------------+------------------+----------------------------+
                 | spawn            | spawn
                 v                  v
   +------------------------+   +-----------------------------+
   |  Node.js sidecar       |   |  MinerU sidecar             |
   |  (node-server)         |   |  (mineru-server)            |
   |  Next.js standalone    |   |  Python, mineru_server.py   |
   |  port: node_port       |   |  port: mineru_port          |
   +-----------+------------+   +-----------------------------+
               ^                        ^
               |  navigate()            |
               |                        | HTTP (server-side fetch in Next.js)
   +-----------+------------+           |
   |  WebView (Tauri)       |           |
   |  Loads Next.js UI from +-----------+
   |  http://127.0.0.1:node_port        |
   |  Calls Next.js API     |           |
   |  routes (same origin)  |           |
   +-----------+------------+           |
                                        | HTTP (server-side fetch in Next.js)
                                        v
                          +-----------------------------+
                          |  Translation sidecar        |
                          |  (translation_server.py)    |
                          |  Python, IndicTrans2        |
                          |  port: TRANSLATION_SERVER_  |
                          |        URL (separate proc)  |
                          +-----------------------------+
```

Note: the arrows from Node.js sidecar to MinerU sidecar and to Translation
sidecar both originate at the Node.js process. The WebView never calls
MinerU or Translation directly — all sidecar traffic is server-side fetches
inside Next.js API routes.

IPC mechanisms in use:

- **Tauri shell to sidecars**: `tauri-plugin-shell` spawns each sidecar as a
  child process and forwards stdout/stderr to the parent. PIDs are tracked so
  Tauri can SIGTERM them on window close.
- **Tauri shell to WebView**: emits the `splash-update` event during sidecar
  boot. After both health checks pass, the shell calls `window.navigate()` to
  point the WebView at `http://127.0.0.1:<node_port>`.
- **WebView to Node.js sidecar**: same-origin HTTP. The UI is served by the
  Next.js standalone server, so component code calls Next.js API routes with
  ordinary `fetch`.
- **Node.js sidecar to MinerU sidecar**: server-side `fetch` to
  `http://127.0.0.1:<mineru_port>/...`. See `app/src/lib/mineru/client.ts`.
- **Node.js sidecar to Translation sidecar**: server-side `fetch` to
  `TRANSLATION_SERVER_URL`. Same client file.
- **WebView to persisted settings**: `@tauri-apps/plugin-store` (the JS side
  of `tauri-plugin-store`). Used for the OpenRouter API key and similar user
  preferences. See `app/src/components/settings/ApiKeysPanel.tsx`.

There are no custom Tauri commands today. All app logic lives behind Next.js
API routes; the Rust shell only handles process lifecycle and the splash
screen.

## 2. OCR pipeline data flow

A PDF dropped into the UI flows through five stages. Stages 1 to 4 always
run; stage 5 (heading correction) is opt-in and only runs when the user
asks for it.

```
+--------------+   1. submitFile()       +---------------------------+
|  UI (drop)   | ----------------------> |  Next.js API route        |
+--------------+                         |  enqueues via jobQueue    |
                                         +-------------+-------------+
                                                       |
                                                       v
                                         +---------------------------+
                                         |  PipelineRunner           |
                                         |  app/src/lib/pipelines/   |
                                         |  runner.ts                |
                                         +-------------+-------------+
                                                       |
                                                       v
                                         +---------------------------+
                                         |  OcrPipeline.execute()    |
                                         |  app/src/lib/pipelines/   |
                                         |  ocr.ts                   |
                                         +-------------+-------------+
                                                       |
                          2. POST /file_parse          |
                          3. GET  /tasks/{id}  (poll)  |
                                                       v
                                         +---------------------------+
                                         |  MinerU sidecar           |
                                         |  mineru_server.py         |
                                         |  - layout, OCR, formula,  |
                                         |    table, reading order   |
                                         |  - writes middle.json     |
                                         |    (MinerU's intermediate |
                                         |    block/bbox/reading-    |
                                         |    order representation)  |
                                         |    + img_dir under        |
                                         |    /tmp/mineru_*          |
                                         +-------------+-------------+
                                                       |
                                                       v
                                         +---------------------------+
                                         |  MineruOutput JSON in     |
                                         |  Node memory              |
                                         +-------------+-------------+
                                                       |
                          4. exportAll()               |
                                                       v
                                         +---------------------------+
                                         |  Exporters                |
                                         |  app/src/lib/export/      |
                                         |  - markdown.ts            |
                                         |  - reflowed-docx.ts       |
                                         |  - reflowed-pdf.ts        |
                                         |  - searchable-pdf.ts      |
                                         |  - true-copy-html.ts      |
                                         |  - true-copy-docx.ts      |
                                         |  - true-copy-pdf.ts       |
                                         |  - true-copy-pptx.ts      |
                                         |  - epub.ts                |
                                         +-------------+-------------+
                                                       |
                          5. (optional) heading        |
                             correction re-runs        |
                             stage 4                   |
                                                       v
                                         +---------------------------+
                                         |  Output folder            |
                                         |  <basename>/Data/...      |
                                         +---------------------------+
```

Stage detail:

1. **Drop and enqueue**: the UI uploads the file and calls a Next.js API
   route, which calls `jobQueue.enqueue(...)` in
   `app/src/lib/pipelines/queue.ts`.
2. **Submit to MinerU**: `OcrPipeline.execute()` posts the file to MinerU's
   `POST /file_parse` (handled in `mineru_server.py` at line 2860). MinerU
   spawns a worker, runs layout analysis, OCR, formula and table recognition,
   and assembles the standard MinerU `middle.json` (MinerU's intermediate
   block/bbox/reading-order representation).
3. **Poll**: the pipeline calls `GET /tasks/{id}` (line 2740 in
   `mineru_server.py`) until the task reports completion. Per-page progress
   is forwarded to the UI via the runner's `onProgress` callback.
4. **Export**: `exportAll(...)` in `app/src/lib/export/index.ts` walks the
   `MineruOutput` JSON and writes the requested output formats to the user's
   chosen output folder.
5. **Heading correction (optional)**: if the user runs it,
   `HeadingCorrectionPipeline` (`app/src/lib/pipelines/heading-correction.ts`)
   reads back the saved OCR JSON, runs a two-pass LLM call (TOC detection
   then a single bulk heading-level assignment for all titles), updates the
   JSON in place, and re-invokes `exportAll(...)`.
6. **Cleanup**: the OCR pipeline calls `DELETE /tasks/{id}` (line 2829 in
   `mineru_server.py`) so the server can free the per-task `pipe_result`,
   PDF bytes, and `img_dir`.

The MinerU intermediate artifacts live under `/tmp/mineru_*` for the
duration of a task. The runner sweeps stale `doctransform-uploads/` temp
files older than 24 hours on startup (`runner.ts` line 161).

## 3. Translation pipeline data flow

The translation UI is fully shipped at v0.1. The component
(`app/src/components/tools/TranslationTool.tsx`, 1,482 lines) supports file
drop, multi-language selection, model variant picking, bulk folder processing,
and live progress. The status bar shows "Translation Ready" / "Translation
Offline" based on a health check against `/api/translation/health`. Urdu is
the only language disabled in v0.1 (`TranslationTool.tsx:94`,
`disabledReason: "RTL coming soon"`).

The translation sidecar (`translation_server.py`) is a separate process that
the user starts manually via `./test-venv/bin/python translation_server.py`.
Unlike the MinerU server, it is NOT auto-spawned by Tauri at v0.1 — see
section 1.

```
+--------------+   text or OCR JSON   +-------------------------------+
|  UI / job    | -------------------> |  TranslationPipeline.execute  |
|  queue       |                      |  app/src/lib/pipelines/       |
+--------------+                      |  translation.ts               |
                                      +---------------+---------------+
                                                      |
                          POST /translate             |
                                                      v
                                      +-------------------------------+
                                      |  Translation sidecar          |
                                      |  translation_server.py        |
                                      |  - IndicTrans2                |
                                      |  - MPS (Metal Performance     |
                                      |    Shaders, Apple's GPU       |
                                      |    compute layer) on Apple    |
                                      |    Silicon, CUDA when         |
                                      |    available, else CPU        |
                                      +---------------+---------------+
                                                      |
                          translated_json             |
                                                      v
                                      +-------------------------------+
                                      |  <basename>_<tgt_lang>.json   |
                                      |  in output folder             |
                                      +-------------------------------+
```

Behaviour notes:

- The pipeline iterates `tgt_langs` and calls `submitTranslation(...)` once
  per target language. Per-language progress is reported to the runner.
- Translation runs in its **own Python process**, separate from MinerU, to
  avoid GPU and RAM contention between OCR and translation models.
- Endpoints exposed by `translation_server.py`: `GET /health`,
  `POST /translate` (line 341), `POST /translate/batch` (346),
  `GET /translate/status/{id}` (302), `GET /translate/models` (319),
  `POST /translate/model/load` (351), `POST /translate/model/unload` (356).

## 4. Key directories

| Path                         | Role                                                            |
| ---------------------------- | --------------------------------------------------------------- |
| `app/`                       | Next.js 15 frontend (UI, exports, pipeline orchestration)       |
| `app/src/app/`               | Next.js routes (`page.tsx`, `layout.tsx`, `api/`)               |
| `app/src/lib/pipelines/`     | `runner.ts`, `queue.ts`, `ocr.ts`, `extraction.ts`, `heading-correction.ts`, `translation.ts`, `types.ts` |
| `app/src/lib/db/`            | `sqlite.ts` (jobs, schema templates, WAL)                       |
| `app/src/lib/mineru/`        | HTTP client to MinerU and translation sidecars                  |
| `app/src/lib/export/`        | True-copy and reflowed exporters (DOCX, PDF, PPTX, HTML, EPUB)  |
| `app/src/lib/llm/`           | OpenRouter client for heading correction and extraction         |
| `src-tauri/`                 | Rust shell, Tauri config, capabilities, sidecar wiring          |
| `src-tauri/src/main.rs`      | Process supervisor and splash flow (251 lines)                  |
| `src-tauri/capabilities/`    | Plugin permissions (shell, fs, dialog, store)                   |
| `lib/`                       | Python modules and pytest tests (`patch_mineru.py`, `vision_llm_ocr.py`, `translation.py`, `tests/`) |
| `mineru-venv/`               | Placeholder; not committed. The real production venv is `test-venv/`, per the build scripts |
| `scripts/`                   | `build-app.sh`, `build-mineru.sh`, `build-node-sidecar.sh`, `bundle-mineru.spec`, `download-noto-fonts.sh` |
| `spikes/`                    | Research and experimentation; not part of the shipped app       |
| `mineru_server.py`           | MinerU REST sidecar (3,247 lines; module split deferred to v0.2 — see section 8) |
| `translation_server.py`      | IndicTrans2 REST sidecar (604 lines)                            |

## 5. Entry points

| User-visible action              | Entry point                                                      |
| -------------------------------- | ---------------------------------------------------------------- |
| Launch the app                   | `src-tauri/src/main.rs` `main()` (251 lines)                     |
| First UI rendered                | `app/src/app/page.tsx` (with `app/src/app/layout.tsx`)           |
| Run OCR on a PDF                 | `mineru_server.py` `POST /file_parse` (line 2860)                |
| Poll OCR progress                | `mineru_server.py` `GET /tasks/{id}` (line 2740)                 |
| Free OCR resources for a task    | `mineru_server.py` `DELETE /tasks/{id}` (line 2829)              |
| Translate text or OCR JSON       | `translation_server.py` `POST /translate` (line 341)             |
| Pipeline orchestration           | `app/src/lib/pipelines/runner.ts`, `queue.ts`                    |
| Persist OpenRouter API key       | `app/src/components/settings/ApiKeysPanel.tsx` via `tauri-plugin-store` |

## 6. State management

State is partitioned by lifetime and by who owns it. There is no global
store; each layer owns what it needs.

- **Persisted user settings** — `tauri-plugin-store`. The OpenRouter API key
  and theme preferences live here. The store is granted to the app via
  `src-tauri/capabilities/default.json` (`store:default`).
- **Job queue and history** — SQLite, via `app/src/lib/db/sqlite.ts`. The
  database lives at `~/.doctransform/doctransform.db` with WAL journal mode.
  Two tables: `jobs` (one row per OCR/extraction/translation job, including
  status, retry count, output file paths) and `schema_templates` (saved
  extraction schemas).
- **In-memory** — Next.js components hold UI state (current document,
  selected exports, transient progress events). Progress events are streamed
  through the in-process emitter at `runner.ts` lines 14 to 43.
- **Filesystem scratch** — `/tmp/mineru_*` for MinerU's per-task
  intermediate artifacts (PDF copy, page images, `pipe_result`).
  `os.tmpdir()/doctransform-uploads/` for inbound file uploads; the runner
  sweeps anything older than 24 hours on startup
  (`runner.ts` `cleanupOldTempFiles()`).
- **Output folder** — chosen by the user per job. Exports land under
  `<output_folder>/<basename>/Data/`.

On startup the queue calls `resetStuckJobs()` to flip any job left in
`processing` (from a hard shutdown) back to `queued` so it gets re-run
(`queue.ts` lines 117 to 128).

## 7. Concurrency model

The job queue (`app/src/lib/pipelines/queue.ts`) keeps two independent
counters: one for OCR-class work and one for LLM-class work.

- **OCR slots** are derived from system memory by `calcOcrSlots()`
  (`queue.ts` lines 25 to 30):

  ```
  slots = max(1, floor((totalMemoryGb - 4 - 3) / 4))
  ```

  Reserved: 4 GB for the OS, 3 GB for MinerU models at rest, ~4 GB per
  concurrent job. Under this formula a 16 GB Mac yields **2 slots** in
  theory; in practice MPS (Metal Performance Shaders, Apple's GPU compute
  layer) serializes inference, so on common 16 GB hardware the effective
  concurrency is around 1. The header comment caps the result at 5 even on
  much larger machines.

- **LLM slots** are fixed: `maxConcurrentLlm = 30` (`queue.ts` line 37). LLM
  work (extraction and heading correction) is API-bound, so the limit is set
  by upstream rate limits, not local resources.

`isOcrType(jobType)` routes `ocr` and `heading_correction` jobs through the
OCR counter; everything else goes through the LLM counter (`queue.ts` lines
61 to 70). The queue is sorted ascending by page count so small documents
do not get starved behind large ones (`queue.ts` lines 47 to 53).

Each job goes through `PipelineRunner` (`runner.ts`), which retries up to
`MAX_RETRIES = 2` times on classified-retryable errors (`mineru_crash`,
`rate_limited`, `network_error`, `partial_failure`). See
`classifyError()` in `app/src/lib/pipelines/types.ts`.

## 8. Module split (deferred to v0.2)

`mineru_server.py` is 3,247 lines. Filed as GitHub issue #1
(`good first issue`) for v0.2: split into `server.py` (HTTP layer),
`cleanup.py` (the `/tmp/mineru_*` sweep and disk-space guard),
`processing.py` (the MinerU invocation and per-page work), and `fonts.py`
(font handling). No design changes are proposed in this document.
