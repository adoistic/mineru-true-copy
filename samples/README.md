# samples/

Scripts and instructions for producing the README hero comparison images.

## What goes here

This folder holds **scripts** and **generated outputs**. We don't ship sample PDFs (copyright varies — government PDFs are usually fine, but you should pick what you compare against).

You drop a representative PDF in here (anything containing **bold or italic emphasis** in the source layout — Hindi government gazettes, NCERT textbooks, Sanskrit critical editions, an academic paper with bold theorem labels, etc.) and run the comparison script.

Suggested public-domain sources:
- Hindi government gazettes from `egazette.gov.in` (Government of India Press releases)
- NCERT textbooks from `ncert.nic.in/textbook.php` (Hindi/Sanskrit/regional language editions are dense with styled headers)
- Wikisource Indic projects (`hi.wikisource.org`, `sa.wikisource.org`, `ta.wikisource.org`) — out-of-copyright scanned books
- Any IEEE or ACM paper PDF (bold theorem labels, italic axiom names)

## The comparison

We want to demonstrate the README's central claim: **PaddleOCR strips bold and italic from OCR output; vision-LLM OCR preserves them.** The script runs the same PDF through MinerU's pipeline twice — once in `local` mode (PaddleOCR) and once in `cloud` mode (VLM via OpenRouter) — and produces a side-by-side HTML page showing the structural difference in the OCR output.

## Prerequisites

1. **`mineru_server.py` running on port 8765.** Start it from the repo root:
   ```bash
   ./mineru-venv/bin/python mineru_server.py
   ```

2. **`OPENROUTER_API_KEY` set in `mineru_server.py`'s environment** (the *server's* env, not the script's — the server is the one calling OpenRouter). Either export it before launching the server, or put it in a `.env` the server loads.

3. **A sample PDF in this folder.** Drop it as `samples/<your-name>.pdf`.

## Usage

```bash
# From the repo root
node samples/run-ocr-comparison.mjs samples/your-pdf-name.pdf
```

The script:

1. POSTs the PDF to the running mineru_server with `processing_mode=local`.
2. Polls `/tasks/{id}` until the run completes.
3. Pulls the MinerU content list via `/tasks/{id}/export/content_list`.
4. Saves it as `samples/out/<basename>-local.json`.
5. Repeats with `processing_mode=cloud`.
6. Saves as `samples/out/<basename>-cloud.json`.
7. Generates `samples/out/<basename>-comparison.html` — side-by-side rendering of both content lists.

## Producing the README hero image

1. Run the script with a representative PDF.
2. Open `samples/out/<basename>-comparison.html` in any browser.
3. Scroll to a region where bold/italic differences are visible (titles, section headers, theorem labels are good candidates).
4. Screenshot that region (the page is designed at 1600 px wide so two columns fit cleanly).
5. Save as `samples/comparison-bold-italic.png`.
6. Reference it from the README hero (the README is set up to expect the image at `samples/comparison-bold-italic.png` — see the "Why this exists" section).

## Notes on what the image proves

The script renders each content list as semantic HTML — `<b>` and `<i>` spans come from MinerU's content list output, which preserves whatever the OCR backend returned. In local mode, those spans are absent (PaddleOCR strips emphasis at the OCR stage). In cloud mode, the VLM returns text with `<b>` and `<i>` markers and MinerU passes them through unchanged.

So the comparison image is a real artifact of the pipeline, not a stylized illustration. Anyone running the same script on the same PDF should get the same structural difference.
