"""Scanned-PDF font classifier using gaborcselle/font-identifier.

Lazy-loads the ResNet-18 model on first call. Model is ~44MB and cached to
~/.cache/doctransform/font_classifier/ on first run.

Only imported when the OCR (scanned) path is active. Digital-born PDFs
use PyMuPDF font metadata directly and never touch this module.
"""

import functools
from pathlib import Path

_MODEL = None
_PROCESSOR = None
_CACHE_DIR = Path.home() / '.cache' / 'doctransform' / 'font_classifier'
_MODEL_ID = 'gaborcselle/font-identifier'


def _ensure_model():
    """Download + load the model once. Idempotent."""
    global _MODEL, _PROCESSOR
    if _MODEL is not None:
        return
    from transformers import AutoImageProcessor, AutoModelForImageClassification
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _PROCESSOR = AutoImageProcessor.from_pretrained(
        _MODEL_ID, cache_dir=str(_CACHE_DIR))
    _MODEL = AutoModelForImageClassification.from_pretrained(
        _MODEL_ID, cache_dir=str(_CACHE_DIR))
    _MODEL.eval()


@functools.lru_cache(maxsize=1)
def _id2label() -> dict:
    _ensure_model()
    return dict(_MODEL.config.id2label)


def classify_crop(image, min_confidence: float = 0.4) -> str | None:
    """Given a PIL Image crop of a text block, return the detected font name.

    Returns the model's top-1 label (e.g. 'Arial', 'Times New Roman',
    'Roboto-Regular') if confidence >= threshold, else None.
    """
    import torch
    _ensure_model()
    inputs = _PROCESSOR(images=image, return_tensors='pt')
    with torch.no_grad():
        logits = _MODEL(**inputs).logits
        probs = torch.softmax(logits, dim=-1)[0]
        top_idx = int(probs.argmax())
        top_prob = float(probs[top_idx])
    if top_prob < min_confidence:
        return None
    return _id2label()[top_idx]


def discover_scanned_fonts(fitz_doc, sample_blocks: list[tuple[int, list]],
                           max_samples: int = 10) -> dict[str, str]:
    """Sample N representative blocks from a scanned PDF, classify each.

    Args:
        fitz_doc: open fitz document (for rasterizing page regions)
        sample_blocks: list of (page_idx, bbox) tuples from MinerU's text blocks
        max_samples: how many blocks to classify (more = better accuracy, slower)

    Returns:
        {bundled_file: family_name} for the unique fonts detected.
    """
    from PIL import Image
    import fitz as _fitz
    import io

    # Prefer larger blocks (more text → better classification)
    scored = sorted(sample_blocks,
                    key=lambda pb: (pb[1][2] - pb[1][0]) * (pb[1][3] - pb[1][1]),
                    reverse=True)
    samples = scored[:max_samples]
    detected: set[str] = set()
    for page_idx, bbox in samples:
        try:
            page = fitz_doc[page_idx]
            rect = _fitz.Rect(*bbox[:4])
            pix = page.get_pixmap(clip=rect, dpi=200)
            img = Image.open(io.BytesIO(pix.tobytes('png'))).convert('RGB')
            name = classify_crop(img)
            if name:
                detected.add(name)
        except Exception:
            pass

    # Map each detected name to a bundled file
    from lib.font_utils import map_font_name as _map_font_name

    results: dict[str, str] = {}
    for name in detected:
        bundled, family = _map_font_name(name)
        if bundled:
            results[bundled] = family
    return results
