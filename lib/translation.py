"""
Core translation engine wrapping IndicTrans2 for offline Indic language translation.

Provides the TranslationEngine class which handles model loading/unloading,
single-text translation, OCR JSON translation (preserving bbox/font/type fields),
and batch file translation with progress reporting.

Works gracefully without IndicTrans2 installed — callers should check
`is_available()` before attempting model operations.
"""

import copy
import gc
import json
import logging
import os
import time
from typing import Any, Callable, Optional

logger = logging.getLogger('translation')

# ---------------------------------------------------------------------------
# FLORES-200 language codes supported by IndicTrans2
# ---------------------------------------------------------------------------

SUPPORTED_LANGUAGES = {
    'eng_Latn': 'English',
    'hin_Deva': 'Hindi',
    'ben_Beng': 'Bengali',
    'tam_Taml': 'Tamil',
    'tel_Telu': 'Telugu',
    'mar_Deva': 'Marathi',
    'guj_Gujr': 'Gujarati',
    'kan_Knda': 'Kannada',
    'mal_Mlym': 'Malayalam',
    'pan_Guru': 'Punjabi',
    'asm_Beng': 'Assamese',
    'ory_Orya': 'Odia',
    'san_Deva': 'Sanskrit',
    'kas_Arab': 'Kashmiri',
    'snd_Arab': 'Sindhi',
    'mai_Deva': 'Maithili',
    'gom_Deva': 'Konkani',
    'npi_Deva': 'Nepali',
    'brx_Deva': 'Bodo',
    'doi_Deva': 'Dogri',
    'mni_Beng': 'Manipuri',
    'sat_Olck': 'Santali',
    'urd_Arab': 'Urdu',
}

INDIC_LANGUAGES = {k for k in SUPPORTED_LANGUAGES if k != 'eng_Latn'}


def _infer_direction(src_lang: str, tgt_lang: str) -> str:
    """Infer model direction from source and target language codes.

    Returns one of: "en-indic", "indic-en", "indic-indic".
    """
    src_is_en = src_lang == 'eng_Latn'
    tgt_is_en = tgt_lang == 'eng_Latn'

    if src_is_en and not tgt_is_en:
        return 'en-indic'
    elif not src_is_en and tgt_is_en:
        return 'indic-en'
    else:
        return 'indic-indic'


def _model_name(direction: str, variant: str) -> str:
    """Build the HuggingFace model name for a given direction and variant.

    direction: "en-indic", "indic-en", or "indic-indic"
    variant: "1B" or "200M"

    HuggingFace model IDs:
      ai4bharat/indictrans2-en-indic-1B
      ai4bharat/indictrans2-en-indic-dist-200M
      ai4bharat/indictrans2-indic-en-1B
      ai4bharat/indictrans2-indic-en-dist-200M
      ai4bharat/indictrans2-indic-indic-1B
      ai4bharat/indictrans2-indic-indic-dist-320M  (320M not 200M)
    """
    if variant == "1B":
        return f"ai4bharat/indictrans2-{direction}-1B"
    else:
        # Distilled variants: 200M for en-indic/indic-en, 320M for indic-indic
        size = "320M" if direction == "indic-indic" else "200M"
        return f"ai4bharat/indictrans2-{direction}-dist-{size}"


def is_available() -> bool:
    """Check if IndicTrans2 dependencies are installed."""
    try:
        import torch  # noqa: F401
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer  # noqa: F401
        from IndicTransToolkit import IndicProcessor  # noqa: F401
        return True
    except ImportError:
        return False


class TranslationEngine:
    """Manages IndicTrans2 model lifecycle and translation operations."""

    def __init__(self):
        self._model = None
        self._tokenizer = None
        self._processor = None
        self._device = None
        self._direction = None
        self._variant = None

    @property
    def model_loaded(self) -> bool:
        return self._model is not None

    @property
    def model_direction(self) -> Optional[str]:
        return self._direction

    @property
    def model_variant(self) -> Optional[str]:
        return self._variant

    def load_model(self, direction: str, variant: str = '1B'):
        """Load an IndicTrans2 model + tokenizer + IndicProcessor.

        direction: "en-indic", "indic-en", or "indic-indic"
        variant: "1B" or "200M"
        """
        if not is_available():
            raise RuntimeError('IndicTrans2 dependencies not installed')

        if direction not in ('en-indic', 'indic-en', 'indic-indic'):
            raise ValueError(f'Invalid direction: {direction}')
        if variant not in ('1B', '200M'):
            raise ValueError(f'Invalid variant: {variant}')

        # Unload existing model first if different
        if self._model is not None:
            if self._direction == direction and self._variant == variant:
                logger.info('Model already loaded: %s %s', direction, variant)
                return
            self.unload_model()

        import torch
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
        from IndicTransToolkit import IndicProcessor

        model_name = _model_name(direction, variant)
        logger.info('Loading model: %s', model_name)

        self._device = 'mps' if torch.backends.mps.is_available() else 'cpu'

        start = time.time()
        self._tokenizer = AutoTokenizer.from_pretrained(
            model_name, trust_remote_code=True
        )
        self._model = AutoModelForSeq2SeqLM.from_pretrained(
            model_name, trust_remote_code=True
        ).to(self._device)
        self._model.eval()
        self._processor = IndicProcessor(inference=True)
        self._direction = direction
        self._variant = variant

        elapsed = time.time() - start
        logger.info('Model loaded in %.1fs on %s', elapsed, self._device)

    def unload_model(self):
        """Free model memory."""
        if self._model is not None:
            del self._model
            self._model = None
        if self._tokenizer is not None:
            del self._tokenizer
            self._tokenizer = None
        if self._processor is not None:
            del self._processor
            self._processor = None
        self._direction = None
        self._variant = None

        gc.collect()
        try:
            import torch
            if torch.backends.mps.is_available():
                torch.mps.empty_cache()
        except Exception:
            pass

        logger.info('Model unloaded')

    def translate_text(self, text: str, src_lang: str, tgt_lang: str) -> str:
        """Translate a single text string."""
        if not self._model:
            raise RuntimeError('No model loaded')

        import torch

        # IndicProcessor handles sentence splitting and script normalization
        batch = self._processor.preprocess_batch(
            [text], src_lang=src_lang, tgt_lang=tgt_lang
        )
        inputs = self._tokenizer(
            batch, return_tensors='pt', padding=True, truncation=True,
            max_length=256
        ).to(self._device)

        with torch.no_grad():
            outputs = self._model.generate(
                **inputs, num_beams=5, max_length=256,
                num_return_sequences=1,
                use_cache=False,  # IndicTrans2 custom model incompatible with KV cache on transformers>=4.50
            )

        decoded = self._tokenizer.batch_decode(outputs, skip_special_tokens=True)
        result = self._processor.postprocess_batch(
            decoded, lang=tgt_lang
        )
        return result[0] if result else text

    def translate_json(self, json_data: dict, src_lang: str, tgt_lang: str) -> dict:
        """Translate text fields in OCR JSON, preserving all structural fields.

        Translates text in content_list blocks:
        - text blocks: translates the 'text' field
        - table blocks: extracts text from each <td>/<th>, translates, reinserts
        - Other block types (image, figure, equation): preserved as-is

        Preserved fields: bbox, type, font_size, font_name, lines, page_idx, etc.
        """
        result = copy.deepcopy(json_data)
        content_list = result.get('content_list', [])

        if not content_list:
            return result

        # Ensure correct model direction is loaded
        needed_dir = _infer_direction(src_lang, tgt_lang)
        if self._direction != needed_dir:
            raise RuntimeError(
                f'Loaded model direction is {self._direction}, '
                f'but {needed_dir} is needed for {src_lang} -> {tgt_lang}'
            )

        for block in content_list:
            block_type = block.get('type', '')

            if block_type in ('text', 'title'):
                text = block.get('text', '')
                if text and text.strip():
                    block['text'] = self.translate_text(text, src_lang, tgt_lang)

            elif block_type == 'table':
                html = block.get('text', '') or block.get('html', '')
                if html and html.strip():
                    translated_html = self._translate_table_html(
                        html, src_lang, tgt_lang
                    )
                    if 'text' in block:
                        block['text'] = translated_html
                    if 'html' in block:
                        block['html'] = translated_html

            # image, figure, equation, interline_equation — no text to translate

        return result

    def _translate_table_html(self, html: str, src_lang: str, tgt_lang: str) -> str:
        """Extract text from table cells, translate individually, reinsert."""
        try:
            from bs4 import BeautifulSoup
        except ImportError:
            logger.warning('BeautifulSoup not installed, skipping table translation')
            return html

        soup = BeautifulSoup(html, 'html.parser')
        cells = soup.find_all(['td', 'th'])

        for cell in cells:
            text = cell.get_text(strip=True)
            if text:
                translated = self.translate_text(text, src_lang, tgt_lang)
                cell.string = translated

        return str(soup)

    def translate_batch(
        self,
        items: list[dict],
        src_lang: str,
        tgt_langs: list[str],
        output_dir: str,
        on_progress: Optional[Callable] = None,
    ) -> dict:
        """Process multiple JSON files, writing results to output_dir.

        items: list of {"json_path": str} dicts
        src_lang: source language code
        tgt_langs: list of target language codes
        output_dir: directory to write translated JSON files
        on_progress: callback(completed, total, current_file, current_lang)

        Returns: {"completed": N, "total": N, "output_dir": str, "files": [...]}
        """
        json_dir = os.path.join(output_dir, 'json')
        os.makedirs(json_dir, exist_ok=True)

        total = len(items) * len(tgt_langs)
        completed = 0
        output_files = []
        manifest = {
            'status': 'processing',
            'src_lang': src_lang,
            'tgt_langs': tgt_langs,
            'completed': 0,
            'total': total,
            'files': [],
        }
        manifest_path = os.path.join(output_dir, 'batch_status.json')
        self._write_manifest(manifest_path, manifest)

        for item in items:
            json_path = item['json_path']
            basename = os.path.splitext(os.path.basename(json_path))[0]

            with open(json_path, 'r') as f:
                json_data = json.load(f)

            for tgt_lang in tgt_langs:
                if on_progress:
                    on_progress(completed, total, basename, tgt_lang)

                # Ensure correct model direction
                needed_dir = _infer_direction(src_lang, tgt_lang)
                if self._direction != needed_dir:
                    self.load_model(needed_dir, self._variant or '1B')

                translated = self.translate_json(json_data, src_lang, tgt_lang)
                out_name = f'{basename}_{tgt_lang}.json'
                out_path = os.path.join(json_dir, out_name)

                with open(out_path, 'w') as f:
                    json.dump(translated, f, ensure_ascii=False, indent=2)

                output_files.append(out_path)
                completed += 1

                manifest['completed'] = completed
                manifest['files'].append({
                    'source': json_path,
                    'target_lang': tgt_lang,
                    'output': out_path,
                })
                self._write_manifest(manifest_path, manifest)

        manifest['status'] = 'completed'
        self._write_manifest(manifest_path, manifest)

        return {
            'completed': completed,
            'total': total,
            'output_dir': output_dir,
            'files': output_files,
        }

    @staticmethod
    def _write_manifest(path: str, data: dict):
        """Atomically write the batch manifest JSON."""
        tmp = path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
