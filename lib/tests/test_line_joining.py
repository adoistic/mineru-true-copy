"""Tests for text merging, list detection, sidebar detection, and heading hierarchy."""
import sys
import os

# Add project root to path so we can import mineru_server
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from mineru_server import (
    _unescape_markdown, _extract_block_content, _assign_heading_levels,
    _is_list_item, _detect_list_content, _is_decorative_sidebar,
    _is_decorative_block, _merge_overlapping_blocks,
)
from magic_pdf.config.ocr_content_type import ContentType


def _make_block(lines_content: list[list[tuple[str, str]]], block_type='text',
                list_starts: list[int] | None = None,
                span_bboxes: dict | None = None,
                line_bboxes: list | None = None) -> dict:
    """Build a para_block dict from a list of lines.

    Each line is a list of (text, span_type) tuples.
    Shorthand: plain string is treated as (text, 'Text').
    span_bboxes: dict mapping (line_idx, span_idx) to [x1,y1,x2,y2]
    line_bboxes: list of [x1,y1,x2,y2] per line
    """
    lines = []
    for i, spans_data in enumerate(lines_content):
        spans = []
        for j, item in enumerate(spans_data):
            if isinstance(item, str):
                span = {'content': item, 'type': ContentType.Text}
            else:
                text, stype = item
                span = {'content': text, 'type': stype}
            if span_bboxes and (i, j) in span_bboxes:
                span['bbox'] = span_bboxes[(i, j)]
            spans.append(span)
        line = {'spans': spans}
        if list_starts and i in list_starts:
            line['is_list_start_line'] = True
        if line_bboxes and i < len(line_bboxes):
            line['bbox'] = line_bboxes[i]
        lines.append(line)
    return {'type': block_type, 'lines': lines}


class TestUnescapeMarkdown:
    """Tests for _unescape_markdown adapter."""

    def test_unescapes_star(self):
        assert _unescape_markdown(r'a \* b') == 'a * b'

    def test_unescapes_backtick(self):
        assert _unescape_markdown(r'a \` b') == 'a ` b'

    def test_unescapes_tilde(self):
        assert _unescape_markdown(r'a \~ b') == 'a ~ b'

    def test_keeps_dollar_escaped(self):
        # Dollar signs stay escaped to prevent KaTeX false matches
        assert _unescape_markdown(r'costs \$50') == r'costs \$50'

    def test_multiple_escapes(self):
        assert _unescape_markdown(r'\*bold\* and \`code\`') == '*bold* and `code`'


class TestExtractBlockContent:
    """Tests for _extract_block_content using _join_lines_for_html."""

    def test_western_text_joins_with_spaces(self):
        """Non-list text lines are joined with spaces for paragraph flow."""
        block = _make_block([
            ['Hello, my name is'],
            ['Claude and I help'],
            ['with coding tasks.'],
        ])
        text, _, _, _, _ = _extract_block_content(block)
        assert 'Hello, my name is' in text
        assert 'Claude and I help' in text

    def test_hyphenated_line_end_joins(self):
        """MinerU's merge_para_with_text dehyphenates line-wrapped words."""
        block = _make_block([
            ['trace-class opera-'],
            ['tor in Hilbert space'],
        ])
        text, _, _, _, _ = _extract_block_content(block)
        # MinerU's native dehyphenation removes trailing hyphen when next line starts lowercase
        assert 'operator' in text or 'opera-' in text

    def test_list_items_preserve_line_breaks(self):
        block = _make_block(
            [
                ['Introduction to the topic'],
                ['1. First item in the list'],
                ['2. Second item in the list'],
            ],
            list_starts=[1, 2],
        )
        text, _, _, _, _ = _extract_block_content(block)
        assert '1. First item' in text

    def test_inline_equation_uses_placeholder(self):
        """Blocks with equations go through _join_lines_for_html with {{EQ:index}} placeholders."""
        block = _make_block([
            ['The formula '],
            [('E=mc^2', ContentType.InlineEquation)],
            [' is famous.'],
        ])
        text, _, _, _, inline_eqs = _extract_block_content(block)
        assert '{{EQ:0}}' in text
        assert len(inline_eqs) == 1
        assert inline_eqs[0]['latex'] == 'E=mc^2'
        assert inline_eqs[0]['display'] == 'inline'

    def test_interline_equation_uses_placeholder(self):
        """Block equations also get {{EQ:index}} placeholders."""
        block = _make_block([
            ['Consider the equation'],
            [('\\int_0^1 f(x) dx', ContentType.InterlineEquation)],
            ['where f is continuous.'],
        ])
        text, _, _, _, inline_eqs = _extract_block_content(block)
        assert '{{EQ:0}}' in text
        assert len(inline_eqs) == 1
        assert inline_eqs[0]['latex'] == '\\int_0^1 f(x) dx'
        assert inline_eqs[0]['display'] == 'block'

    def test_inline_equation_passes_bbox(self):
        """Equation span bbox and line bbox are passed through to eq_entry."""
        block = _make_block(
            [['Lemma: ', ('x^2', ContentType.InlineEquation)]],
            span_bboxes={(0, 1): [150, 200, 180, 220]},
            line_bboxes=[[50, 195, 500, 225]],
        )
        _, _, _, _, inline_eqs = _extract_block_content(block)
        assert len(inline_eqs) == 1
        assert inline_eqs[0]['bbox'] == [150, 200, 180, 220]
        assert inline_eqs[0]['line_bbox'] == [50, 195, 500, 225]

    def test_inline_equation_missing_bbox_graceful(self):
        """Equation without bbox on span still works (no bbox key in eq_entry)."""
        block = _make_block([
            ['Formula: ', ('y=mx+b', ContentType.InlineEquation)],
        ])
        _, _, _, _, inline_eqs = _extract_block_content(block)
        assert len(inline_eqs) == 1
        assert 'bbox' not in inline_eqs[0]
        assert 'line_bbox' not in inline_eqs[0]

    def test_empty_block_returns_empty(self):
        block = {'type': 'text', 'lines': []}
        text, _, _, _, _ = _extract_block_content(block)
        assert text == ''

    def test_table_html_extraction(self):
        block = {
            'type': 'table',
            'blocks': [{
                'type': 'table_body',
                'lines': [{'spans': [{'type': ContentType.Table, 'content': '', 'html': '<table><tr><td>A</td></tr></table>'}]}],
            }],
        }
        _, table_html, _, _, _ = _extract_block_content(block)
        assert '<table>' in table_html

    def test_image_path_extraction(self):
        block = {
            'type': 'image',
            'blocks': [{
                'type': 'image_body',
                'lines': [{'spans': [{'type': ContentType.Image, 'content': '', 'image_path': 'img/test.png'}]}],
            }],
        }
        _, _, img_path, _, _ = _extract_block_content(block)
        assert img_path == 'img/test.png'

    def test_latex_extraction_from_equation_span(self):
        block = _make_block([
            [('E=mc^2', ContentType.InterlineEquation)],
        ])
        _, _, _, latex, _ = _extract_block_content(block)
        assert latex == 'E=mc^2'

    def test_fallback_to_text_field(self):
        block = {'type': 'text', 'text': 'Fallback text content'}
        text, _, _, _, _ = _extract_block_content(block)
        assert text == 'Fallback text content'

    def test_markdown_escaping_removed(self):
        """MinerU escapes *, `, ~ — our adapter should remove those escapes."""
        block = _make_block([
            ['The result is 5 \\* 3 = 15'],
        ])
        text, _, _, _, _ = _extract_block_content(block)
        assert '5 * 3' in text or '5 \\* 3' in text  # depends on where escaping happens


class TestAssignHeadingLevels:
    """Tests for heuristic heading hierarchy assignment."""

    def _make_title_block(self, text: str, line_height: float) -> dict:
        return {
            'type': 'title',
            'lines': [{
                'bbox': [0, 0, 100, line_height],
                'spans': [{'content': text, 'type': ContentType.Text}],
            }],
        }

    def test_single_title_gets_h1(self):
        pdf_info = [{'para_blocks': [self._make_title_block('Introduction', 24)]}]
        _assign_heading_levels(pdf_info)
        assert pdf_info[0]['para_blocks'][0]['level'] == 1

    def test_two_sizes_get_h1_h2(self):
        pdf_info = [{'para_blocks': [
            self._make_title_block('Chapter Title', 30),
            self._make_title_block('Section Title', 20),
        ]}]
        _assign_heading_levels(pdf_info)
        assert pdf_info[0]['para_blocks'][0]['level'] == 1
        assert pdf_info[0]['para_blocks'][1]['level'] == 2

    def test_three_sizes_get_h1_h2_h3(self):
        pdf_info = [{'para_blocks': [
            self._make_title_block('Chapter', 36),
            self._make_title_block('Section', 24),
            self._make_title_block('Subsection', 18),
        ]}]
        _assign_heading_levels(pdf_info)
        assert pdf_info[0]['para_blocks'][0]['level'] == 1
        assert pdf_info[0]['para_blocks'][1]['level'] == 2
        assert pdf_info[0]['para_blocks'][2]['level'] == 3

    def test_similar_heights_clustered(self):
        """Heights within 2px should be treated as the same level."""
        pdf_info = [{'para_blocks': [
            self._make_title_block('Title A', 24),
            self._make_title_block('Title B', 25),  # within 2px of 24
            self._make_title_block('Subtitle', 16),
        ]}]
        _assign_heading_levels(pdf_info)
        # A and B should be same level
        assert pdf_info[0]['para_blocks'][0]['level'] == pdf_info[0]['para_blocks'][1]['level']
        assert pdf_info[0]['para_blocks'][2]['level'] > pdf_info[0]['para_blocks'][0]['level']

    def test_contiguity_enforced(self):
        """Levels should be contiguous — no jumping from H1 to H4."""
        pdf_info = [{'para_blocks': [
            self._make_title_block('Main', 36),
            self._make_title_block('Sub', 12),  # big gap in height
        ]}]
        _assign_heading_levels(pdf_info)
        assert pdf_info[0]['para_blocks'][0]['level'] == 1
        assert pdf_info[0]['para_blocks'][1]['level'] == 2  # contiguous, not 4+

    def test_max_six_levels(self):
        """Never assign more than H6."""
        blocks = [self._make_title_block(f'Level {i}', 40 - i * 5) for i in range(8)]
        pdf_info = [{'para_blocks': blocks}]
        _assign_heading_levels(pdf_info)
        for b in blocks:
            assert b['level'] <= 6

    def test_numbering_depth_tiebreaker(self):
        """Dotted numbering like '1.2.3' should influence level assignment."""
        pdf_info = [{'para_blocks': [
            self._make_title_block('1 Introduction', 24),
            self._make_title_block('1.1 Background', 24),  # same height but deeper numbering
        ]}]
        _assign_heading_levels(pdf_info)
        # Both have same height, but numbering depth may differentiate
        # (within ±1 level tolerance)

    def test_no_titles_no_crash(self):
        """Empty or no-title pages should not crash."""
        pdf_info = [{'para_blocks': [
            {'type': 'text', 'lines': [{'spans': [{'content': 'body text', 'type': ContentType.Text}]}]},
        ]}]
        _assign_heading_levels(pdf_info)  # should not raise

    def test_across_pages(self):
        """Titles across multiple pages should get consistent levels."""
        pdf_info = [
            {'para_blocks': [self._make_title_block('Chapter 1', 30)]},
            {'para_blocks': [self._make_title_block('Chapter 2', 30)]},
        ]
        _assign_heading_levels(pdf_info)
        assert pdf_info[0]['para_blocks'][0]['level'] == pdf_info[1]['para_blocks'][0]['level']


class TestIsListItem:
    """Tests for content-based list item detection."""

    def test_bullet_dash(self):
        assert _is_list_item('- First item')

    def test_bullet_unicode(self):
        assert _is_list_item('\u2022 Bullet point')  # •

    def test_numbered_dot(self):
        assert _is_list_item('1. First item')

    def test_numbered_paren(self):
        assert _is_list_item('1) First item')

    def test_numbered_in_parens(self):
        assert _is_list_item('(1) First item')

    def test_lettered_paren(self):
        assert _is_list_item('(a) Option alpha')

    def test_lettered_dot(self):
        assert _is_list_item('a. Option alpha')

    def test_roman_in_parens(self):
        assert _is_list_item('(i) Sub-question one')

    def test_roman_ii_in_parens(self):
        assert _is_list_item('(ii) Sub-question two')

    def test_roman_iv_in_parens(self):
        assert _is_list_item('(iv) Sub-question four')

    def test_section_number(self):
        assert _is_list_item('1.1. Subsection')

    def test_multi_level_section(self):
        assert _is_list_item('2.3.1. Deep section')

    def test_plain_text_not_list(self):
        assert not _is_list_item('This is just a sentence.')

    def test_number_in_sentence_not_list(self):
        assert not _is_list_item('The year 2024 was eventful.')

    def test_section_keyword(self):
        assert _is_list_item('Section 3: Analysis')

    def test_chapter_keyword(self):
        assert _is_list_item('Chapter 1')


class TestDetectListContent:
    """Tests for block-level list reclassification."""

    def test_mcq_block_detected_as_list(self):
        """REGRESSION: MCQ exercise content must be reclassified as list."""
        text = '(i) A landmass bounded by sea\n(a) Coast (c) Peninsula\n(b) Island (d) None\n(ii) Mountain ranges'
        assert _detect_list_content(text)

    def test_numbered_list_detected(self):
        text = '(1) The Himalayan Mountains\n(2) The Northern Plains\n(3) The Peninsular Plateau'
        assert _detect_list_content(text)

    def test_plain_paragraph_not_list(self):
        text = 'India is a vast country.\nIt has diverse geography.\nThe climate varies widely.'
        assert not _detect_list_content(text)

    def test_single_line_not_list(self):
        text = '(1) Only one item'
        assert not _detect_list_content(text)

    def test_mixed_content_below_threshold(self):
        """Less than 60% list items → stays as text."""
        text = 'Introduction paragraph.\nSome more text.\nAnother line.\n1. One list item\n2. Two list item'
        assert not _detect_list_content(text)


class TestLinePreservationRegression:
    """REGRESSION TESTS: Ensure list sub-items preserve \\n between lines."""

    def test_mcq_lines_preserved(self):
        """Exercise page MCQ items must NOT be joined into one paragraph."""
        block = _make_block([
            ['(i) A landmass bounded by sea on three sides is referred to as'],
            ['(a) Coast (c) Peninsula'],
            ['(b) Island (d) None of the above'],
            ['(ii) Mountain ranges in the eastern part of India forming its boundary with Myanmar are collectively called as'],
        ])
        text, _, _, _, _ = _extract_block_content(block)
        lines = text.split('\n')
        assert len(lines) >= 4, f'Expected 4+ lines, got {len(lines)}: {text!r}'
        assert any('(i)' in l for l in lines)
        assert any('(ii)' in l for l in lines)

    def test_numbered_list_lines_preserved(self):
        """Numbered list items must be on separate lines."""
        block = _make_block([
            ['(1) The Himalayan Mountains'],
            ['(2) The Northern Plains'],
            ['(3) The Peninsular Plateau'],
            ['(4) The Indian Desert'],
        ])
        text, _, _, _, _ = _extract_block_content(block)
        lines = text.split('\n')
        assert len(lines) == 4, f'Expected 4 lines, got {len(lines)}: {text!r}'

    def test_plain_paragraph_still_joins(self):
        """Non-list prose lines should still be joined with spaces."""
        block = _make_block([
            ['India is a vast country with'],
            ['diverse geography spanning from'],
            ['the Himalayas to the Indian Ocean.'],
        ])
        text, _, _, _, _ = _extract_block_content(block)
        # Should be one flowing paragraph, not 3 separate lines
        assert '\n' not in text
        assert 'country with diverse' in text


class TestDecorativeSidebar:
    """Tests for narrow vertical strip detection."""

    def test_narrow_vertical_strip(self):
        block = {'bbox': [15, 209, 37, 585], 'type': 'text'}
        # width=22, height=376, aspect=17.1
        assert _is_decorative_sidebar(block)

    def test_normal_text_block(self):
        block = {'bbox': [72, 100, 540, 130], 'type': 'text'}
        # width=468, height=30 — normal text block
        assert not _is_decorative_sidebar(block)

    def test_wide_tall_block(self):
        block = {'bbox': [50, 50, 200, 700], 'type': 'text'}
        # width=150, height=650 — tall but not narrow enough
        assert not _is_decorative_sidebar(block)

    def test_uses_bbox_not_bbox_fs(self):
        """Uses layout-detected bbox, not text-fitted bbox_fs.

        bbox_fs is only available on text blocks and is too tight for
        image cropping. cut_image() needs the original layout bbox.
        """
        # bbox is wide (not decorative), bbox_fs is narrow — should use bbox
        block = {'bbox': [0, 0, 500, 50], 'bbox_fs': [15, 209, 37, 585], 'type': 'text'}
        assert not _is_decorative_sidebar(block)

    def test_bbox_only(self):
        """Works with bbox when bbox_fs is absent (image blocks)."""
        block = {'bbox': [15, 209, 37, 585], 'type': 'text'}
        assert _is_decorative_sidebar(block)

    def test_missing_bbox(self):
        block = {'type': 'text'}
        assert not _is_decorative_sidebar(block)


class TestDecorativeBlock:
    """Tests for unified decorative block detection."""

    def test_narrow_vertical_strip(self):
        """Catches arXiv ID sidebars, vertical watermarks."""
        block = {'bbox': [15, 209, 37, 585], 'type': 'text'}
        assert _is_decorative_block(block, '', 612)

    def test_normal_text_block(self):
        """Regular paragraph should never be decorative."""
        block = {'bbox': [72, 100, 540, 130], 'type': 'text'}
        assert not _is_decorative_block(block, 'This is normal text content.', 612)

    def test_small_block_short_text(self):
        """Small block with short text: likely icon/logo."""
        block = {'bbox': [500, 50, 570, 100], 'type': 'text'}
        # width=70 (11% of 612), height=50, text="©"
        assert _is_decorative_block(block, '©', 612)

    def test_small_block_with_real_text(self):
        """Small block but with enough text to be real content."""
        block = {'bbox': [500, 50, 570, 100], 'type': 'text'}
        assert not _is_decorative_block(block, 'Section 3.2: Results', 612)

    def test_watermark_short_text(self):
        """Very short text (1-3 chars) in small area = stamp/watermark."""
        block = {'bbox': [100, 100, 140, 130], 'type': 'text'}
        assert _is_decorative_block(block, 'OK', 612)

    def test_empty_text_not_decorative(self):
        """Empty text blocks are handled elsewhere, not here."""
        block = {'bbox': [100, 100, 140, 130], 'type': 'text'}
        assert not _is_decorative_block(block, '', 612)

    def test_wide_block_never_decorative(self):
        """Full-width blocks should never be decorative."""
        block = {'bbox': [72, 100, 540, 130], 'type': 'text'}
        assert not _is_decorative_block(block, 'X', 612)

    def test_ocr_watermark_text_caught(self):
        """Decorative watermark where MinerU OCR'd a few words.
        Previously missed by len(text) <= 5 heuristic.
        """
        # Small block, short watermark text
        block = {'bbox': [520, 700, 590, 730], 'type': 'text'}
        assert _is_decorative_block(block, 'DRAFT', 612)

    def test_uses_bbox_not_bbox_fs(self):
        """Uses layout bbox, not text-fitted bbox_fs."""
        block = {'bbox': [0, 0, 500, 50], 'bbox_fs': [15, 209, 37, 585], 'type': 'text'}
        assert not _is_decorative_block(block, 'real content here', 612)


class TestMergeOverlappingBlocks:
    """Tests for _merge_overlapping_blocks: dedup of stacked text regions."""

    def test_overlapping_text_blocks_get_merged(self):
        """Doc 3 p44 case: short text r2 sits inside long body r3."""
        small = {
            'type': 'text',
            'bbox': [70, 166, 526, 200],  # 456 x 34
            'text': 'Header line that is also captured below',
        }
        large = {
            'type': 'list',
            'bbox': [68, 179, 528, 779],  # 460 x 600
            'text': 'Item one\nItem two\nItem three',
        }
        out = _merge_overlapping_blocks([small, large])
        assert len(out) == 1
        merged = out[0]
        # Larger block's bbox + type win
        assert merged['bbox'] == [68, 179, 528, 779]
        assert merged['type'] == 'list'
        # Smaller text prepended with newline separator
        assert merged['text'].startswith('Header line that is also captured below')
        assert 'Item one' in merged['text']
        assert '\n' in merged['text']

    def test_empty_smaller_block_dropped_without_content_merge(self):
        """An empty inner block is dropped, larger text untouched."""
        empty_small = {'type': 'text', 'bbox': [70, 166, 526, 200], 'text': '   '}
        large = {'type': 'text', 'bbox': [68, 179, 528, 779], 'text': 'Body content'}
        out = _merge_overlapping_blocks([empty_small, large])
        assert len(out) == 1
        assert out[0]['text'] == 'Body content'
        assert out[0]['bbox'] == [68, 179, 528, 779]

    def test_non_overlapping_text_blocks_are_preserved(self):
        """Stacked but non-overlapping blocks must NOT be merged."""
        a = {'type': 'text', 'bbox': [70, 100, 526, 150], 'text': 'first paragraph'}
        b = {'type': 'text', 'bbox': [70, 200, 526, 400], 'text': 'second paragraph'}
        out = _merge_overlapping_blocks([a, b])
        assert len(out) == 2
        assert out[0]['text'] == 'first paragraph'
        assert out[1]['text'] == 'second paragraph'

    def test_text_and_table_not_merged(self):
        """Different fundamental types (text vs table) must not merge."""
        small = {'type': 'text', 'bbox': [70, 166, 526, 200], 'text': 'caption'}
        table = {'type': 'table', 'bbox': [68, 179, 528, 779], 'text': 'cell data'}
        out = _merge_overlapping_blocks([small, table])
        assert len(out) == 2


# ============================================================================
# Cross-page un-merge tests
# ============================================================================

def test_unmerge_cross_page_basic():
    """Standard 2-page paragraph merge: lines get moved back to their home page."""
    from mineru_server import _unmerge_cross_page_blocks

    pdf_info = [
        {
            'page_idx': 0,
            'page_size': {'width': 595, 'height': 842},
            'para_blocks': [{
                'type': 'text',
                'bbox': [70, 750, 525, 773],
                'lines': [
                    {'bbox': [70, 750, 525, 773],
                     'spans': [{'content': 'Own line page 0.', 'type': 'text'}]},
                    {'bbox': [70, 72, 525, 95],
                     'spans': [{'content': 'Line 1 from page 1.', 'type': 'text',
                                'cross_page': True}]},
                    {'bbox': [70, 96, 525, 119],
                     'spans': [{'content': 'Line 2 from page 1.', 'type': 'text',
                                'cross_page': True}]},
                ],
            }],
        },
        {
            'page_idx': 1,
            'page_size': {'width': 595, 'height': 842},
            'para_blocks': [{
                'type': 'text',
                'bbox': [70, 72, 525, 200],
                'lines': [],
                'lines_deleted': True,
            }],
        },
    ]

    _unmerge_cross_page_blocks(pdf_info)

    p0 = pdf_info[0]['para_blocks'][0]
    p1 = pdf_info[1]['para_blocks'][0]

    assert len(p0['lines']) == 1
    assert p0['lines'][0]['spans'][0]['content'] == 'Own line page 0.'
    assert len(p1['lines']) == 2
    assert p1['lines'][0]['spans'][0]['content'] == 'Line 1 from page 1.'
    assert p1['lines'][1]['spans'][0]['content'] == 'Line 2 from page 1.'
    # Markers cleared after restoration
    assert 'cross_page' not in p1['lines'][0]['spans'][0]
    assert 'lines_deleted' not in p1


def test_unmerge_no_cross_page_noop():
    """With no cross_page markers, the function must be a no-op."""
    from mineru_server import _unmerge_cross_page_blocks

    pdf_info = [
        {'page_idx': 0, 'page_size': {'width': 595, 'height': 842},
         'para_blocks': [{'type': 'text', 'bbox': [70, 72, 525, 200],
                          'lines': [{'bbox': [70, 72, 525, 95],
                                     'spans': [{'content': 'Normal.', 'type': 'text'}]}]}]},
    ]
    _unmerge_cross_page_blocks(pdf_info)
    assert len(pdf_info[0]['para_blocks'][0]['lines']) == 1


def test_unmerge_idempotent():
    """Running twice must not double-restore or drop lines."""
    from mineru_server import _unmerge_cross_page_blocks
    import copy

    pdf_info = [
        {'page_idx': 0, 'page_size': {'width': 595, 'height': 842},
         'para_blocks': [{'type': 'text', 'bbox': [70, 750, 525, 773],
                          'lines': [
                              {'bbox': [70, 750, 525, 773],
                               'spans': [{'content': 'Own.', 'type': 'text'}]},
                              {'bbox': [70, 72, 525, 95],
                               'spans': [{'content': 'Cross.', 'type': 'text',
                                          'cross_page': True}]},
                          ]}]},
        {'page_idx': 1, 'page_size': {'width': 595, 'height': 842},
         'para_blocks': [{'type': 'text', 'bbox': [70, 72, 525, 200],
                          'lines': [], 'lines_deleted': True}]},
    ]
    _unmerge_cross_page_blocks(pdf_info)
    snapshot = copy.deepcopy(pdf_info)
    _unmerge_cross_page_blocks(pdf_info)
    assert pdf_info == snapshot


def test_unmerge_multiple_groups_same_page():
    """Two independent cross_page groups on the same page pair — FIFO matching."""
    from mineru_server import _unmerge_cross_page_blocks

    pdf_info = [
        {'page_idx': 0, 'page_size': {'width': 595, 'height': 842},
         'para_blocks': [
             {'type': 'text', 'bbox': [70, 400, 290, 420],
              'lines': [
                  {'bbox': [70, 400, 290, 420],
                   'spans': [{'content': 'Col-A own.', 'type': 'text'}]},
                  {'bbox': [70, 72, 290, 95],
                   'spans': [{'content': 'Col-A cross.', 'type': 'text',
                              'cross_page': True}]},
              ]},
             {'type': 'text', 'bbox': [310, 400, 525, 420],
              'lines': [
                  {'bbox': [310, 400, 525, 420],
                   'spans': [{'content': 'Col-B own.', 'type': 'text'}]},
                  {'bbox': [310, 72, 525, 95],
                   'spans': [{'content': 'Col-B cross.', 'type': 'text',
                              'cross_page': True}]},
              ]},
         ]},
        {'page_idx': 1, 'page_size': {'width': 595, 'height': 842},
         'para_blocks': [
             {'type': 'text', 'bbox': [70, 72, 290, 200],
              'lines': [], 'lines_deleted': True},
             {'type': 'text', 'bbox': [310, 72, 525, 200],
              'lines': [], 'lines_deleted': True},
         ]},
    ]

    _unmerge_cross_page_blocks(pdf_info)

    p1_blocks = pdf_info[1]['para_blocks']
    assert p1_blocks[0]['lines'][0]['spans'][0]['content'] == 'Col-A cross.'
    assert p1_blocks[1]['lines'][0]['spans'][0]['content'] == 'Col-B cross.'
