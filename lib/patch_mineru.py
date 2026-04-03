"""
Monkey-patch MinerU to use our customized VisionLLMOCR instead of PytorchPaddleOCR.

Usage: import lib.patch_mineru  # before any MinerU imports
"""
import importlib
import sys
from pathlib import Path

def patch():
    """Replace MinerU's OCR module with our customized version."""
    from lib import vision_llm_ocr
    target = 'magic_pdf.model.sub_modules.ocr.paddleocr2pytorch.vision_llm_ocr'
    sys.modules[target] = vision_llm_ocr

patch()
