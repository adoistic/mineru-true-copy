"""
Monkey-patch MinerU to use VisionLLM for OCR and table extraction.

Replaces:
  - PytorchPaddleOCR → VisionLLMOCR (text recognition via OpenRouter VLM)
  - RapidTable → VisionLLMTableModel (table extraction via OpenRouter VLM)

Usage: import lib.patch_mineru  # before any MinerU imports
"""
import logging
import sys

logger = logging.getLogger('patch_mineru')


def patch():
    """Replace MinerU's OCR and table models with VisionLLM versions."""
    from lib import vision_llm_ocr

    # 1. Register our module so any `from ... import vision_llm_ocr` finds ours
    target = 'magic_pdf.model.sub_modules.ocr.paddleocr2pytorch.vision_llm_ocr'
    sys.modules[target] = vision_llm_ocr

    # 2. Patch atom_model_init to intercept OCR and Table model creation
    import magic_pdf.model.sub_modules.model_init as model_init

    _original_atom_init = model_init.atom_model_init

    def _patched_atom_model_init(model_name, **kwargs):
        import logging
        logging.getLogger('patch_mineru').info(
            f'[patch_mineru] atom_model_init called with model_name={model_name}'
        )
        # Intercept OCR model init — VisionLLMOCR instead of PytorchPaddleOCR
        if model_name == model_init.AtomicModel.OCR:
            lang = kwargs.get('lang') or 'ch'
            return vision_llm_ocr.VisionLLMOCR(lang=lang)
        # Intercept Table model init — VisionLLMTableModel instead of RapidTable
        if model_name == model_init.AtomicModel.Table:
            logging.getLogger('patch_mineru').info(
                '[patch_mineru] Intercepting Table model — using VisionLLMTableModel'
            )
            return vision_llm_ocr.VisionLLMTableModel()
        return _original_atom_init(model_name, **kwargs)

    model_init.atom_model_init = _patched_atom_model_init

    # 3. Patch BatchAnalyze to preserve figure blocks (category_id=3).
    #
    # MinerU's default logic reclassifies figures as plain_text (category_id=1)
    # when >25% of the figure area contains detected text boxes. This causes
    # ALL figures in rasterized/scanned PDFs to be lost because our OCR
    # detector finds text everywhere. We raise the threshold to 80% so only
    # regions that are almost entirely text get reclassified.
    import magic_pdf.model.batch_analyze as batch_analyze

    _OrigBatchAnalyzeCall = batch_analyze.BatchAnalyze.__call__

    def _patched_batch_call(self, images_with_extra_info):
        results = _OrigBatchAnalyzeCall(self, images_with_extra_info)
        return results

    # Monkey-patch the reclassification threshold inline
    import magic_pdf.model.sub_modules.model_utils as model_utils
    _original_get_coords_and_area = model_utils.get_coords_and_area

    # Instead of patching the call, patch the source: raise the threshold
    # by modifying the batch_analyze module's __call__ at the bytecode level
    # is fragile. Instead, we patch get_ocr_result_list to tag figure OCR
    # results, then intercept the reclassification.
    #
    # Simplest approach: patch the batch_analyze source to use a higher
    # threshold. We do this by replacing the __call__ method.
    import types
    import inspect

    src = inspect.getsource(batch_analyze.BatchAnalyze.__call__)
    # Replace the 0.25 threshold with 0.80
    if 'ratio > 0.25' in src:
        new_src = src.replace('ratio > 0.25', 'ratio > 0.80')
        # We can't easily re-compile the method from source in a clean way,
        # so instead we directly patch the compiled code object.
        # Fall back to a simpler approach: override the entire method.
        pass

    # Direct approach: copy and patch the method
    def _patched_call(self, images_with_extra_info):
        """BatchAnalyze.__call__ with raised figure→text reclassification threshold."""
        import time
        import cv2
        from tqdm import tqdm
        from magic_pdf.config.constants import MODEL_NAME
        from magic_pdf.model.sub_modules.model_init import AtomModelSingleton
        from magic_pdf.model.sub_modules.model_utils import (
            crop_img, get_res_list_from_layout_res, get_coords_and_area)
        from magic_pdf.model.sub_modules.ocr.paddleocr2pytorch.ocr_utils import (
            get_adjusted_mfdetrec_res, get_ocr_result_list)

        if len(images_with_extra_info) == 0:
            return []

        images_layout_res = []
        self.model = self.model_manager.get_model(
            ocr=True, show_log=self.show_log, lang=None,
            layout_model=self.layout_model,
            formula_enable=self.formula_enable,
            table_enable=self.table_enable,
        )
        images = [image for image, _, _ in images_with_extra_info]

        if self.model.layout_model_name == MODEL_NAME.DocLayout_YOLO:
            layout_images = list(images)
            images_layout_res += self.model.layout_model.batch_predict(
                layout_images, 1)
        else:
            for image in images:
                layout_res = self.model.layout_model(image, ignore_catids=[])
                images_layout_res.append(layout_res)

        if self.model.apply_formula:
            images_mfd_res = self.model.mfd_model.batch_predict(images, 1)
            images_formula_list = self.model.mfr_model.batch_predict(
                images_mfd_res, images, batch_size=self.batch_ratio * 16)
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

                    # PATCHED: skip figure→text reclassification entirely.
                    # MinerU's default reclassifies figures as text when >25%
                    # of the area has OCR text. For rasterized PDFs our OCR
                    # detector finds text everywhere, so ALL figures would
                    # be reclassified. Trust DocLayout-YOLO's classification.
                    if res["category_id"] == 3:
                        continue  # preserve figure, skip OCR text for it

                    ocr_res_list_dict['layout_res'].extend(ocr_result_list)

        # ---- Collect data for concurrent phases ----
        # OCR rec data must be collected BEFORE launching threads
        # (reads from images_layout_res, pops np_img/lang keys)
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

        # Get models ONCE before threads (AtomModelSingleton is not thread-safe)
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

        # ---- Define phase functions ----
        from concurrent.futures import ThreadPoolExecutor, as_completed
        import threading as _threading
        from lib.vision_llm_ocr import reset_429_count, get_429_count

        reset_429_count()

        def _run_table_rec():
            """Phase 3: Parallel table recognition via VLM."""
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

            max_workers = min(len(table_res_list_all_page), 30)
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                futures = [executor.submit(_process_table, t) for t in table_res_list_all_page]
                for f in as_completed(futures):
                    try:
                        f.result()
                    except Exception as exc:
                        logger.warning(f"[patch_mineru] Table recognition failed: {exc}")

            elapsed = time.time() - t_start
            logger.info(f"[patch_mineru] Phase 3 (table rec): {elapsed:.1f}s, "
                        f"{len(table_res_list_all_page)} tables, "
                        f"429s so far: {get_429_count()}")

        def _run_ocr_rec():
            """Phase 4: Parallel OCR recognition via VLM."""
            if not img_crop_lists_by_lang:
                return
            t_start = time.time()

            for lang, img_crop_list in img_crop_lists_by_lang.items():
                if len(img_crop_list) > 0:
                    ocr_model = ocr_model_by_lang[lang]
                    ocr_res_list = ocr_model.ocr(
                        img_crop_list, det=False, tqdm_enable=True)[0]
                    assert len(ocr_res_list) == len(need_ocr_lists_by_lang[lang])
                    for index, item in enumerate(need_ocr_lists_by_lang[lang]):
                        ocr_text, ocr_score = ocr_res_list[index]
                        item['text'] = ocr_text
                        item['score'] = float(f"{ocr_score:.3f}")

            elapsed = time.time() - t_start
            total_spans = sum(len(v) for v in img_crop_lists_by_lang.values())
            logger.info(f"[patch_mineru] Phase 4 (OCR rec): {elapsed:.1f}s, "
                        f"{total_spans} spans, "
                        f"429s so far: {get_429_count()}")

        # ---- Run Phase 3 + Phase 4 concurrently ----
        t_concurrent_start = time.time()
        table_thread = _threading.Thread(target=_run_table_rec, name="table-rec")
        ocr_thread = _threading.Thread(target=_run_ocr_rec, name="ocr-rec")
        table_thread.start()
        ocr_thread.start()
        table_thread.join()
        ocr_thread.join()
        t_concurrent_end = time.time()
        logger.info(f"[patch_mineru] Phases 3+4 concurrent total: "
                    f"{t_concurrent_end - t_concurrent_start:.1f}s, "
                    f"total 429s: {get_429_count()}")

        return images_layout_res

    batch_analyze.BatchAnalyze.__call__ = _patched_call

    # 4. Fix UniMerNet / transformers 4.38+ incompatibility.
    #
    # transformers>=4.38 injects `cache_position` into model_inputs during
    # generation. VisionEncoderDecoderModel.forward() passes it to the decoder,
    # but UnimerMBartForCausalLM.forward() doesn't accept it (no **kwargs).
    # Patch: accept and discard cache_position.
    try:
        from magic_pdf.model.sub_modules.mfr.unimernet.unimernet_hf.unimer_mbart.modeling_unimer_mbart import UnimerMBartForCausalLM

        _original_unimer_forward = UnimerMBartForCausalLM.forward

        def _patched_unimer_forward(self, *args, cache_position=None, **kwargs):
            return _original_unimer_forward(self, *args, **kwargs)

        UnimerMBartForCausalLM.forward = _patched_unimer_forward
        logger.info('[patch_mineru] Patched UnimerMBartForCausalLM.forward for cache_position compat')

        # Also patch UnimerMBartDecoder.forward to handle DynamicCache.
        # transformers 4.38+ uses DynamicCache instead of tuple-of-tuples for
        # past_key_values. UnimerMBartDecoder.forward() at line 1419 does:
        #   past_key_values[0][0].shape[2]
        # which crashes when DynamicCache entries are None on first pass.
        from magic_pdf.model.sub_modules.mfr.unimernet.unimernet_hf.unimer_mbart.modeling_unimer_mbart import UnimerMBartDecoder

        _original_decoder_forward = UnimerMBartDecoder.forward

        def _patched_decoder_forward(self, *args, past_key_values=None, **kwargs):
            # Convert DynamicCache to None if it has no cached values yet
            if past_key_values is not None:
                try:
                    # DynamicCache: check if it has any real content
                    if hasattr(past_key_values, 'get_seq_length'):
                        if past_key_values.get_seq_length() == 0:
                            past_key_values = None
                    elif isinstance(past_key_values, (list, tuple)):
                        # Tuple format: check if first entry is valid
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
