"""
MinerU REST API server — wraps the MinerU Python library to serve
the /health, /file_parse, and /tasks/{id} endpoints expected by the
Next.js OCR pipeline client.

Usage:
    ./mineru-venv/bin/python mineru_server.py
    ./mineru-venv/bin/python mineru_server.py --port 9000 --models-dir /path/to/models
"""

# PyInstaller compatibility: patch inspect + transformers docstring decorator.
# transformers uses @docstring_decorator which calls inspect.getsource()
# at class definition time. This fails in PyInstaller because .py source
# files are not included in the bundle.
import inspect
_original_getsource = inspect.getsource
_original_getsourcelines = inspect.getsourcelines
_original_findsource = inspect.findsource
def _safe_getsource(obj, **kwargs):
    try:
        return _original_getsource(obj, **kwargs)
    except (OSError, TypeError):
        return '    pass\n'
def _safe_getsourcelines(obj, **kwargs):
    try:
        return _original_getsourcelines(obj, **kwargs)
    except (OSError, TypeError):
        return (['    pass\n'], 0)
def _safe_findsource(obj):
    try:
        return _original_findsource(obj)
    except (OSError, TypeError):
        return (['    pass\n'], 0)
inspect.getsource = _safe_getsource
inspect.getsourcelines = _safe_getsourcelines
inspect.findsource = _safe_findsource

import argparse
import lib.patch_mineru  # noqa: F401
import json
import os
import tempfile
import threading
import time
import traceback
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

# MinerU imports
from magic_pdf.data.dataset import PymuDocDataset
from magic_pdf.model.doc_analyze_by_custom_model import doc_analyze
from magic_pdf.data.data_reader_writer.filebase import FileBasedDataWriter
from magic_pdf.libs.pdf_image_tools import cut_image
from magic_pdf.libs.commons import join_path
from magic_pdf.config.ocr_content_type import ContentType

import base64
import hashlib
import fitz  # PyMuPDF


def _crop_and_embed(bbox, page_idx, fitz_page, img_dir: str, pdf_md5: str,
                    label: str = 'crop') -> dict | None:
    """Crop a region from a PDF page and return base64-embedded image data.

    Returns dict with {img_path, img_data, img_mime} or None on failure.
    Centralises the cut_image → read file → base64 encode pattern.
    """
    try:
        return_path = join_path(pdf_md5, label)
        img_path = cut_image(
            bbox, page_idx, fitz_page,
            return_path=return_path,
            imageWriter=FileBasedDataWriter(img_dir),
        )
        img_full_path = os.path.join(img_dir, img_path)
        if os.path.exists(img_full_path):
            with open(img_full_path, 'rb') as f:
                img_data = base64.b64encode(f.read()).decode('ascii')
            ext = os.path.splitext(img_path)[1].lower()
            img_mime = 'image/jpeg' if ext in ('.jpg', '.jpeg') else 'image/png'
            return {'img_path': img_path, 'img_data': img_data, 'img_mime': img_mime}
        else:
            print(f'[MinerU Server] WARNING: Cropped image not found: {img_full_path}')
            return None
    except Exception as e:
        print(f'[MinerU Server] Failed to crop {label} on page {page_idx}: {e}')
        return None


# Task store (in-memory) with LRU eviction
MAX_TASKS = 3
tasks: dict[str, dict] = {}


def _evict_old_tasks():
    """Evict oldest tasks when over MAX_TASKS limit."""
    while len(tasks) > MAX_TASKS:
        oldest_id = next(iter(tasks))
        old_task = tasks.pop(oldest_id)
        # Clean up temp directory if it exists
        img_dir = old_task.get('_img_dir')
        if img_dir:
            import shutil
            try:
                shutil.rmtree(img_dir, ignore_errors=True)
            except Exception:
                pass
        print(f'[MinerU Server] Evicted task {oldest_id} ({len(tasks)} remaining)')

# Dynamic concurrency based on system memory
# ~3GB base for models, ~2GB per concurrent OCR job, reserve 4GB for OS
def _calc_ocr_slots():
    import psutil
    total_gb = psutil.virtual_memory().total / (1024 ** 3)
    # Reserve 4GB for OS, 3GB for models at rest, ~4GB per concurrent job
    # (inference tensors + rasterized pages + base64 images + output buffers)
    slots = max(1, int((total_gb - 4 - 3) / 4))
    # No artificial cap — let memory be the only constraint
    print(f"[MinerU] System RAM: {total_gb:.0f}GB → OCR concurrency: {slots}")
    return slots

_max_ocr_concurrent = _calc_ocr_slots()
_parse_semaphore = threading.Semaphore(_max_ocr_concurrent)

# Server readiness state — starts as "warming" until models are pre-loaded
_server_status = "warming"


def _crop_equation_images(pdf_bytes: bytes, pdf_info: list, image_writer):
    """Post-process MinerU results to crop equation spans from the PDF.

    MinerU's cut_image.py only crops ContentType.Image and ContentType.Table.
    This patches in crops for interline and inline equations so they get
    image_path set, just like images and tables do.
    """

    pdf_md5 = hashlib.md5(pdf_bytes).hexdigest()

    doc = fitz.open(stream=pdf_bytes, filetype='pdf')
    cropped = 0

    try:
        for page_info in pdf_info:
            page_idx = page_info.get('page_idx', 0)
            if page_idx >= len(doc):
                continue
            fitz_page = doc[page_idx]

            # Collect all spans from all block structures on this page
            all_spans = []
            for block in page_info.get('para_blocks', page_info.get('preproc_blocks', [])):
                # Direct lines -> spans
                for line in block.get('lines', []):
                    all_spans.extend(line.get('spans', []))
                # Nested blocks -> lines -> spans
                for inner_block in block.get('blocks', []):
                    for line in inner_block.get('lines', []):
                        all_spans.extend(line.get('spans', []))

            span_types_found = {}
            for span in all_spans:
                span_type = span.get('type', '')
                span_types_found[span_type] = span_types_found.get(span_type, 0) + 1

                if span_type not in (ContentType.InterlineEquation, ContentType.InlineEquation):
                    continue
                if span.get('image_path'):
                    continue  # already has an image
                bbox = span.get('bbox')
                if not bbox or bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
                    print(f'[MinerU Server] Skipping equation span on page {page_idx}: invalid bbox={bbox}')
                    continue

                return_path = join_path(pdf_md5, 'equations')
                try:
                    img_path = cut_image(
                        bbox, page_idx, fitz_page,
                        return_path=return_path,
                        imageWriter=image_writer,
                    )
                    span['image_path'] = img_path
                    cropped += 1
                except Exception as crop_err:
                    print(f'[MinerU Server] Failed to crop equation on page {page_idx}: {crop_err}')

            if span_types_found:
                print(f'[MinerU Server] Page {page_idx} span types: {span_types_found}')
    finally:
        doc.close()

    print(f'[MinerU Server] Equation image cropping: {cropped} cropped')


def process_pdf(task_id: str, pdf_bytes: bytes, file_name: str, config: dict | None = None):
    """Run full MinerU OCR pipeline and store the structured result."""
    try:
        tasks[task_id]['status'] = 'processing'
        t_start = time.time()
        config = config or {}

        ds = PymuDocDataset(pdf_bytes, lang='en')

        # Step 1: Model inference (layout detection + OCR)
        # formula_enable controls UniMerNet (LaTeX recognition), NOT formula detection.
        # The layout model always detects equation bounding boxes regardless.
        # When formula_display='image', we still need detection (for bounding boxes to crop)
        # but can skip LaTeX recognition (UniMerNet) since we'll show images.
        # HOWEVER: MinerU's formula_enable=False skips the ENTIRE formula pipeline,
        # including detection. So we must always enable it.
        formula_enable = True
        table_enable = config.get('table_display') != 'image'
        t1 = time.time()
        infer_result = ds.apply(
            doc_analyze,
            ocr=True,
            lang='en',
            formula_enable=formula_enable,
            table_enable=table_enable,
        )
        skipped = []
        if not formula_enable:
            skipped.append('UniMerNet (formula)')
        if not table_enable:
            skipped.append('table structure recognition')
        if skipped:
            print(f'[MinerU Server] Skipped: {", ".join(skipped)}')
        t2 = time.time()
        print(f'[MinerU Server] Step 1 (model inference): {t2-t1:.1f}s')

        # Step 2: Run full pipeline (paragraph merging, heading detection,
        # table extraction, reading order, image extraction)
        tmpdir = tempfile.mkdtemp(prefix='mineru_')
        img_dir = os.path.join(tmpdir, 'images')
        image_writer = FileBasedDataWriter(img_dir)
        pipe_result = infer_result.pipe_ocr_mode(
            image_writer, debug_mode=True, lang='en'
        )
        t3 = time.time()
        print(f'[MinerU Server] Step 2 (pipe_ocr_mode): {t3-t2:.1f}s')

        # Step 2b: Crop equation images (MinerU only crops images + tables)
        raw = pipe_result._pipe_res
        pdf_info_raw = raw.get('pdf_info', [])
        _crop_equation_images(pdf_bytes, pdf_info_raw, image_writer)
        t3b = time.time()
        print(f'[MinerU Server] Step 2b (equation crops): {t3b-t3:.1f}s')

        # Step 2c: Assign heading hierarchy (H1-H6) to title blocks
        _assign_heading_levels(pdf_info_raw)
        t3c = time.time()
        print(f'[MinerU Server] Step 2c (heading hierarchy): {t3c-t3b:.1f}s')

        # Step 3: Convert pipeline output to the format the client expects
        # img_dir is where MinerU wrote extracted images
        _current_img_dir = img_dir

        # Open PDF once for all cropping operations in Step 3
        _fitz_doc = fitz.open(stream=pdf_bytes, filetype='pdf')
        _pdf_md5 = hashlib.md5(pdf_bytes).hexdigest()

        pages = []
        for page in pdf_info_raw:
            page_idx = page.get('page_idx', 0)
            page_size = page.get('page_size', {})
            # page_size may be a dict or a list [width, height]
            if isinstance(page_size, list):
                width = page_size[0] if len(page_size) > 0 else 612
                height = page_size[1] if len(page_size) > 1 else 792
            elif isinstance(page_size, dict):
                width = page_size.get('width', 612)
                height = page_size.get('height', 792)
            else:
                width, height = 612, 792

            # Use para_blocks (fully processed) over preproc_blocks
            para_blocks = page.get('para_blocks', page.get('preproc_blocks', []))

            # Debug: log block types present on each page
            block_types = {}
            for b in para_blocks:
                bt = b.get('type', 'unknown')
                block_types[bt] = block_types.get(bt, 0) + 1
            print(f'[MinerU Server] Page {page_idx}: block types = {block_types}')

            blocks = []
            for b in para_blocks:
                block_type = b.get('type', 'text')
                bbox = b.get('bbox', [0, 0, 0, 0])

                # Debug: log image/figure blocks
                if block_type in ('image', 'image_body', 'figure'):
                    print(f'[MinerU Server] Page {page_idx}: Found {block_type} block, '
                          f'keys={list(b.keys())}, has blocks={bool(b.get("blocks"))}')

                # Extract content from the nested structure:
                # para_block may have direct lines/spans OR nested blocks[].lines[].spans[]
                text, table_html, img_path, latex, inline_equations = _extract_block_content(b, img_dir)

                # Content-based list reclassification: MinerU's geometric heuristics
                # miss MCQ patterns like (i), (a), (b). Our regex catches them.
                if block_type == 'text' and text and _detect_list_content(text):
                    block_type = 'list'

                # Decorative block detection: narrow strips, small icons, watermarks
                # classified as text by MinerU → crop as image instead
                if (block_type == 'text'
                        and config.get('figure_display') == 'image'
                        and page_idx < len(_fitz_doc)
                        and _is_decorative_block(b, text, width)):
                    crop = _crop_and_embed(bbox, page_idx, _fitz_doc[page_idx],
                                           img_dir, _pdf_md5, 'sidebar')
                    if crop:
                        block_type = 'image'
                        img_path = crop['img_path']
                        text = ''
                        print(f'[MinerU Server] Page {page_idx}: sidebar→image '
                              f'bbox={[round(x, 1) for x in bbox]}')

                block = {
                    'type': block_type,
                    'bbox': bbox,
                    'text': text,
                }

                if inline_equations:
                    block['inline_equations'] = inline_equations

                # Include heading level for title blocks
                if block_type == 'title' and 'level' in b:
                    block['level'] = b['level']

                if table_html:
                    block['table_html'] = table_html
                if latex:
                    block['latex'] = latex
                if img_path:
                    block['img_path'] = img_path
                    # Embed image as base64 for client rendering
                    img_full_path = os.path.join(img_dir, img_path)
                    if os.path.exists(img_full_path):
                        with open(img_full_path, 'rb') as f:
                            block['img_data'] = base64.b64encode(f.read()).decode('ascii')
                        ext = os.path.splitext(img_path)[1].lower()
                        block['img_mime'] = 'image/jpeg' if ext in ('.jpg', '.jpeg') else 'image/png'
                    else:
                        print(f'[MinerU Server] WARNING: Image file not found: {img_full_path}')

                # Fallback crop: figure/image blocks without img_data — crop from PDF
                if (block_type in ('image', 'image_body', 'figure')
                        and 'img_data' not in block
                        and config.get('figure_display') == 'image'
                        and page_idx < len(_fitz_doc)):
                    crop = _crop_and_embed(bbox, page_idx, _fitz_doc[page_idx],
                                           img_dir, _pdf_md5, 'figure_crop')
                    if crop:
                        block.update(crop)
                        print(f'[MinerU Server] Page {page_idx}: fallback crop for {block_type} '
                              f'bbox={[round(x, 1) for x in bbox]}')

                blocks.append(block)

            # Post-OCR pass: merge overflowed blocks with adjacent empty blocks.
            # Pattern: VisionLLM OCR stuffs text from multiple small adjacent blocks
            # into one, leaving neighbors empty. Expand the bbox to cover the empties.
            blocks = _merge_overflowed_blocks(blocks)

            pages.append({
                'page_idx': page_idx,
                'page_size': {'width': width, 'height': height},
                'preproc_blocks': blocks,
            })

        # Recover discarded blocks that have real content (e.g. styled section
        # headers like "EXERCISE") while filtering out repeating page headers,
        # footers, and page numbers.  Strategy: extract text from every
        # discarded block across all pages, count how many pages each
        # normalised text appears on, and only keep text that is unique.
        _recover_discarded_blocks(pdf_info_raw, pages, img_dir, pdf_bytes, config)

        _fitz_doc.close()

        result = {
            'pdf_info': pages,
            'file_name': file_name,
        }

        tasks[task_id]['status'] = 'completed'
        tasks[task_id]['result'] = result
        # Store pipe_result for native export methods (content_list, markdown)
        tasks[task_id]['_pipe_result'] = pipe_result
        tasks[task_id]['_img_dir'] = img_dir
        # Store PDF bytes for page image rasterization (true-copy export)
        tasks[task_id]['_pdf_bytes'] = pdf_bytes

        total_blocks = sum(len(p['preproc_blocks']) for p in pages)
        print(f'[MinerU Server] Task {task_id} completed: '
              f'{len(pages)} pages, {total_blocks} blocks')

    except Exception as e:
        tb_str = traceback.format_exc()
        print(tb_str)
        tasks[task_id]['status'] = 'failed'
        # Include traceback location in the error for client-side debugging
        tb_lines = tb_str.strip().split('\n')
        location = tb_lines[-2].strip() if len(tb_lines) >= 2 else ''
        tasks[task_id]['error'] = f'{e} | at: {location}'
        print(f'[MinerU Server] Task {task_id} failed: {e}')
    finally:
        _parse_semaphore.release()


def _recover_discarded_blocks(pdf_info_raw: list, pages: list, img_dir: str,
                               pdf_bytes: bytes | None = None, config: dict | None = None):
    """Recover discarded blocks that contain real content.

    MinerU's layout model classifies some real content as "Abandon" (category 2),
    e.g. styled section headers like "EXERCISE" with colored backgrounds.
    This function recovers those blocks while filtering out genuinely repeating
    page elements (running headers, footers, page numbers).

    Decorative/image-like discarded blocks (QR codes, logos, etc.) are handled
    based on the include_figures / figure_display config:
      - include_figures=false → skip decorative blocks entirely
      - figure_display='image' → crop image from PDF, don't OCR
      - figure_display='text' → OCR as text (current behavior)
    """
    import re

    config = config or {}
    include_figures = config.get('include_figures', True)
    figure_display = config.get('figure_display', 'image')

    # Phase 1: collect all discarded blocks across all pages
    all_discarded: list[tuple[int, dict, str]] = []  # (page_idx, block, text)
    for pi, raw_page in enumerate(pdf_info_raw):
        for db in raw_page.get('discarded_blocks', []):
            db_text, _, _, _, _ = _extract_block_content(db, img_dir)
            text = db_text.strip() if db_text else ''
            all_discarded.append((pi, db, text))

    if not all_discarded:
        return

    # Phase 2: count how many pages each normalised text appears on
    text_page_count: dict[str, set] = {}
    for pi, _db, text in all_discarded:
        if not text:
            continue
        norm = re.sub(r'<[^>]*>', '', text).strip().lower()
        norm = re.sub(r'\s+', ' ', norm)
        if norm not in text_page_count:
            text_page_count[norm] = set()
        text_page_count[norm].add(pi)

    # Phase 3: classify and recover discarded blocks.
    # Repeating text (3+ pages) or page numbers → type='header'/'footer'
    # Blocks with very little text → likely decorative (QR codes, logos)
    # Unique text content → type='text' (real content MinerU wrongly abandoned)
    total_pages = len(pdf_info_raw)
    page_num_re = re.compile(r'^\d{1,4}$')
    from collections import defaultdict
    recovered_per_page: dict[int, list] = defaultdict(list)

    # Open PDF for image cropping if needed
    fitz_doc = None
    discard_pdf_md5 = None
    if pdf_bytes and include_figures and figure_display == 'image':
        try:
            fitz_doc = fitz.open(stream=pdf_bytes, filetype='pdf')
            discard_pdf_md5 = hashlib.md5(pdf_bytes).hexdigest()
        except Exception as e:
            print(f'[MinerU Server] Could not open PDF for discarded block cropping: {e}')

    try:
        for pi, db, text in all_discarded:
            if pi >= len(pages):
                continue
            db_bbox = db.get('bbox', [0, 0, 0, 0])
            page_h = pages[pi]['page_size']['height']
            is_top_half = db_bbox[1] < page_h * 0.5

            # Check if this is a repeating element (header/footer)
            if text:
                norm = re.sub(r'<[^>]*>', '', text).strip().lower()
                norm = re.sub(r'\s+', ' ', norm)
                is_repeating = len(text_page_count.get(norm, set())) >= min(3, total_pages)
                is_page_num = bool(page_num_re.match(norm))
            else:
                is_repeating = False
                is_page_num = False

            if is_repeating or is_page_num:
                block_type = 'header' if is_top_half else 'footer'
                block = {
                    'type': block_type,
                    'bbox': db_bbox,
                    'text': text,
                }
                recovered_per_page[pi].append(block)
                print(f'[MinerU Server] Page {pi}: {block_type} block '
                      f'bbox={[round(x, 1) for x in db_bbox]} text="{text[:60]}"')
                continue

            # Use unified decorative detection
            page_w = pages[pi]['page_size']['width'] if pi < len(pages) else 612
            is_decorative = _is_decorative_block(db, text, page_w)

            if is_decorative:
                if not include_figures:
                    print(f'[MinerU Server] Page {pi}: skipping decorative block '
                          f'bbox={[round(x, 1) for x in db_bbox]} (figures excluded)')
                    continue

                if figure_display == 'image' and fitz_doc and pi < len(fitz_doc):
                    block = {
                        'type': 'image',
                        'bbox': db_bbox,
                        'text': text,
                    }
                    crop = _crop_and_embed(db_bbox, pi, fitz_doc[pi],
                                           img_dir, discard_pdf_md5, 'discarded')
                    if crop:
                        block.update(crop)
                    recovered_per_page[pi].append(block)
                    print(f'[MinerU Server] Page {pi}: decorative→image block '
                          f'bbox={[round(x, 1) for x in db_bbox]}')
                else:
                    # figure_display='text' — recover as text (OCR'd)
                    block = {
                        'type': 'text',
                        'bbox': db_bbox,
                        'text': text or '[Decorative element]',
                    }
                    recovered_per_page[pi].append(block)
                    print(f'[MinerU Server] Page {pi}: decorative→text block '
                          f'bbox={[round(x, 1) for x in db_bbox]} text="{text[:60]}"')
            else:
                # Real text content — recover as text block
                block = {
                    'type': 'text',
                    'bbox': db_bbox,
                    'text': text,
                }
                recovered_per_page[pi].append(block)
                print(f'[MinerU Server] Page {pi}: recovered block '
                      f'bbox={[round(x, 1) for x in db_bbox]} text="{text[:60]}"')
    finally:
        if fitz_doc:
            fitz_doc.close()

    # Extend and sort once per page
    for pi, new_blocks in recovered_per_page.items():
        if pi >= len(pages):
            continue
        page_blocks = pages[pi]['preproc_blocks']
        page_blocks.extend(new_blocks)
        page_blocks.sort(key=lambda b: b.get('bbox', [0, 0, 0, 0])[1])


def _unescape_markdown(text: str) -> str:
    """Remove MinerU's markdown escaping for characters we render as HTML.

    MinerU's ocr_escape_special_markdown_char() escapes: * ` ~ $
    We un-escape *, `, ~ (not needed in HTML output) but KEEP \\$ escaped
    to prevent KaTeX false matches with dollar signs in financial docs.
    """
    return text.replace('\\*', '*').replace('\\`', '`').replace('\\~', '~')


def _is_valid_roman(s: str) -> bool:
    """Check if a string is a valid Roman numeral (i through xxxix)."""
    import re
    return bool(re.match(r'^(?:x{0,3})(?:ix|iv|v?i{0,3})$', s.lower())) and len(s) > 0


def _is_list_item(line: str) -> bool:
    """Detect whether a line starts with any list/bullet/numbering pattern."""
    import re
    # Bullets: •○▪▫–—➤‣›▶►∙★☆ etc.
    if re.match(r'^[\-\u2022\u25CF\u25CB\u25AA\u25AB\u2013\u2014\u27A4\u2023\u203A\u25B6\u25BA\u2219\u2605\u2606\*]\s', line):
        return True
    # Arabic numbered: 1. / 1) / (1) / [1] / 1.1. / 3.2.1. (multi-level)
    if re.match(r'^(\d+\.)+\s', line) or re.match(r'^\d+\)\s', line) or re.match(r'^\(\d+\)\s', line) or re.match(r'^\[\d+\]\s', line):
        return True
    # Letters: (a) / a. / a) / [a]  (excluding roman-ambiguous single letters)
    if re.match(r'^\([a-zA-Z]\)\s', line) or re.match(r'^\[[a-zA-Z]\]\s', line):
        return True
    if re.match(r'^[a-zA-Z][\.\)]\s', line):
        return True
    # Roman numerals in parens: (i), (ii), (iii), (iv), (v), (vi), etc.
    m = re.match(r'^\(([ivxlcdm]+)\)\s', line, re.IGNORECASE)
    if m and _is_valid_roman(m.group(1)):
        return True
    # Bare roman with 2+ chars: ii. / iii) / iv.  (avoids ambiguity with single letters)
    m = re.match(r'^([ivxlcdm]{2,})[\.\)]\s', line, re.IGNORECASE)
    if m and _is_valid_roman(m.group(1)):
        return True
    # Single roman i/v/x with period/paren — ambiguous, treat as list item
    if re.match(r'^[ivxIVX][\.\)]\s', line):
        return True
    # Section/Article/Part/Chapter/Item/Note/Step/Appendix/References prefixes
    if re.match(r'^(?:Section|Article|Part|Chapter|Item|Note|Step|Appendix|References)\b', line, re.IGNORECASE):
        return True
    return False


def _detect_list_content(text: str) -> bool:
    """Check if a text block's content is predominantly list items.

    Returns True if the block should be converted to a 'list' type.
    """
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    if len(lines) < 2:
        return False
    list_count = sum(1 for l in lines if _is_list_item(l))
    # If at least 60% of lines are list items, treat as list block
    return list_count / len(lines) >= 0.6


def _is_decorative_block(block: dict, text: str, page_width: float = 612) -> bool:
    """Detect blocks that are decorative rather than content.

    Unified detection covering:
    1. Narrow vertical strips (arXiv IDs, watermarks, vertical barcodes)
    2. Small blocks with minimal text (logos, QR codes, icons)
    3. Blocks with very low text density relative to their area

    Returns True if the block should be treated as a decorative image
    rather than text content.
    """
    bbox = block.get('bbox', [0, 0, 0, 0])
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    if width <= 0 or height <= 0:
        return False

    area = width * height
    text_stripped = text.strip() if text else ''
    text_len = len(text_stripped)

    # 1. Narrow vertical strips: extreme aspect ratio + narrow
    aspect_ratio = height / width
    if aspect_ratio > 6 and width < 60:
        return True

    # 2. Small blocks with short text: likely icons, logos, QR codes
    #    Block is small relative to page AND has very little text (but not empty)
    is_small = width < page_width * 0.15 and height < 100
    if is_small and 0 < text_len <= 10:
        return True

    # 3. Very short text in a small block: watermark text, stamps
    #    Requires both short text AND small width to avoid false positives
    if 0 < text_len <= 3 and width < page_width * 0.25 and area < page_width * 50:
        return True

    return False


def _is_decorative_sidebar(block: dict) -> bool:
    """Legacy wrapper — use _is_decorative_block instead."""
    return _is_decorative_block(block, '', 612)


def _extract_block_content(block: dict, img_dir: str = '') -> tuple[str, str, str, str, list]:
    """Extract content from a para_block.

    Uses _join_lines_for_html() for ALL text/title/list/index blocks in the
    HTML/JSON pipeline. This preserves line structure (\\n between lines) which
    the client-side HTML converter needs to create separate <p> tags.

    MinerU's merge_para_with_text() is NOT used here — it joins lines with
    spaces (correct for markdown, wrong for HTML). The markdown export path
    uses merge_para_with_text() via pipe_result.get_markdown() separately.

    Returns: (text, table_html, img_path, latex, inline_equations)
    """
    block_type = block.get('type', 'text')
    table_html = ''
    img_path = ''
    latex = ''
    inline_equations = []

    # Collect spans from all nested structures for table/image/latex extraction
    all_spans = []
    for line in block.get('lines', []):
        all_spans.extend(line.get('spans', []))
    for inner_block in block.get('blocks', []):
        for line in inner_block.get('lines', []):
            all_spans.extend(line.get('spans', []))

    for span in all_spans:
        span_type = span.get('type', '')
        if span.get('html'):
            table_html = span['html']
        if span.get('image_path'):
            img_path = span['image_path']
        if span_type in (ContentType.InterlineEquation, ContentType.InlineEquation):
            latex = span.get('content', '') or span.get('latex', '')
        elif span.get('latex'):
            latex = span['latex']

    # Extract text: use _join_lines_for_html() for ALL blocks in the HTML pipeline
    if block_type in ('text', 'title', 'list', 'index') and block.get('lines'):
        text, inline_equations = _join_lines_for_html(block, img_dir)
    elif block.get('text'):
        text = block['text']
    else:
        # Fallback: concatenate span content
        text_parts = [s.get('content', '') for s in all_spans if s.get('content', '').strip()]
        text = '\n'.join(text_parts)

    return text, table_html, img_path, latex, inline_equations


def _join_lines_for_html(block: dict, img_dir: str = '') -> tuple[str, list]:
    """Join block lines for HTML rendering, preserving line structure.

    Used for ALL text/title/list/index blocks in the HTML/JSON pipeline.
    Adds \\n between lines using two complementary detection methods:

    1. MinerU's is_list_start_line geometric tags (alignment, indentation)
    2. Content-based _is_list_item() regex (bullets, numbering, MCQ patterns)

    Lines without either signal are joined with spaces (paragraph flow)
    with dehyphenation. Equation spans become {{EQ:index}} placeholders
    carrying base64 image data.

    This is NOT a reimplementation of merge_para_with_text(). That function
    is for markdown output (used by get_markdown()). This function is for
    HTML rendering where \\n characters create separate <p> tags.

    Returns: (text, inline_equations) where inline_equations is a list of
    dicts with {latex, img_data, img_mime, display} for each embedded equation.
    """
    CT = ContentType
    inline_equations = []

    # Collect (line_text, is_list_start) pairs
    line_entries = []
    for line in block.get('lines', []):
        is_list_start = line.get('is_list_start_line', False)
        parts = []
        for span in line.get('spans', []):
            span_type = span.get('type', '')
            content = span.get('content', '').strip()
            if not content:
                continue
            if span_type in (CT.InterlineEquation, CT.InlineEquation):
                display = 'block' if span_type == CT.InterlineEquation else 'inline'
                eq_idx = len(inline_equations)
                eq_entry = {'latex': content, 'display': display}
                # Pass equation bbox for proper sizing on the client
                span_bbox = span.get('bbox')
                if span_bbox:
                    eq_entry['bbox'] = span_bbox
                line_bbox = line.get('bbox')
                if line_bbox:
                    eq_entry['line_bbox'] = line_bbox
                # Attach image data if available
                eq_img_path = span.get('image_path', '')
                if eq_img_path and img_dir:
                    full_path = os.path.join(img_dir, eq_img_path)
                    if os.path.exists(full_path):
                        with open(full_path, 'rb') as f:
                            eq_entry['img_data'] = base64.b64encode(f.read()).decode('ascii')
                        ext = os.path.splitext(eq_img_path)[1].lower()
                        eq_entry['img_mime'] = 'image/jpeg' if ext in ('.jpg', '.jpeg') else 'image/png'
                inline_equations.append(eq_entry)
                if display == 'block':
                    parts.append(f'\n{{{{EQ:{eq_idx}}}}}\n')
                else:
                    parts.append(f'{{{{EQ:{eq_idx}}}}}')
            else:
                parts.append(_unescape_markdown(content))
        line_text = ' '.join(parts)
        if line_text.strip():
            line_entries.append((line_text, is_list_start))

    if not line_entries:
        return '', []

    # Build final text using MinerU's geometric tags + content-based detection
    result = line_entries[0][0]
    for i in range(1, len(line_entries)):
        lt, is_list_start = line_entries[i]
        lt_stripped = lt.strip()

        if is_list_start or _is_list_item(lt_stripped):
            # MinerU geometric tag OR content pattern → new line
            result += '\n' + lt_stripped
        else:
            # Paragraph continuation — join with space
            # Dehyphenation: remove trailing hyphen when next starts lowercase
            if result.endswith('-') and lt_stripped and lt_stripped[0].islower():
                result = result[:-1] + lt_stripped
            else:
                result += ' ' + lt_stripped

    # Post-process: split bibliography/endnote entries that OCR merged into
    # one line. Pattern: multiple [N] or (N) markers in a single line of text.
    import re
    bracket_refs = re.findall(r'(?:\[\d+\]|\(\d+\))', result)
    if len(bracket_refs) >= 3 and '\n' not in result:
        # Split at [N] or (N) boundaries, keeping the marker with its text
        parts = re.split(r'(?=(?:\[\d+\]|\(\d+\))\s)', result)
        result = '\n'.join(p.strip() for p in parts if p.strip())

    return result, inline_equations


def _merge_overflowed_blocks(blocks: list[dict]) -> list[dict]:
    """Merge overflowed text blocks with adjacent empty blocks.

    Detects the pattern where VisionLLM OCR crams text from multiple
    adjacent layout blocks into one, leaving the rest empty. When found,
    expands the text block's bbox to cover the empty neighbors.

    This handles MCQ grids, columnar options, form-like layouts, and any
    structured content where layout detection creates many small blocks
    but OCR recognizes them as a single unit.
    """
    if len(blocks) < 2:
        return blocks

    # Mark which blocks to skip (absorbed into a previous block)
    absorbed = set()
    result = []

    for i, block in enumerate(blocks):
        if i in absorbed:
            continue

        text = block.get('text', '').strip()
        bbox = list(block.get('bbox', [0, 0, 0, 0]))
        block_h = bbox[3] - bbox[1]

        # Skip non-text blocks, empty blocks, or blocks with enough space
        if not text or block.get('type') in ('table', 'figure', 'image', 'image_body'):
            result.append(block)
            continue

        # Estimate how much height this text needs (rough: ~12px per line)
        line_count = text.count('\n') + 1
        min_height_needed = line_count * 10  # conservative estimate

        if block_h >= min_height_needed:
            result.append(block)
            continue

        # This block overflows. Look forward for empty adjacent blocks to absorb.
        x1, y1, x2, y2 = bbox
        absorbed_this = 0
        j = i + 1
        while j < len(blocks):
            next_block = blocks[j]
            next_text = next_block.get('text', '').strip()
            next_bbox = next_block.get('bbox', [0, 0, 0, 0])
            next_y1 = next_bbox[1]

            # Stop if: non-empty block, or large vertical gap (>5px), or different type
            gap = next_y1 - y2
            if next_text or gap > 5:
                break
            if next_block.get('type') in ('table', 'figure', 'title', 'image'):
                break

            # Absorb this empty block: expand bbox
            y2 = max(y2, next_bbox[3])
            x1 = min(x1, next_bbox[0])
            x2 = max(x2, next_bbox[2])
            absorbed.add(j)
            absorbed_this += 1
            j += 1

        if absorbed_this > 0:
            block = dict(block)  # copy to avoid mutating original
            block['bbox'] = [x1, y1, x2, y2]
            new_h = y2 - y1
            print(f'[MinerU Server] Merged block [{i}] with {absorbed_this} empty neighbors: '
                  f'{block_h:.0f}px → {new_h:.0f}px ({line_count} lines)')

        result.append(block)

    return result



def _assign_heading_levels(pdf_info: list):
    """Assign H1-H6 levels to title blocks using height clustering + numbering regex.

    Heuristic approach (no LLM needed):
    1. Collect avg line height for each title block across all pages
    2. Cluster unique heights with ~2px tolerance
    3. Map clusters to H1-H6 (largest height = H1)
    4. Use numbering patterns as tiebreaker (e.g. "1.1.1" → depth 3)
    5. Enforce contiguity (no jumping levels)
    """
    import re

    # Step 1: Collect all title blocks with their average line heights
    title_entries = []  # [(block_ref, avg_height, text)]
    for page in pdf_info:
        for block in page.get('para_blocks', page.get('preproc_blocks', [])):
            if block.get('type') != 'title':
                continue
            # Calculate avg line height from line bboxes
            heights = []
            text = ''
            for line in block.get('lines', []):
                bbox = line.get('bbox')
                if bbox and len(bbox) >= 4:
                    heights.append(bbox[3] - bbox[1])
                for span in line.get('spans', []):
                    text += span.get('content', '')
            if heights:
                avg_h = sum(heights) / len(heights)
                title_entries.append((block, avg_h, text.strip()))

    if not title_entries:
        return

    # Step 2: Cluster unique heights with ~2px tolerance
    unique_heights = sorted(set(h for _, h, _ in title_entries), reverse=True)
    clusters = []  # list of representative heights, largest first
    for h in unique_heights:
        merged = False
        for i, rep in enumerate(clusters):
            if abs(h - rep) <= 2.0:
                # Merge into existing cluster (keep the average)
                clusters[i] = (rep + h) / 2
                merged = True
                break
        if not merged:
            clusters.append(h)

    # Step 3: Map clusters to H1-H6 (largest = H1, capped at 6 levels)
    clusters.sort(reverse=True)
    height_to_level = {}
    for idx, rep in enumerate(clusters[:6]):
        level = idx + 1
        height_to_level[rep] = level

    def _get_level_for_height(h):
        """Find which cluster this height belongs to."""
        best_level = len(clusters[:6])  # default to deepest
        best_dist = float('inf')
        for rep, level in height_to_level.items():
            dist = abs(h - rep)
            if dist < best_dist:
                best_dist = dist
                best_level = level
        return best_level

    # Step 4: Numbering regex as depth indicator (tiebreaker)
    def _numbering_depth(text):
        """Detect section numbering depth: "1.2.3" → 3, "Chapter 1" → 1, None if no pattern."""
        # Dotted numbering: 1.2.3.4
        m = re.match(r'^(\d+(?:\.\d+)*)\s', text)
        if m:
            return m.group(1).count('.') + 1
        # Chapter/Part/Section prefix
        if re.match(r'^(?:Chapter|Part)\s+\d', text, re.IGNORECASE):
            return 1
        if re.match(r'^(?:Section|Article)\s+\d', text, re.IGNORECASE):
            return 2
        return None

    # Step 5: Assign levels
    for block, avg_h, text in title_entries:
        level = _get_level_for_height(avg_h)
        # Use numbering depth as tiebreaker when heights are ambiguous
        num_depth = _numbering_depth(text)
        if num_depth is not None:
            # Only override if numbering suggests a different level AND heights
            # are close (within same cluster or adjacent)
            if abs(num_depth - level) <= 1:
                level = num_depth
        block['level'] = min(level, 6)

    # Step 6: Enforce contiguity — no jumping from H1 to H4
    levels_used = sorted(set(b['level'] for b, _, _ in title_entries))
    if levels_used:
        # Remap to contiguous: if we have [1, 3, 5] → [1, 2, 3]
        remap = {old: new for new, old in enumerate(levels_used, 1)}
        for block, _, _ in title_entries:
            block['level'] = min(remap.get(block['level'], block['level']), 6)

    level_counts = {}
    for block, _, text in title_entries:
        l = block['level']
        level_counts[l] = level_counts.get(l, 0) + 1
    print(f'[MinerU Server] Heading hierarchy: {len(title_entries)} titles, levels: {level_counts}')


def _is_poor_table_html(html: str) -> bool:
    """Check if RapidTable HTML is low quality (mostly empty cells or all data in one cell)."""
    if not html:
        return True
    import re
    cells = re.findall(r'<td[^>]*>(.*?)</td>', html, re.DOTALL)
    if not cells:
        return True
    non_empty = [c for c in cells if c.strip()]
    # If fewer than 30% of cells have content, it's poor
    if len(cells) > 4 and len(non_empty) / len(cells) < 0.3:
        return True
    # If one cell has >80% of all text, it's poor (everything dumped in one cell)
    total_len = sum(len(c) for c in non_empty)
    if total_len > 0 and non_empty:
        max_cell_len = max(len(c) for c in non_empty)
        if max_cell_len / total_len > 0.8 and len(non_empty) > 1:
            return True
    return False



def _attach_table_html(blocks: list, tbl_bbox: list, tbl_html: str):
    """Attach table HTML to the block whose bbox overlaps the table."""
    best_idx = -1
    best_overlap = 0

    for i, b in enumerate(blocks):
        if b.get('type') not in ('table', 'text'):
            continue
        bb = b.get('bbox', [0, 0, 0, 0])
        # Calculate overlap
        x_overlap = max(0, min(bb[2], tbl_bbox[2]) - max(bb[0], tbl_bbox[0]))
        y_overlap = max(0, min(bb[3], tbl_bbox[3]) - max(bb[1], tbl_bbox[1]))
        overlap = x_overlap * y_overlap
        if overlap > best_overlap:
            best_overlap = overlap
            best_idx = i

    if best_idx >= 0:
        blocks[best_idx]['table_html'] = tbl_html
        blocks[best_idx]['type'] = 'table'


class MineruHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f'[MinerU Server] {args[0]}')

    def _send_json(self, code: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == '/health':
            global _server_status
            code = 200 if _server_status == 'ok' else 503
            self._send_json(code, {'status': _server_status})
            return

        # GET /tasks/{task_id}
        if parsed.path.startswith('/tasks/'):
            path_parts = parsed.path.strip('/').split('/')
            task_id = path_parts[1] if len(path_parts) >= 2 else ''
            task = tasks.get(task_id)
            if not task:
                self._send_json(404, {'error': 'Task not found'})
                return

            # GET /tasks/{id}/export/{format} — native MinerU exports
            if len(path_parts) >= 4 and path_parts[2] == 'export':
                export_format = path_parts[3]
                self._handle_export(task, export_format)
                return

            # GET /tasks/{id}/page_image/{page_idx} — rasterize a page as PNG
            if len(path_parts) >= 4 and path_parts[2] == 'page_image':
                try:
                    page_idx = int(path_parts[3])
                except ValueError:
                    self._send_json(400, {'error': 'page_idx must be an integer'})
                    return
                self._handle_page_image(task, page_idx)
                return

            # Return task without internal Python objects
            safe_task = {k: v for k, v in task.items() if not k.startswith('_')}
            self._send_json(200, safe_task)
            return

        self._send_json(404, {'error': 'Not found'})

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == '/health':
            global _server_status
            code = 200 if _server_status == 'ok' else 503
            self._send_json(code, {'status': _server_status})
            return

        if parsed.path == '/file_parse':
            self._handle_file_parse()
            return

        self._send_json(404, {'error': 'Not found'})

    def _handle_export(self, task: dict, export_format: str):
        """Handle native MinerU export: content_list, markdown, plaintext."""
        from magic_pdf.config.make_content_config import MakeMode

        if task['status'] != 'completed':
            self._send_json(400, {'error': f'Task not completed (status: {task["status"]})'})
            return

        pipe_result = task.get('_pipe_result')
        img_dir = task.get('_img_dir', '')
        if not pipe_result:
            self._send_json(400, {'error': 'Export data not available (task may have been cleaned up)'})
            return

        try:
            if export_format == 'content_list':
                content = pipe_result.get_content_list(img_dir)
                self._send_json(200, {'format': 'content_list', 'data': content})
            elif export_format == 'markdown':
                content = pipe_result.get_markdown(img_dir, md_make_mode=MakeMode.MM_MD)
                self._send_json(200, {'format': 'markdown', 'data': content})
            elif export_format == 'plaintext':
                content = pipe_result.get_markdown(img_dir, md_make_mode=MakeMode.NLP_MD)
                self._send_json(200, {'format': 'plaintext', 'data': content})
            else:
                self._send_json(400, {'error': f'Unknown export format: {export_format}. Use: content_list, markdown, plaintext'})
        except Exception as e:
            traceback.print_exc()
            self._send_json(500, {'error': f'Export failed: {str(e)}'})

    def _handle_page_image(self, task: dict, page_idx: int):
        """Rasterize a single page as PNG using pymupdf."""
        import fitz

        if task['status'] != 'completed':
            self._send_json(400, {'error': f'Task not completed (status: {task["status"]})'})
            return

        pdf_bytes = task.get('_pdf_bytes')
        if not pdf_bytes:
            self._send_json(400, {'error': 'PDF data not available (task may have been cleaned up)'})
            return

        try:
            doc = fitz.open(stream=pdf_bytes, filetype='pdf')
            if page_idx < 0 or page_idx >= len(doc):
                doc.close()
                self._send_json(400, {'error': f'page_idx {page_idx} out of range (0-{len(doc)-1})'})
                return

            page = doc[page_idx]
            # Rasterize at 150 DPI for good quality without excessive size
            pixmap = page.get_pixmap(dpi=150)
            png_bytes = pixmap.tobytes('png')
            doc.close()

            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', str(len(png_bytes)))
            self.end_headers()
            self.wfile.write(png_bytes)
        except Exception as e:
            traceback.print_exc()
            self._send_json(500, {'error': f'Page image rendering failed: {str(e)}'})

    def _handle_file_parse(self):
        """Parse multipart form data and start processing."""
        content_type = self.headers.get('Content-Type', '')
        if 'multipart/form-data' not in content_type:
            self._send_json(400, {'error': 'Expected multipart/form-data'})
            return

        # Parse boundary
        boundary = None
        for part in content_type.split(';'):
            part = part.strip()
            if part.startswith('boundary='):
                boundary = part[len('boundary='):]
                break

        if not boundary:
            self._send_json(400, {'error': 'No boundary in multipart'})
            return

        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        # Extract file from multipart
        file_data, file_name, fields = self._parse_multipart(body, boundary)

        if not file_data:
            self._send_json(400, {'error': 'No file found in request'})
            return

        # Enforce concurrency limit — reject if another job is running
        if not _parse_semaphore.acquire(blocking=False):
            self._send_json(429, {'error': 'Server busy, try again later'})
            return

        # Parse display preferences from form fields
        config = {
            'formula_display': fields.get('formula_display', 'image'),
            'table_display': fields.get('table_display', 'rendered'),
            'include_figures': fields.get('include_figures', 'true').lower() != 'false',
            'figure_display': fields.get('figure_display', 'image'),
        }

        # Create task and start processing
        task_id = str(uuid.uuid4())
        tasks[task_id] = {
            'task_id': task_id,
            'status': 'pending',
            'result': None,
            'error': None,
        }
        _evict_old_tasks()

        print(f'[MinerU Server] Task {task_id} created for {file_name} ({len(file_data)} bytes), config={config}')

        thread = threading.Thread(
            target=process_pdf,
            args=(task_id, file_data, file_name, config),
            daemon=True,
        )
        thread.start()

        self._send_json(200, {'task_id': task_id})

    def _parse_multipart(self, body: bytes, boundary: str) -> tuple[bytes | None, str, dict[str, str]]:
        """Extract file data and form fields from multipart form body."""
        boundary_bytes = f'--{boundary}'.encode()
        parts = body.split(boundary_bytes)

        file_data = None
        file_name = ''
        fields: dict[str, str] = {}

        for part in parts:
            if b'Content-Disposition' not in part:
                continue

            header_end = part.find(b'\r\n\r\n')
            if header_end == -1:
                continue

            header = part[:header_end].decode('utf-8', errors='replace')
            data = part[header_end + 4:]
            if data.endswith(b'\r\n'):
                data = data[:-2]
            if data.endswith(b'--\r\n'):
                data = data[:-4]
            if data.endswith(b'--'):
                data = data[:-2]
            if data.endswith(b'\r\n'):
                data = data[:-2]

            if 'name="file"' in header:
                # Extract filename
                file_name = 'document.pdf'
                if 'filename="' in header:
                    start = header.index('filename="') + len('filename="')
                    end = header.index('"', start)
                    file_name = header[start:end]
                file_data = data
            else:
                # Extract field name and value
                import re
                name_match = re.search(r'name="([^"]+)"', header)
                if name_match:
                    fields[name_match.group(1)] = data.decode('utf-8', errors='replace')

        return file_data, file_name, fields


def _pre_warm_models():
    """Pre-load ML models so the first real OCR job is fast.

    Runs a tiny dummy inference to force torch/ONNX to load weights into memory.
    Updates _server_status to 'ok' when done.
    """
    global _server_status
    try:
        print('[MinerU Server] Pre-warming models...')
        t0 = time.time()

        # Create a minimal 1-page blank PDF to trigger model loading
        import fitz  # pymupdf
        doc = fitz.open()
        page = doc.new_page(width=612, height=792)
        page.insert_text((72, 72), "warm-up", fontsize=12)
        pdf_bytes = doc.tobytes()
        doc.close()

        ds = PymuDocDataset(pdf_bytes, lang='en')
        infer_result = ds.apply(doc_analyze, ocr=True, lang='en', formula_enable=True)

        t1 = time.time()
        print(f'[MinerU Server] Models pre-warmed in {t1-t0:.1f}s')
        _server_status = 'ok'

    except Exception as e:
        print(f'[MinerU Server] WARNING: Pre-warm failed: {e}')
        traceback.print_exc()
        # Still mark as ok — models will load on first real request
        _server_status = 'ok'


def _write_magic_pdf_config(models_dir: str):
    """Write magic-pdf.json pointing to the given models directory."""
    home = os.path.expanduser('~')
    config_path = os.path.join(home, 'magic-pdf.json')
    config = {
        "models-dir": models_dir,
        "device-mode": "mps",
        "table-config": {
            "model": "rapid_table",
            "enable": True,
            "max_time": 400
        },
        "layout-config": {
            "model": "doclayout_yolo"
        },
        "formula-config": {
            "mfd_model": "yolo_v8_mfd",
            "mfr_model": "unimernet_small",
            "enable": True
        }
    }
    with open(config_path, 'w') as f:
        json.dump(config, f, indent=2)
    print(f'[MinerU Server] Wrote config to {config_path} (models-dir: {models_dir})')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='MinerU REST API server')
    parser.add_argument('--port', type=int, default=int(os.environ.get('MINERU_PORT', '8765')),
                        help='Port to listen on (default: 8765 or MINERU_PORT env)')
    parser.add_argument('--models-dir', type=str, default=None,
                        help='Override models directory in magic-pdf.json')
    parser.add_argument('--no-warm', action='store_true',
                        help='Skip model pre-warming on startup')
    args = parser.parse_args()

    # Write magic-pdf.json if --models-dir is provided
    if args.models_dir:
        _write_magic_pdf_config(args.models_dir)

    # Start HTTP server in a thread so we can respond to health checks during warm-up
    server = HTTPServer(('127.0.0.1', args.port), MineruHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    print(f'[MinerU Server] Listening on http://127.0.0.1:{args.port}')
    print(f'[MinerU Server] Endpoints: GET /health, POST /file_parse, GET /tasks/{{id}}')

    # Pre-warm models (blocking — health returns 503 until done)
    if not args.no_warm:
        _pre_warm_models()
    else:
        _server_status = 'ok'

    print(f'[MinerU Server] Ready')

    try:
        server_thread.join()
    except KeyboardInterrupt:
        print('\n[MinerU Server] Shutting down')
        server.shutdown()
