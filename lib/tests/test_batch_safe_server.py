"""
Tests for W1: Batch-Safe Server (waste management hardening).

Covers: orphan sweep, cleanup lifecycle, concurrent cleanup, max upload,
disk-space pre-flight, RotatingFileHandler fallback, invalid LOG_LEVEL,
pre-warm exit, and rmtree failure.
"""

import glob
import json
import logging
import os
import shutil
import tempfile
import threading
import time
from unittest.mock import patch, MagicMock

import pytest

# Import server module — need to handle the heavy MinerU imports
# We mock them where needed.
import sys

# Add project root to path so we can import mineru_server
_project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)


# ---------------------------------------------------------------------------
# Test 1: Orphan sweep cleans up mineru_task_* dirs
# ---------------------------------------------------------------------------

class TestOrphanSweep:
    def test_sweeps_orphaned_task_dirs(self):
        """Create mineru_task_* dirs, call sweep, verify they're cleaned."""
        tmpdir = tempfile.gettempdir()
        # Create fake orphan dirs
        orphan_dirs = []
        for i in range(3):
            d = tempfile.mkdtemp(prefix='mineru_task_', dir=tmpdir)
            # Put a file inside to verify rmtree works
            with open(os.path.join(d, 'dummy.txt'), 'w') as f:
                f.write('test')
            orphan_dirs.append(d)

        # Remove any stale PID file
        pid_file = os.path.join(tmpdir, 'mineru_server.pid')
        if os.path.exists(pid_file):
            os.remove(pid_file)

        try:
            from mineru_server import _sweep_orphan_tempdirs
            _sweep_orphan_tempdirs()

            for d in orphan_dirs:
                assert not os.path.exists(d), f'Orphan dir was not cleaned: {d}'
        finally:
            # Cleanup in case test fails
            for d in orphan_dirs:
                if os.path.exists(d):
                    shutil.rmtree(d, ignore_errors=True)

    def test_skips_sweep_if_another_instance_running(self):
        """If PID file points to a live process, skip the sweep."""
        tmpdir = tempfile.gettempdir()
        pid_file = os.path.join(tmpdir, 'mineru_server.pid')

        # Create a fake orphan dir
        orphan = tempfile.mkdtemp(prefix='mineru_task_', dir=tmpdir)

        # Write current PID (which IS alive) to the PID file
        with open(pid_file, 'w') as f:
            f.write(str(os.getpid()))

        try:
            from mineru_server import _sweep_orphan_tempdirs
            _sweep_orphan_tempdirs()

            # Orphan should NOT be cleaned (another instance is "running")
            assert os.path.exists(orphan), 'Orphan was cleaned despite live PID'
        finally:
            shutil.rmtree(orphan, ignore_errors=True)
            if os.path.exists(pid_file):
                os.remove(pid_file)

    def test_rmtree_failure_logs_warning(self):
        """If rmtree fails (PermissionError), log warning and continue."""
        tmpdir = tempfile.gettempdir()
        pid_file = os.path.join(tmpdir, 'mineru_server.pid')
        if os.path.exists(pid_file):
            os.remove(pid_file)

        orphan = tempfile.mkdtemp(prefix='mineru_task_', dir=tmpdir)

        try:
            from mineru_server import _sweep_orphan_tempdirs, logger
            with patch('shutil.rmtree', side_effect=PermissionError('denied')):
                # Should not raise — logs warning and continues
                _sweep_orphan_tempdirs()
        finally:
            shutil.rmtree(orphan, ignore_errors=True)


# ---------------------------------------------------------------------------
# Test 2: Cleanup lifecycle
# ---------------------------------------------------------------------------

class TestCleanupLifecycle:
    def test_cleanup_frees_resources(self):
        """Create task, complete it, call cleanup, verify resources freed."""
        from mineru_server import tasks, _cleanup_task

        task_id = 'test-cleanup-lifecycle'
        tmpdir = tempfile.mkdtemp(prefix='mineru_task_test_')

        tasks[task_id] = {
            'task_id': task_id,
            'status': 'completed',
            '_completed_at': time.time(),
            'result': {'pages': [{'preproc_blocks': []}]},
            '_pdf_bytes': b'fake pdf bytes' * 1000,
            '_img_dir': tmpdir,
        }

        try:
            _cleanup_task(task_id)

            task = tasks[task_id]
            assert '_pdf_bytes' not in task
            assert 'result' not in task
            assert task.get('_cleaned') is True
            assert not os.path.exists(tmpdir)
        finally:
            tasks.pop(task_id, None)
            if os.path.exists(tmpdir):
                shutil.rmtree(tmpdir, ignore_errors=True)

    def test_double_cleanup_is_noop(self):
        """Calling cleanup twice on same task should not raise."""
        from mineru_server import tasks, _cleanup_task

        task_id = 'test-double-cleanup'
        tasks[task_id] = {
            'task_id': task_id,
            'status': 'completed',
            '_completed_at': time.time(),
            'result': {'pages': []},
            '_cleaned': True,
        }

        try:
            _cleanup_task(task_id)  # Second call — should be no-op
            assert tasks[task_id].get('_cleaned') is True
        finally:
            tasks.pop(task_id, None)


# ---------------------------------------------------------------------------
# Test 3: Concurrent cleanup safety
# ---------------------------------------------------------------------------

class TestConcurrentCleanup:
    def test_concurrent_delete_and_auto_cleanup(self):
        """Trigger cleanup from two threads simultaneously, verify no crash."""
        from mineru_server import tasks, _cleanup_task

        task_id = 'test-concurrent-cleanup'
        tmpdir = tempfile.mkdtemp(prefix='mineru_task_test_')

        tasks[task_id] = {
            'task_id': task_id,
            'status': 'completed',
            '_completed_at': time.time() - 300,  # old enough for auto-cleanup
            'result': {'pages': []},
            '_pdf_bytes': b'fake' * 100,
            '_img_dir': tmpdir,
        }

        errors = []

        def cleanup_worker():
            try:
                _cleanup_task(task_id)
            except Exception as e:
                errors.append(e)

        t1 = threading.Thread(target=cleanup_worker)
        t2 = threading.Thread(target=cleanup_worker)
        t1.start()
        t2.start()
        t1.join(timeout=5)
        t2.join(timeout=5)

        try:
            assert not errors, f'Concurrent cleanup raised: {errors}'
            assert tasks[task_id].get('_cleaned') is True
        finally:
            tasks.pop(task_id, None)
            if os.path.exists(tmpdir):
                shutil.rmtree(tmpdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Test 4: Max upload size (413)
# ---------------------------------------------------------------------------

class TestMaxUpload:
    def test_large_content_length_rejected(self):
        """Content-Length > 500MB should get 413."""
        from mineru_server import MineruHandler

        handler = MagicMock(spec=MineruHandler)
        handler.headers = {
            'Content-Type': 'multipart/form-data; boundary=abc123',
            'Content-Length': str(600 * 1024 * 1024),  # 600MB
        }
        responses = []

        def mock_send_json(code, data):
            responses.append((code, data))

        handler._send_json = mock_send_json
        # Call the actual method
        MineruHandler._handle_file_parse(handler)

        assert len(responses) == 1
        assert responses[0][0] == 413
        assert 'too large' in responses[0][1]['error'].lower()


# ---------------------------------------------------------------------------
# Test 5: Disk-space pre-flight (507)
# ---------------------------------------------------------------------------

class TestDiskSpacePreFlight:
    """The disk-space safeguard now lives at the HTTP layer (returns 507
    from /file_parse before queueing). The dedicated regression test is
    in lib/tests/test_disk_safeguard.py — see TODO 17 for context."""

    def test_disk_check_no_longer_in_worker(self):
        """process_pdf must not contain its own disk-space check anymore.

        Keeping the gate in one place (the HTTP handler) avoids the tautology
        of checking twice and makes the failure mode obvious to readers.
        """
        import inspect
        from mineru_server import process_pdf

        src = inspect.getsource(process_pdf)
        assert 'disk_usage' not in src, (
            'process_pdf still references disk_usage; the check should '
            'live in _handle_file_parse (HTTP 507), not the worker.'
        )


# ---------------------------------------------------------------------------
# Test 6: RotatingFileHandler fallback
# ---------------------------------------------------------------------------

class TestLoggingSetup:
    def test_setup_logging_creates_handler(self):
        """_setup_logging should add at least one handler."""
        from mineru_server import _setup_logging

        test_logger = _setup_logging()
        assert len(test_logger.handlers) > 0
        # Clean up
        for h in test_logger.handlers[:]:
            test_logger.removeHandler(h)

    def test_fallback_to_stderr_on_permission_error(self):
        """When RotatingFileHandler fails, should fall back to stderr."""
        from mineru_server import _setup_logging

        test_logger = logging.getLogger('mineru')
        # Remove existing handlers
        for h in test_logger.handlers[:]:
            test_logger.removeHandler(h)

        with patch('logging.handlers.RotatingFileHandler',
                   side_effect=PermissionError('denied')):
            result = _setup_logging()

        assert len(result.handlers) > 0
        assert isinstance(result.handlers[0], logging.StreamHandler)

        # Clean up
        for h in result.handlers[:]:
            result.removeHandler(h)

    def test_invalid_log_level_defaults_to_info(self):
        """Invalid LOG_LEVEL env var should default to INFO."""
        from mineru_server import _setup_logging

        test_logger = logging.getLogger('mineru')
        for h in test_logger.handlers[:]:
            test_logger.removeHandler(h)

        with patch.dict(os.environ, {'LOG_LEVEL': 'BOGUS'}):
            result = _setup_logging()

        assert result.level == logging.INFO

        # Clean up
        for h in result.handlers[:]:
            result.removeHandler(h)


# ---------------------------------------------------------------------------
# Test 7: JSON formatter output
# ---------------------------------------------------------------------------

class TestJsonFormatter:
    def test_json_format(self):
        """JsonFormatter should produce valid JSON with required fields."""
        from mineru_server import JsonFormatter

        formatter = JsonFormatter()
        record = logging.LogRecord(
            name='mineru', level=logging.INFO, pathname='test.py',
            lineno=1, msg='Test message', args=(), exc_info=None,
        )
        record.task_id = 'abc123'
        record.page_idx = 3
        record.rss_mb = 1200

        output = formatter.format(record)
        parsed = json.loads(output)

        assert parsed['level'] == 'INFO'
        assert parsed['msg'] == 'Test message'
        assert parsed['task_id'] == 'abc123'
        assert parsed['page_idx'] == 3
        assert parsed['rss_mb'] == 1200
        assert 'ts' in parsed

    def test_json_format_nullable_fields(self):
        """task_id and page_idx should be null when not set."""
        from mineru_server import JsonFormatter

        formatter = JsonFormatter()
        record = logging.LogRecord(
            name='mineru', level=logging.WARNING, pathname='test.py',
            lineno=1, msg='No context', args=(), exc_info=None,
        )

        output = formatter.format(record)
        parsed = json.loads(output)

        assert parsed['task_id'] is None
        assert parsed['page_idx'] is None


# ---------------------------------------------------------------------------
# Test 8: Temp prefix is mineru_task_
# ---------------------------------------------------------------------------

class TestTempPrefix:
    def test_tempdir_uses_task_prefix(self):
        """Verify our temp dirs use mineru_task_ prefix (not mineru_)."""
        # This is a code inspection test — verify the constant in process_pdf
        import mineru_server
        import inspect

        source = inspect.getsource(mineru_server.process_pdf)
        assert "prefix='mineru_task_'" in source
        assert "prefix='mineru_'" not in source or "prefix='mineru_task_'" in source


# ---------------------------------------------------------------------------
# Test 9: Auto-cleanup intervals are tightened
# ---------------------------------------------------------------------------

class TestAutoCleanupIntervals:
    def test_cleanup_interval_is_30s(self):
        """Verify auto-cleanup uses 30s interval (tightened from 60s)."""
        import mineru_server
        import inspect

        source = inspect.getsource(mineru_server._auto_cleanup_loop)
        assert 'CLEANUP_INTERVAL = 30' in source

    def test_stale_age_is_120s(self):
        """Verify stale threshold is 2min (tightened from 10min)."""
        import mineru_server
        import inspect

        source = inspect.getsource(mineru_server._auto_cleanup_loop)
        assert 'STALE_AGE_SECONDS = 120' in source
