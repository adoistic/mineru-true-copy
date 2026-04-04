"""
MinerU REST API server — wraps the MinerU Python library to serve
the /health, /file_parse, and /tasks/{id} endpoints expected by the
Next.js OCR pipeline client.

Usage:
    ./mineru-venv/bin/python mineru_server.py
"""
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

# Task store (in-memory)
tasks: dict[str, dict] = {}


def process_pdf(task_id: str, pdf_bytes: bytes, file_name: str):
    """Run full MinerU OCR pipeline and store the structured result."""
    try:
        tasks[task_id]['status'] = 'processing'
        t_start = time.time()

        ds = PymuDocDataset(pdf_bytes, lang='en')

        # Step 1: Model inference (layout detection + OCR)
        t1 = time.time()
        infer_result = ds.apply(
            doc_analyze,
            ocr=True,
            lang='en',
            formula_enable=True,  # UniMerNet patched for transformers 4.38+ compatibility
        )
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

        # Step 3: Convert pipeline output to the format the client expects
        raw = pipe_result._pipe_res
        pdf_info_raw = raw.get('pdf_info', [])
        # img_dir is where MinerU wrote extracted images
        _current_img_dir = img_dir

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
                text, table_html, img_path, latex = _extract_block_content(b, img_dir)

                # Detect list content in text blocks
                if block_type == 'text' and text and _detect_list_content(text):
                    block_type = 'list'

                block = {
                    'type': block_type,
                    'bbox': bbox,
                    'text': text,
                }

                if table_html:
                    block['table_html'] = table_html
                if latex:
                    block['latex'] = latex
                if img_path:
                    block['img_path'] = img_path
                    # Embed image as base64 for client rendering
                    img_full_path = os.path.join(img_dir, img_path)
                    if os.path.exists(img_full_path):
                        import base64
                        with open(img_full_path, 'rb') as f:
                            block['img_data'] = base64.b64encode(f.read()).decode('ascii')
                        ext = os.path.splitext(img_path)[1].lower()
                        block['img_mime'] = 'image/jpeg' if ext in ('.jpg', '.jpeg') else 'image/png'
                    else:
                        print(f'[MinerU Server] WARNING: Image file not found: {img_full_path}')

                blocks.append(block)

            pages.append({
                'page_idx': page_idx,
                'page_size': {'width': width, 'height': height},
                'preproc_blocks': blocks,
            })

        result = {
            'pdf_info': pages,
            'file_name': file_name,
        }

        tasks[task_id]['status'] = 'completed'
        tasks[task_id]['result'] = result

        total_blocks = sum(len(p['preproc_blocks']) for p in pages)
        print(f'[MinerU Server] Task {task_id} completed: '
              f'{len(pages)} pages, {total_blocks} blocks')

    except Exception as e:
        traceback.print_exc()
        tasks[task_id]['status'] = 'failed'
        tasks[task_id]['error'] = str(e)
        print(f'[MinerU Server] Task {task_id} failed: {e}')


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
    # Arabic numbered: 1. / 1) / (1) / [1]
    if re.match(r'^\d+[\.\)]\s', line) or re.match(r'^\(\d+\)\s', line) or re.match(r'^\[\d+\]\s', line):
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
    # (single 'i.' could be alphabetical, but in list context it usually is roman)
    if re.match(r'^[ivxIVX][\.\)]\s', line):
        return True
    # Section/Article/Part/Chapter/Item/Note/Step prefixes
    if re.match(r'^(?:Section|Article|Part|Chapter|Item|Note|Step)\s+\d', line, re.IGNORECASE):
        return True
    return False


def _merge_block_text(block: dict) -> str:
    """Merge text spans from a para_block into flowing prose.

    Adapted from MinerU's merge_para_with_text() (dict2md/ocr_mkcontent.py:177)
    but designed for HTML-formatted VLM output instead of markdown.

    Key differences from MinerU's version:
    - No markdown character escaping (we output HTML)
    - Preserves HTML formatting tags (<strong>, <em>, <sup>, etc.)
    - Same language-aware spacing (CJK: no space, Western: space)
    - Same hyphen handling at line ends
    - Same list line break preservation
    """
    import re

    lines = block.get('lines', [])
    if not lines:
        # Fallback: use direct text field if no structured lines
        return block.get('text', '')

    # Collect all plain text to detect language
    plain_text = ''
    for line in lines:
        for span in line.get('spans', []):
            content = span.get('content', '')
            if content:
                plain_text += content

    # Detect language for spacing rules
    try:
        from magic_pdf.libs.language import detect_lang
        block_lang = detect_lang(plain_text)
    except Exception:
        block_lang = 'en'  # Default to Western spacing

    cjk_langs = ['zh', 'ja', 'ko']
    para_text = ''

    for i, line in enumerate(lines):
        # Preserve list line breaks (MinerU marks these during paragraph splitting)
        if i >= 1 and line.get('is_list_start_line', False):
            para_text += '\n'

        spans = line.get('spans', [])
        for j, span in enumerate(spans):
            content = span.get('content', '')
            if not content or not content.strip():
                continue

            content = content.strip()
            is_last_span = (j == len(spans) - 1)

            if block_lang in cjk_langs:
                # CJK: no space between lines within a paragraph,
                # but add space after inline equations
                if is_last_span:
                    para_text += content
                else:
                    para_text += f'{content} '
            else:
                # Western: add space between spans
                # Handle hyphenation: if span ends with letter+hyphen, join without space
                if is_last_span and re.search(r'[A-Za-z]+-\s*$', content):
                    # Remove trailing hyphen, next line continues the word
                    para_text += content.rstrip()[:-1]
                else:
                    para_text += f'{content} '

    return para_text.strip()


def _join_visual_lines(parts: list[str]) -> str:
    """Join visual text lines into flowing prose (legacy fallback).

    Used when structured block data (lines→spans) is not available.
    Prefer _merge_block_text() which uses MinerU's structural approach.
    """
    if not parts:
        return ''
    if len(parts) == 1:
        return parts[0]

    import re
    result = [parts[0]]
    for line in parts[1:]:
        prev = result[-1]
        stripped_prev = prev.rstrip()
        stripped_line = line.strip()
        if not stripped_line:
            # Empty line = paragraph break
            result.append('\n\n')
            continue
        # Check if previous line ends with sentence-terminal punctuation
        ends_sentence = bool(re.search(r'[.!?:;]\s*$', stripped_prev))
        # Check if current line is a list item
        is_list = _is_list_item(stripped_line)

        if ends_sentence or is_list:
            result.append('\n' + line)
        else:
            # Mid-sentence line break — join with space
            # Handle hyphenation: if prev ends with '-', join without space
            if stripped_prev.endswith('-'):
                result[-1] = stripped_prev[:-1]
                result.append(line)
            else:
                result.append(' ' + line)

    return ''.join(result)


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


def _extract_block_content(block: dict, img_dir: str = '') -> tuple[str, str, str, str]:
    """
    Extract all content from a para_block, including nested blocks.

    Returns: (text, table_html, img_path, latex)
    """
    block_type = block.get('type', 'text')
    text_parts = []
    table_html = ''
    img_path = ''
    latex = ''

    # Collect spans from all nested structures:
    # para_block may have:
    #   - direct lines[].spans[]
    #   - nested blocks[].lines[].spans[] (for tables, images)
    all_spans = []

    # Direct lines
    for line in block.get('lines', []):
        for span in line.get('spans', []):
            all_spans.append(span)

    # Nested blocks (tables have blocks[] containing table_body, table_caption, etc.)
    for inner_block in block.get('blocks', []):
        for line in inner_block.get('lines', []):
            for span in line.get('spans', []):
                all_spans.append(span)

    # Process all spans
    for span in all_spans:
        span_type = span.get('type', '')

        # Table HTML
        if span.get('html'):
            table_html = span['html']

        # Image path
        if span.get('image_path'):
            img_path = span['image_path']

        # LaTeX
        if span.get('latex'):
            latex = span['latex']

        # Text content
        content = span.get('content', '')
        if content and content.strip():
            text_parts.append(content)

    # Direct text field (fallback)
    if not text_parts and block.get('text'):
        text_parts = [block['text']]

    # Join visual lines into flowing text.
    # Use MinerU's structural approach (lines→spans) when available,
    # falling back to the legacy flat-text heuristic.
    if block_type in ('text', 'title'):
        if block.get('lines'):
            text = _merge_block_text(block)
        else:
            text = _join_visual_lines(text_parts)
    else:
        text = '\n'.join(text_parts)

    return text, table_html, img_path, latex



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
            self._send_json(200, {'status': 'ok'})
            return

        # GET /tasks/{task_id}
        if parsed.path.startswith('/tasks/'):
            task_id = parsed.path.split('/tasks/')[-1].strip('/')
            task = tasks.get(task_id)
            if not task:
                self._send_json(404, {'error': 'Task not found'})
                return
            self._send_json(200, task)
            return

        self._send_json(404, {'error': 'Not found'})

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == '/health':
            self._send_json(200, {'status': 'ok'})
            return

        if parsed.path == '/file_parse':
            self._handle_file_parse()
            return

        self._send_json(404, {'error': 'Not found'})

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
        file_data, file_name = self._parse_multipart(body, boundary)

        if not file_data:
            self._send_json(400, {'error': 'No file found in request'})
            return

        # Create task and start processing
        task_id = str(uuid.uuid4())
        tasks[task_id] = {
            'task_id': task_id,
            'status': 'pending',
            'result': None,
            'error': None,
        }

        print(f'[MinerU Server] Task {task_id} created for {file_name} ({len(file_data)} bytes)')

        thread = threading.Thread(
            target=process_pdf,
            args=(task_id, file_data, file_name),
            daemon=True,
        )
        thread.start()

        self._send_json(200, {'task_id': task_id})

    def _parse_multipart(self, body: bytes, boundary: str) -> tuple[bytes | None, str]:
        """Extract file data from multipart form body."""
        boundary_bytes = f'--{boundary}'.encode()
        parts = body.split(boundary_bytes)

        for part in parts:
            if b'Content-Disposition' not in part:
                continue

            # Check if this is the file part
            header_end = part.find(b'\r\n\r\n')
            if header_end == -1:
                continue

            header = part[:header_end].decode('utf-8', errors='replace')
            if 'name="file"' not in header:
                continue

            # Extract filename
            file_name = 'document.pdf'
            if 'filename="' in header:
                start = header.index('filename="') + len('filename="')
                end = header.index('"', start)
                file_name = header[start:end]

            # Extract file data (skip headers, strip trailing \r\n--)
            file_data = part[header_end + 4:]
            if file_data.endswith(b'\r\n'):
                file_data = file_data[:-2]
            if file_data.endswith(b'--\r\n'):
                file_data = file_data[:-4]
            if file_data.endswith(b'--'):
                file_data = file_data[:-2]
            if file_data.endswith(b'\r\n'):
                file_data = file_data[:-2]

            return file_data, file_name

        return None, ''


if __name__ == '__main__':
    port = int(os.environ.get('MINERU_PORT', '8765'))
    server = HTTPServer(('127.0.0.1', port), MineruHandler)
    print(f'[MinerU Server] Starting on http://127.0.0.1:{port}')
    print(f'[MinerU Server] Endpoints: GET /health, POST /file_parse, GET /tasks/{{id}}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n[MinerU Server] Shutting down')
        server.server_close()
