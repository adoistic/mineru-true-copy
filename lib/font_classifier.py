"""Scanned-PDF font classifier using ONNX Runtime.

Uses a pre-exported ResNet-18 model (gaborcselle/font-identifier) for font
classification. The .onnx file is bundled with the app (~43MB), eliminating
the ~2GB torch+transformers runtime dependency.

Lazy-loads the ONNX InferenceSession on first scanned PDF (no eager loading
at server start). Falls back to Inter on any model load or inference failure.

Only imported when the OCR (scanned) path is active. Digital-born PDFs
use PyMuPDF font metadata directly and never touch this module.
"""

import hashlib
import json
import logging
import os

import numpy as np

logger = logging.getLogger('mineru')

_SESSION = None
_ID2LABEL: dict[int, str] = {}
_MODEL_UNAVAILABLE = False

# Bundled model path (relative to this file)
_MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts')
_MODEL_PATH = os.path.join(_MODEL_DIR, 'font_classifier.onnx')
_LABELS_PATH = os.path.join(_MODEL_DIR, 'font_classifier_labels.json')

# SHA-256 of the bundled ONNX model — verified on first load
_MODEL_SHA256 = '4d7994f88fcd7ba9cae8a841d74742c8ad3c0efaed2315509589f0ff008af490'

# ResNet-18 input size
_INPUT_SIZE = 224
# ImageNet normalization constants (used by the original HuggingFace processor)
_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def _preprocess_image(image) -> np.ndarray:
    """Preprocess a PIL Image for ResNet-18 inference.

    Replicates the HuggingFace AutoImageProcessor pipeline:
    resize to 224x224, convert to float32, normalize with ImageNet stats,
    transpose to NCHW format.
    """
    # Resize to 224x224
    img = image.resize((_INPUT_SIZE, _INPUT_SIZE))
    # Convert to numpy float32 [0, 1]
    arr = np.array(img, dtype=np.float32) / 255.0
    # Normalize with ImageNet mean/std
    arr = (arr - _MEAN) / _STD
    # HWC -> CHW -> NCHW
    arr = arr.transpose(2, 0, 1)
    return arr[np.newaxis, ...]


def _ensure_model():
    """Load the ONNX model and label mapping. Idempotent."""
    global _SESSION, _ID2LABEL, _MODEL_UNAVAILABLE

    if _SESSION is not None or _MODEL_UNAVAILABLE:
        return

    try:
        import onnxruntime as ort
    except ImportError:
        logger.warning('onnxruntime not installed, font classification disabled')
        _MODEL_UNAVAILABLE = True
        return

    if not os.path.exists(_MODEL_PATH):
        logger.warning('ONNX model not found at %s, font classification disabled', _MODEL_PATH)
        _MODEL_UNAVAILABLE = True
        return

    # SHA-256 verification
    try:
        with open(_MODEL_PATH, 'rb') as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        if digest != _MODEL_SHA256:
            logger.warning('ONNX model SHA-256 mismatch: expected %s, got %s. '
                           'Skipping classification, using Inter fallback.',
                           _MODEL_SHA256[:16], digest[:16])
            _MODEL_UNAVAILABLE = True
            return
    except OSError as e:
        logger.warning('Could not verify ONNX model hash: %s', e)
        _MODEL_UNAVAILABLE = True
        return

    # Load labels
    try:
        with open(_LABELS_PATH) as f:
            raw = json.load(f)
        _ID2LABEL = {int(k): v for k, v in raw.items()}
    except (FileNotFoundError, json.JSONDecodeError) as e:
        logger.warning('Could not load font classifier labels: %s', e)
        _MODEL_UNAVAILABLE = True
        return

    # Create ONNX Runtime session
    try:
        # Prefer CoreML on macOS ARM, fall back to CPU
        providers = ['CoreMLExecutionProvider', 'CPUExecutionProvider']
        _SESSION = ort.InferenceSession(_MODEL_PATH, providers=providers)
        logger.info('Font classifier loaded: ONNX Runtime (%s), %d labels',
                     _SESSION.get_providers()[0], len(_ID2LABEL))
    except (OSError, RuntimeError) as e:
        logger.warning('Failed to load ONNX model: %s. Font classification disabled.', e)
        _MODEL_UNAVAILABLE = True


def classify_crop(image, min_confidence: float = 0.4) -> str | None:
    """Given a PIL Image crop of a text block, return the detected font name.

    Returns the model's top-1 label (e.g. 'Arial', 'Times New Roman',
    'Roboto-Regular') if confidence >= threshold, else None.

    Skips images smaller than 32x32 (ResNet-18 needs minimum input size).
    """
    if _MODEL_UNAVAILABLE:
        return None

    # Skip tiny crops
    if image.width < 32 or image.height < 32:
        return None

    _ensure_model()
    if _SESSION is None:
        return None

    try:
        input_data = _preprocess_image(image)
        outputs = _SESSION.run(None, {'pixel_values': input_data})
        logits = outputs[0][0]  # shape: (num_classes,)

        # Softmax
        exp_logits = np.exp(logits - np.max(logits))
        probs = exp_logits / exp_logits.sum()

        top_idx = int(np.argmax(probs))
        top_prob = float(probs[top_idx])

        if top_prob < min_confidence:
            return None
        return _ID2LABEL.get(top_idx)
    except Exception as e:
        logger.warning('Font classification inference failed: %s', e)
        return None


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

    # Prefer larger blocks (more text -> better classification)
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
