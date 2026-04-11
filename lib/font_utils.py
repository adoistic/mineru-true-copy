"""Font name normalization and mapping utilities.

Extracted from mineru_server.py to avoid circular imports between
font_classifier.py and mineru_server.py. Both modules import from here.
"""

import json
import logging
import os
import re

logger = logging.getLogger('mineru')

_SUBSET_PREFIX_RE = re.compile(r'^[A-Z]{6}\+')

# Load font mapping table at import time
_FONT_MAP_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts', 'font_map.json')
try:
    with open(_FONT_MAP_PATH) as _f:
        _FONT_MAP: dict = {k: v for k, v in json.load(_f).items() if not k.startswith('_')}
except FileNotFoundError:
    logger.warning('font_map.json not found at %s', _FONT_MAP_PATH)
    _FONT_MAP = {}


def normalize_font_name(ps_name: str) -> str:
    """Strip subset prefix and normalize for lookup."""
    if not ps_name:
        return ''
    name = _SUBSET_PREFIX_RE.sub('', ps_name)
    return name.strip().lower()


def map_font_name(ps_name: str) -> tuple[str | None, str | None]:
    """Look up a detected font name in the bundle mapping.

    Returns (bundled_file, family_name) or (None, None) if no match.
    Tries exact match first, then longest-substring match.
    """
    if not ps_name:
        return (None, None)
    norm = normalize_font_name(ps_name)
    if not norm:
        return (None, None)
    # Exact match
    if norm in _FONT_MAP:
        entry = _FONT_MAP[norm]
        return (entry['file'], entry['family'])
    # Longest substring match
    matches = [(k, v) for k, v in _FONT_MAP.items() if k in norm]
    if matches:
        matches.sort(key=lambda kv: -len(kv[0]))
        return (matches[0][1]['file'], matches[0][1]['family'])
    return (None, None)
