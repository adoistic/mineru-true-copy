#!/usr/bin/env python3
"""
Benchmark script: Process documents through MinerU and extract every OCR component
with its image crop and text result. Flag any "THE QUICK BROWN FOX" hallucinations.

Saves a JSON report per document with:
- Each block's image (base64 PNG crop from the original PDF page)
- The OCR text result for that block
- Block metadata (page, category, bbox)
- Hallucination flags
"""

import json
import sys
import os
import time
import base64
import re
import requests
import subprocess

VENV_PYTHON = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'test-venv', 'bin', 'python')
PROJECT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')

MINERU_URL = "http://localhost:53269"
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "output", "pangram_bench")

PANGRAM_PATTERNS = [
    re.compile(r'THE\s+QUICK\s+BROWN\s+FOX', re.IGNORECASE),
    re.compile(r'JUMPS?\s+OVER\s+THE\s+LAZY\s+DOG', re.IGNORECASE),
    re.compile(r'quick\s+brown\s+fox\s+jumps', re.IGNORECASE),
]

CATEGORY_NAMES = {
    0: "Title",
    1: "PlainText",
    2: "Abandon",
    3: "Figure",
    4: "FigureCaption",
    5: "Table",
    6: "TableCaption",
    7: "TableFootnote",
    8: "IsolatedFormula",
    9: "FormulaCaption",
    13: "InlineEquation",
    14: "OcrText",
    15: "PageHeader",
    16: "PageFooter",
    17: "Reference",
}


def check_pangram(text: str) -> list:
    """Return list of pangram pattern matches found in text."""
    matches = []
    for pat in PANGRAM_PATTERNS:
        m = pat.search(text)
        if m:
            matches.append(m.group(0))
    return matches


def crop_page_region(pdf_path: str, page_num: int, bbox: list, scale: float = 2.0) -> str:
    """Crop a region from a PDF page and return base64 PNG."""
    script = f'''
import fitz, base64, sys
doc = fitz.open("{pdf_path}")
page = doc[{page_num}]
rect = fitz.Rect({bbox[0]}, {bbox[1]}, {bbox[2]}, {bbox[3]})
mat = fitz.Matrix({scale}, {scale})
clip = page.get_pixmap(matrix=mat, clip=rect)
png_data = clip.tobytes("png")
sys.stdout.buffer.write(base64.b64encode(png_data))
doc.close()
'''
    result = subprocess.run([VENV_PYTHON, '-c', script], capture_output=True)
    if result.returncode != 0:
        return ""
    return result.stdout.decode('ascii', errors='ignore')


def crop_full_page(pdf_path: str, page_num: int, scale: float = 1.5) -> str:
    """Render a full PDF page as base64 PNG."""
    script = f'''
import fitz, base64, sys
doc = fitz.open("{pdf_path}")
page = doc[{page_num}]
mat = fitz.Matrix({scale}, {scale})
pix = page.get_pixmap(matrix=mat)
sys.stdout.buffer.write(base64.b64encode(pix.tobytes("png")))
doc.close()
'''
    result = subprocess.run([VENV_PYTHON, '-c', script], capture_output=True)
    if result.returncode != 0:
        return ""
    return result.stdout.decode('ascii', errors='ignore')


def extract_text_recursive(obj, texts=None):
    """Recursively extract all text content from a nested result object."""
    if texts is None:
        texts = []
    if isinstance(obj, str):
        texts.append(obj)
    elif isinstance(obj, dict):
        for k, v in obj.items():
            if k in ('content', 'text', 'raw_text', 'joined_text', 'html'):
                if isinstance(v, str):
                    texts.append(v)
            else:
                extract_text_recursive(v, texts)
    elif isinstance(obj, list):
        for item in obj:
            extract_text_recursive(item, texts)
    return texts


def process_document(pdf_path: str, doc_name: str):
    """Process a document through MinerU and extract all components."""
    print(f"\n{'='*60}")
    print(f"Processing: {doc_name}")
    print(f"PDF: {pdf_path}")
    print(f"{'='*60}")

    # Step 1: Upload to MinerU via /file_parse
    print("Uploading to MinerU...")
    with open(pdf_path, 'rb') as f:
        # Build multipart form data manually
        import urllib.request
        import mimetypes
        boundary = '----FormBoundary' + str(int(time.time()))

        body_parts = []
        # File field
        body_parts.append(f'--{boundary}'.encode())
        body_parts.append(f'Content-Disposition: form-data; name="file"; filename="{os.path.basename(pdf_path)}"'.encode())
        body_parts.append(b'Content-Type: application/pdf')
        body_parts.append(b'')
        body_parts.append(f.read())
        # parse_method field
        body_parts.append(f'--{boundary}'.encode())
        body_parts.append(b'Content-Disposition: form-data; name="parse_method"')
        body_parts.append(b'')
        body_parts.append(b'auto')
        # is_json_md_dump
        body_parts.append(f'--{boundary}'.encode())
        body_parts.append(b'Content-Disposition: form-data; name="is_json_md_dump"')
        body_parts.append(b'')
        body_parts.append(b'true')
        # formula_display
        body_parts.append(f'--{boundary}'.encode())
        body_parts.append(b'Content-Disposition: form-data; name="formula_display"')
        body_parts.append(b'')
        body_parts.append(b'image')
        # End
        body_parts.append(f'--{boundary}--'.encode())
        body_parts.append(b'')

        body = b'\r\n'.join(body_parts)

        req = urllib.request.Request(
            f"{MINERU_URL}/file_parse",
            data=body,
            headers={
                'Content-Type': f'multipart/form-data; boundary={boundary}',
            },
            method='POST'
        )

        try:
            resp = urllib.request.urlopen(req, timeout=30)
            resp_data = json.loads(resp.read().decode())
        except Exception as e:
            print(f"ERROR: Upload failed: {e}")
            return None

    task_id = resp_data.get("task_id")
    print(f"Task ID: {task_id}")

    # Step 2: Poll for completion via GET /tasks/{task_id}
    print("Waiting for processing...")
    max_wait = 600
    start = time.time()
    result_data = None
    while time.time() - start < max_wait:
        try:
            status_resp = requests.get(f"{MINERU_URL}/tasks/{task_id}", timeout=10)
            task_data = status_resp.json()
        except Exception as e:
            print(f"  Poll error: {e}")
            time.sleep(3)
            continue

        status = task_data.get("status", "unknown")
        progress = task_data.get("progress", 0)

        if status == "completed":
            elapsed = time.time() - start
            print(f"Completed in {elapsed:.0f}s")
            result_data = task_data.get("result", task_data)
            break
        elif status in ("error", "failed"):
            print(f"ERROR: Processing failed: {task_data.get('error', 'unknown')}")
            return None

        print(f"  {status}: {progress}%    ", end='\r')
        time.sleep(3)
    else:
        print("TIMEOUT waiting for processing")
        return None

    # Step 3: Parse the result structure
    # The result can be nested; find pages
    pages = []
    if isinstance(result_data, dict):
        pages = result_data.get("pages", [])
        if not pages and "result" in result_data:
            r = result_data["result"]
            if isinstance(r, dict):
                pages = r.get("pages", [])

    print(f"Got {len(pages)} pages")

    # Also get the raw JSON for deep text search
    all_texts = extract_text_recursive(result_data)
    raw_pangrams = []
    for t in all_texts:
        matches = check_pangram(t)
        if matches:
            raw_pangrams.append({"text_preview": t[:300], "matches": matches})

    if raw_pangrams:
        print(f"\n*** FOUND {len(raw_pangrams)} PANGRAM REFERENCES IN RAW TEXT ***")
        for rp in raw_pangrams:
            print(f"  Matches: {rp['matches']}")
            print(f"  Text: {rp['text_preview'][:200]}")

    # Step 4: Extract components from pages
    components = []
    hallucinations = []

    for page_idx, page in enumerate(pages):
        page_num = page.get("page_number", page.get("page_idx", page_idx))

        # Try both 'regions' and 'blocks' structure
        regions = page.get("regions", page.get("blocks", []))

        for region_idx, region in enumerate(regions):
            # Get text content from various possible fields
            content = ""
            for field in ["content", "text", "html", "raw_text", "joined_text"]:
                if field in region and region[field]:
                    content += str(region[field]) + " "
            content = content.strip()

            # Also check nested lines/spans
            for line in region.get("lines", []):
                for span in line.get("spans", []):
                    span_text = span.get("content", "") or span.get("text", "")
                    if span_text:
                        content += " " + span_text

            category_id = region.get("category_id", region.get("type", -1))
            if isinstance(category_id, str):
                # Try to map string type to category
                cat_map = {"title": 0, "text": 1, "figure": 3, "table": 5, "equation": 8}
                category_id = cat_map.get(category_id, -1)
            category_name = CATEGORY_NAMES.get(category_id, f"Unknown({category_id})")
            bbox = region.get("bbox", [0, 0, 0, 0])

            # Check for pangram
            pangram_matches = check_pangram(content)
            is_hallucination = len(pangram_matches) > 0

            # Crop region image
            region_image = ""
            if bbox and bbox != [0, 0, 0, 0] and is_hallucination:
                # Only crop images for hallucinated regions (save time)
                region_image = crop_page_region(pdf_path, page_idx, bbox)

            component = {
                "page": page_num,
                "region_index": region_idx,
                "category_id": category_id,
                "category_name": category_name,
                "bbox": bbox,
                "content": content,
                "content_preview": content[:150] if content else "",
                "image_base64": region_image,
                "is_pangram_hallucination": is_hallucination,
                "pangram_matches": pangram_matches,
            }
            components.append(component)

            if is_hallucination:
                hallucinations.append({
                    "page": page_num,
                    "region_index": region_idx,
                    "category_name": category_name,
                    "bbox": bbox,
                    "content": content[:500],
                    "matches": pangram_matches,
                })

    # Step 5: Get page images for hallucinated pages
    page_images = {}
    for h in hallucinations:
        pg = h["page"]
        if pg not in page_images:
            page_images[pg] = crop_full_page(pdf_path, pg if isinstance(pg, int) else int(pg))

    # Step 6: Save report
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    report = {
        "document": doc_name,
        "pdf_path": pdf_path,
        "total_pages": len(pages),
        "total_components": len(components),
        "total_hallucinations": len(hallucinations),
        "raw_text_pangrams": raw_pangrams,
        "hallucinations": hallucinations,
        "hallucination_page_images": {str(k): v for k, v in page_images.items()},
        "components": components,
    }

    report_path = os.path.join(OUTPUT_DIR, f"{doc_name}_pangram_report.json")
    with open(report_path, 'w') as f:
        json.dump(report, f, indent=2)
    print(f"\nReport saved: {report_path}")
    print(f"Total components: {len(components)}")
    print(f"PANGRAM HALLUCINATIONS: {len(hallucinations)}")
    print(f"RAW TEXT PANGRAMS: {len(raw_pangrams)}")

    if hallucinations:
        print("\n--- HALLUCINATION DETAILS ---")
        for h in hallucinations:
            print(f"  Page {h['page']}, {h['category_name']}, bbox={h['bbox']}")
            print(f"    Matches: {h['matches']}")
            print(f"    Text: {h['content'][:200]}")
            print()

    if raw_pangrams and not hallucinations:
        print("\n--- RAW TEXT PANGRAM MATCHES (not in structured regions) ---")
        for rp in raw_pangrams:
            print(f"  Matches: {rp['matches']}")
            print(f"  Text: {rp['text_preview'][:200]}")
            print()

    # Save summary without images
    summary = {
        "document": doc_name,
        "total_pages": len(pages),
        "total_components": len(components),
        "total_hallucinations": len(hallucinations),
        "raw_text_pangrams": raw_pangrams,
        "hallucinations": hallucinations,
        "components_summary": [
            {
                "page": c["page"],
                "region_index": c["region_index"],
                "category_name": c["category_name"],
                "bbox": c["bbox"],
                "content_preview": c["content_preview"],
                "is_pangram_hallucination": c["is_pangram_hallucination"],
            }
            for c in components
        ],
    }
    summary_path = os.path.join(OUTPUT_DIR, f"{doc_name}_summary.json")
    with open(summary_path, 'w') as f:
        json.dump(summary, f, indent=2)
    print(f"Summary saved: {summary_path}")

    # Also save the full raw MinerU result for deep inspection
    raw_path = os.path.join(OUTPUT_DIR, f"{doc_name}_raw_result.json")
    with open(raw_path, 'w') as f:
        json.dump(result_data, f, indent=2)
    print(f"Raw result saved: {raw_path}")

    # Cleanup task
    try:
        requests.delete(f"{MINERU_URL}/tasks/{task_id}", timeout=5)
    except Exception:
        pass

    return report


def main():
    # Check MinerU health
    try:
        health = requests.get(f"{MINERU_URL}/health", timeout=5)
        if health.json().get("status") != "ok":
            print("MinerU not healthy!")
            sys.exit(1)
    except Exception as e:
        print(f"Cannot reach MinerU at {MINERU_URL}: {e}")
        sys.exit(1)

    print("MinerU is healthy. Starting benchmark...")

    docs = [
        (os.path.join(PROJECT_ROOT, "PDF", "iess102.pdf"), "iess102"),
        (os.path.join(PROJECT_ROOT, "PDF", "2604.00252v1.pdf"), "2604_00252v1"),
    ]

    results = {}
    for pdf_path, doc_name in docs:
        if not os.path.exists(pdf_path):
            print(f"WARNING: {pdf_path} not found, skipping")
            continue
        report = process_document(pdf_path, doc_name)
        if report:
            results[doc_name] = {
                "total_components": report["total_components"],
                "total_hallucinations": report["total_hallucinations"],
                "raw_text_pangrams": len(report["raw_text_pangrams"]),
            }

    print(f"\n{'='*60}")
    print("BENCHMARK SUMMARY")
    print(f"{'='*60}")
    for doc, stats in results.items():
        h_count = stats["total_hallucinations"] + stats["raw_text_pangrams"]
        status = "HALLUCINATIONS FOUND" if h_count > 0 else "CLEAN"
        print(f"  {doc}: {stats['total_components']} components, {h_count} hallucinations — {status}")


if __name__ == "__main__":
    main()
