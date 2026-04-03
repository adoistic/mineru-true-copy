"""
Monkey-patch MinerU to use our customized VisionLLMOCR instead of PytorchPaddleOCR.

Usage: Import this module before MinerU processes any documents.
    import lib.patch_mineru  # noqa: F401
"""
import importlib
import sys
from pathlib import Path


def patch():
    """Replace MinerU's OCR module with our custom version."""
    # Add lib/ to path so our module is importable
    lib_dir = str(Path(__file__).parent)
    if lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)

    # Import our custom module
    from lib import vision_llm_ocr

    # Patch it into MinerU's module registry
    target = "magic_pdf.model.sub_modules.ocr.paddleocr2pytorch.vision_llm_ocr"
    sys.modules[target] = vision_llm_ocr

    print("[patch_mineru] VisionLLMOCR patched successfully")


patch()
