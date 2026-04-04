"""
VisionLLMOCR — Drop-in replacement for PytorchPaddleOCR.

Uses OpenRouter vision models for text recognition and OpenCV for
text-line detection, matching the exact interface that MinerU's
CustomPEKModel expects.

Environment variables:
    OPENROUTER_API_KEY  — required
    OPENROUTER_MODEL_PRIMARY   — optional (default: x-ai/grok-4.1-fast)
    OPENROUTER_MODEL_FALLBACK  — optional (default: google/gemini-3.1-flash-lite-preview)
"""

import base64
import json
import os
import random
import threading
import time
import warnings

import cv2
import numpy as np
from loguru import logger

from lib.ocr_utils import (
    check_img,
    merge_det_boxes,
    sorted_boxes,
    update_det_boxes,
)

# ---------------------------------------------------------------------------
# OpenRouter helpers
# ---------------------------------------------------------------------------

_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
_MAX_RETRIES = 3
_BASE_DELAY = 1.0  # seconds
_API_SEMAPHORE = threading.Semaphore(30)
_429_COUNT = 0
_429_LOCK = threading.Lock()


def get_429_count() -> int:
    """Return the total number of 429 rate limit responses encountered."""
    return _429_COUNT


def reset_429_count():
    """Reset the 429 counter (call at start of each document)."""
    global _429_COUNT
    with _429_LOCK:
        _429_COUNT = 0


def _get_api_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY environment variable is not set")
    return key


def _get_models(task: str = "extraction") -> list[dict]:
    """Get model chain for the given task.

    Task types:
        "extraction" — structured data extraction (Grok primary, Gemini fallback)
        "ocr"        — text recognition / table OCR (Grok primary, Gemini fallback)
    """
    if task == "ocr":
        return [
            {
                "id": os.environ.get(
                    "OPENROUTER_MODEL_OCR_PRIMARY",
                    "x-ai/grok-4.1-fast",
                ),
                "label": "primary",
            },
            {
                "id": os.environ.get(
                    "OPENROUTER_MODEL_OCR_FALLBACK",
                    "google/gemini-3.1-flash-lite-preview",
                ),
                "label": "fallback",
            },
        ]
    # Default: extraction task
    return [
        {
            "id": os.environ.get("OPENROUTER_MODEL_PRIMARY", "x-ai/grok-4.1-fast"),
            "label": "primary",
        },
        {
            "id": os.environ.get(
                "OPENROUTER_MODEL_FALLBACK",
                "google/gemini-3.1-flash-lite-preview",
            ),
            "label": "fallback",
        },
    ]


def _is_transient(status: int, err_text: str = "") -> bool:
    if status in (0, 429) or status >= 500:
        return True
    for token in ("ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "socket hang up", "fetch failed"):
        if token in err_text:
            return True
    return False


def _encode_image(img: np.ndarray, max_dim: int = 2048, quality: int = 85) -> str:
    """Encode a numpy image to a base64 JPEG string for API calls."""
    h, w = img.shape[:2]
    if max(h, w) > max_dim:
        scale = max_dim / max(h, w)
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    success, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not success:
        raise ValueError("Failed to encode image to JPEG")
    return base64.b64encode(buf).decode("ascii")


def _call_openrouter(image_b64: str, prompt: str, *, max_tokens: int = 4096, json_mode: bool = True, task: str = "extraction") -> str:
    """Call OpenRouter with a vision prompt. Returns the raw response text.

    Args:
        task: "ocr" for text recognition (Gemini primary), "extraction" for structured data (Grok primary)
    """
    import urllib.request
    import urllib.error

    api_key = _get_api_key()
    models = _get_models(task=task)

    if json_mode:
        system_msg = "You are a precise OCR engine. Return ONLY valid JSON, no markdown fences."
    else:
        system_msg = "You are a precise document analysis engine. Follow the user's instructions exactly."

    messages = [
        {"role": "system", "content": system_msg},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                },
            ],
        },
    ]

    last_error = None
    for model in models:
        for attempt in range(_MAX_RETRIES):
            try:
                payload = {
                    "model": model["id"],
                    "messages": messages,
                    "temperature": 0.05,
                    "max_tokens": max_tokens,
                }
                if json_mode and 'gemini' not in model["id"].lower():
                    payload["response_format"] = {"type": "json_object"}

                body = json.dumps(payload).encode()

                req = urllib.request.Request(
                    _OPENROUTER_URL,
                    data=body,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {api_key}",
                        "HTTP-Referer": "https://doctransform.app",
                        "X-Title": "DocTransform",
                    },
                    method="POST",
                )

                with urllib.request.urlopen(req, timeout=120) as resp:
                    data = json.loads(resp.read().decode())

                choice = data.get("choices", [{}])[0]
                content = choice.get("message", {}).get("content", "")
                if not content:
                    raise ValueError(f"{model['label']} returned empty content")

                finish_reason = choice.get("finish_reason", "")
                if finish_reason == "length":
                    logger.warning(
                        f"[VisionLLM] {model['label']} response truncated "
                        f"(finish_reason=length, max_tokens={max_tokens}). "
                        f"Output may be incomplete."
                    )

                return content

            except (urllib.error.HTTPError, urllib.error.URLError, OSError, ValueError) as exc:
                last_error = exc
                status = getattr(exc, "code", 0) or 0
                err_text = str(exc)
                # Capture response body for HTTP errors
                if hasattr(exc, "read"):
                    try:
                        err_body = exc.read().decode()[:300]
                        err_text = f"{err_text} | {err_body}"
                    except Exception:
                        pass
                if status == 429:
                    with _429_LOCK:
                        global _429_COUNT
                        _429_COUNT += 1
                        logger.warning(f"[VisionLLM] 429 rate limit hit (total: {_429_COUNT})")
                if _is_transient(status, err_text) and attempt < _MAX_RETRIES - 1:
                    delay = _BASE_DELAY * (2 ** attempt) + random.uniform(0, 1.0)
                    logger.warning(
                        f"[VisionLLM] {model['label']} attempt {attempt+1} failed ({err_text}), "
                        f"retrying in {delay:.1f}s"
                    )
                    time.sleep(delay)
                    continue
                break  # non-transient or exhausted retries — try next model

        logger.warning(f"[VisionLLM] {model['label']} exhausted retries ({last_error}), trying next model")

    raise RuntimeError(f"All vision LLM models failed. Last error: {last_error}")


# ---------------------------------------------------------------------------
# VLM Table Extraction (replaces RapidTable)
# ---------------------------------------------------------------------------

_TABLE_PROMPT = """\
Extract the table from this image and return it as a clean HTML table.

Rules:
- Return ONLY an HTML <table> element, nothing else.
- Each row becomes a <tr>, each cell a <td> (use <th> for header cells).
- If a cell spans multiple columns or rows, use colspan/rowspan attributes.
- Preserve all text in every cell exactly as it appears.
- Use <thead> and <tbody> for semantic grouping when headers are present.

Formatting rules:
- Use inline CSS styles on elements for visual formatting.
- Column widths: use PERCENTAGES (e.g., style="width: 25%"), never fixed pixel widths.
- If the source has colored/shaded rows or columns, preserve with background-color.
- Reproduce the border pattern from the source document:
  - Fully bordered -> border on cells
  - No visible borders -> no border CSS
  - Partial borders -> selective border-top/border-bottom/border-left/border-right
- Allowed CSS: width (%), min-width, background-color, border properties,
  text-align, vertical-align, padding, border-collapse
- Do NOT use: font-family, font-size, color, position, float, display,
  margin, !important, class, id, or <style> blocks.

- Do NOT wrap in <html> or <body> tags.
- Do NOT include any explanation, just the HTML."""


class VisionLLMTableModel:
    """
    Drop-in replacement for RapidTable that uses a vision LLM
    to extract table structure from cropped table images.
    """

    def __init__(self, *args, **kwargs):
        logger.info("[VisionLLM] Table model initialised (OpenRouter vision)")

    def predict(self, image, *args, **kwargs):
        """
        Match RapidTable.predict() interface.

        Returns: (html_code, table_cell_bboxes, logic_points, elapse)
        """
        start = time.time()
        try:
            img = check_img(image)
            b64 = _encode_image(img)

            with _API_SEMAPHORE:
                raw = _call_openrouter(
                    b64,
                    _TABLE_PROMPT,
                    max_tokens=16384,
                    json_mode=False,
                    task="extraction",
                )

            # Strip markdown fences if the model wraps in ```html
            html = raw.strip()
            if html.startswith("```"):
                # Remove first line (```html) and last line (```)
                lines = html.split("\n")
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines and lines[-1].strip() == "```":
                    lines = lines[:-1]
                html = "\n".join(lines).strip()

            # Strip <html>/<body> wrappers if the model added them
            import re
            html = re.sub(r'</?html[^>]*>', '', html, flags=re.IGNORECASE)
            html = re.sub(r'</?body[^>]*>', '', html, flags=re.IGNORECASE)
            html = html.strip()

            # Ensure output ends with </table> — MinerU validates this
            table_end = html.rfind('</table>')
            if table_end >= 0:
                html = html[:table_end + len('</table>')]
            else:
                logger.warning(f"[VisionLLM] No </table> found in response. Last 200 chars: {html[-200:]}")
                # Try to salvage by appending closing tags
                if '<table' in html:
                    # Close any open tags and append </table>
                    html = html.rstrip() + '\n</tbody>\n</table>'
            # Ensure output starts with <table
            table_start = html.find('<table')
            if table_start > 0:
                html = html[table_start:]

            elapse = time.time() - start
            logger.info(f"[VisionLLM] Table extracted in {elapse:.1f}s ({len(html)} chars)")
            return html, [], [], elapse

        except Exception as exc:
            elapse = time.time() - start
            logger.warning(f"[VisionLLM] Table extraction failed: {exc}")
            return "", [], [], elapse


# ---------------------------------------------------------------------------
# OpenCV text-line detection (replaces PaddleOCR's DBNet detector)
# ---------------------------------------------------------------------------

def _detect_text_lines_cv(img: np.ndarray) -> list[np.ndarray]:
    """
    Detect text-line bounding boxes using morphological operations.

    Returns a list of 4-point polygons in the same format PaddleOCR uses:
        [[x1,y1], [x2,y1], [x2,y2], [x1,y2]]
    """
    h, w = img.shape[:2]
    if h == 0 or w == 0:
        return []

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img.copy()

    # Adaptive threshold for varied backgrounds
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 15, 10
    )

    # Horizontal dilation to merge characters into text lines
    # Kernel width proportional to image width, height kept small
    kw = max(w // 8, 15)
    kh = max(h // 80, 2)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kw, kh))
    dilated = cv2.dilate(binary, kernel, iterations=1)

    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    boxes = []
    min_area = max(w * h * 0.0005, 20)  # filter tiny noise
    for cnt in contours:
        x, y, bw, bh = cv2.boundingRect(cnt)
        if bw * bh < min_area:
            continue
        box = np.array(
            [[x, y], [x + bw, y], [x + bw, y + bh], [x, y + bh]],
            dtype=np.float32,
        )
        boxes.append(box)

    # Sort top-to-bottom, left-to-right (same as PaddleOCR's sorted_boxes)
    if boxes:
        boxes = sorted_boxes(np.array(boxes))

    return boxes


# ---------------------------------------------------------------------------
# VisionLLMOCR class — PytorchPaddleOCR drop-in replacement
# ---------------------------------------------------------------------------

_OCR_PROMPT = """\
Extract ALL text from this image. Return a JSON object:

{"lines": ["line 1", "line 2", ...]}

Rules:
- One array element per visual line of text, top-to-bottom, left-to-right.
- Preserve original spelling, capitalisation, and punctuation exactly.
- If no text, return {"lines": []}.
- Bold text: wrap with <strong>...</strong>
- Italic text: wrap with <em>...</em>
- Underlined text: wrap with <u>...</u>
- Strikethrough text: wrap with <s>...</s>
- Superscript text: wrap with <sup>...</sup>
- Subscript text: wrap with <sub>...</sub>
- No other HTML tags. No CSS. No attributes.
"""


class VisionLLMOCR:
    """
    Drop-in replacement for PytorchPaddleOCR that uses a vision LLM
    (via OpenRouter) for text recognition and OpenCV for text-line detection.
    """

    def __init__(self, **kwargs):
        self.lang = kwargs.get("lang", "ch")
        self.drop_score = kwargs.get("drop_score", 0.5)
        # Verify API key is available at init time
        try:
            _get_api_key()
            logger.info("[VisionLLM] OCR engine initialised (OpenRouter vision)")
        except RuntimeError:
            logger.warning(
                "[VisionLLM] OPENROUTER_API_KEY not set — OCR calls will fail until it is configured"
            )

    def ocr(
        self,
        img,
        det=True,
        rec=True,
        mfd_res=None,
        tqdm_enable=False,
    ):
        """
        Match PytorchPaddleOCR.ocr() interface exactly.

        Returns:
            det=True,  rec=True  → [[ [4-point-box, (text, score)], ... ]]
            det=True,  rec=False → [[ 4-point-box, ... ]]
            det=False, rec=True  → [[ (text, score), ... ]]
        """
        assert isinstance(img, (np.ndarray, list, str, bytes))
        if isinstance(img, list) and det:
            logger.error("When input is a list of images, det must be False")
            return [None]

        img = check_img(img)
        imgs = [img]

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", category=RuntimeWarning)

            if det and rec:
                return self._det_and_rec(imgs, mfd_res)
            elif det and not rec:
                return self._det_only(imgs, mfd_res)
            elif not det and rec:
                return self._rec_only(imgs)

    # ---- det + rec ----------------------------------------------------------

    def _det_and_rec(self, imgs, mfd_res):
        ocr_res = []
        for img in imgs:
            h, w = img.shape[:2]
            if h == 0 or w == 0:
                ocr_res.append(None)
                continue

            # 1. Detect text-line boxes via OpenCV
            dt_boxes = _detect_text_lines_cv(img)
            if not dt_boxes:
                ocr_res.append(None)
                continue

            dt_boxes = merge_det_boxes(dt_boxes)
            if mfd_res:
                dt_boxes = update_det_boxes(dt_boxes, mfd_res)
            if not dt_boxes:
                ocr_res.append(None)
                continue

            # 2. Recognise text via vision LLM (one call for entire region)
            try:
                texts = self._recognise_text(img, len(dt_boxes))
            except Exception as exc:
                logger.error(f"[VisionLLM] recognition failed: {exc}")
                ocr_res.append(None)
                continue

            # 3. Pair boxes with recognised text lines
            result = self._pair_boxes_and_texts(dt_boxes, texts, h)

            ocr_res.append(result if result else None)

        return ocr_res

    # ---- det only -----------------------------------------------------------

    def _det_only(self, imgs, mfd_res):
        ocr_res = []
        for img in imgs:
            dt_boxes = _detect_text_lines_cv(img)
            if not dt_boxes:
                ocr_res.append(None)
                continue

            dt_boxes = merge_det_boxes(dt_boxes)
            if mfd_res:
                dt_boxes = update_det_boxes(dt_boxes, mfd_res)

            tmp_res = [box.tolist() if isinstance(box, np.ndarray) else box for box in dt_boxes]
            ocr_res.append(tmp_res if tmp_res else None)

        return ocr_res

    # ---- rec only -----------------------------------------------------------

    def _rec_only(self, imgs):
        from concurrent.futures import ThreadPoolExecutor, as_completed

        # Flatten all sub-images into a list of tasks: (outer_idx, inner_idx, sub_img)
        flat_tasks = []
        for outer_idx, img in enumerate(imgs):
            if not isinstance(img, list):
                img = [img]
            for inner_idx, sub_img in enumerate(img):
                flat_tasks.append((outer_idx, inner_idx, sub_img))

        if not flat_tasks:
            return [[] for _ in imgs]

        def _process_span(outer_idx, inner_idx, sub_img):
            try:
                with _API_SEMAPHORE:
                    texts = self._recognise_text(sub_img, expected_lines=1)
                text = " ".join(t for t, _ in texts) if texts else ""
                score = sum(s for _, s in texts) / len(texts) if texts else 0.0
                return (outer_idx, inner_idx, (text, score))
            except Exception as exc:
                logger.error(f"[VisionLLM] recognition failed: {exc}")
                return (outer_idx, inner_idx, ("[OCR: region unreadable]", 0.0))

        max_workers = min(len(flat_tasks), 16)
        results_map: dict[int, dict[int, tuple]] = {}
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [
                executor.submit(_process_span, oi, ii, si)
                for oi, ii, si in flat_tasks
            ]
            for future in as_completed(futures):
                outer_idx, inner_idx, result = future.result()
                results_map.setdefault(outer_idx, {})[inner_idx] = result

        # Reassemble results in original order
        ocr_res = []
        for outer_idx in range(len(imgs)):
            inner_results = results_map.get(outer_idx, {})
            ordered = [inner_results[k] for k in sorted(inner_results.keys())]
            ocr_res.append(ordered)
        return ocr_res

    # ---- helpers ------------------------------------------------------------

    def _recognise_text(self, img: np.ndarray, expected_lines: int = 0) -> list[tuple[str, float]]:
        """
        Send image to vision LLM.

        Returns list of (text, confidence) tuples — one per visual line.
        """
        h, w = img.shape[:2]

        # Skip tiny images that can't contain meaningful text
        if h < 5 or w < 5:
            return [("[OCR: region unreadable]", 0.0)]

        image_b64 = _encode_image(img)

        raw = _call_openrouter(image_b64, _OCR_PROMPT, task="ocr")

        # Strip markdown fences if the model ignores the instruction
        raw = raw.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1]
            if raw.endswith("```"):
                raw = raw[:-3]
            raw = raw.strip()

        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning(f"[VisionLLM] failed to parse JSON, using raw text")
            return [(raw.strip(), 0.9)]

        lines = data.get("lines", [])

        if not lines:
            # Maybe the model returned text directly
            if isinstance(data, dict) and "text" in data:
                return [(data["text"], 0.95)]
            logger.warning("[VisionLLM] empty response for region — marking unreadable")
            return [("[OCR: region unreadable]", 0.0)]

        results = []
        for line in lines:
            text = ""
            if isinstance(line, dict):
                text = line.get("text", "")
            elif isinstance(line, str):
                text = line
            # LLMs may embed \n within a single "line" — split them out
            for sub in text.split("\n"):
                if sub.strip():
                    results.append((sub.strip(), 0.95))

        if not results:
            logger.warning("[VisionLLM] all lines empty for region — marking unreadable")
            return [("[OCR: region unreadable]", 0.0)]

        return results

    def _pair_boxes_and_texts(
        self,
        dt_boxes: list,
        texts: list[tuple[str, float]],
        img_height: int,
    ) -> list:
        """
        Pair detected bounding boxes with recognised text lines.
        Boxes are sorted top-to-bottom; texts are in reading order.
        """
        if not dt_boxes or not texts:
            return []

        # Sort boxes by vertical centre
        box_centres = []
        for box in dt_boxes:
            arr = np.array(box) if not isinstance(box, np.ndarray) else box
            y_centre = arr[:, 1].mean()
            box_centres.append((y_centre, arr))
        box_centres.sort(key=lambda x: x[0])

        result = []
        n_boxes = len(box_centres)
        n_texts = len(texts)

        if n_boxes <= n_texts:
            # More text lines than boxes — concatenate extra text into last boxes
            for i, (_, box) in enumerate(box_centres):
                if i < n_boxes - 1:
                    text, score = texts[i] if i < n_texts else ("", 0.0)
                else:
                    # Last box gets remaining text
                    remaining = texts[i:]
                    text = " ".join(t for t, _ in remaining)
                    score = sum(s for _, s in remaining) / len(remaining) if remaining else 0.0
                result.append([box.tolist(), (text, score)])
        else:
            # More boxes than text lines — assign text to closest boxes, leave rest empty
            for i, (_, box) in enumerate(box_centres):
                if i < n_texts:
                    text, score = texts[i]
                else:
                    text, score = "", 0.0
                if text:  # only include boxes with text
                    result.append([box.tolist(), (text, score)])

        return result
