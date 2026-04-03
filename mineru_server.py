"""
MinerU REST API server — wraps the MinerU Python library to serve
the /health, /file_parse, and /tasks/{id} endpoints expected by the
Next.js OCR pipeline client.

Usage:
    ./mineru-venv/bin/python mineru_server.py
"""
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

        ds = PymuDocDataset(pdf_bytes, lang='en')

        # Step 1: Model inference (layout detection + OCR)
        infer_result = ds.apply(
            doc_analyze,
            ocr=True,
            lang='en',
            formula_enable=False,
        )

        # Step 2: Run full pipeline (paragraph merging, heading detection,
        # table extraction, reading order, image extraction)
        tmpdir = tempfile.mkdtemp(prefix='mineru_')
        img_dir = os.path.join(tmpdir, 'images')
        image_writer = FileBasedDataWriter(img_dir)
        pipe_result = infer_result.pipe_ocr_mode(
            image_writer, debug_mode=True, lang='en'
        )

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

            blocks = []
            for b in para_blocks:
                block_type = b.get('type', 'text')
                bbox = b.get('bbox', [0, 0, 0, 0])

                # Extract content from the nested structure:
                # para_block may have direct lines/spans OR nested blocks[].lines[].spans[]
                text, table_html, img_path, latex = _extract_block_content(b, img_dir)

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

    # Join text — preserve \n between spans (each span is a visual line)
    text = '\n'.join(text_parts)

    return text, table_html, img_path, latex


def _join_visual_lines(text: str) -> str:
    """Replace single \\n with space, preserve \\n\\n (paragraph breaks)."""
    import re
    # Protect double newlines
    text = text.replace('\r\n', '\n')
    text = re.sub(r'\n{2,}', '\x00', text)
    # Single newlines → space
    text = text.replace('\n', ' ')
    # Restore paragraph breaks
    text = text.replace('\x00', '\n\n')
    # Collapse multiple spaces
    text = re.sub(r'  +', ' ', text)
    return text.strip()


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


def _vision_llm_table(img_path: str) -> str:
    """Use vision LLM to extract a proper HTML table from a table image."""
    import base64
    import cv2
    from magic_pdf.model.sub_modules.ocr.paddleocr2pytorch.vision_llm_ocr import (
        _call_openrouter,
    )

    prompt = """\
Extract the table from this image and return it as a clean HTML table.

Rules:
- Return ONLY an HTML <table> element, nothing else.
- Each row becomes a <tr>, each cell a <td> (use <th> for header cells).
- Preserve all text exactly as it appears.
- If a cell spans multiple columns or rows, use colspan/rowspan attributes.
- Do NOT wrap in <html> or <body> tags.
"""

    try:
        img = cv2.imread(img_path)
        if img is None:
            return ''
        success, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if not success:
            return ''
        image_b64 = base64.b64encode(buf).decode('ascii')
        raw = _call_openrouter(image_b64, prompt)
        raw = raw.strip()
        # Strip markdown fences
        if raw.startswith('```'):
            raw = raw.split('\n', 1)[-1]
            if raw.endswith('```'):
                raw = raw[:-3]
            raw = raw.strip()
        # Remove <html><body> wrapper if model added it
        raw = raw.replace('<html>', '').replace('</html>', '')
        raw = raw.replace('<body>', '').replace('</body>', '')
        raw = raw.strip()
        if '<table' in raw.lower():
            return raw
        return ''
    except Exception as e:
        print(f'[MinerU Server] Vision LLM table extraction failed: {e}')
        return ''


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
