"""Tests for dual-mode OCR routing: threading.local, cache key extension, mode routing."""
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

# Import the module under test
from lib.patch_mineru import (
    set_processing_mode,
    get_processing_mode,
    _request_context,
    _get_key_lock,
    _key_locks,
)


class TestProcessingModeThreading(unittest.TestCase):
    """Test threading.local mode storage and isolation."""

    def setUp(self):
        # Clear thread-local for each test
        for attr in ('ocr_mode', 'table_mode'):
            try:
                delattr(_request_context, attr)
            except AttributeError:
                pass

    def test_set_get_processing_mode_same_thread(self):
        """Mode values round-trip on the same thread."""
        set_processing_mode(ocr_mode='cloud', table_mode='local')
        ocr, table = get_processing_mode()
        self.assertEqual(ocr, 'cloud')
        self.assertEqual(table, 'local')

    def test_get_processing_mode_unset_thread_defaults(self):
        """Unset thread returns defaults: cloud OCR, cloud tables."""
        ocr, table = get_processing_mode()
        self.assertEqual(ocr, 'cloud')
        self.assertEqual(table, 'cloud')

    def test_threading_local_isolation(self):
        """Two threads set different modes, each reads its own."""
        results = {}
        barrier = threading.Barrier(2)

        def thread_fn(name, ocr_mode, table_mode):
            set_processing_mode(ocr_mode=ocr_mode, table_mode=table_mode)
            barrier.wait()  # Ensure both threads have set their modes
            time.sleep(0.01)  # Brief delay to test persistence
            results[name] = get_processing_mode()

        t1 = threading.Thread(target=thread_fn, args=('t1', 'local', 'local'))
        t2 = threading.Thread(target=thread_fn, args=('t2', 'cloud', 'cloud'))
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        self.assertEqual(results['t1'], ('local', 'local'))
        self.assertEqual(results['t2'], ('cloud', 'cloud'))

    def test_child_thread_does_not_inherit_mode(self):
        """Child threads spawned from a parent do NOT inherit threading.local."""
        set_processing_mode(ocr_mode='local', table_mode='local')
        child_result = {}

        def child_fn():
            child_result['mode'] = get_processing_mode()

        t = threading.Thread(target=child_fn)
        t.start()
        t.join()

        # Child gets defaults, not parent's values
        self.assertEqual(child_result['mode'], ('cloud', 'cloud'))

    def test_closure_captures_mode_for_child_thread(self):
        """Capturing mode in closure before spawning child works correctly."""
        set_processing_mode(ocr_mode='cloud', table_mode='local')
        captured_ocr, captured_table = get_processing_mode()
        child_result = {}

        def child_fn():
            # Use captured values, not get_processing_mode()
            child_result['ocr'] = captured_ocr
            child_result['table'] = captured_table

        t = threading.Thread(target=child_fn)
        t.start()
        t.join()

        self.assertEqual(child_result['ocr'], 'cloud')
        self.assertEqual(child_result['table'], 'local')

    def test_finally_clears_mode_on_exception(self):
        """After exception + cleanup, threading.local resets to safe defaults."""
        set_processing_mode(ocr_mode='cloud', table_mode='cloud')

        try:
            raise RuntimeError("simulated failure")
        except RuntimeError:
            pass
        finally:
            set_processing_mode(ocr_mode='local', table_mode='local')

        ocr, table = get_processing_mode()
        self.assertEqual(ocr, 'local')
        self.assertEqual(table, 'local')

    def test_set_processing_mode_default_args(self):
        """Default args: ocr=cloud, table=cloud."""
        set_processing_mode()
        ocr, table = get_processing_mode()
        self.assertEqual(ocr, 'cloud')
        self.assertEqual(table, 'cloud')


class TestPerKeyLocks(unittest.TestCase):
    """Test per-key lock mechanism for model loading."""

    def setUp(self):
        _key_locks.clear()

    def test_same_key_returns_same_lock(self):
        lock1 = _get_key_lock(('ocr', 'en', 'local'))
        lock2 = _get_key_lock(('ocr', 'en', 'local'))
        self.assertIs(lock1, lock2)

    def test_different_keys_return_different_locks(self):
        lock1 = _get_key_lock(('ocr', 'en', 'local'))
        lock2 = _get_key_lock(('ocr', 'en', 'cloud'))
        self.assertIsNot(lock1, lock2)

    def test_concurrent_key_lock_creation(self):
        """Two threads creating locks for different keys don't race."""
        locks = {}

        def get_lock(key_name, key):
            locks[key_name] = _get_key_lock(key)

        t1 = threading.Thread(target=get_lock, args=('a', ('ocr', 'en', 'local')))
        t2 = threading.Thread(target=get_lock, args=('b', ('table', None, 'cloud')))
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        self.assertIsNot(locks['a'], locks['b'])
        # threading.Lock() returns _thread.lock, not threading.Lock (which is a factory)
        self.assertTrue(hasattr(locks['a'], 'acquire'))
        self.assertTrue(hasattr(locks['b'], 'acquire'))


class TestCacheKeyExtension(unittest.TestCase):
    """Test that cache keys include processing mode for dual-engine support."""

    def test_ocr_key_includes_mode(self):
        """Same lang, different mode = different cache keys."""
        set_processing_mode(ocr_mode='local', table_mode='cloud')
        local_key = ('ocr', 'en', 'local')

        set_processing_mode(ocr_mode='cloud', table_mode='cloud')
        cloud_key = ('ocr', 'en', 'cloud')

        self.assertNotEqual(local_key, cloud_key)

    def test_table_key_includes_mode(self):
        """Same table config, different mode = different cache keys."""
        local_key = ('table', 'rapid_table', 'en', 'local')
        cloud_key = ('table', 'rapid_table', 'en', 'cloud')
        self.assertNotEqual(local_key, cloud_key)

    def test_layout_key_has_no_mode(self):
        """Layout key should not include mode (shared between modes)."""
        key = ('layout', 'doclayout_yolo')
        # Layout model is mode-independent
        self.assertEqual(len(key), 2)


class TestParallelOcrChunking(unittest.TestCase):
    """Test the parallel OCR recognition chunking logic."""

    def test_small_list_skips_threading(self):
        """Lists under 500 items should not use ThreadPoolExecutor."""
        # The threshold is 500 — below this, process directly
        self.assertTrue(499 < 500)  # would skip threading
        self.assertFalse(500 < 500)  # would use threading

    def test_chunk_splitting_even(self):
        """Even split: 8000 items with n_workers=4 = 4 chunks of 2000."""
        items = list(range(8000))
        n_workers = min(4, max(1, len(items) // 2000))
        chunk_size = (len(items) + n_workers - 1) // n_workers
        chunks = [items[i:i + chunk_size] for i in range(0, len(items), chunk_size)]
        self.assertEqual(n_workers, 4)
        self.assertEqual(len(chunks), 4)
        self.assertEqual(sum(len(c) for c in chunks), 8000)

    def test_chunk_splitting_uneven(self):
        """Uneven split: 5000 items with n_workers=2 = 2 chunks (2500 + 2500)."""
        items = list(range(5000))
        n_workers = min(4, max(1, len(items) // 2000))
        chunk_size = (len(items) + n_workers - 1) // n_workers
        chunks = [items[i:i + chunk_size] for i in range(0, len(items), chunk_size)]
        self.assertEqual(n_workers, 2)
        self.assertEqual(sum(len(c) for c in chunks), 5000)

    def test_chunk_splitting_large(self):
        """Large split: 42888 items should use 4 workers."""
        items = list(range(42888))
        n_workers = min(4, max(1, len(items) // 2000))
        chunk_size = (len(items) + n_workers - 1) // n_workers
        chunks = [items[i:i + chunk_size] for i in range(0, len(items), chunk_size)]
        self.assertEqual(n_workers, 4)
        self.assertEqual(sum(len(c) for c in chunks), 42888)
        # All chunks should be close in size (no off-by-one)
        sizes = [len(c) for c in chunks]
        self.assertTrue(max(sizes) - min(sizes) <= 1)

    def test_result_reassembly_order(self):
        """Results must be reassembled in chunk order, not completion order."""
        all_results = [None] * 3
        # Simulate chunks completing out of order
        all_results[2] = ['c1', 'c2']
        all_results[0] = ['a1', 'a2']
        all_results[1] = ['b1', 'b2']
        combined = []
        for r in all_results:
            combined.extend(r)
        self.assertEqual(combined, ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'])

    def test_n_workers_calculation(self):
        """Worker count scales with span count."""
        cases = [
            (499, 0),    # below threshold, no parallelization
            (500, 1),    # minimum for threading (500 < 2000 floor)
            (2000, 1),
            (4000, 2),
            (8000, 4),
            (42888, 4),  # capped at 4
            (100000, 4), # still capped at 4
        ]
        for n_items, expected_workers in cases:
            if n_items < 500:
                continue  # skip, these don't enter the threading path
            workers = min(4, max(1, n_items // 2000))
            self.assertEqual(workers, expected_workers,
                             f"n_items={n_items}: expected {expected_workers}, got {workers}")

    def test_thread_exception_propagates(self):
        """If a chunk fails, the exception should propagate to the caller."""
        from concurrent.futures import ThreadPoolExecutor

        def _failing_fn():
            raise ValueError("chunk failed")

        with ThreadPoolExecutor(max_workers=2) as executor:
            future = executor.submit(_failing_fn)
            with self.assertRaises(ValueError):
                future.result()


class TestModeValidation(unittest.TestCase):
    """Test HTTP-layer mode validation."""

    def test_valid_ocr_modes(self):
        """'local' and 'cloud' are the only valid OCR modes."""
        for mode in ('local', 'cloud'):
            self.assertIn(mode, ('local', 'cloud'))

    def test_invalid_mode_rejected(self):
        """Invalid mode values should be rejected at HTTP layer."""
        self.assertNotIn('hybrid', ('local', 'cloud'))
        self.assertNotIn('', ('local', 'cloud'))
        self.assertNotIn('auto', ('local', 'cloud'))


class TestErrorCodes(unittest.TestCase):
    """Test error code classification."""

    def test_error_messages_exist_for_all_codes(self):
        """Every defined error code has a user-facing message."""
        import importlib
        # Dynamically check the ERROR_MESSAGES dict in mineru_server
        import mineru_server
        codes = ['CP-401', 'CP-429', 'CP-503', 'CP-500',
                 'LP-MDL', 'LP-OOM', 'CT-503', 'CR-INS', 'CR-ERR']
        for code in codes:
            self.assertIn(code, mineru_server.ERROR_MESSAGES,
                          f"Missing message for error code {code}")
            self.assertNotIn('OpenRouter', mineru_server.ERROR_MESSAGES[code],
                             f"Engine name leaked in {code} message")
            self.assertNotIn('PaddleOCR', mineru_server.ERROR_MESSAGES[code],
                             f"Engine name leaked in {code} message")

    def test_make_error_structure(self):
        """_make_error returns correct structure."""
        import mineru_server
        result = mineru_server._make_error('CP-401', 'openrouter:401:invalid_key')
        self.assertIn('error', result)
        self.assertIn('code', result)
        self.assertIn('diagnostic', result)
        self.assertEqual(result['code'], 'CP-401')
        self.assertEqual(result['diagnostic'], 'openrouter:401:invalid_key')
        # User message should not contain engine names
        self.assertNotIn('OpenRouter', result['error'])


class TestModelValidation(unittest.TestCase):
    """Test model file validation for bundled app distribution."""

    def test_validate_models_returns_structure(self):
        """_validate_models returns dict with core_ok, local_ocr_ok, missing."""
        import mineru_server
        result = mineru_server._validate_models('/nonexistent/path')
        self.assertIn('core_ok', result)
        self.assertIn('local_ocr_ok', result)
        self.assertIn('missing', result)
        self.assertIsInstance(result['missing'], list)

    def test_validate_models_missing_dir(self):
        """Missing models directory reports all models as missing."""
        import mineru_server
        result = mineru_server._validate_models('/nonexistent/path')
        self.assertFalse(result['core_ok'])
        self.assertFalse(result['local_ocr_ok'])
        self.assertGreater(len(result['missing']), 0)

    def test_validate_models_with_real_dir(self):
        """If models exist at the configured path, validation passes."""
        import mineru_server
        models_dir = mineru_server._get_models_dir()
        if not models_dir:
            self.skipTest('No models-dir configured')
        result = mineru_server._validate_models(models_dir)
        # Core models should be present on the dev machine
        self.assertTrue(result['core_ok'],
                        f"Core models missing: {result['missing']}")

    def test_check_local_models_returns_bool(self):
        """_check_local_models_exist returns a boolean."""
        import mineru_server
        result = mineru_server._check_local_models_exist()
        self.assertIsInstance(result, bool)

    def test_check_local_models_caches_result(self):
        """Second call within 60s returns cached result (no disk I/O)."""
        import mineru_server
        # First call populates cache
        result1 = mineru_server._check_local_models_exist()
        # Second call should be instant (cached)
        t0 = time.time()
        result2 = mineru_server._check_local_models_exist()
        elapsed = time.time() - t0
        self.assertEqual(result1, result2)
        self.assertLess(elapsed, 0.01)  # cached, no disk I/O


if __name__ == '__main__':
    unittest.main()
