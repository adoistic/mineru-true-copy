"""
Monkey-patch MinerU for dual-mode OCR: Local Processing + Cloud Processing.

Modes:
  - local: PytorchPaddleOCR (native, offline, GPU) + RapidTable (CPU)
  - cloud: VisionLLMOCR (OpenRouter API) + VisionLLMTableModel (OpenRouter API)

OCR and table modes are independently selectable per request via threading.local().
SECURITY: defaults to local OCR so data never leaves the machine by accident.

Usage: import lib.patch_mineru  # before any MinerU imports
"""
import logging
import sys
import threading

logger = logging.getLogger('patch_mineru')

# ---------------------------------------------------------------------------
# Per-request mode routing via threading.local()
# ---------------------------------------------------------------------------
#
#   REQUEST FLOW:
#   HTTP handler → process_pdf() → set_processing_mode() → ds.apply()
#     → BatchAnalyze.__call__() → AtomModelSingleton.get_atom_model()
#       → _patched_atom_model_init() → PaddleOCR or VisionLLMOCR
#
#   The mode is set on the worker thread. Child threads (table rec, OCR rec)
#   do NOT inherit threading.local — the patched BatchAnalyze.__call__
#   captures mode in closures before spawning children.

_request_context = threading.local()


def set_processing_mode(ocr_mode='cloud', table_mode='cloud'):
    """Set OCR and table engine mode for the current thread.

    Called from process_pdf() before ds.apply(). Thread-safe via threading.local().

    SECURITY: Defaults are local/cloud (not cloud/cloud) so that if the
    thread-local is somehow unset, data never leaves the machine by accident.
    OCR defaults to local (safe). Tables default to cloud (better accuracy).
    """
    _request_context.ocr_mode = ocr_mode
    _request_context.table_mode = table_mode


def get_processing_mode():
    """Read OCR and table mode for the current thread.

    SECURITY: Default to 'local' for OCR if thread-local is unset.
    Never default to 'cloud' for OCR — compliance users must never
    have data sent externally without explicit opt-in.
    """
    return (
        getattr(_request_context, 'ocr_mode', 'cloud'),
        getattr(_request_context, 'table_mode', 'cloud'),
    )


# ---------------------------------------------------------------------------
# Per-key model locks (avoids blocking cloud behind local model load)
# ---------------------------------------------------------------------------

_key_locks: dict[tuple, threading.Lock] = {}
_key_locks_meta = threading.Lock()


def _get_key_lock(key: tuple) -> threading.Lock:
    """Get or create a lock for a specific model cache key."""
    with _key_locks_meta:
        if key not in _key_locks:
            _key_locks[key] = threading.Lock()
        return _key_locks[key]


# ---------------------------------------------------------------------------
# Patch entry point
# ---------------------------------------------------------------------------

def patch():
    """Patch MinerU for dual-mode OCR/table routing."""
    from lib import vision_llm_ocr

    # 1. Register our module so any `from ... import vision_llm_ocr` finds ours
    target = 'magic_pdf.model.sub_modules.ocr.paddleocr2pytorch.vision_llm_ocr'
    sys.modules[target] = vision_llm_ocr

    # 2. Patch atom_model_init for conditional OCR/Table routing
    import magic_pdf.model.sub_modules.model_init as model_init
    from magic_pdf.model.sub_modules.model_init import AtomModelSingleton, AtomicModel

    _original_atom_init = model_init.atom_model_init

    def _patched_atom_model_init(model_name, **kwargs):
        """Route model creation based on per-request processing mode."""
        ocr_mode, table_mode = get_processing_mode()

        if model_name == AtomicModel.OCR:
            if ocr_mode == 'local':
                logger.info('[patch_mineru] OCR model: local (PaddleOCR)')
                # Maximize batch sizes for local GPU — no rate limits, no API costs.
                # Default rec_batch_num=6 means 7000+ GPU passes for a 200-page book.
                # At 64, that drops to ~670 passes — 10x fewer round-trips.
                kwargs['rec_batch_num'] = 64
                kwargs['cls_batch_num'] = 64
                return _original_atom_init(model_name, **kwargs)
            else:
                lang = kwargs.get('lang') or 'ch'
                logger.info('[patch_mineru] OCR model: cloud (VisionLLM), lang=%s', lang)
                return vision_llm_ocr.VisionLLMOCR(lang=lang)

        if model_name == AtomicModel.Table:
            if table_mode == 'local':
                logger.info('[patch_mineru] Table model: local (RapidTable)')
                return _original_atom_init(model_name, **kwargs)
            else:
                logger.info('[patch_mineru] Table model: cloud (VisionLLM)')
                # Cloud constructor takes no kwargs — don't forward local-only kwargs
                return vision_llm_ocr.VisionLLMTableModel()

        return _original_atom_init(model_name, **kwargs)

    model_init.atom_model_init = _patched_atom_model_init

    # 3. Patch AtomModelSingleton.get_atom_model to include mode in cache key
    _original_get_atom_model = AtomModelSingleton.get_atom_model

    def _patched_get_atom_model(self, atom_model_name: str, **kwargs):
        """Extended cache key includes processing mode for dual-engine support."""
        ocr_mode, table_mode = get_processing_mode()
        lang = kwargs.get('lang')

        if atom_model_name == AtomicModel.OCR:
            key = (atom_model_name, lang, ocr_mode)
        elif atom_model_name == AtomicModel.Table:
            key = (atom_model_name, kwargs.get('table_model_name'), lang, table_mode)
        elif atom_model_name == AtomicModel.Layout:
            key = (atom_model_name, kwargs.get('layout_model_name'))
        else:
            key = (atom_model_name,)

        key_lock = _get_key_lock(key)
        with key_lock:
            if key not in self._models:
                self._models[key] = model_init.atom_model_init(
                    model_name=atom_model_name, **kwargs)
            return self._models[key]

    AtomModelSingleton.get_atom_model = _patched_get_atom_model

    # 4. Patch BatchAnalyze to preserve figure blocks + conditional concurrency
    import magic_pdf.model.batch_analyze as batch_analyze
    from magic_pdf.config.constants import MODEL_NAME

    def _patched_call(self, images_with_extra_info):
        """BatchAnalyze.__call__ with figure preservation + dual-mode concurrency.

        Captures processing mode from the worker thread BEFORE spawning child
        threads, since threading.local() values are NOT inherited by children.
        """
        import time
        import cv2
        from tqdm import tqdm
        from magic_pdf.model.sub_modules.model_utils import (
            crop_img, get_res_list_from_layout_res, get_coords_and_area)
        from magic_pdf.model.sub_modules.ocr.paddleocr2pytorch.ocr_utils import (
            get_adjusted_mfdetrec_res, get_ocr_result_list)

        if len(images_with_extra_info) == 0:
            return []

        # ---- Capture mode from worker thread (before spawning children) ----
        _ocr_mode, _table_mode = get_processing_mode()
        logger.info('[patch_mineru] BatchAnalyze: ocr_mode=%s, table_mode=%s',
                    _ocr_mode, _table_mode)

        images_layout_res = []
        self.model = self.model_manager.get_model(
            ocr=True, show_log=self.show_log, lang=None,
            layout_model=self.layout_model,
            formula_enable=self.formula_enable,
            table_enable=self.table_enable,
        )
        images = [image for image, _, _ in images_with_extra_info]

        # Batch sizes for GPU inference. Default MinerU uses batch_size=1 for
        # layout and MFD (one page at a time through GPU). On Apple Silicon with
        # unified memory, we can batch many pages at once for better throughput.
        _layout_batch = 8
        _mfd_batch = 8

        if self.model.layout_model_name == MODEL_NAME.DocLayout_YOLO:
            layout_images = list(images)
            images_layout_res += self.model.layout_model.batch_predict(
                layout_images, _layout_batch)
        else:
            for image in images:
                layout_res = self.model.layout_model(image, ignore_catids=[])
                images_layout_res.append(layout_res)

        if self.model.apply_formula:
            images_mfd_res = self.model.mfd_model.batch_predict(images, _mfd_batch)
            images_formula_list = self.model.mfr_model.batch_predict(
                images_mfd_res, images, batch_size=self.batch_ratio * 64)
            for i in range(len(images)):
                images_layout_res[i] += images_formula_list[i]

        ocr_res_list_all_page = []
        table_res_list_all_page = []
        for index in range(len(images)):
            _, ocr_enable, _lang = images_with_extra_info[index]
            layout_res = images_layout_res[index]
            np_array_img = images[index]
            ocr_res_list, table_res_list, single_page_mfdetrec_res = (
                get_res_list_from_layout_res(layout_res))
            ocr_res_list_all_page.append({
                'ocr_res_list': ocr_res_list, 'lang': _lang,
                'ocr_enable': ocr_enable, 'np_array_img': np_array_img,
                'single_page_mfdetrec_res': single_page_mfdetrec_res,
                'layout_res': layout_res,
            })
            for table_res in table_res_list:
                table_img, _ = crop_img(table_res, np_array_img)
                table_res_list_all_page.append({
                    'table_res': table_res, 'lang': _lang, 'table_img': table_img})

        # OCR detection
        for ocr_res_list_dict in tqdm(ocr_res_list_all_page, desc="OCR-det Predict"):
            _lang = ocr_res_list_dict['lang']
            atom_model_manager = AtomModelSingleton()
            ocr_model = atom_model_manager.get_atom_model(
                atom_model_name='ocr', ocr_show_log=False,
                det_db_box_thresh=0.3, lang=_lang)
            for res in ocr_res_list_dict['ocr_res_list']:
                new_image, useful_list = crop_img(
                    res, ocr_res_list_dict['np_array_img'],
                    crop_paste_x=50, crop_paste_y=50)
                adjusted_mfdetrec_res = get_adjusted_mfdetrec_res(
                    ocr_res_list_dict['single_page_mfdetrec_res'], useful_list)
                new_image = cv2.cvtColor(new_image, cv2.COLOR_RGB2BGR)
                ocr_res = ocr_model.ocr(
                    new_image, mfd_res=adjusted_mfdetrec_res, rec=False)[0]
                if ocr_res:
                    ocr_result_list = get_ocr_result_list(
                        ocr_res, useful_list, ocr_res_list_dict['ocr_enable'],
                        new_image, _lang)

                    # PATCHED: skip figure->text reclassification entirely.
                    # MinerU's default reclassifies figures as text when >25%
                    # of the area has OCR text. For rasterized PDFs our OCR
                    # detector finds text everywhere, so ALL figures would
                    # be reclassified. Trust DocLayout-YOLO's classification.
                    if res["category_id"] == 3:
                        continue  # preserve figure, skip OCR text for it

                    ocr_res_list_dict['layout_res'].extend(ocr_result_list)

        # ---- Collect data for concurrent phases ----
        need_ocr_lists_by_lang = {}
        img_crop_lists_by_lang = {}
        for layout_res in images_layout_res:
            for item in layout_res:
                if item['category_id'] in [15]:
                    if 'np_img' in item and 'lang' in item:
                        lang = item['lang']
                        if lang not in need_ocr_lists_by_lang:
                            need_ocr_lists_by_lang[lang] = []
                            img_crop_lists_by_lang[lang] = []
                        need_ocr_lists_by_lang[lang].append(item)
                        img_crop_lists_by_lang[lang].append(item['np_img'])
                        item.pop('np_img')
                        item.pop('lang')

        # Get models ONCE before threads (on worker thread where threading.local is set)
        atom_model_manager = AtomModelSingleton()
        ocr_model_by_lang = {}
        for lang in img_crop_lists_by_lang:
            ocr_model_by_lang[lang] = atom_model_manager.get_atom_model(
                atom_model_name='ocr', ocr_show_log=False,
                det_db_box_thresh=0.3, lang=lang)

        table_model = None
        if self.model.apply_table and table_res_list_all_page:
            table_model = atom_model_manager.get_atom_model(
                atom_model_name='table', table_model_name='rapid_table',
                table_model_path='', table_max_time=400,
                device='cpu', lang='en', table_sub_model_name='slanet_plus')

        # ---- Define phase functions (use captured _ocr_mode/_table_mode) ----
        from concurrent.futures import ThreadPoolExecutor, as_completed
        import threading as _threading
        from lib.vision_llm_ocr import reset_429_count, get_429_count

        reset_429_count()

        def _run_table_rec():
            """Phase 3: Table recognition (uses captured _table_mode)."""
            if not table_model or not table_res_list_all_page:
                return
            t_start = time.time()

            def _process_table(table_res_dict):
                html_code, _, _, _ = table_model.predict(table_res_dict['table_img'])
                if html_code:
                    expected_ending = (html_code.strip().endswith('</html>')
                                      or html_code.strip().endswith('</table>'))
                    if expected_ending:
                        table_res_dict['table_res']['html'] = html_code

            # Concurrency: local RapidTable on CPU caps at 4, cloud API at 30
            if _table_mode == 'local':
                max_workers = min(len(table_res_list_all_page), 4)
            else:
                max_workers = min(len(table_res_list_all_page), 30)

            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                futures = [executor.submit(_process_table, t) for t in table_res_list_all_page]
                for f in as_completed(futures):
                    try:
                        f.result()
                    except Exception as exc:
                        logger.warning("[patch_mineru] Table recognition failed: %s", exc)

            elapsed = time.time() - t_start
            logger.info("[patch_mineru] Phase 3 (table rec, mode=%s): %.1fs, "
                        "%d tables, 429s so far: %d",
                        _table_mode, elapsed, len(table_res_list_all_page),
                        get_429_count())

        def _run_ocr_rec():
            """Phase 4: OCR recognition (uses captured _ocr_mode).

            For local mode with large span counts, splits into chunks and
            processes in parallel threads. CRNN is stateless, numpy/cv2
            release GIL during C-level work, torch GPU releases GIL.
            Threads overlap CPU preprocessing with GPU inference.
            """
            if not img_crop_lists_by_lang:
                return
            t_start = time.time()

            for lang, img_crop_list in img_crop_lists_by_lang.items():
                if len(img_crop_list) == 0:
                    continue
                ocr_model = ocr_model_by_lang[lang]

                if len(img_crop_list) < 500 or _ocr_mode == 'cloud':
                    # Small lists or cloud mode: process directly
                    ocr_res_list = ocr_model.ocr(
                        img_crop_list, det=False, tqdm_enable=True)[0]
                else:
                    # Large local list: chunk and parallelize
                    n_workers = min(4, max(1, len(img_crop_list) // 2000))
                    chunk_size = (len(img_crop_list) + n_workers - 1) // n_workers
                    chunks = [img_crop_list[i:i + chunk_size]
                              for i in range(0, len(img_crop_list), chunk_size)]

                    all_results = [None] * len(chunks)

                    def _process_chunk(idx, chunk):
                        all_results[idx] = ocr_model.ocr(
                            chunk, det=False, tqdm_enable=False)[0]

                    logger.info("[patch_mineru] OCR rec: %d spans, %d chunks, "
                                "%d workers", len(img_crop_list), len(chunks),
                                n_workers)
                    with ThreadPoolExecutor(max_workers=n_workers) as executor:
                        futures = [executor.submit(_process_chunk, i, c)
                                   for i, c in enumerate(chunks)]
                        for f in futures:
                            f.result()

                    ocr_res_list = []
                    for r in all_results:
                        ocr_res_list.extend(r)

                assert len(ocr_res_list) == len(need_ocr_lists_by_lang[lang])
                for index, item in enumerate(need_ocr_lists_by_lang[lang]):
                    ocr_text, ocr_score = ocr_res_list[index]
                    item['text'] = ocr_text
                    item['score'] = float(f"{ocr_score:.3f}")

            elapsed = time.time() - t_start
            total_spans = sum(len(v) for v in img_crop_lists_by_lang.values())
            logger.info("[patch_mineru] Phase 4 (OCR rec, mode=%s): %.1fs, "
                        "%d spans, 429s so far: %d",
                        _ocr_mode, elapsed, total_spans, get_429_count())

        # ---- Run Phase 3 + Phase 4 concurrently ----
        t_concurrent_start = time.time()
        table_thread = _threading.Thread(target=_run_table_rec, name="table-rec")
        ocr_thread = _threading.Thread(target=_run_ocr_rec, name="ocr-rec")
        table_thread.start()
        ocr_thread.start()
        table_thread.join()
        ocr_thread.join()
        t_concurrent_end = time.time()
        logger.info("[patch_mineru] Phases 3+4 concurrent total: %.1fs, "
                    "total 429s: %d",
                    t_concurrent_end - t_concurrent_start, get_429_count())

        return images_layout_res

    batch_analyze.BatchAnalyze.__call__ = _patched_call

    # 5. Fix UniMerNet / transformers 4.38+ incompatibility.
    try:
        from magic_pdf.model.sub_modules.mfr.unimernet.unimernet_hf.unimer_mbart.modeling_unimer_mbart import UnimerMBartForCausalLM

        _original_unimer_forward = UnimerMBartForCausalLM.forward

        def _patched_unimer_forward(self, *args, cache_position=None, **kwargs):
            return _original_unimer_forward(self, *args, **kwargs)

        UnimerMBartForCausalLM.forward = _patched_unimer_forward
        logger.info('[patch_mineru] Patched UnimerMBartForCausalLM.forward for cache_position compat')

        from magic_pdf.model.sub_modules.mfr.unimernet.unimernet_hf.unimer_mbart.modeling_unimer_mbart import UnimerMBartDecoder

        _original_decoder_forward = UnimerMBartDecoder.forward

        def _patched_decoder_forward(self, *args, past_key_values=None, **kwargs):
            if past_key_values is not None:
                try:
                    if hasattr(past_key_values, 'get_seq_length'):
                        if past_key_values.get_seq_length() == 0:
                            past_key_values = None
                    elif isinstance(past_key_values, (list, tuple)):
                        if len(past_key_values) > 0 and past_key_values[0] is not None:
                            if past_key_values[0][0] is None:
                                past_key_values = None
                except (IndexError, AttributeError):
                    past_key_values = None
            return _original_decoder_forward(self, *args, past_key_values=past_key_values, **kwargs)

        UnimerMBartDecoder.forward = _patched_decoder_forward
        logger.info('[patch_mineru] Patched UnimerMBartDecoder.forward for DynamicCache compat')
    except ImportError:
        logger.warning('[patch_mineru] UniMerNet not found, skipping cache_position patch')


patch()
