# Roadmap

## v0.1 — shipped

### Platform

- macOS `.dmg` for Apple Silicon and Intel (universal binary via `tauri-action`).
- AGPL-3.0 license, enforced by the `lib/patch_mineru.py` runtime integration with upstream MinerU.

### OCR

- **Local OCR** via PaddleOCR — default, no key required, works offline.
- **Cloud OCR** via OpenRouter — user supplies their own key through Settings; VLM returns bold and italic spans that PaddleOCR strips.

### Translation

- IndicTrans2 sidecar (`translation_server.py`) with MPS-aware batching tuned for Apple Silicon.
- 21 of 22 IndicTrans2 languages active in the UI. Urdu is shown but disabled ("RTL coming soon").
- The translation sidecar must be started manually before use; Tauri does not auto-spawn it.

### Heading correction

- Two-pass LLM pipeline: TOC extraction pass, then a single LLM call assigns `h1`–`h6` levels to all headings in the document.

### Exports

Eleven export targets ship in v0.1, organized into three groups:

**True-copy** (layout-preserving, per-glyph placement via `@chenglou/pretext` + WebKit canvas):

| Format | Notes |
|---|---|
| HTML | Self-contained, text at exact positions |
| Word (.docx) | Positioned text boxes |
| PDF | Reconstructed with visible text at exact positions |
| PowerPoint (.pptx) | Slides with positioned text boxes |

**Reflowed** (clean, editable, paragraph flow):

| Format | Notes |
|---|---|
| HTML | Semantic HTML with headings and tables |
| Word (.docx) | Editable with proper styles |
| PDF | Paragraph flow and page breaks |
| Markdown | Plain text with Markdown formatting |
| EPUB | Reflowable e-book |

**Data:**

| Format | Notes |
|---|---|
| Searchable PDF | Original PDF with invisible OCR text layer |
| JSON | Structured OCR output with regions and bounding boxes |

### Settings and UX

- OpenRouter key management in Settings: six explicit states (unset, typing, saving, set, editing, error).
- About/Credits section with AGPL notice and third-party attribution table.
- Status bar `AGPL-3.0` indicator links directly to the About section.

---

## v0.2 — candidates

Nothing below is committed. Each item is marked **candidate** because it is under consideration, not scheduled. Sequencing depends on contributor interest, hardware access, and scope.

### Refactor `mineru_server.py` into modules

**Candidate.** The file is 3,241 lines. The split is mechanical: `server.py`, `cleanup.py`, `processing.py`, `fonts.py`. Filed as issue #1, tagged `good first issue`. Blocked only by someone having time to do it — no design decisions required.

### Translation sidecar auto-spawn from Tauri

**Candidate.** The MinerU sidecar is auto-spawned on app start; the translation sidecar is not. Wiring it up follows the same pattern already in `src-tauri/src/main.rs`. Blocked by the translation models being large and warm-up being slow — the UX for a lazy-start or on-demand spawn needs thought.

### Urdu (RTL) translation support

**Candidate.** The language entry exists in `TranslationTool.tsx` and is disabled with `"RTL coming soon"`. IndicTrans2 supports Urdu. The blocker is rendering: right-to-left text in the export serializers and in the UI language list both need work.

### Image toggle and true-copy HTML export with pretext

**Candidate.** The true-copy HTML serializer (`app/src/lib/export/true-copy-html.ts`) exists. The candidate feature adds a per-document option to show or hide embedded images in the export, and exposes a clean true-copy HTML download suitable as a QA/benchmark artifact. Depends on the pretext measurement pipeline being stable.

### Discarded block recovery for styled headers

**Candidate.** MinerU's `Abandon` classifier misclassifies large styled headers as discarded content. A content-bounds approach to recover them has been proposed but is not implemented. See README "Known limitations" item 2. This is a genuine accuracy gap for documents with prominent section headers. Touches MinerU classifier internals (`lib/patch_mineru.py`) and the upstream Abandon heuristic — non-trivial relative to peer candidates here.

### Multi-file batch UI

**Candidate.** Queue logic exists in `app/src/lib/pipelines/queue.ts`. No UI exposes it. A batch panel with per-file status, a stop control, and progress would unlock processing hundreds of documents without manual re-submission. The supporting work — page-count pre-calculation (so the UI can warn before a large run starts) and LRU model-cache eviction under memory pressure — is not yet written.

### Broader VLM provider support

**Candidate.** Cloud OCR currently routes through OpenRouter only. Direct Anthropic and OpenAI API keys are natural additions — they eliminate the OpenRouter intermediary for users who already have accounts with those providers. The abstraction in `lib/vision_llm_ocr.py` is thin enough that adding a provider is small work.

### Windows and Linux builds

**Candidate.** No Windows or Linux builds exist. The `tauri-action` matrix already supports both targets. The blockers are: Python environment packaging for non-macOS, MinerU dependency testing on Linux, and no CI runner with a Windows cert for signing. See README "Known limitations" item 1 and `docs/HELP-WANTED.md`.

---

## Future / longer-term

No timelines. No commitments. These are directions worth naming so contributors understand the intent.

- **VLM-only mode.** Skip PaddleOCR entirely and route all OCR through a vision-language model. Removes the PaddleOCR dependency for non-Latin script documents where VLMs significantly outperform it.
- **Self-hosted MinerU server with shared cache for teams.** The current architecture runs one MinerU process per desktop. A networked variant with a shared model cache and job queue would serve small document-processing teams without each member needing a full local install.
- **Plugin API for custom export formats.** The export serializers in `app/src/lib/export/` are internal. Exposing a plugin interface would let users add formats (JATS XML, IDML, custom JSON schemas) without forking.
- **16GB Apple Silicon translation perf.** The current IndicTrans2 batching is tuned conservatively for 16GB MacBook Air. Quantized model variants or progressive batch-size negotiation could improve throughput on constrained hardware.
