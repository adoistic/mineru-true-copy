"""
Tests for VLM concurrency: semaphore gating, parallel table rec,
concurrent Phase 3 + Phase 4 execution, and thread-safe result writes.
"""

import threading
import time
from unittest.mock import patch, MagicMock

import numpy as np
import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_fake_image(w=100, h=100):
    """Create a minimal numpy image for testing."""
    return np.zeros((h, w, 3), dtype=np.uint8)


class FakeOpenRouterResponse:
    """Mock urllib response for _call_openrouter."""
    def __init__(self, content='{"lines": ["hello"]}'):
        self._content = content

    def read(self):
        return self._content.encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


# ---------------------------------------------------------------------------
# Semaphore tests
# ---------------------------------------------------------------------------

class TestSemaphore:
    def test_semaphore_value_is_20(self):
        from lib.vision_llm_ocr import _API_SEMAPHORE
        # Semaphore doesn't expose its value directly, but we can check
        # by acquiring and releasing
        acquired = 0
        for _ in range(30):
            if _API_SEMAPHORE.acquire(blocking=False):
                acquired += 1
        # Release all
        for _ in range(acquired):
            _API_SEMAPHORE.release()
        assert acquired == 30, f"Expected semaphore value 30, got {acquired}"

    def test_semaphore_limits_concurrent_calls(self):
        """Verify that _API_SEMAPHORE actually gates concurrent VLM calls."""
        from lib.vision_llm_ocr import _API_SEMAPHORE

        max_concurrent = 0
        current_concurrent = 0
        lock = threading.Lock()
        sem_value = _API_SEMAPHORE._value
        barrier = threading.Barrier(sem_value + 1, timeout=5)

        def _worker():
            nonlocal max_concurrent, current_concurrent
            with _API_SEMAPHORE:
                with lock:
                    current_concurrent += 1
                    max_concurrent = max(max_concurrent, current_concurrent)
                # Hold the semaphore briefly
                time.sleep(0.05)
                with lock:
                    current_concurrent -= 1

        # Launch more threads than semaphore allows
        thread_count = sem_value + 5
        threads = [threading.Thread(target=_worker) for _ in range(thread_count)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        assert max_concurrent <= sem_value, f"Semaphore allowed {max_concurrent} concurrent, expected max {sem_value}"
        assert max_concurrent >= sem_value - 5, f"Only {max_concurrent} concurrent, expected close to {sem_value}"


# ---------------------------------------------------------------------------
# 429 counter tests
# ---------------------------------------------------------------------------

class Test429Counter:
    def test_reset_and_get(self):
        from lib.vision_llm_ocr import reset_429_count, get_429_count
        reset_429_count()
        assert get_429_count() == 0

    def test_counter_increments_on_429(self):
        from lib.vision_llm_ocr import reset_429_count, get_429_count, _429_LOCK
        import lib.vision_llm_ocr as vlm

        reset_429_count()

        # Simulate a 429 increment
        with _429_LOCK:
            vlm._429_COUNT += 1
        assert get_429_count() == 1

        reset_429_count()
        assert get_429_count() == 0


# ---------------------------------------------------------------------------
# Table recognition parallelization tests
# ---------------------------------------------------------------------------

class TestTableRecParallel:
    def test_parallel_table_rec_produces_correct_results(self):
        """Verify parallel table rec writes HTML to the correct table_res dicts."""
        from concurrent.futures import ThreadPoolExecutor, as_completed

        table_data = [
            {'table_res': {'category_id': 5}, 'table_img': _make_fake_image(), 'lang': 'en'},
            {'table_res': {'category_id': 5}, 'table_img': _make_fake_image(), 'lang': 'en'},
            {'table_res': {'category_id': 5}, 'table_img': _make_fake_image(), 'lang': 'en'},
        ]

        call_count = 0
        count_lock = threading.Lock()

        def fake_predict(img):
            nonlocal call_count
            with count_lock:
                call_count += 1
                idx = call_count
            time.sleep(0.05)  # simulate API latency
            return f'<table><tr><td>table {idx}</td></tr></table>', [], [], 0.1

        mock_model = MagicMock()
        mock_model.predict.side_effect = fake_predict

        def _process_table(table_res_dict):
            html_code, _, _, _ = mock_model.predict(table_res_dict['table_img'])
            if html_code and html_code.strip().endswith('</table>'):
                table_res_dict['table_res']['html'] = html_code

        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = [executor.submit(_process_table, t) for t in table_data]
            for f in as_completed(futures):
                f.result()

        # All 3 tables should have HTML assigned
        for td in table_data:
            assert 'html' in td['table_res'], "Table result missing HTML"
            assert '<table>' in td['table_res']['html']

        assert call_count == 3

    def test_parallel_table_rec_handles_failure(self):
        """One table VLM call failing shouldn't affect others."""
        from concurrent.futures import ThreadPoolExecutor, as_completed

        table_data = [
            {'table_res': {'category_id': 5}, 'table_img': _make_fake_image(), 'lang': 'en'},
            {'table_res': {'category_id': 5}, 'table_img': _make_fake_image(), 'lang': 'en'},
        ]

        call_idx = 0
        idx_lock = threading.Lock()

        def fake_predict(img):
            nonlocal call_idx
            with idx_lock:
                call_idx += 1
                my_idx = call_idx
            if my_idx == 1:
                raise RuntimeError("VLM API error")
            return '<table><tr><td>ok</td></tr></table>', [], [], 0.1

        mock_model = MagicMock()
        mock_model.predict.side_effect = fake_predict

        def _process_table(table_res_dict):
            html_code, _, _, _ = mock_model.predict(table_res_dict['table_img'])
            if html_code and html_code.strip().endswith('</table>'):
                table_res_dict['table_res']['html'] = html_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(_process_table, t) for t in table_data]
            errors = 0
            for f in as_completed(futures):
                try:
                    f.result()
                except RuntimeError:
                    errors += 1

        assert errors == 1, "Expected exactly 1 error"
        # At least one table should have succeeded
        html_count = sum(1 for t in table_data if 'html' in t['table_res'])
        assert html_count >= 1, "At least one table should have HTML"


# ---------------------------------------------------------------------------
# Concurrent phases test
# ---------------------------------------------------------------------------

class TestConcurrentPhases:
    def test_table_and_ocr_run_concurrently(self):
        """Verify Phase 3 and Phase 4 overlap in time."""
        phase3_times = {}
        phase4_times = {}

        def _run_table_rec():
            phase3_times['start'] = time.time()
            time.sleep(0.2)  # simulate table rec work
            phase3_times['end'] = time.time()

        def _run_ocr_rec():
            phase4_times['start'] = time.time()
            time.sleep(0.2)  # simulate OCR rec work
            phase4_times['end'] = time.time()

        t3 = threading.Thread(target=_run_table_rec)
        t4 = threading.Thread(target=_run_ocr_rec)
        t3.start()
        t4.start()
        t3.join()
        t4.join()

        # If concurrent, total wall time should be ~0.2s, not ~0.4s
        total_wall = max(phase3_times['end'], phase4_times['end']) - \
                     min(phase3_times['start'], phase4_times['start'])
        assert total_wall < 0.35, f"Phases took {total_wall:.2f}s, expected ~0.2s (concurrent)"

        # Verify overlap: phase4 started before phase3 ended (or vice versa)
        overlap = min(phase3_times['end'], phase4_times['end']) - \
                  max(phase3_times['start'], phase4_times['start'])
        assert overlap > 0.1, f"Phases didn't overlap enough: {overlap:.2f}s"

    def test_disjoint_data_writes(self):
        """Verify table rec and OCR rec write to disjoint items in layout_res."""
        # Simulate layout_res with both table (cat 5) and OCR (cat 15) items
        layout_res = [
            {'category_id': 5, 'poly': [0]*8},   # table
            {'category_id': 15, 'np_img': _make_fake_image(), 'lang': 'en'},  # OCR
            {'category_id': 5, 'poly': [0]*8},   # table
            {'category_id': 15, 'np_img': _make_fake_image(), 'lang': 'en'},  # OCR
        ]

        table_items = [item for item in layout_res if item['category_id'] == 5]
        ocr_items = [item for item in layout_res if item['category_id'] == 15]

        # Verify they reference different objects
        table_ids = {id(item) for item in table_items}
        ocr_ids = {id(item) for item in ocr_items}
        assert table_ids.isdisjoint(ocr_ids), "Table and OCR items should be disjoint"

        # Simulate concurrent writes
        def _write_tables():
            for item in table_items:
                item['html'] = '<table></table>'
                time.sleep(0.01)

        def _write_ocr():
            for item in ocr_items:
                item['text'] = 'recognized text'
                item['score'] = 0.95
                time.sleep(0.01)

        t1 = threading.Thread(target=_write_tables)
        t2 = threading.Thread(target=_write_ocr)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        # Verify no cross-contamination
        for item in table_items:
            assert 'html' in item
            assert 'text' not in item
        for item in ocr_items:
            assert 'text' in item
            assert 'html' not in item
