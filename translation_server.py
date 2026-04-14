"""
Translation REST API server — wraps IndicTrans2 for offline Indic language
translation via /translate, /translate/batch, and model lifecycle endpoints.

Runs as a SEPARATE process from MinerU to avoid memory conflicts between
MinerU's OCR models and IndicTrans2's translation models.

Usage:
    ./test-venv/bin/python translation_server.py
    ./test-venv/bin/python translation_server.py --port 51823
"""

import argparse
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
# Structured JSON logging (same pattern as mineru_server.py)
# ---------------------------------------------------------------------------

class JsonFormatter(logging.Formatter):
    """Emit one JSON object per log line for structured log consumption."""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict = {
            'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(record.created)),
            'level': record.levelname,
            'task_id': getattr(record, 'task_id', None),
            'msg': record.getMessage(),
        }
        for key in ('duration_ms', 'error'):
            val = getattr(record, key, None)
            if val is not None:
                entry[key] = val
        return json.dumps(entry, default=str)


class StreamToLogger:
    """Redirect stdout/stderr through the logging system."""

    def __init__(self, logger: logging.Logger, level: int = logging.INFO):
        self._logger = logger
        self._level = level

    def write(self, msg: str) -> None:
        if msg and msg.strip():
            for line in msg.rstrip('\n').split('\n'):
                self._logger.log(self._level, line)

    def flush(self) -> None:
        pass

    def isatty(self) -> bool:
        return False


def _setup_logging() -> logging.Logger:
    """Configure the 'translation' logger with RotatingFileHandler + JSON format."""
    log_level_name = os.environ.get('LOG_LEVEL', 'INFO').upper()
    log_level = getattr(logging, log_level_name, logging.INFO)

    logger = logging.getLogger('translation')
    logger.setLevel(log_level)
    logger.propagate = False
    logging.raiseExceptions = False

    formatter = JsonFormatter()

    log_path = os.path.join(tempfile.gettempdir(), 'translation_server.log')
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


logger = logging.getLogger('translation')


# ---------------------------------------------------------------------------
# Translation engine (lazy import)
# ---------------------------------------------------------------------------

_engine = None
_engine_lock = threading.Lock()


def _get_engine():
    """Get or create the singleton TranslationEngine."""
    global _engine
    if _engine is None:
        from lib.translation import TranslationEngine
        _engine = TranslationEngine()
    return _engine


# ---------------------------------------------------------------------------
# Task store (in-memory) for batch operations
# ---------------------------------------------------------------------------

_tasks: dict[str, dict] = {}
_tasks_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Idle timeout
# ---------------------------------------------------------------------------

_last_request_time = time.time()
_IDLE_TIMEOUT = 300  # 5 minutes


def _touch_activity():
    """Record that a request was received (resets idle timer)."""
    global _last_request_time
    _last_request_time = time.time()


def _idle_watchdog(server: HTTPServer):
    """Background thread: exit if idle for IDLE_TIMEOUT with no active tasks."""
    while True:
        time.sleep(30)
        elapsed = time.time() - _last_request_time
        if elapsed < _IDLE_TIMEOUT:
            continue
        # Check for active tasks
        has_active = False
        with _tasks_lock:
            for task in _tasks.values():
                if task.get('status') == 'processing':
                    has_active = True
                    break
        if not has_active:
            logger.info('Idle timeout (%.0fs), shutting down', elapsed)
            server.shutdown()
            return


# ---------------------------------------------------------------------------
# Batch worker
# ---------------------------------------------------------------------------

def _batch_worker(task_id: str, items: list, src_lang: str,
                  tgt_langs: list, model_variant: str, output_dir: str):
    """Run batch translation in a background thread."""
    from lib.translation import TranslationEngine, _infer_direction, is_available

    task = _tasks[task_id]
    try:
        if not is_available():
            task['status'] = 'failed'
            task['error'] = 'IndicTrans2 dependencies not installed'
            return

        engine = _get_engine()

        # Load model for first direction needed
        if items and tgt_langs:
            first_dir = _infer_direction(src_lang, tgt_langs[0])
            engine.load_model(first_dir, model_variant)

        def on_progress(completed, total, current_file, current_lang):
            task['progress'] = {
                'completed': completed,
                'total': total,
                'current_file': current_file,
                'current_lang': current_lang,
            }

        result = engine.translate_batch(
            items=items,
            src_lang=src_lang,
            tgt_langs=tgt_langs,
            output_dir=output_dir,
            on_progress=on_progress,
        )

        task['status'] = 'completed'
        task['progress'] = {
            'completed': result['completed'],
            'total': result['total'],
            'current_file': None,
            'current_lang': None,
        }
        task['result'] = result

    except Exception as e:
        logger.error('Batch task %s failed: %s', task_id, e,
                      extra={'task_id': task_id, 'error': str(e)})
        task['status'] = 'failed'
        task['error'] = str(e)


# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------

class TranslationHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        logger.debug('%s', args[0] if args else format)

    def _send_json(self, code: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        # CORS for localhost
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict | None:
        """Read and parse the JSON request body."""
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length == 0:
            return {}
        try:
            body = self.rfile.read(content_length)
            return json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            self._send_json(400, {'error': f'Invalid JSON: {e}'})
            return None

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '86400')
        self.end_headers()

    def do_GET(self):
        _touch_activity()
        parsed = urlparse(self.path)

        if parsed.path == '/health':
            from lib.translation import is_available, SUPPORTED_LANGUAGES
            engine = _get_engine()
            # ready = server up AND default model loaded (for splash screen gating)
            ready = bool(is_available() and engine.model_loaded)
            self._send_json(200, {
                'status': 'ok',
                'ready': ready,
                'model_loaded': engine.model_loaded,
                'model_direction': engine.model_direction,
                'model_variant': engine.model_variant,
                'available': is_available(),
            })
            return

        # GET /translate/status/{task_id}
        if parsed.path.startswith('/translate/status/'):
            path_parts = parsed.path.strip('/').split('/')
            task_id = path_parts[2] if len(path_parts) >= 3 else ''
            with _tasks_lock:
                task = _tasks.get(task_id)
            if not task:
                self._send_json(404, {'error': 'Task not found'})
                return
            self._send_json(200, {
                'task_id': task_id,
                'status': task.get('status', 'unknown'),
                'progress': task.get('progress', {}),
                'error': task.get('error'),
            })
            return

        # GET /translate/models
        if parsed.path == '/translate/models':
            from lib.translation import is_available, SUPPORTED_LANGUAGES
            engine = _get_engine()
            self._send_json(200, {
                'available': is_available(),
                'supported_languages': SUPPORTED_LANGUAGES,
                'directions': ['en-indic', 'indic-en', 'indic-indic'],
                'variants': ['1B', '200M'],
                'loaded': {
                    'direction': engine.model_direction,
                    'variant': engine.model_variant,
                } if engine.model_loaded else None,
            })
            return

        self._send_json(404, {'error': 'Not found'})

    def do_POST(self):
        _touch_activity()
        parsed = urlparse(self.path)

        # POST /translate — single document translation
        if parsed.path == '/translate':
            self._handle_translate()
            return

        # POST /translate/batch — batch translation
        if parsed.path == '/translate/batch':
            self._handle_translate_batch()
            return

        # POST /translate/model/load
        if parsed.path == '/translate/model/load':
            self._handle_model_load()
            return

        # POST /translate/model/unload
        if parsed.path == '/translate/model/unload':
            self._handle_model_unload()
            return

        self._send_json(404, {'error': 'Not found'})

    def _handle_translate(self):
        """POST /translate — translate OCR JSON inline."""
        from lib.translation import is_available, _infer_direction

        if not is_available():
            self._send_json(503, {
                'error': 'Translation model not installed. '
                         'Install IndicTrans2 dependencies to enable translation.'
            })
            return

        body = self._read_json_body()
        if body is None:
            return

        json_data = body.get('json_data')
        src_lang = body.get('src_lang', 'eng_Latn')
        tgt_lang = body.get('tgt_lang')
        model_variant = body.get('model_variant', '1B')

        if not json_data:
            self._send_json(400, {'error': 'json_data is required'})
            return
        if not tgt_lang:
            self._send_json(400, {'error': 'tgt_lang is required'})
            return

        try:
            engine = _get_engine()
            needed_dir = _infer_direction(src_lang, tgt_lang)

            with _engine_lock:
                if not engine.model_loaded or engine.model_direction != needed_dir:
                    engine.load_model(needed_dir, model_variant)

                start = time.time()
                translated = engine.translate_json(json_data, src_lang, tgt_lang)
                elapsed_ms = (time.time() - start) * 1000

            logger.info('Translated %s -> %s in %.0fms',
                        src_lang, tgt_lang, elapsed_ms,
                        extra={'duration_ms': elapsed_ms})

            self._send_json(200, {
                'translated_json': translated,
                'src_lang': src_lang,
                'tgt_lang': tgt_lang,
                'duration_ms': round(elapsed_ms),
            })

        except Exception as e:
            logger.error('Translation failed: %s', e, extra={'error': str(e)})
            traceback.print_exc()
            self._send_json(500, {'error': f'Translation failed: {str(e)}'})

    def _handle_translate_batch(self):
        """POST /translate/batch — start async batch translation."""
        from lib.translation import is_available

        if not is_available():
            self._send_json(503, {
                'error': 'Translation model not installed.'
            })
            return

        body = self._read_json_body()
        if body is None:
            return

        items = body.get('items', [])
        src_lang = body.get('src_lang', 'eng_Latn')
        model_variant = body.get('model_variant', '1B')
        output_dir = body.get('output_dir')

        if not items:
            self._send_json(400, {'error': 'items is required (list of {json_path, tgt_langs})'})
            return
        if not output_dir:
            self._send_json(400, {'error': 'output_dir is required'})
            return

        # Collect all target languages from items
        all_tgt_langs = set()
        for item in items:
            tgt_langs = item.get('tgt_langs', [])
            all_tgt_langs.update(tgt_langs)
        all_tgt_langs = sorted(all_tgt_langs)

        if not all_tgt_langs:
            self._send_json(400, {'error': 'No target languages specified in items'})
            return

        # Normalize items to just json_path for the engine
        engine_items = [{'json_path': item['json_path']} for item in items]

        task_id = str(uuid.uuid4())
        total = len(items) * len(all_tgt_langs)

        task = {
            'status': 'processing',
            'progress': {
                'completed': 0,
                'total': total,
                'current_file': None,
                'current_lang': None,
            },
            'created_at': time.time(),
        }

        with _tasks_lock:
            _tasks[task_id] = task

        worker = threading.Thread(
            target=_batch_worker,
            args=(task_id, engine_items, src_lang, all_tgt_langs,
                  model_variant, output_dir),
            daemon=True,
        )
        worker.start()

        self._send_json(202, {
            'task_id': task_id,
            'status': 'processing',
            'total': total,
        })

    def _handle_model_load(self):
        """POST /translate/model/load — load a specific model."""
        from lib.translation import is_available

        if not is_available():
            self._send_json(503, {
                'error': 'Translation model not installed.'
            })
            return

        body = self._read_json_body()
        if body is None:
            return

        direction = body.get('direction', 'en-indic')
        variant = body.get('variant', '1B')

        try:
            engine = _get_engine()
            with _engine_lock:
                engine.load_model(direction, variant)
            self._send_json(200, {
                'status': 'loaded',
                'direction': direction,
                'variant': variant,
            })
        except Exception as e:
            logger.error('Model load failed: %s', e, extra={'error': str(e)})
            self._send_json(500, {'error': f'Model load failed: {str(e)}'})

    def _handle_model_unload(self):
        """POST /translate/model/unload — free model memory."""
        engine = _get_engine()
        with _engine_lock:
            engine.unload_model()
        self._send_json(200, {'status': 'unloaded'})


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Translation REST API server')
    parser.add_argument('--port', type=int,
                        default=int(os.environ.get('TRANSLATION_PORT', '51823')),
                        help='Port to listen on (default: 51823 or TRANSLATION_PORT env)')
    args = parser.parse_args()

    # Set up structured JSON logging
    _setup_logging()
    sys.stdout = StreamToLogger(logger, logging.INFO)
    sys.stderr = StreamToLogger(logger, logging.WARNING)

    # Start HTTP server
    server = HTTPServer(('127.0.0.1', args.port), TranslationHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    logger.info('Listening on http://127.0.0.1:%d', args.port)
    logger.info('Endpoints: GET /health, POST /translate, POST /translate/batch, '
                'GET /translate/status/{id}, GET /translate/models, '
                'POST /translate/model/load, POST /translate/model/unload')

    # Start idle watchdog
    watchdog = threading.Thread(target=_idle_watchdog, args=(server,), daemon=True)
    watchdog.start()

    # Pre-warm default model so the app doesn't need a first-request warmup.
    # Set TRANSLATION_PREWARM=0 to skip (useful for dev).
    prewarm = os.environ.get('TRANSLATION_PREWARM', '1') != '0'
    prewarm_direction = os.environ.get('TRANSLATION_PREWARM_DIRECTION', 'en-indic')
    prewarm_variant = os.environ.get('TRANSLATION_PREWARM_VARIANT', '200M')

    def _prewarm():
        try:
            from lib.translation import is_available as _ts_is_available
            engine = _get_engine()
            if not _ts_is_available():
                logger.warning('Skipping prewarm: IndicTrans2 not installed')
                return
            logger.info('Pre-warming model: %s %s', prewarm_direction, prewarm_variant)
            with _engine_lock:
                engine.load_model(prewarm_direction, prewarm_variant)
            logger.info('Pre-warm complete')
        except Exception as e:
            import traceback
            logger.warning('Pre-warm failed: %s\n%s', e, traceback.format_exc())

    if prewarm:
        threading.Thread(target=_prewarm, daemon=True).start()

    logger.info('Ready (idle timeout: %ds, prewarm: %s)', _IDLE_TIMEOUT, prewarm)

    try:
        server_thread.join()
    except KeyboardInterrupt:
        logger.info('Shutting down')
        server.shutdown()
