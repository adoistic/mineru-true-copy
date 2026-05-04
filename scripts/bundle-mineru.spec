# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for MinerU server sidecar.

Builds a --onedir bundle containing mineru_server.py and all MinerU/torch
dependencies. Models are NOT included — they are loaded at runtime from
the path passed via --models-dir.

Usage (from the repo root):
    test-venv/bin/pyinstaller scripts/bundle-mineru.spec
"""

import sys
import os
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

block_cipher = None

# Collect all submodules for packages that use dynamic imports
hiddenimports = []
hiddenimports += collect_submodules('magic_pdf')
hiddenimports += collect_submodules('torch')
hiddenimports += collect_submodules('torchvision')
hiddenimports += collect_submodules('transformers')
hiddenimports += collect_submodules('onnxruntime')
hiddenimports += collect_submodules('cv2')
hiddenimports += collect_submodules('loguru')
hiddenimports += collect_submodules('pdfminer')
hiddenimports += collect_submodules('pymupdf')
hiddenimports += collect_submodules('ultralytics')
hiddenimports += collect_submodules('PIL')
hiddenimports += collect_submodules('sklearn')
hiddenimports += collect_submodules('scipy')
hiddenimports += collect_submodules('yaml')
hiddenimports += collect_submodules('numpy')
hiddenimports += [
    'lib.patch_mineru',
    'lib.vision_llm_ocr',
    'lib.ocr_utils',
    'tiktoken_ext.openai_public',
    'tiktoken_ext',
    'matplotlib',
]
hiddenimports += collect_submodules('doclayout_yolo')
hiddenimports += collect_submodules('matplotlib')

# Exclude large unused packages to reduce bundle size
# NOTE: Do NOT exclude torch.cuda — torch.__init__.py imports it unconditionally
# NOTE: Do NOT exclude matplotlib — doclayout_yolo imports it at module init
excludes = [
    'torch.utils.tensorboard',
    'tensorboard',
    'IPython',
    'notebook',
    'jupyter',
]

# Collect data files needed at runtime (configs, tokenizer data, etc.)
datas = []
datas += collect_data_files('transformers', include_py_files=False)
datas += collect_data_files('ultralytics')
datas += collect_data_files('magic_pdf')
datas += collect_data_files('tiktoken')
datas += collect_data_files('doclayout_yolo')
# Bundle font files (Latin + Noto non-Latin) for the /fonts/ endpoint
datas += [('../lib/fonts', 'lib/fonts')]

a = Analysis(
    ['../mineru_server.py'],
    pathex=[os.path.abspath('..')],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='mineru-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # UPX breaks dylibs on ARM64 macOS
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name='mineru-server',
)
