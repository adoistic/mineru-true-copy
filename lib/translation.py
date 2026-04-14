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

    @staticmethod
    def _auto_tune() -> tuple[int, int]:
        """Pick (batch_size, num_beams) based on available system RAM.

        Rationale: a 200M model + num_beams=5 + seq_len=256 consumes roughly
        50 MB per text per beam. On a shared 16 GB Mac (with MinerU + browser
        + OS eating ~8 GB) we need small batches; on a 24 GB+ Mac we can be
        more aggressive. Users can always override with env vars.

        The MPS graph is recompiled if batch size changes, so we do NOT
        call empty_cache() between inferences — gc.collect() is enough.
        """
        env_bs = os.environ.get('TRANSLATION_BATCH_SIZE')
        env_nb = os.environ.get('TRANSLATION_NUM_BEAMS')
        if env_bs and env_nb:
            return int(env_bs), int(env_nb)

        # Probe total system memory (physical RAM)
        total_gb = None
        try:
            import psutil  # type: ignore
            total_gb = psutil.virtual_memory().total / (1024 ** 3)
        except Exception:
            # Fallback: sysctl on macOS / meminfo on Linux
            try:
                import subprocess
                if sys.platform == 'darwin':
                    out = subprocess.run(
                        ['sysctl', '-n', 'hw.memsize'],
                        capture_output=True, text=True, timeout=2,
                    )
                    total_gb = int(out.stdout.strip()) / (1024 ** 3)
                elif sys.platform.startswith('linux'):
                    with open('/proc/meminfo') as f:
                        for line in f:
                            if line.startswith('MemTotal:'):
                                kb = int(line.split()[1])
                                total_gb = kb / (1024 ** 2)
                                break
            except Exception:
                pass

        if total_gb is None:
            total_gb = 8.0  # Conservative default if we can't tell

        # Tiers — batch_size × num_beams controls peak memory.
        if total_gb >= 32:
            bs, nb = 16, 5          # Plenty of headroom, max quality
        elif total_gb >= 24:
            bs, nb = 8, 5           # 24 GB Mac: healthy batches, full beam width
        elif total_gb >= 16:
            bs, nb = 4, 5           # 16 GB min target: moderate batches
        elif total_gb >= 8:
            bs, nb = 2, 4           # 8 GB: safer batches, slightly fewer beams
        else:
            bs, nb = 1, 3           # <8 GB: strictly one at a time, fewer beams

        if env_bs:
            bs = int(env_bs)
        if env_nb:
            nb = int(env_nb)
        return bs, nb

    def translate_texts(self, texts: list[str], src_lang: str, tgt_lang: str) -> list[str]:
        """Translate text strings. Chunked to keep peak memory bounded without
        thrashing the MPS graph cache — an empty_cache() between inferences
        forces expensive recompiles, so we let the cache persist across chunks
        and only run gc.collect() to reclaim Python-side references.

        Batch size and beam count are auto-tuned on first use based on
        available system RAM; override with TRANSLATION_BATCH_SIZE /
        TRANSLATION_NUM_BEAMS env vars.
        """
        if not self._model:
            raise RuntimeError('No model loaded')
        if not texts:
            return []

        import gc

        bs, nb = self._auto_tune()
        if not getattr(self, '_logged_tune', False):
            logger.info(
                'Translation tuning: batch_size=%d, num_beams=%d', bs, nb,
            )
            self._logged_tune = True

        # Pad the final chunk to a uniform batch size so MPS reuses its
        # compiled graph (different batch sizes = different compiled graphs).
        # The placeholder " " translations are discarded before return.
        all_results: list[str] = []
        for i in range(0, len(texts), bs):
            chunk = texts[i:i + bs]
            real_count = len(chunk)
            if real_count < bs:
                chunk = list(chunk) + [' '] * (bs - real_count)
            chunk_out = self._translate_chunk(chunk, src_lang, tgt_lang, nb)
            all_results.extend(chunk_out[:real_count])
            gc.collect()

        return all_results

    def _translate_chunk(self, texts: list[str], src_lang: str, tgt_lang: str, num_beams: int) -> list[str]:
        """Run one GPU inference over a list of texts.

        CRITICAL for MPS performance: pad every chunk to a fixed shape
        (batch_size x 256). MPS caches the compiled generation graph per
        input shape; with padding='longest' every chunk gets a different
        sequence length, each triggering a 30-60 s recompile on Apple
        Silicon. padding='max_length' with a constant max_length makes
        every chunk the same shape, so MPS compiles once and reuses.
        Padded-up chunks shorter than the max are a small constant-factor
        waste (~2-3x slower per tiny sentence) but VASTLY faster overall
        than recompiling on every chunk.
        """
        import torch

        batch = self._processor.preprocess_batch(
            texts, src_lang=src_lang, tgt_lang=tgt_lang
        )
        inputs = self._tokenizer(
            batch, return_tensors='pt',
            padding='max_length', truncation=True,
            max_length=256,
        ).to(self._device)

        with torch.no_grad():
            outputs = self._model.generate(
                **inputs, num_beams=num_beams, max_length=256,
                num_return_sequences=1,
                use_cache=False,  # IndicTrans2 custom model incompatible with KV cache on transformers>=4.50
            )

        decoded = self._tokenizer.batch_decode(outputs, skip_special_tokens=True)
        result = self._processor.postprocess_batch(decoded, lang=tgt_lang)

        # Drop references so the memory is eligible for collection
        del inputs, outputs, decoded, batch
        return result

    def translate_text(self, text: str, src_lang: str, tgt_lang: str) -> str:
        """Translate a single text string. Wrapper around translate_texts."""
        result = self.translate_texts([text], src_lang, tgt_lang)
        return result[0] if result else text

    def translate_json(self, json_data: dict, src_lang: str, tgt_lang: str) -> dict:
        """Translate text fields in OCR JSON, preserving all structural fields.

        Batches ALL text/title blocks into one GPU inference call for speed.
        Table cells are batched separately.

        Preserved fields: bbox, type, font_size, font_name, lines, page_idx, etc.
        """
        result = copy.deepcopy(json_data)

        # Ensure correct model direction is loaded
        needed_dir = _infer_direction(src_lang, tgt_lang)
        if self._direction != needed_dir:
            raise RuntimeError(
                f'Loaded model direction is {self._direction}, '
                f'but {needed_dir} is needed for {src_lang} -> {tgt_lang}'
            )

        # Support TWO JSON formats:
        # 1. content_list format: {content_list: [{type, text, bbox, ...}]}
        # 2. OCR output format: {pages: [{regions: [{type, content, bbox, ...}]}]}
        content_list = result.get('content_list', [])

        if content_list:
            self._translate_content_list(content_list, src_lang, tgt_lang)
        elif 'pages' in result:
            # OCR output format: collect ALL regions from ALL pages into one
            # list so translate_texts can use a uniform batch size and reuse
            # the MPS graph. Per-page calls create N different batch shapes,
            # each triggering a ~30-60s graph recompile.
            all_regions: list = []
            for page in result.get('pages', []):
                all_regions.extend(page.get('regions', []))
            if all_regions:
                self._translate_regions(all_regions, src_lang, tgt_lang)
        elif 'pdf_info' in result:
            # Raw MinerU format: same idea, flatten all blocks first.
            all_blocks: list = []
            for page in result.get('pdf_info', []):
                all_blocks.extend(
                    page.get('preproc_blocks', page.get('para_blocks', []))
                )
            if all_blocks:
                self._translate_content_list(all_blocks, src_lang, tgt_lang)

        return result

    def _translate_content_list(self, blocks: list, src_lang: str, tgt_lang: str) -> None:
        """Translate text/title blocks. translate_texts chunks internally
        based on available RAM."""
        text_indices: list[int] = []
        text_values: list[str] = []
        table_indices: list[int] = []

        for i, block in enumerate(blocks):
            block_type = block.get('type', '')
            if block_type in ('text', 'title', 'list', 'caption'):
                text = block.get('text', '') or block.get('content', '')
                if text and text.strip():
                    text_indices.append(i)
                    text_values.append(text)
            elif block_type == 'table':
                table_indices.append(i)

        if text_values:
            logger.info('Translating %d text blocks...', len(text_values))
            translated = self.translate_texts(text_values, src_lang, tgt_lang)
            for idx, trans in zip(text_indices, translated):
                if 'text' in blocks[idx]:
                    blocks[idx]['text'] = trans
                elif 'content' in blocks[idx]:
                    blocks[idx]['content'] = trans
                else:
                    blocks[idx]['text'] = trans

        # Handle table cells
        for idx in table_indices:
            block = blocks[idx]
            html = block.get('text', '') or block.get('html', '') or block.get('table_html', '')
            if html and html.strip():
                translated_html = self._translate_table_html(html, src_lang, tgt_lang)
                if 'table_html' in block:
                    block['table_html'] = translated_html
                elif 'html' in block:
                    block['html'] = translated_html
                elif 'text' in block:
                    block['text'] = translated_html

    def _translate_regions(self, regions: list, src_lang: str, tgt_lang: str) -> None:
        """Translate regions. translate_texts chunks internally based on RAM."""
        text_indices: list[int] = []
        text_values: list[str] = []
        table_indices: list[int] = []

        for i, region in enumerate(regions):
            region_type = region.get('type', '')
            if region_type in ('text', 'title', 'list', 'caption'):
                text = region.get('content', '') or region.get('text', '')
                if text and text.strip():
                    text_indices.append(i)
                    text_values.append(text)
            elif region_type == 'table':
                table_indices.append(i)

        if text_values:
            logger.info('Translating %d text regions...', len(text_values))
            translated = self.translate_texts(text_values, src_lang, tgt_lang)
            for idx, trans in zip(text_indices, translated):
                if 'content' in regions[idx]:
                    regions[idx]['content'] = trans
                elif 'text' in regions[idx]:
                    regions[idx]['text'] = trans
                else:
                    regions[idx]['content'] = trans

        for idx in table_indices:
            region = regions[idx]
            html = region.get('table_html', '') or region.get('html', '') or region.get('content', '')
            if html and html.strip() and '<' in html:
                translated_html = self._translate_table_html(html, src_lang, tgt_lang)
                if 'table_html' in region:
                    region['table_html'] = translated_html
                elif 'html' in region:
                    region['html'] = translated_html

    def _translate_table_html(self, html: str, src_lang: str, tgt_lang: str) -> str:
        """Extract text from table cells, batch translate, reinsert."""
        try:
            from bs4 import BeautifulSoup
        except ImportError:
            logger.warning('BeautifulSoup not installed, skipping table translation')
            return html

        soup = BeautifulSoup(html, 'html.parser')
        cells = soup.find_all(['td', 'th'])

        # Collect all non-empty cells, batch translate, reinsert
        cell_refs = []
        cell_texts = []
        for cell in cells:
            text = cell.get_text(strip=True)
            if text:
                cell_refs.append(cell)
                cell_texts.append(text)

        if cell_texts:
            translated = self.translate_texts(cell_texts, src_lang, tgt_lang)
            for cell, trans in zip(cell_refs, translated):
                cell.string = trans

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
