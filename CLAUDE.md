# DocTransform — Data Transformation App

## Project Overview

Desktop document processing application built with Tauri + Next.js + Python (MinerU wrapper).
Three core capabilities: OCR, Data Extraction, and Translation.
Design doc: `~/.gstack/projects/DataTransformationApp/siraj-unknown-design-20260402-212633.md`

## Key Constraints

- All file processing is local. Only LLM API calls go over the network (via OpenRouter).
- White-labeled: NO mention of OpenRouter, MinerU, PaddleOCR, or any LLM model names in the UI.
- Activation key system (no user auth/registration).
- Credit-based billing: 1 credit flat for extraction, 1 credit/page for OCR, 2 credits/page for translation.

## MinerU-First Rule (CRITICAL)

**NEVER reimplement functionality that MinerU already provides.** Do not write custom regex,
heuristics, or workarounds for problems MinerU's pipeline already solves. This includes but
is not limited to: line joining, paragraph merging, list detection, formula handling, column
detection, language-aware text processing, and dehyphenation.

Before writing ANY custom text processing logic, you MUST:
1. Search `test-venv/lib/python3.12/site-packages/magic_pdf/` for existing implementations
2. Check if MinerU's pipeline already tags, classifies, or handles the case (e.g. `IS_LIST_START_LINE`)
3. Use MinerU's native output (e.g. `merge_para_with_text`, `get_content_list`, `get_markdown`)

The only places where custom code is justified are:
- HTML rendering (MinerU outputs markdown, we need HTML)
- Base64 image embedding (MinerU writes to disk, we need inline data)
- Heading hierarchy heuristic (MinerU doesn't assign H1-H6)
- VLM integration (replacing PaddleOCR with vision LLM, which MinerU itself supports via config)
- Export format serializers (DOCX, PPTX, PDF — MinerU only outputs markdown/JSON)

## Pretext Renderer Constraint (CRITICAL)

All true-copy exports (HTML, DOCX, PPTX, PDF) use Pretext for font sizing via canvas measurement.
Pretext requires a browser/canvas context. This means:
- **All true-copy export code MUST run in the Tauri WebView renderer process** (Next.js frontend)
- Do NOT move true-copy export logic to API routes or Node.js background workers
- The `@chenglou/pretext` library uses `CanvasRenderingContext2D` internally — no canvas = no measurement
- Fonts must be loaded via `@font-face` in the WebView before Pretext can measure with them
- For future batch processing, `node-canvas` or similar would be needed (not yet implemented)

Even in these cases, we are extending MinerU, not replacing it. If you find yourself writing
regex to detect list items, numbered sections, or paragraph boundaries — STOP. MinerU already
did this work during its pipeline. Use its tags and decisions.

## Starting the App

When the user says "start the app", "open the app", "launch the app", or similar,
start ALL of the following processes — not just one:

**CRITICAL:** Source `.env` before starting any process. The MinerU server uses VisionLLM OCR
which requires `OPENROUTER_API_KEY`. Without it, all OCR silently fails and outputs are empty.
Use: `export $(grep -v '^#' .env | grep -v '^\s*$' | xargs)` from the project root.

1. **MinerU server** (Python sidecar): `./test-venv/bin/python mineru_server.py --port <random>`
2. **Next.js main app**: `MINERU_API_URL="http://localhost:<mineru_port>" npx next dev --port <random>` (from `app/`)
3. **Admin app**: `npx next dev --port <random>` (from `admin/`)
4. **Tauri desktop app**: `cargo tauri dev` (from project root, after Next.js is up)
5. **Open browser tabs** for the main app and admin app

Use random high ports (49152-65000) for all services to avoid conflicts.
Use `localhost` (not `127.0.0.1`) for all URLs — Firebase Auth authorizes `localhost` by default.
The Tauri `devUrl` in `src-tauri/tauri.conf.json` must match the Next.js port.
Wait for MinerU model warm-up (`/health` returns `{"status": "ok"}`) before launching Tauri.
PATH must include `/opt/homebrew/bin` for Node and `/Users/siraj/.cargo/bin` for Cargo.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
