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
