"""Tests for font name normalization, mapping, and dominant-font detection."""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from lib.font_utils import (
    normalize_font_name as _normalize_font_name,
    map_font_name as _map_font_name,
    _FONT_MAP,
)
from mineru_server import _dominant_font_for_block


# ── Normalization ──

def test_normalize_strips_subset_prefix():
    assert _normalize_font_name('ABCDEF+Helvetica-Bold') == 'helvetica-bold'


def test_normalize_no_prefix():
    assert _normalize_font_name('Arial') == 'arial'


def test_normalize_empty():
    assert _normalize_font_name('') == ''


def test_normalize_none():
    assert _normalize_font_name(None) == ''


def test_normalize_lowercase():
    assert _normalize_font_name('TimesNewRomanPSMT') == 'timesnewromanpsmt'


def test_normalize_strips_whitespace():
    assert _normalize_font_name('AAPYUV+ Arial ') == 'arial'


# ── Exact mapping ──

def test_map_arial():
    f, fam = _map_font_name('Arial')
    assert f == 'Arimo-Regular.woff2'
    assert fam == 'Arimo'


def test_map_arial_bold():
    f, fam = _map_font_name('Arial-Bold')
    assert f == 'Arimo-Bold.woff2'
    assert fam == 'Arimo'


def test_map_times_new_roman():
    f, fam = _map_font_name('TimesNewRomanPSMT')
    assert f == 'Tinos-Regular.woff2'
    assert fam == 'Tinos'


def test_map_times_bold_subset():
    f, fam = _map_font_name('AAPYUV+TimesNewRomanPS-BoldMT')
    assert f == 'Tinos-Bold.woff2'
    assert fam == 'Tinos'


def test_map_courier():
    f, fam = _map_font_name('CourierNewPSMT')
    assert f == 'Cousine-Regular.woff2'
    assert fam == 'Cousine'


def test_map_courier_bold():
    f, fam = _map_font_name('CourierNewPS-BoldMT')
    assert f == 'Cousine-Bold.woff2'
    assert fam == 'Cousine'


def test_map_helvetica():
    f, fam = _map_font_name('Helvetica')
    assert f == 'Arimo-Regular.woff2'
    assert fam == 'Arimo'


def test_map_open_sans():
    f, fam = _map_font_name('OpenSans-Regular')
    assert 'OpenSans' in f
    assert fam == 'Open Sans'


def test_map_roboto_mono():
    f, fam = _map_font_name('RobotoMono-Regular')
    assert 'RobotoMono' in f
    assert fam == 'Roboto Mono'


def test_map_unknown_font():
    assert _map_font_name('WeirdCustomFont123') == (None, None)


def test_map_empty():
    assert _map_font_name('') == (None, None)


def test_map_none():
    assert _map_font_name(None) == (None, None)


# ── Computer Modern (LaTeX) ──

def test_map_cmr10():
    f, fam = _map_font_name('CMR10')
    assert fam == 'Tinos'


def test_map_cmbx10():
    f, fam = _map_font_name('CMBX10')
    assert fam == 'Tinos'


def test_map_cmtt10():
    f, fam = _map_font_name('CMTT10')
    assert fam == 'Cousine'


# ── Subset prefix handling ──

def test_map_subset_prefix_times():
    f, fam = _map_font_name('BCDEFG+Times-Roman')
    assert f == 'Tinos-Regular.woff2'
    assert fam == 'Tinos'


def test_map_subset_prefix_helvetica():
    f, fam = _map_font_name('XYZABC+Helvetica-Bold')
    assert f == 'Arimo-Bold.woff2'
    assert fam == 'Arimo'


# ── Dominant font detection ──

def test_dominant_font_picks_majority():
    spans = [
        ('Arial', [0, 0, 100, 20], 50),
        ('Times-Roman', [0, 0, 100, 20], 20),
    ]
    assert _dominant_font_for_block(spans, [0, 0, 100, 20]) == 'Arial'


def test_dominant_font_no_overlap():
    spans = [
        ('Arial', [200, 200, 300, 220], 50),
    ]
    # Block bbox doesn't overlap span centers
    assert _dominant_font_for_block(spans, [0, 0, 100, 20]) is None


def test_dominant_font_empty_spans():
    assert _dominant_font_for_block([], [0, 0, 100, 20]) is None


def test_dominant_font_multiple_fonts_picks_most_chars():
    spans = [
        ('Courier', [10, 10, 50, 20], 5),
        ('Arial', [10, 10, 50, 20], 100),
        ('Times', [10, 10, 50, 20], 30),
    ]
    assert _dominant_font_for_block(spans, [0, 0, 100, 30]) == 'Arial'


# ── Font map sanity ──

def test_font_map_loaded():
    """Ensure font_map.json was loaded with entries."""
    assert len(_FONT_MAP) > 50


def test_font_map_entries_have_file_and_family():
    """Every entry must have 'file' and 'family' keys."""
    for key, entry in _FONT_MAP.items():
        assert 'file' in entry, f'Missing "file" in entry "{key}"'
        assert 'family' in entry, f'Missing "family" in entry "{key}"'
        assert entry['file'].endswith('.woff2'), f'File not .woff2: {entry["file"]}'


def test_font_map_all_woff2_files_exist():
    """Every referenced WOFF2 file must exist on disk."""
    fonts_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))), 'lib', 'fonts')
    referenced = set(entry['file'] for entry in _FONT_MAP.values())
    for woff2 in referenced:
        assert os.path.exists(os.path.join(fonts_dir, woff2)), \
            f'WOFF2 file missing: {woff2}'
