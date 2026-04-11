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
import logging
import logging.handlers
import os
import sys
import tempfile
import threading
import time
import traceback
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse


# ---------------------------------------------------------------------------
# Structured JSON logging
# ---------------------------------------------------------------------------

class JsonFormatter(logging.Formatter):
    """Emit one JSON object per log line for structured log consumption."""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict = {
            'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(record.created)),
            'level': record.levelname,
            'task_id': getattr(record, 'task_id', None),
            'page_idx': getattr(record, 'page_idx', None),
            'msg': record.getMessage(),
        }
        for key in ('rss_mb', 'duration_ms', 'error'):
            val = getattr(record, key, None)
            if val is not None:
                entry[key] = val
        return json.dumps(entry, default=str)


class StreamToLogger:
    """Redirect stdout/stderr through the logging system so native C/torch
    prints are also subject to rotation and level gating."""

    def __init__(self, logger: logging.Logger, level: int = logging.INFO):
        self._logger = logger
        self._level = level
        self._buf = ''

    def write(self, msg: str) -> None:
        if msg and msg.strip():
            for line in msg.rstrip('\n').split('\n'):
                self._logger.log(self._level, line)

    def flush(self) -> None:
        pass

    def isatty(self) -> bool:
        return False


def _setup_logging() -> logging.Logger:
    """Configure the 'mineru' logger with RotatingFileHandler + JSON format.

    Falls back to stderr if the file handler can't be created (PermissionError).
    Respects LOG_LEVEL env var (default: INFO).
    """
    log_level_name = os.environ.get('LOG_LEVEL', 'INFO').upper()
    log_level = getattr(logging, log_level_name, logging.INFO)

    logger = logging.getLogger('mineru')
    logger.setLevel(log_level)
    logger.propagate = False
    # Prevent logging errors from triggering more logging (breaks the crash loop)
    logging.raiseExceptions = False

    formatter = JsonFormatter()

    log_path = os.path.join(tempfile.gettempdir(), 'mineru_server.log')
    try:
        file_handler = logging.handlers.RotatingFileHandler(
            log_path, maxBytes=50 * 1024 * 1024, backupCount=3,
        )
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
    except (PermissionError, OSError):
        stderr_handler = logging.StreamHandler(sys.stderr)
        stderr_handler.setFormatter(formatter)
        logger.addHandler(stderr_handler)

    return logger


# Module-level logger — configured properly in __main__, usable at import time
logger = logging.getLogger('mineru')


def _sweep_orphan_tempdirs():
    """Remove leftover mineru_task_* directories from previous server runs.

    Called once at startup. If the server was kill -9'd or the laptop crashed,
    in-flight task tempdirs leak forever (each holds 50-200MB of cropped images).
    Uses a PID file to avoid sweeping dirs owned by another running instance.
    """
    import glob
    import shutil

    tmpdir = tempfile.gettempdir()
    pid_file = os.path.join(tmpdir, 'mineru_server.pid')

    # Check if another instance is running via PID file
    if os.path.exists(pid_file):
        try:
            with open(pid_file) as f:
                old_pid = int(f.read().strip())
            # Check if that PID is still alive
            try:
                os.kill(old_pid, 0)  # signal 0 = existence check
                logger.warning('Another MinerU server is running (PID %d), skipping orphan sweep',
                               old_pid)
                return
            except OSError:
                pass  # PID is dead, safe to sweep
        except (ValueError, OSError):
            pass  # corrupt PID file, ignore

    # Write our PID
    try:
        with open(pid_file, 'w') as f:
            f.write(str(os.getpid()))
    except OSError as e:
        logger.warning('Could not write PID file: %s', e)

    # Sweep orphaned task directories
    pattern = os.path.join(tmpdir, 'mineru_task_*')
    orphans = glob.glob(pattern)
    if orphans:
        for orphan in orphans:
            try:
                shutil.rmtree(orphan, ignore_errors=True)
                logger.info('Swept orphan tempdir: %s', orphan)
            except Exception as e:
                logger.warning('Failed to sweep orphan %s: %s', orphan, e)
        logger.info('Startup sweep: removed %d orphaned tempdirs', len(orphans))


# MinerU imports
from magic_pdf.data.dataset import PymuDocDataset
from magic_pdf.model.doc_analyze_by_custom_model import doc_analyze
from magic_pdf.data.data_reader_writer.filebase import FileBasedDataWriter
from magic_pdf.libs.pdf_image_tools import cut_image
from magic_pdf.libs.commons import join_path
from magic_pdf.config.ocr_content_type import ContentType

import base64
import hashlib
import re as _re
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
            logger.warning('Cropped image not found: %s', img_full_path)
            return None
    except Exception as e:
        logger.warning('Failed to crop %s on page %d: %s', label, page_idx, e)
        return None


# Task store (in-memory) with LRU eviction
MAX_TASKS = 3
tasks: dict[str, dict] = {}


def _safe_bbox(val) -> list:
    """Normalize bbox to [x1, y1, x2, y2].

    MinerU sometimes sets bbox to [] (empty list) rather than omitting the key.
    In that case .get('bbox', [0,0,0,0]) returns [] because the key exists.
    This helper guarantees a 4-element list, preventing IndexError.
    """
    if not val or not isinstance(val, (list, tuple)) or len(val) < 4:
        return [0, 0, 0, 0]
    return list(val[:4])


# ---------------------------------------------------------------------------
# Font detection helpers (digital-born PDFs via PyMuPDF)
# ---------------------------------------------------------------------------

_SUBSET_PREFIX_RE = _re.compile(r'^[A-Z]{6}\+')

# Load font mapping table
_FONT_MAP_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib', 'fonts', 'font_map.json')
try:
    with open(_FONT_MAP_PATH) as _f:
        _FONT_MAP: dict = {k: v for k, v in json.load(_f).items() if not k.startswith('_')}
except FileNotFoundError:
    logger.warning('font_map.json not found at %s', _FONT_MAP_PATH)
    _FONT_MAP = {}


def _normalize_font_name(ps_name: str) -> str:
    """Strip subset prefix and normalize for lookup."""
    if not ps_name:
        return ''
    name = _SUBSET_PREFIX_RE.sub('', ps_name)
    return name.strip().lower()


def _map_font_name(ps_name: str) -> tuple[str | None, str | None]:
    """Look up a detected font name in the bundle mapping.

    Returns (bundled_file, family_name) or (None, None) if no match.
    Tries exact match first, then longest-substring match.
    """
    if not ps_name:
        return (None, None)
    norm = _normalize_font_name(ps_name)
    if not norm:
        return (None, None)
    # Exact match
    if norm in _FONT_MAP:
        entry = _FONT_MAP[norm]
        return (entry['file'], entry['family'])
    # Longest substring match (so 'timesnewromanps-boldmt' matches 'timesnewromanps-boldmt')
    matches = [(k, v) for k, v in _FONT_MAP.items() if k in norm]
    if matches:
        matches.sort(key=lambda kv: -len(kv[0]))
        return (matches[0][1]['file'], matches[0][1]['family'])
    return (None, None)


def _discover_digital_fonts(fitz_doc) -> dict[int, list[tuple[str, list, int]]]:
    """Pre-pass: extract (ps_font_name, bbox, char_count) per page from PyMuPDF.

    Returns {page_idx: [(name, bbox, nchars), ...]}.
    One call to get_text('dict') per page. Fast (~5ms/page).
    """
    page_fonts: dict[int, list[tuple[str, list, int]]] = {}
    for page_idx in range(len(fitz_doc)):
        spans_info: list[tuple[str, list, int]] = []
        try:
            page = fitz_doc[page_idx]
            d = page.get_text('dict')
            for block in d.get('blocks', []):
                for line in block.get('lines', []):
                    for span in line.get('spans', []):
                        name = span.get('font', '') or ''
                        bbox = list(span.get('bbox', [0, 0, 0, 0]))
                        text = span.get('text', '') or ''
                        if not name or not text.strip():
                            continue
                        spans_info.append((name, bbox, len(text)))
        except Exception:
            pass
        page_fonts[page_idx] = spans_info
    return page_fonts


def _dominant_font_for_block(page_spans: list, block_bbox: list) -> str | None:
    """Find the font with the most characters overlapping a block's bbox.

    Returns the PostScript name (not yet mapped) or None.
    """
    if not page_spans:
        return None
    bx1, by1, bx2, by2 = block_bbox[:4]
    char_counts: dict[str, int] = {}
    for name, sbbox, nchars in page_spans:
        sx1, sy1, sx2, sy2 = sbbox[:4]
        # Span center inside block bbox
        cx = (sx1 + sx2) / 2
        cy = (sy1 + sy2) / 2
        if bx1 <= cx <= bx2 and by1 <= cy <= by2:
            char_counts[name] = char_counts.get(name, 0) + nchars
    if not char_counts:
        return None
    return max(char_counts.items(), key=lambda kv: kv[1])[0]


def _cleanup_task(task_id: str, *, remove_from_store: bool = False):
    """Free heavy resources for a task, keeping lightweight metadata.

    Called by DELETE endpoint (client-triggered) and auto-cleanup thread.
    Frees _pdf_bytes, _pipe_result, result, and _img_dir on disk.
    """
    task = tasks.get(task_id)
    if not task:
        return
    if task.get('_cleaned'):
        if remove_from_store:
            tasks.pop(task_id, None)
        return

    freed = []

    if '_pdf_bytes' in task:
        del task['_pdf_bytes']
        freed.append('pdf_bytes')

    if '_pipe_result' in task:
        del task['_pipe_result']
        freed.append('pipe_result')

    if 'result' in task and task['result'] is not None:
        del task['result']
        freed.append('result')

    img_dir = task.pop('_img_dir', None)
    if img_dir:
        import shutil
        try:
            shutil.rmtree(img_dir, ignore_errors=True)
            freed.append('img_dir')
        except Exception:
            pass

    task['_cleaned'] = True
    task['_cleaned_at'] = time.time()

    if remove_from_store:
        tasks.pop(task_id, None)

    if freed:
        import gc
        gc.collect()
        try:
            import psutil
            rss_mb = psutil.Process().memory_info().rss / (1024 * 1024)
            logger.info('Cleaned task %s: freed %s, RSS=%.0fMB', task_id, freed, rss_mb,
                        extra={'task_id': task_id, 'rss_mb': round(rss_mb)})
        except ImportError:
            logger.info('Cleaned task %s: freed %s', task_id, freed,
                        extra={'task_id': task_id})


def _evict_old_tasks():
    """Evict oldest tasks when over MAX_TASKS limit."""
    while len(tasks) > MAX_TASKS:
        oldest_id = next(iter(tasks))
        _cleanup_task(oldest_id, remove_from_store=True)
        logger.info('Evicted task %s (%d remaining)', oldest_id, len(tasks),
                    extra={'task_id': oldest_id})

# Dynamic concurrency based on system memory
# ~3GB base for models, ~2GB per concurrent OCR job, reserve 4GB for OS
def _calc_ocr_slots():
    import psutil
    total_gb = psutil.virtual_memory().total / (1024 ** 3)
    # Reserve 4GB for OS, 3GB for models at rest, ~4GB per concurrent job
    # (inference tensors + rasterized pages + base64 images + output buffers)
    slots = max(1, int((total_gb - 4 - 3) / 4))
    # No artificial cap — let memory be the only constraint
    logger.info('System RAM: %.0fGB, OCR concurrency: %d', total_gb, slots)
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
                    logger.debug('Skipping equation span on page %d: invalid bbox=%s', page_idx, bbox)
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
                    logger.warning('Failed to crop equation on page %d: %s', page_idx, crop_err)

            if span_types_found:
                logger.debug('Page %d span types: %s', page_idx, span_types_found)
    finally:
        doc.close()

    logger.info('Equation image cropping: %d cropped', cropped)


def _unmerge_cross_page_blocks(pdf_info: list) -> None:
    """Reverse MinerU's cross-page paragraph merge for true-copy fidelity.

    MinerU's para_split_v3.__merge_2_text_blocks moves lines from a later block
    into an earlier block when a paragraph crosses a page boundary. It:
      1. Marks each moved span with `cross_page=True` (config/constants.py)
      2. Empties the later block's lines list
      3. Flags the later block with `lines_deleted=True`

    For reading-order output (markdown) this is correct — the paragraph is
    represented once, on the page where it "starts". But for true-copy HTML,
    each page's region bbox must match what was visible on that physical page,
    otherwise a tiny 1-line bbox at the bottom of page N gets stuffed with the
    full multi-line continuation paragraph. The font fitter then has no choice
    but to shrink the text to 3-5px, or worse overflow the page.

    This pass walks every block across all pages. For any block whose lines
    contain cross_page-marked spans, it splits those lines out and restores
    them to the next page's corresponding `lines_deleted` block (matching by
    the order emptied blocks appear).

    Mutates `pdf_info` in place. Safe to call multiple times (idempotent:
    after the first pass, no spans are marked cross_page anymore).
    """
    # Collect queues of lines to restore, per-page, in order.
    # Key insight: __merge_2_text_blocks iterates groups in reverse, so the
    # earlier block (prev_block) accumulates the later block's lines. Walking
    # pages in forward order, the first empty block on each page corresponds
    # to the most recent stash from the previous page.
    pending: list[list] = []  # queue of "lines lists" to restore

    for page in pdf_info:
        para_blocks = page.get('para_blocks', page.get('preproc_blocks', []))

        for block in para_blocks:
            # Restore emptied blocks first, before checking this block's own lines.
            if block.get('lines_deleted') and not block.get('lines'):
                if pending:
                    restored = pending.pop(0)
                    # Clear cross_page markers on restored lines — they're back
                    # on their home page now.
                    for line in restored:
                        for span in line.get('spans', []):
                            span.pop('cross_page', None)
                    block['lines'] = restored
                    block.pop('lines_deleted', None)

            # Now look for cross_page lines in this block and split them off.
            own_lines: list = []
            cross_lines: list = []
            for line in block.get('lines', []):
                spans = line.get('spans', [])
                # A line is "cross_page" if any of its spans is marked.
                if spans and any(s.get('cross_page') for s in spans):
                    cross_lines.append(line)
                else:
                    own_lines.append(line)

            if cross_lines:
                block['lines'] = own_lines
                pending.append(cross_lines)

    if pending:
        logger.warning('%d cross_page line groups had no destination block — text may be truncated',
                       len(pending))


def process_pdf(task_id: str, pdf_bytes: bytes, file_name: str, config: dict | None = None):
    """Run full MinerU OCR pipeline and store the structured result."""
    # Block here until a slot is free. This is the backpressure point: callers
    # can submit thousands of tasks; they sit in 'pending' status until the
    # semaphore releases. No 429s, no fail-and-retry storms.
    _parse_semaphore.acquire()
    acquired = True
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
            logger.info('Skipped: %s', ', '.join(skipped), extra={'task_id': task_id})
        t2 = time.time()
        logger.info('Step 1 (model inference): %.1fs', t2 - t1,
                    extra={'task_id': task_id, 'duration_ms': round((t2 - t1) * 1000)})

        # Step 2: Run full pipeline (paragraph merging, heading detection,
        # table extraction, reading order, image extraction)
        tmpdir = tempfile.mkdtemp(prefix='mineru_task_')
        img_dir = os.path.join(tmpdir, 'images')
        image_writer = FileBasedDataWriter(img_dir)
        pipe_result = infer_result.pipe_ocr_mode(
            image_writer, debug_mode=True, lang='en'
        )
        t3 = time.time()
        logger.info('Step 2 (pipe_ocr_mode): %.1fs', t3 - t2,
                    extra={'task_id': task_id, 'duration_ms': round((t3 - t2) * 1000)})

        # Step 2b: Crop equation images (MinerU only crops images + tables)
        raw = pipe_result._pipe_res
        pdf_info_raw = raw.get('pdf_info', [])
        _crop_equation_images(pdf_bytes, pdf_info_raw, image_writer)
        t3b = time.time()
        logger.info('Step 2b (equation crops): %.1fs', t3b - t3,
                    extra={'task_id': task_id, 'duration_ms': round((t3b - t3) * 1000)})

        # Step 2c: Assign heading hierarchy (H1-H6) to title blocks
        _assign_heading_levels(pdf_info_raw)
        t3c = time.time()
        logger.info('Step 2c (heading hierarchy): %.1fs', t3c - t3b,
                    extra={'task_id': task_id, 'duration_ms': round((t3c - t3b) * 1000)})

        # Step 2d: Build a PARALLEL per-page-fidelity view for true-copy export.
        # MinerU's para_split_v3 merges text across page boundaries (moves lines
        # from a later block into an earlier block and empties the later block).
        # This is correct for reading-order output (markdown/normal HTML) and we
        # MUST preserve it — it's MinerU's native paragraph coherence.
        #
        # For true-copy HTML however, each page's region bbox must match what was
        # visible on that physical page, otherwise a 15px bbox at the bottom of
        # page N gets stuffed with a whole continuation paragraph.
        #
        # Approach: deep-copy pdf_info, run _unmerge_cross_page_blocks on the copy
        # (using MinerU's own cross_page/lines_deleted markers), and build a lookup
        # of per-block per-page text. The ORIGINAL pdf_info stays merged so normal
        # HTML / markdown export keeps MinerU's reading-order output.
        import copy as _copy_mod
        _unmerged_info = _copy_mod.deepcopy(pdf_info_raw)
        _unmerge_cross_page_blocks(_unmerged_info)
        _per_page_text_lookup: dict[tuple[int, int], tuple[str, list]] = {}
        for _upage in _unmerged_info:
            _upi = _upage.get('page_idx', 0)
            _ublocks = _upage.get('para_blocks', _upage.get('preproc_blocks', []))
            for _ubi, _ublock in enumerate(_ublocks):
                _utext, _, _, _, _uineq = _extract_block_content(_ublock, img_dir)
                _per_page_text_lookup[(_upi, _ubi)] = (_utext, _uineq)
        del _unmerged_info
        t3d = time.time()
        logger.info('Step 2d (per-page un-merge view): %.1fs', t3d - t3c,
                    extra={'task_id': task_id, 'duration_ms': round((t3d - t3c) * 1000)})

        # Step 3: Convert pipeline output to the format the client expects
        # img_dir is where MinerU wrote extracted images
        _current_img_dir = img_dir

        # Open PDF once for all cropping operations in Step 3
        _fitz_doc = fitz.open(stream=pdf_bytes, filetype='pdf')
        _pdf_md5 = hashlib.md5(pdf_bytes).hexdigest()

        # Step 2e: Document-level font discovery
        # Always try PyMuPDF first (works for digital-born PDFs).
        # If no text spans are found (scanned PDF), _pdf_is_scanned is set True
        # and the ResNet-18 classifier runs after blocks are collected.
        _digital_font_spans: dict[int, list[tuple[str, list, int]]] = {}
        _used_fonts: dict[str, str] = {}  # {bundled_file: family_name}
        _pdf_is_scanned = False
        if _FONT_MAP:
            _digital_font_spans = _discover_digital_fonts(_fitz_doc)
            total_spans = sum(len(spans) for spans in _digital_font_spans.values())
            if total_spans > 0:
                all_names = {name for spans in _digital_font_spans.values()
                             for name, _, _ in spans}
                for name in all_names:
                    bundled, family = _map_font_name(name)
                    if bundled:
                        _used_fonts[bundled] = family
                t3e = time.time()
                logger.info('Step 2e (font discovery): %.1fs, %d spans, %d unique fonts mapped',
                            t3e - t3d, total_spans, len(_used_fonts),
                            extra={'task_id': task_id, 'duration_ms': round((t3e - t3d) * 1000)})
            else:
                _pdf_is_scanned = True
                t3e = time.time()
                logger.info('Step 2e: no text spans found — PDF is scanned, will use classifier',
                            extra={'task_id': task_id})

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
            logger.debug('Page %d: block types = %s', page_idx, block_types)

            blocks = []
            for _bi, b in enumerate(para_blocks):
                block_type = b.get('type', 'text')
                bbox = _safe_bbox(b.get('bbox'))

                # Debug: log image/figure blocks
                if block_type in ('image', 'image_body', 'figure'):
                    logger.debug('Page %d: Found %s block, keys=%s, has blocks=%s',
                                page_idx, block_type, list(b.keys()), bool(b.get('blocks')))

                # Extract content from the nested structure:
                # para_block may have direct lines/spans OR nested blocks[].lines[].spans[]
                # NOTE: this reads MinerU's MERGED lines (cross-page paragraphs joined).
                # The per-page un-merged version is looked up below and attached as
                # `text_per_page` / `inline_equations_per_page` for true-copy export.
                text, table_html, img_path, latex, inline_equations = _extract_block_content(b, img_dir)
                text_per_page, inline_equations_per_page = _per_page_text_lookup.get(
                    (page_idx, _bi), (text, inline_equations))

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
                        logger.debug('Page %d: sidebar→image bbox=%s',
                                    page_idx, [round(x, 1) for x in bbox])

                # Per-block font assignment
                font_family = None
                if block_type in ('text', 'title', 'list', 'index', 'caption',
                                  'header', 'footer'):
                    if _digital_font_spans:
                        dom = _dominant_font_for_block(
                            _digital_font_spans.get(page_idx, []), bbox)
                        if dom:
                            _, family = _map_font_name(dom)
                            font_family = family
                    # Fallback: use document-dominant font when per-block
                    # lookup fails (bbox mismatch between MinerU and PyMuPDF)
                    if not font_family and _used_fonts:
                        font_family = next(iter(_used_fonts.values()))

                block = {
                    'type': block_type,
                    'bbox': bbox,
                    'text': text,
                }
                if font_family:
                    block['font_family'] = font_family

                # Attach per-page (un-merged) text for true-copy export.
                # Normal HTML/markdown export uses `text` (MinerU's cross-page
                # merged paragraphs). True-copy uses `text_per_page` so
                # continuation text doesn't get stuffed into the previous page's
                # bbox. Only set when different from `text` to keep payload lean.
                if text_per_page != text:
                    block['text_per_page'] = text_per_page

                if inline_equations:
                    block['inline_equations'] = inline_equations
                if inline_equations_per_page and inline_equations_per_page != inline_equations:
                    block['inline_equations_per_page'] = inline_equations_per_page

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
                        logger.warning('Image file not found: %s', img_full_path)

                # Fallback crop: figure/image blocks without img_data — crop from PDF
                if (block_type in ('image', 'image_body', 'figure')
                        and 'img_data' not in block
                        and config.get('figure_display') == 'image'
                        and page_idx < len(_fitz_doc)):
                    crop = _crop_and_embed(bbox, page_idx, _fitz_doc[page_idx],
                                           img_dir, _pdf_md5, 'figure_crop')
                    if crop:
                        block.update(crop)
                        logger.debug('Page %d: fallback crop for %s bbox=%s',
                                    page_idx, block_type, [round(x, 1) for x in bbox])

                blocks.append(block)

            # Post-OCR pass: merge overflowed blocks with adjacent empty blocks.
            # Pattern: VisionLLM OCR stuffs text from multiple small adjacent blocks
            # into one, leaving neighbors empty. Expand the bbox to cover the empties.
            blocks = _merge_overflowed_blocks(blocks)

            # Dedup pass: MinerU sometimes emits two text/list regions whose
            # bboxes overlap heavily (a short header sitting inside a long body
            # region). Merge the smaller into the larger to prevent visual
            # stacking on the rendered page.
            blocks = _merge_overlapping_blocks(blocks)

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

        # Scanned PDF font detection: sample blocks, run ResNet-18 classifier
        if _pdf_is_scanned and not _used_fonts:
            try:
                from lib import font_classifier
                candidates = []
                for pg in pages:
                    for blk in pg.get('preproc_blocks', []):
                        if blk.get('type') in ('text', 'title', 'list', 'caption'):
                            candidates.append((pg['page_idx'], blk['bbox']))
                if candidates:
                    _used_fonts = font_classifier.discover_scanned_fonts(
                        _fitz_doc, candidates, max_samples=10)
                    # Assign the dominant scanned font to all text blocks
                    if _used_fonts:
                        dominant_family = next(iter(_used_fonts.values()))
                        for pg in pages:
                            for blk in pg.get('preproc_blocks', []):
                                if (blk.get('type') in ('text', 'title', 'list',
                                                         'index', 'caption')
                                        and 'font_family' not in blk):
                                    blk['font_family'] = dominant_family
                    logger.info('Scanned font detection: %d fonts detected',
                                len(_used_fonts), extra={'task_id': task_id})
            except ImportError:
                logger.info('font_classifier not available, skipping scanned font detection',
                            extra={'task_id': task_id})
            except Exception as e:
                logger.warning('Scanned font detection failed: %s', e,
                               extra={'task_id': task_id})

        _fitz_doc.close()

        result = {
            'pdf_info': pages,
            'file_name': file_name,
        }
        if _used_fonts:
            result['used_fonts'] = _used_fonts

        tasks[task_id]['status'] = 'completed'
        tasks[task_id]['_completed_at'] = time.time()
        tasks[task_id]['result'] = result
        tasks[task_id]['_img_dir'] = img_dir
        # Store PDF bytes for page image rasterization (true-copy export)
        tasks[task_id]['_pdf_bytes'] = pdf_bytes
        # Drop heavy intermediates immediately. pipe_result holds tensors and
        # the full inference state (~100-300MB); Next.js never calls the native
        # /export endpoints so we can free it now instead of at LRU eviction.
        del pipe_result
        del infer_result
        import gc
        gc.collect()

        total_blocks = sum(len(p['preproc_blocks']) for p in pages)
        logger.info('Task %s completed: %d pages, %d blocks', task_id, len(pages), total_blocks,
                    extra={'task_id': task_id})

    except Exception as e:
        tb_str = traceback.format_exc()
        logger.error('Task %s exception:\n%s', task_id, tb_str,
                     extra={'task_id': task_id, 'error': str(e)})
        tasks[task_id]['status'] = 'failed'
        tasks[task_id]['_completed_at'] = time.time()
        # Include traceback location in the error for client-side debugging
        tb_lines = tb_str.strip().split('\n')
        location = tb_lines[-2].strip() if len(tb_lines) >= 2 else ''
        tasks[task_id]['error'] = f'{e} | at: {location}'
        logger.error('Task %s failed: %s', task_id, e, extra={'task_id': task_id})
    finally:
        # Ensure fitz doc is closed even on error (may already be closed on success path)
        try:
            _fitz_doc.close()
        except Exception:
            pass
        if acquired:
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
            logger.warning('Could not open PDF for discarded block cropping: %s', e)

    try:
        for pi, db, text in all_discarded:
            if pi >= len(pages):
                continue
            db_bbox = _safe_bbox(db.get('bbox'))
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

            # Check decorative BEFORE repeating, so QR codes / logos that
            # happen to repeat on every page get cropped as images when user
            # selected "include as image", instead of being treated as headers
            page_w = pages[pi]['page_size']['width'] if pi < len(pages) else 612
            is_decorative = _is_decorative_block(db, text, page_w)

            if is_decorative and (is_repeating or is_page_num):
                # Decorative repeating element (QR code, logo, icon on every page).
                # When figure_display='image', crop as image. Otherwise treat as
                # header/footer with the OCR'd text.
                if figure_display == 'image' and include_figures and fitz_doc and pi < len(fitz_doc):
                    block = {
                        'type': 'image',
                        'bbox': db_bbox,
                        'text': '',
                    }
                    crop = _crop_and_embed(db_bbox, pi, fitz_doc[pi],
                                           img_dir, discard_pdf_md5, 'decorative_repeat')
                    if crop:
                        block.update(crop)
                    recovered_per_page[pi].append(block)
                    logger.debug('Page %d: decorative repeating→image bbox=%s',
                                pi, [round(x, 1) for x in db_bbox])
                    continue
                elif not include_figures:
                    logger.debug('Page %d: skipping decorative repeating bbox=%s (figures excluded)',
                                pi, [round(x, 1) for x in db_bbox])
                    continue
                # else: fall through to header/footer classification below

            if is_repeating or is_page_num:
                block_type = 'header' if is_top_half else 'footer'
                block = {
                    'type': block_type,
                    'bbox': db_bbox,
                    'text': text,
                }
                recovered_per_page[pi].append(block)
                logger.debug('Page %d: %s block bbox=%s text="%s"',
                            pi, block_type, [round(x, 1) for x in db_bbox], text[:60])
                continue

            if is_decorative:
                if not include_figures:
                    logger.debug('Page %d: skipping decorative block bbox=%s (figures excluded)',
                                pi, [round(x, 1) for x in db_bbox])
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
                    logger.debug('Page %d: decorative→image block bbox=%s',
                                pi, [round(x, 1) for x in db_bbox])
                else:
                    # figure_display='text' — recover as text (OCR'd)
                    block = {
                        'type': 'text',
                        'bbox': db_bbox,
                        'text': text or '[Decorative element]',
                    }
                    recovered_per_page[pi].append(block)
                    logger.debug('Page %d: decorative→text block bbox=%s text="%s"',
                                pi, [round(x, 1) for x in db_bbox], text[:60])
            else:
                # Real text content — recover as text block
                block = {
                    'type': 'text',
                    'bbox': db_bbox,
                    'text': text,
                }
                recovered_per_page[pi].append(block)
                logger.debug('Page %d: recovered block bbox=%s text="%s"',
                            pi, [round(x, 1) for x in db_bbox], text[:60])
    finally:
        if fitz_doc:
            fitz_doc.close()

    # Extend and sort once per page
    for pi, new_blocks in recovered_per_page.items():
        if pi >= len(pages):
            continue
        page_blocks = pages[pi]['preproc_blocks']
        page_blocks.extend(new_blocks)
        page_blocks.sort(key=lambda b: _safe_bbox(b.get('bbox'))[1])


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
    bbox = _safe_bbox(block.get('bbox'))
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
        bbox = _safe_bbox(block.get('bbox'))
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
            next_bbox = _safe_bbox(next_block.get('bbox'))
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
            logger.debug('Merged block [%d] with %d empty neighbors: %.0fpx → %.0fpx (%d lines)',
                        i, absorbed_this, block_h, new_h, line_count)

        result.append(block)

    return result


# Text-like block types that may legitimately be merged when bboxes overlap.
_MERGEABLE_TEXT_TYPES = ('text', 'title', 'list')


def _merge_overlapping_blocks(blocks: list[dict]) -> list[dict]:
    """Merge text-like blocks whose bboxes overlap heavily.

    MinerU's layout model occasionally emits two regions for the same chunk
    of page real-estate (e.g. a short header bbox positioned inside a long
    body bbox). When two text/title/list blocks overlap by >=60% relative to
    the smaller block's area, fold the smaller into the larger one. The
    larger block's bbox and type win; the smaller block's content is
    prepended to the larger block's text with a newline separator. Empty
    smaller blocks are simply dropped.
    """
    if len(blocks) < 2:
        return blocks

    # Precompute bbox + area for each block, marking those eligible for merge.
    n = len(blocks)
    info = []
    for b in blocks:
        bb = _safe_bbox(b.get('bbox'))
        area = max(0, bb[2] - bb[0]) * max(0, bb[3] - bb[1])
        mergeable = b.get('type') in _MERGEABLE_TEXT_TYPES and area > 0
        info.append((bb, area, mergeable))

    # Work on copies so we can mutate text/bbox without touching originals.
    out = [dict(b) for b in blocks]
    dropped = set()

    for i in range(n):
        if i in dropped or not info[i][2]:
            continue
        for j in range(n):
            if j == i or j in dropped or not info[j][2]:
                continue
            bb_i, area_i, _ = info[i]
            bb_j, area_j, _ = info[j]
            # i must be the smaller (or equal) block.
            if area_i > area_j:
                continue
            ix1 = max(bb_i[0], bb_j[0])
            iy1 = max(bb_i[1], bb_j[1])
            ix2 = min(bb_i[2], bb_j[2])
            iy2 = min(bb_i[3], bb_j[3])
            inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
            if inter / area_i < 0.6:
                continue
            # Merge i into j.
            small_text = (out[i].get('text') or '').strip()
            if small_text:
                large_text = out[j].get('text') or ''
                out[j]['text'] = (small_text + '\n' + large_text).strip()
            logger.debug('Merged overlapping block [%d] (type=%s, area=%.0f) into [%d] (type=%s, area=%.0f); overlap=%.0f%%',
                        i, out[i].get('type'), area_i, j, out[j].get('type'), area_j, (inter / area_i) * 100)
            dropped.add(i)
            break

    return [b for k, b in enumerate(out) if k not in dropped]


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
    logger.info('Heading hierarchy: %d titles, levels: %s', len(title_entries), level_counts)


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
        bb = _safe_bbox(b.get('bbox'))
        tbl_bb = _safe_bbox(tbl_bbox)
        # Calculate overlap
        x_overlap = max(0, min(bb[2], tbl_bb[2]) - max(bb[0], tbl_bb[0]))
        y_overlap = max(0, min(bb[3], tbl_bb[3]) - max(bb[1], tbl_bb[1]))
        overlap = x_overlap * y_overlap
        if overlap > best_overlap:
            best_overlap = overlap
            best_idx = i

    if best_idx >= 0:
        blocks[best_idx]['table_html'] = tbl_html
        blocks[best_idx]['type'] = 'table'


class MineruHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        logger.debug('%s', args[0] if args else format)

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
            if task.get('_cleaned'):
                safe_task['cleaned'] = True
            self._send_json(200, safe_task)
            return

        # GET /fonts/{filename}[?format=ttf] — serve bundled font files
        # Default: serve WOFF2 as-is. With ?format=ttf: convert via fontTools,
        # cache in /tmp/mineru_fonts_ttf/ for subsequent requests.
        if parsed.path.startswith('/fonts/'):
            from urllib.parse import parse_qs
            query = parse_qs(parsed.query)
            fmt = query.get('format', ['woff2'])[0].lower()
            filename = os.path.basename(parsed.path[len('/fonts/'):])
            font_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    'lib', 'fonts')
            woff2_path = os.path.join(font_dir, filename)
            if not filename.endswith('.woff2') or not os.path.exists(woff2_path):
                self._send_json(404, {'error': 'Font not found'})
                return

            if fmt == 'ttf':
                ttf_cache_dir = os.path.join(tempfile.gettempdir(), 'mineru_fonts_ttf')
                os.makedirs(ttf_cache_dir, exist_ok=True)
                ttf_name = filename.replace('.woff2', '.ttf')
                ttf_path = os.path.join(ttf_cache_dir, ttf_name)
                if not os.path.exists(ttf_path):
                    try:
                        from fontTools.ttLib import TTFont
                        font = TTFont(woff2_path)
                        font.flavor = None  # Strip WOFF2 wrapper to produce real TTF
                        font.save(ttf_path)
                        font.close()
                    except Exception as e:
                        self._send_json(500, {'error': f'TTF conversion failed: {e}'})
                        return
                with open(ttf_path, 'rb') as f:
                    data = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'font/ttf')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'public, max-age=31536000')
                self.end_headers()
                self.wfile.write(data)
            else:
                with open(woff2_path, 'rb') as f:
                    data = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'font/woff2')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'public, max-age=31536000')
                self.end_headers()
                self.wfile.write(data)
            return

        self._send_json(404, {'error': 'Not found'})

    def do_DELETE(self):
        parsed = urlparse(self.path)

        # DELETE /tasks/{task_id} — free heavy resources after exports
        if parsed.path.startswith('/tasks/'):
            path_parts = parsed.path.strip('/').split('/')
            task_id = path_parts[1] if len(path_parts) >= 2 else ''
            task = tasks.get(task_id)
            if not task:
                self._send_json(404, {'error': 'Task not found'})
                return
            if task.get('status') == 'processing':
                self._send_json(409, {'error': 'Task still processing'})
                return
            _cleanup_task(task_id)
            self._send_json(200, {'task_id': task_id, 'cleaned': True})
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

        # Concurrency limit is enforced inside the worker thread (blocking acquire),
        # so HTTP submissions never fail with 429 — they queue as 'pending' tasks.

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

        logger.info('Task %s created for %s (%d bytes), config=%s',
                    task_id, file_name, len(file_data), config,
                    extra={'task_id': task_id})

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
        logger.info('Pre-warming models...')
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
        logger.info('Models pre-warmed in %.1fs', t1 - t0,
                    extra={'duration_ms': round((t1 - t0) * 1000)})
        _server_status = 'ok'

    except Exception as e:
        logger.error('Pre-warm failed: %s', e, extra={'error': str(e)})
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
    logger.info('Wrote config to %s (models-dir: %s)', config_path, models_dir)


def _auto_cleanup_loop():
    """Background thread: clean up stale completed/failed tasks every 60s."""
    CLEANUP_INTERVAL = 60
    STALE_AGE_SECONDS = 600  # 10 minutes

    while True:
        time.sleep(CLEANUP_INTERVAL)
        try:
            now = time.time()
            for task_id, task in list(tasks.items()):
                if task.get('_cleaned'):
                    continue
                status = task.get('status')
                if status not in ('completed', 'failed'):
                    continue
                completed_at = task.get('_completed_at', 0)
                if completed_at and (now - completed_at) > STALE_AGE_SECONDS:
                    logger.info('Auto-cleaning stale task %s (status=%s, age=%.0fs)',
                                task_id, status, now - completed_at,
                                extra={'task_id': task_id})
                    _cleanup_task(task_id)
            _evict_old_tasks()
        except Exception as e:
            logger.error('Auto-cleanup error: %s', e, extra={'error': str(e)})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='MinerU REST API server')
    parser.add_argument('--port', type=int, default=int(os.environ.get('MINERU_PORT', '8765')),
                        help='Port to listen on (default: 8765 or MINERU_PORT env)')
    parser.add_argument('--models-dir', type=str, default=None,
                        help='Override models directory in magic-pdf.json')
    parser.add_argument('--no-warm', action='store_true',
                        help='Skip model pre-warming on startup')
    args = parser.parse_args()

    # Set up structured JSON logging with rotation
    _setup_logging()
    # Redirect native stdout/stderr (torch, MinerU, PaddleOCR prints) through logger
    sys.stdout = StreamToLogger(logger, logging.INFO)
    sys.stderr = StreamToLogger(logger, logging.WARNING)

    # Sweep orphaned task directories from previous runs (before serving requests)
    _sweep_orphan_tempdirs()

    # Write magic-pdf.json if --models-dir is provided
    if args.models_dir:
        _write_magic_pdf_config(args.models_dir)

    # Clear stale TTF font cache from previous server runs
    _ttf_cache = os.path.join(tempfile.gettempdir(), 'mineru_fonts_ttf')
    if os.path.isdir(_ttf_cache):
        import shutil
        shutil.rmtree(_ttf_cache, ignore_errors=True)

    # Start HTTP server in a thread so we can respond to health checks during warm-up
    server = HTTPServer(('127.0.0.1', args.port), MineruHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    logger.info('Listening on http://127.0.0.1:%d', args.port)
    logger.info('Endpoints: GET /health, POST /file_parse, GET /tasks/{id}')

    # Pre-warm models (blocking — health returns 503 until done)
    if not args.no_warm:
        _pre_warm_models()
    else:
        _server_status = 'ok'

    # Start auto-cleanup background thread
    cleanup_thread = threading.Thread(target=_auto_cleanup_loop, daemon=True)
    cleanup_thread.start()

    logger.info('Ready')

    try:
        server_thread.join()
    except KeyboardInterrupt:
        logger.info('Shutting down')
        server.shutdown()
