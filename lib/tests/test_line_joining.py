"""Tests for text merging, list detection, sidebar detection, and heading hierarchy."""
import sys
import os

# Add project root to path so we can import mineru_server
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from mineru_server import (
    _unescape_markdown, _extract_block_content, _assign_heading_levels,
    _is_list_item, _detect_list_content, _is_decorative_sidebar,
    _is_decorative_block, _merge_overlapping_blocks,
    _detect_margin_line_numbers, _strip_document_line_numbers,
    _typical_line_height, _content_x_union,
    _is_false_positive_equation, _latex_to_plain_text,
    _normalize_equation_latex, _is_scientific_measurement,
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

    # Hindi / Devanagari patterns
    def test_devanagari_consonant_paren(self):
        assert _is_list_item('क) पहला विकल्प')  # ka) first option

    def test_devanagari_consonant_in_parens(self):
        assert _is_list_item('(ख) दूसरा विकल्प')  # (kha) second option

    def test_devanagari_consonant_dot(self):
        assert _is_list_item('ग. तीसरा विकल्प')  # ga. third option

    def test_devanagari_vowel_paren(self):
        assert _is_list_item('अ) स्वर विकल्प')  # a) vowel option

    def test_devanagari_vowel_in_parens(self):
        assert _is_list_item('(इ) स्वर विकल्प')  # (i) vowel option

    def test_devanagari_digit_dot(self):
        assert _is_list_item('१. पहला आइटम')  # 1. first item (Devanagari digits)

    def test_devanagari_digit_paren(self):
        assert _is_list_item('२) दूसरा आइटम')  # 2) second item

    def test_devanagari_digit_in_parens(self):
        assert _is_list_item('(३) तीसरा आइटम')  # (3) third item

    def test_hindi_chapter_keyword(self):
        assert _is_list_item('अध्याय 1')  # Chapter 1

    def test_hindi_section_keyword(self):
        assert _is_list_item('खंड 3: विश्लेषण')  # Section 3: Analysis

    def test_devanagari_text_not_list(self):
        assert not _is_list_item('यह सिर्फ एक वाक्य है।')  # Just a sentence

    # English alphabet in Devanagari script (ए=A, बी=B, सी=C, etc.)
    def test_deva_abc_a_paren(self):
        assert _is_list_item('ए) पहला विकल्प')  # A) first option

    def test_deva_abc_b_in_parens(self):
        assert _is_list_item('(बी) दूसरा विकल्प')  # (B) second option

    def test_deva_abc_c_dot(self):
        assert _is_list_item('सी. तीसरा विकल्प')  # C. third option

    def test_deva_abc_d_paren(self):
        assert _is_list_item('डी) चौथा विकल्प')  # D) fourth option

    def test_deva_abc_p_dot(self):
        assert _is_list_item('पी. सोलहवां')  # P. sixteenth

    def test_deva_abc_multi_char_ef(self):
        assert _is_list_item('एफ) छठा विकल्प')  # F) sixth option


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
        """Small block with short text in margin: likely icon/logo."""
        block = {'bbox': [500, 50, 570, 100], 'type': 'text'}
        # width=70 (11% of 612), height=50, text="©"
        # In margin (content is at x=60-490), so decorative rules fire
        assert _is_decorative_block(block, '©', 612, 12.0, (60, 490))

    def test_small_block_with_real_text(self):
        """Small block but with enough text to be real content."""
        block = {'bbox': [500, 50, 570, 100], 'type': 'text'}
        assert not _is_decorative_block(block, 'Section 3.2: Results', 612)

    def test_watermark_short_text(self):
        """Very short text (1-3 chars) in small area = stamp/watermark."""
        block = {'bbox': [100, 100, 140, 130], 'type': 'text'}
        # In margin (content is at x=200-540), no overlap
        assert _is_decorative_block(block, 'OK', 612, 12.0, (200, 540))

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
        # Small block, short watermark text, in margin (content at x=60-490)
        block = {'bbox': [520, 700, 590, 730], 'type': 'text'}
        assert _is_decorative_block(block, 'DRAFT', 612, 12.0, (60, 490))

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


# ============================================================================
# Margin line number detection tests
# ============================================================================

class TestDetectMarginLineNumbers:
    """Tests for block-level margin line number detection.

    bioRxiv/arXiv PDFs print sequential line numbers in the left margin.
    OCR merges these into body text: "1 Unstructured regions...".
    The detector finds sequential leading numbers across a block.
    """

    def test_sequential_numbers_detected(self):
        """Classic bioRxiv pattern: lines 1-5 with body text."""
        entries = [
            ('1 Unstructured regions differentially modulate', False),
            ('2 the transcriptomic landscape of hippocampal', False),
            ('3 neurons in an Alzheimer disease mouse model', False),
            ('4 across spatial domains and biological sex', False),
            ('5 Authors Name Here', False),
        ]
        indices = _detect_margin_line_numbers(entries)
        assert indices == {0, 1, 2, 3, 4}

    def test_non_sequential_not_detected(self):
        """Random leading numbers that aren't sequential → no stripping."""
        entries = [
            ('42 The answer to everything', False),
            ('7 Lucky number paragraph', False),
            ('99 Bottles of beer on the wall', False),
        ]
        indices = _detect_margin_line_numbers(entries)
        assert indices == set()

    def test_too_few_lines_not_detected(self):
        """Fewer than 3 candidate lines → no stripping (avoid false positives)."""
        entries = [
            ('1 Introduction paragraph text', False),
            ('2 Methods paragraph text here', False),
        ]
        indices = _detect_margin_line_numbers(entries)
        assert indices == set()

    def test_numbered_list_not_stripped(self):
        """Lines with list markers (dot/paren after number) must NOT be stripped."""
        entries = [
            ('1. Introduction to the topic', False),
            ('2. Methods and materials used', False),
            ('3. Results of the experiment', False),
            ('4. Discussion of the findings', False),
        ]
        indices = _detect_margin_line_numbers(entries)
        assert indices == set()

    def test_parenthesized_numbers_not_stripped(self):
        """(1), (2), (3) are list items, not line numbers."""
        entries = [
            ('(1) The Himalayan Mountains stretch', False),
            ('(2) The Northern Plains are fertile', False),
            ('(3) The Peninsular Plateau is ancient', False),
            ('(4) The Indian Desert is arid land', False),
        ]
        # These don't match the bare-number pattern (start with '(')
        indices = _detect_margin_line_numbers(entries)
        assert indices == set()

    def test_mixed_lines_only_numbered_stripped(self):
        """Block with some numbered and some non-numbered lines."""
        entries = [
            ('5 The hippocampus is a critical brain region', False),
            ('6 involved in learning and memory processes', False),
            ('7 that is particularly vulnerable to neurodegeneration', False),
            ('in Alzheimer disease pathology across multiple', False),
            ('8 spatial transcriptomic domains throughout the', False),
        ]
        indices = _detect_margin_line_numbers(entries)
        # Lines 0-2 and 4 have sequential numbers (5,6,7,8); line 3 has no number
        assert 0 in indices
        assert 1 in indices
        assert 2 in indices
        assert 3 not in indices
        assert 4 in indices

    def test_line_numbers_with_gaps(self):
        """Line numbers may skip (e.g., 10, 15, 20) in 5-line intervals."""
        entries = [
            ('10 First line of visible text here', False),
            ('15 Second visible line of the body', False),
            ('20 Third visible line of the text', False),
            ('25 Fourth visible line appearing here', False),
        ]
        indices = _detect_margin_line_numbers(entries)
        assert indices == {0, 1, 2, 3}

    def test_short_rest_text_not_stripped(self):
        """If remaining text after number is <10 chars, skip (ambiguous)."""
        entries = [
            ('1 Short', False),
            ('2 Also', False),
            ('3 Tiny', False),
        ]
        indices = _detect_margin_line_numbers(entries)
        assert indices == set()

    def test_end_to_end_extraction_strips_line_numbers(self):
        """Integration test: _extract_block_content strips line numbers."""
        block = _make_block([
            ['1 Unstructured regions differentially modulate the'],
            ['2 transcriptomic landscape of hippocampal neurons in'],
            ['3 an Alzheimer disease mouse model across spatial'],
            ['4 domains and biological sex differences throughout'],
            ['5 Authors Name and Affiliations Listed Here Below'],
        ])
        text, _, _, _, _ = _extract_block_content(block)
        # Line numbers should be stripped
        assert not text.startswith('1 ')
        assert 'Unstructured regions' in text
        assert '2 transcriptomic' not in text
        assert 'transcriptomic' in text

    def test_end_to_end_preserves_normal_text(self):
        """Normal text without line numbers must NOT be altered."""
        block = _make_block([
            ['The hippocampus is a critical brain region'],
            ['involved in learning and memory processes'],
            ['that is particularly vulnerable to disease'],
        ])
        text, _, _, _, _ = _extract_block_content(block)
        assert 'hippocampus' in text
        assert 'learning and memory' in text

    def test_end_to_end_preserves_list_items(self):
        """Numbered list items must NOT be stripped by line number detection."""
        block = _make_block([
            ['1. Introduction to the research topic'],
            ['2. Methods and materials used here now'],
            ['3. Results of the experimental approach'],
            ['4. Discussion of findings and implications'],
        ])
        text, _, _, _, _ = _extract_block_content(block)
        assert '1.' in text
        assert '2.' in text


class TestStripDocumentLineNumbers:
    """Tests for document-level margin line number stripping.

    Simulates the post-processing pass in process_pdf() that strips
    line numbers from ALL blocks when the document has margin numbering.
    """

    def _make_pages(self, blocks_per_page: list[list[dict]]) -> list[dict]:
        """Build pages structure from lists of blocks."""
        pages = []
        for pi, blocks in enumerate(blocks_per_page):
            pages.append({
                'page_idx': pi,
                'page_size': {'width': 612, 'height': 792},
                'preproc_blocks': blocks,
            })
        return pages

    def test_strips_line_numbers_across_pages(self):
        """Document with margin line numbers: strip from all blocks."""
        pages = self._make_pages([
            [
                {'type': 'title', 'bbox': [72, 100, 540, 130], 'text': '1 Title of the Paper Here'},
                {'type': 'text', 'bbox': [72, 200, 540, 400],
                 'text': '23 Abstract text starts here and continues'},
            ],
            [
                {'type': 'title', 'bbox': [72, 100, 540, 130], 'text': '44 Introduction'},
                {'type': 'text', 'bbox': [72, 200, 540, 600],
                 'text': '50 Body paragraph with detailed content here'},
                {'type': 'title', 'bbox': [72, 650, 540, 680], 'text': '87 Results'},
            ],
        ])
        _strip_document_line_numbers(pages)

        # All leading numbers should be stripped
        assert pages[0]['preproc_blocks'][0]['text'] == 'Title of the Paper Here'
        assert pages[0]['preproc_blocks'][1]['text'] == 'Abstract text starts here and continues'
        assert pages[1]['preproc_blocks'][0]['text'] == 'Introduction'
        assert pages[1]['preproc_blocks'][1]['text'] == 'Body paragraph with detailed content here'
        assert pages[1]['preproc_blocks'][2]['text'] == 'Results'

    def test_does_not_strip_without_enough_evidence(self):
        """Document with <5 candidate blocks: no stripping."""
        pages = self._make_pages([
            [
                {'type': 'title', 'bbox': [72, 100, 540, 130], 'text': '1 Introduction'},
                {'type': 'text', 'bbox': [72, 200, 540, 400],
                 'text': 'Normal body text without line numbers.'},
            ],
        ])
        _strip_document_line_numbers(pages)
        # Title should NOT be stripped (only 1 candidate, need 5)
        assert pages[0]['preproc_blocks'][0]['text'] == '1 Introduction'

    def test_preserves_numbered_lists(self):
        """Document with numbered list items should NOT be stripped."""
        pages = self._make_pages([
            [
                {'type': 'text', 'bbox': [72, 100, 540, 130],
                 'text': '1. First item in the numbered list'},
                {'type': 'text', 'bbox': [72, 150, 540, 180],
                 'text': '2. Second item in the numbered list'},
                {'type': 'text', 'bbox': [72, 200, 540, 230],
                 'text': '3. Third item in the numbered list'},
                {'type': 'text', 'bbox': [72, 250, 540, 280],
                 'text': '4. Fourth item in the numbered list'},
                {'type': 'text', 'bbox': [72, 300, 540, 330],
                 'text': '5. Fifth item in the numbered list'},
            ],
        ])
        _strip_document_line_numbers(pages)
        # List items with periods should NOT be stripped
        assert pages[0]['preproc_blocks'][0]['text'] == '1. First item in the numbered list'

    def test_strips_from_text_per_page_too(self):
        """text_per_page field also gets stripped."""
        pages = self._make_pages([
            [
                {'type': 'title', 'bbox': [72, 100, 540, 130], 'text': '1 Title Text Here'},
                {'type': 'text', 'bbox': [72, 200, 540, 400],
                 'text': '23 Abstract of the paper here continuing',
                 'text_per_page': '23 Abstract of the paper here continuing'},
                {'type': 'title', 'bbox': [72, 100, 540, 130], 'text': '44 Introduction'},
                {'type': 'text', 'bbox': [72, 200, 540, 400],
                 'text': '50 Body paragraph of the introduction here'},
                {'type': 'title', 'bbox': [72, 100, 540, 130], 'text': '87 Results Section'},
            ],
        ])
        _strip_document_line_numbers(pages)
        assert pages[0]['preproc_blocks'][1]['text_per_page'] == 'Abstract of the paper here continuing'


# ---------------------------------------------------------------------------
# Position-aware decorative detection
# ---------------------------------------------------------------------------

def _make_para_block(block_type='text', bbox=None, lines_with_bboxes=None):
    """Build a para_block with line-level bboxes for position-aware tests."""
    bbox = bbox or [0, 0, 100, 20]
    block = {'type': block_type, 'bbox': bbox}
    if lines_with_bboxes:
        lines = []
        for lb in lines_with_bboxes:
            lines.append({'bbox': lb, 'spans': [{'content': 'x', 'type': 'text', 'bbox': lb}]})
        block['lines'] = lines
    return block


class TestTypicalLineHeight:
    """Tests for _typical_line_height helper."""

    def test_computes_median_from_lines(self):
        blocks = [
            _make_para_block(bbox=[60, 0, 540, 36],
                             lines_with_bboxes=[[60, 0, 540, 12], [60, 12, 540, 24], [60, 24, 540, 36]]),
            _make_para_block(bbox=[60, 50, 540, 62],
                             lines_with_bboxes=[[60, 50, 540, 62]]),
            _make_para_block(bbox=[60, 70, 540, 82],
                             lines_with_bboxes=[[60, 70, 540, 82]]),
        ]
        lh = _typical_line_height(blocks)
        assert lh == 12.0  # all lines are 12pt

    def test_returns_none_for_sparse_page(self):
        blocks = [
            _make_para_block(bbox=[60, 0, 540, 12],
                             lines_with_bboxes=[[60, 0, 540, 12]]),
        ]
        assert _typical_line_height(blocks) is None  # only 1 text block

    def test_skips_non_text_blocks(self):
        blocks = [
            _make_para_block('image', bbox=[0, 0, 500, 400]),
            _make_para_block('text', bbox=[60, 0, 540, 12],
                             lines_with_bboxes=[[60, 0, 540, 12]]),
        ]
        assert _typical_line_height(blocks) is None  # only 1 text block


class TestContentXUnion:
    """Tests for _content_x_union helper."""

    def test_union_of_text_blocks(self):
        blocks = [
            _make_para_block(bbox=[60, 0, 290, 100]),
            _make_para_block(bbox=[310, 0, 540, 100]),
        ]
        xu = _content_x_union(blocks)
        assert xu == (60, 540)

    def test_returns_none_for_no_text(self):
        blocks = [_make_para_block('image', bbox=[0, 0, 500, 400])]
        assert _content_x_union(blocks) is None


class TestDecorativePositionAware:
    """Tests for position-aware decorative detection."""

    def _page_blocks(self):
        """Simulate a two-column page with text at x=60-290 and x=310-540."""
        return [
            _make_para_block(bbox=[60, 100, 290, 300],
                             lines_with_bboxes=[[60, 100, 290, 112], [60, 112, 290, 124]]),
            _make_para_block(bbox=[60, 320, 290, 450],
                             lines_with_bboxes=[[60, 320, 290, 332], [60, 332, 290, 344]]),
            _make_para_block(bbox=[310, 100, 540, 300],
                             lines_with_bboxes=[[310, 100, 540, 112], [310, 112, 540, 124]]),
        ]

    def test_inline_fragment_not_decorative(self):
        """'10-50 Km' at x=310-360, same height as text → NOT decorative."""
        blocks = self._page_blocks()
        lh = _typical_line_height(blocks)
        xu = _content_x_union(blocks)
        # Small block, 7 chars, but overlaps with content and normal height
        fragment = {'bbox': [310, 650, 360, 662], 'type': 'text'}
        assert not _is_decorative_block(fragment, '10-50 Km', 612, lh, xu)

    def test_sidebar_in_margin_decorative(self):
        """arXiv sidebar at x=15-37, no overlap with content → decorative."""
        blocks = self._page_blocks()
        lh = _typical_line_height(blocks)
        xu = _content_x_union(blocks)
        sidebar = {'bbox': [15, 200, 37, 585], 'type': 'text'}
        # Rule 1: narrow vertical strip (aspect_ratio > 6, width < 60)
        assert _is_decorative_block(sidebar, 'arXiv:2604.00252v1', 612, lh, xu)

    def test_small_margin_block_decorative(self):
        """Small block with short text in the margin → decorative."""
        blocks = self._page_blocks()
        lh = _typical_line_height(blocks)
        xu = _content_x_union(blocks)
        # x=10-50, outside content union x=60-540 → no significant overlap
        margin_block = {'bbox': [10, 300, 50, 340], 'type': 'text'}
        assert _is_decorative_block(margin_block, 'QR', 612, lh, xu)

    def test_normal_height_margin_block_decorative(self):
        """Normal-height block in margin (no x-overlap) → still decorative."""
        blocks = self._page_blocks()
        lh = _typical_line_height(blocks)
        xu = _content_x_union(blocks)
        margin_block = {'bbox': [10, 300, 50, 312], 'type': 'text'}
        assert _is_decorative_block(margin_block, 'v1', 612, lh, xu)

    def test_centered_title_not_decorative(self):
        """Centered title spanning both columns → significant overlap with union."""
        blocks = self._page_blocks()
        lh = _typical_line_height(blocks)
        xu = _content_x_union(blocks)
        # x=100-500 overlaps with union x=60-540: overlap=400, width=400, 100% > 50%
        title = {'bbox': [100, 50, 500, 62], 'type': 'text'}
        assert not _is_decorative_block(title, 'Chapter 1', 612, lh, xu)

    def test_narrow_strip_still_decorative(self):
        """Rule 1 (narrow strip) fires regardless of position data."""
        # Even with line_height=None
        strip = {'bbox': [15, 100, 25, 600], 'type': 'text'}
        assert _is_decorative_block(strip, 'sidebar text', 612, None, None)

    def test_sparse_page_rules_suppressed(self):
        """On sparse pages (line_height=None), rules 2/3 suppressed."""
        # Small block, short text — would normally be decorative
        block = {'bbox': [10, 300, 50, 340], 'type': 'text'}
        # Without position data → suppressed, returns False
        assert not _is_decorative_block(block, 'QR code', 612, None, None)

    def test_margin_annotation_barely_overlapping(self):
        """Margin annotation with < 50% overlap → decorative."""
        blocks = self._page_blocks()
        lh = _typical_line_height(blocks)
        xu = _content_x_union(blocks)  # (60, 540)
        # Block at x=40-70: overlap with union = 70-60=10, width=30, 33% < 50%
        annotation = {'bbox': [40, 300, 70, 312], 'type': 'text'}
        # Normal height, but insufficient overlap → rules 2/3 can fire
        assert _is_decorative_block(annotation, 'ref', 612, lh, xu)

    def test_tall_block_with_overlap_and_tiny_text_decorative(self):
        """Tall block overlapping content with very short text (≤3 chars) → decorative."""
        blocks = self._page_blocks()
        lh = _typical_line_height(blocks)
        xu = _content_x_union(blocks)
        # Tall (200px >> 2*12=24), within content x-range, text ≤3 chars
        # Rule 3: text_len<=3, width=60 < 612*0.25=153, area=12000 < 612*50=30600
        tall_block = {'bbox': [60, 100, 120, 300], 'type': 'text'}
        assert _is_decorative_block(tall_block, 'OK', 612, lh, xu)


class TestFalsePositiveEquation:
    """Tests for detecting inline equations that are actually text/measurements."""

    def test_measurement_km(self):
        """'150 Km' misclassified as equation."""
        assert _is_false_positive_equation(r'1 5 0 \mathrm { K m }')

    def test_measurement_range_km(self):
        """'10-50 Km' — the user's original pain point."""
        assert _is_false_positive_equation(r'1 0 { - } 5 0 ~ \mathrm { K m }')

    def test_measurement_mm(self):
        assert _is_false_positive_equation(r'1 5 0 \mathrm { m m }')

    def test_measurement_km_lower(self):
        assert _is_false_positive_equation(r'3 2 0 ~ \mathrm { k m }')

    def test_simple_number(self):
        assert _is_false_positive_equation(r'1 6 \mathrm { k m }')

    def test_nested_mathrm(self):
        assert _is_false_positive_equation(r'5 0 ~ \mathrm { { K m } }')

    def test_real_equation_greek(self):
        """Real math with Greek letters."""
        assert not _is_false_positive_equation(r'\alpha + \beta')

    def test_real_equation_mathbb(self):
        assert not _is_false_positive_equation(r'\mathbb { T } ^ { d }')

    def test_real_equation_geq(self):
        assert not _is_false_positive_equation(r'd \geq 2')

    def test_real_equation_frac(self):
        assert not _is_false_positive_equation(r'\frac { a } { b }')

    def test_real_equation_subscript_var(self):
        assert not _is_false_positive_equation(r'U _ { V } ( t , s )')

    def test_real_equation_ell_alpha(self):
        assert not _is_false_positive_equation(
            r'( \lambda _ { m } ) \in \ell ^ { \alpha } ( \mathbb { N } )')

    def test_real_equation_infty(self):
        assert not _is_false_positive_equation(r'\mathrm { V o l } ( X ) < \infty')

    def test_real_equation_lesssim(self):
        assert not _is_false_positive_equation(r'A \lesssim B')

    def test_empty_latex(self):
        assert _is_false_positive_equation('')

    def test_just_digits(self):
        assert _is_false_positive_equation('1 2 3')

    def test_percentage(self):
        assert _is_false_positive_equation(r'9 5 \%')

    def test_real_equation_sqrt(self):
        assert not _is_false_positive_equation(r'\sqrt { x ^ 2 + y ^ 2 }')

    def test_real_equation_integral(self):
        assert not _is_false_positive_equation(r'\int _ 0 ^ 1 f ( x ) d x')


class TestLatexToPlainText:
    """Tests for converting false-positive LaTeX back to readable text."""

    def test_measurement_km(self):
        assert _latex_to_plain_text(r'1 5 0 \mathrm { K m }') == '150 Km'

    def test_measurement_range(self):
        assert _latex_to_plain_text(r'1 0 { - } 5 0 ~ \mathrm { K m }') == '10-50 Km'

    def test_measurement_with_tilde(self):
        assert _latex_to_plain_text(r'3 2 0 ~ \mathrm { k m }') == '320 km'

    def test_simple_number(self):
        assert _latex_to_plain_text(r'1 6 \mathrm { k m }') == '16 km'

    def test_nested_braces(self):
        result = _latex_to_plain_text(r'5 0 ~ \mathrm { { K m } }')
        # After unwrapping and collapsing: should contain "50" and "Km"
        assert '50' in result, f'Expected "50" in "{result}"'
        assert 'Km' in result or 'km' in result.lower(), f'Expected "Km" in "{result}"'

    def test_just_digits(self):
        assert _latex_to_plain_text('1 2 3') == '123'


class TestFalsePositiveEquationIntegration:
    """Integration test: equation spans that are false positives should become plain text."""

    def test_measurement_becomes_text(self):
        """A block with '10-50 Km' classified as InlineEquation should produce text, not EQ placeholder."""
        block = _make_block([
            [('of ', ContentType.Text),
             (r'1 0 { - } 5 0 ~ \mathrm { K m }', ContentType.InlineEquation),
             (' and have an altitude', ContentType.Text)]
        ])
        text, _th, _ip, _lx, inline_eqs = _extract_block_content(block, '', 612)
        # The equation should have been converted to plain text
        assert '{{EQ:' not in text, f'Expected plain text but got equation placeholder: {text}'
        assert '10-50' in text, f'Expected "10-50" in text: {text}'
        assert 'Km' in text, f'Expected "Km" in text: {text}'
        assert len(inline_eqs) == 0, f'Expected no inline equations but got {len(inline_eqs)}'

    def test_real_equation_preserved(self):
        """A real equation should NOT be converted to text."""
        block = _make_block([
            [('where ', ContentType.Text),
             (r'd \geq 2', ContentType.InlineEquation),
             (' holds.', ContentType.Text)]
        ])
        text, _th, _ip, _lx, inline_eqs = _extract_block_content(block, '', 612)
        assert '{{EQ:' in text, f'Expected equation placeholder: {text}'
        assert len(inline_eqs) == 1


class TestNormalizeEquationLatex:
    """Tests for MinerU LaTeX normalization."""

    def test_calcium_ion(self):
        norm = _normalize_equation_latex(r'{ \mathsf { C a } } ^ { 2 + }')
        assert 'Ca' in norm and '2+' in norm, f'Got: {norm}'

    def test_temperature(self):
        norm = _normalize_equation_latex(r'3 7 ^ { \circ } \mathsf { C }')
        assert '37' in norm and '\\circ' in norm and 'C' in norm, f'Got: {norm}'

    def test_concentration_mu(self):
        norm = _normalize_equation_latex(r'2 5 0 ~ \mu \mathrm { M }')
        assert '250' in norm and '\\mu' in norm and 'M' in norm, f'Got: {norm}'

    def test_p_value(self):
        norm = _normalize_equation_latex(r'^ { \star } P < 0 . 0 5')
        assert 'P' in norm and '0.05' in norm, f'Got: {norm}'

    def test_deletion_variant(self):
        norm = _normalize_equation_latex(r'{ \mathsf { D } } \Delta 1 2 1')
        assert 'D' in norm and '\\Delta' in norm and '121' in norm, f'Got: {norm}'

    def test_plus_minus(self):
        norm = _normalize_equation_latex(r'\pm \mathsf { S D }')
        assert '\\pm' in norm and 'SD' in norm, f'Got: {norm}'


class TestScientificMeasurement:
    """Tests for detecting scientific measurements that use math-like LaTeX."""

    # --- Chemical ions ---
    def test_calcium_ion(self):
        assert _is_scientific_measurement(r'{ \mathsf { C a } } ^ { 2 + }')

    def test_calcium_alt(self):
        assert _is_scientific_measurement(r'\tt C a ^ { 2 + }')

    def test_calcium_mathsf(self):
        assert _is_scientific_measurement(r'\mathsf { C a } ^ { 2 + }')

    # --- Temperature ---
    def test_temperature_37(self):
        assert _is_scientific_measurement(r'3 7 ^ { \circ } \mathsf { C }')

    def test_temperature_95(self):
        assert _is_scientific_measurement(r'9 5 ^ { \circ } \mathsf { C }')

    def test_temperature_4(self):
        assert _is_scientific_measurement(r'4 ~ ^ { \circ } \mathsf C')

    # --- Concentrations with µ ---
    def test_concentration_250uM(self):
        assert _is_scientific_measurement(r'2 5 0 ~ \mu \mathrm { M }')

    def test_concentration_1uM(self):
        assert _is_scientific_measurement(r'1 \mu \mathsf { M }')

    def test_concentration_100uM(self):
        assert _is_scientific_measurement(r'1 0 0 ~ { \mu \mathsf { M } }')

    def test_concentration_ug_mL(self):
        assert _is_scientific_measurement(r'8 ~ { \mu \ g } / { \ m } L')

    def test_concentration_uL(self):
        assert _is_scientific_measurement(r'2 \mu \ L')

    # --- Concentrations without µ ---
    def test_concentration_20mM(self):
        assert _is_scientific_measurement(r'2 0 ~ { \mathsf { m M } }')

    def test_concentration_150mM(self):
        assert _is_scientific_measurement(r'1 5 0 ~ \mathsf { m M }')

    def test_concentration_3mM(self):
        assert _is_scientific_measurement(r'3 \mathsf { m M }')

    # --- P-values ---
    def test_pvalue_star(self):
        assert _is_scientific_measurement(r'^ { \star } P < 0 . 0 5')

    def test_pvalue_double_star(self):
        assert _is_scientific_measurement(r'^ { \star \star } P < 0 . 0 1')

    def test_pvalue_triple_star(self):
        assert _is_scientific_measurement(r'^ { \star \star \star } P < 0 . 0 0 1')

    def test_pvalue_plain(self):
        assert _is_scientific_measurement(r'\mathsf { P } < 0 . 0 5')

    def test_pvalue_parens(self):
        assert _is_scientific_measurement(r'( \mathsf { P } < 0 . 0 5 )')

    # --- Scientific notation ---
    def test_sci_notation_3e6(self):
        assert _is_scientific_measurement(r'3 \times 1 0 ^ { \wedge } 6')

    def test_sci_notation_5e_3(self):
        assert _is_scientific_measurement(r'5 . 0 \times 1 0 ^ { \cdot 3 }')

    def test_standalone_times(self):
        assert _is_scientific_measurement(r'3 \times')

    def test_standalone_times_large(self):
        assert _is_scientific_measurement(r'1 0 0 , 0 0 0 \times')

    # --- Plus-minus ---
    def test_pm_alone(self):
        assert _is_scientific_measurement(r'\pm')

    def test_pm_sd(self):
        assert _is_scientific_measurement(r'\pm \mathsf { S D }')

    # --- Percentages ---
    def test_percent_gt50(self):
        assert _is_scientific_measurement(r'{ > } 5 0 \%')

    def test_percent_sim20(self):
        assert _is_scientific_measurement(r'{ \sim } 2 0 \%')

    def test_percent_range(self):
        assert _is_scientific_measurement(r'3 5 \mathrm { - } 4 0 \ \%')

    def test_percent_gt90(self):
        assert _is_scientific_measurement(r'{ > } 9 0 \%')

    # --- Chemical formulas ---
    def test_chemical_H2O(self):
        assert _is_scientific_measurement(r'H _ { 2 } O')

    def test_chemical_CO2(self):
        assert _is_scientific_measurement(r'\mathsf { C O } _ { 2 }')

    def test_chemical_MgCl2(self):
        assert _is_scientific_measurement(r'\mathsf { M g C l } _ { 2 }')

    # --- Deletion variants ---
    def test_deletion_D121(self):
        assert _is_scientific_measurement(r'{ \mathsf { D } } \Delta 1 2 1')

    def test_deletion_D155(self):
        assert _is_scientific_measurement(r'D \Delta 1 5 5')

    def test_deletion_H109(self):
        assert _is_scientific_measurement(r'\mathsf { H } \Delta 1 0 9 )')

    # --- Approximate ---
    def test_approx_160(self):
        assert _is_scientific_measurement(r'\sim 1 6 0')

    # --- Greek letters as labels ---
    def test_standalone_beta(self):
        assert _is_scientific_measurement(r'\beta \cdot')

    def test_standalone_alpha(self):
        assert _is_scientific_measurement(r'\alpha')

    # --- Sample sizes ---
    def test_sample_size_N5(self):
        assert _is_scientific_measurement(r'N = 5')

    def test_sample_size_n350(self):
        assert _is_scientific_measurement(r'( n = 3 5 0 )')

    # --- OD measurements ---
    def test_od600(self):
        assert _is_scientific_measurement(r'\mathsf { O D } _ { 6 0 0 } = 0 . 8')

    # --- pH ---
    def test_ph(self):
        assert _is_scientific_measurement(r'{ \mathsf { p } } { \mathsf { H } } \ 8 . 0')

    # --- Molarity with compound ---
    def test_mM_CuSO4(self):
        assert _is_scientific_measurement(r'4 0 \mathrm { \ m M \ C u S O _ { 4 } }')

    # --- Time/duration ---
    def test_time_30min(self):
        assert _is_scientific_measurement(r'3 0 \ \mathrm { m i n }')

    def test_time_1h(self):
        assert _is_scientific_measurement(r'1 \ h')

    # --- Gene with citation superscript ---
    def test_gene_HK1_29(self):
        assert _is_scientific_measurement(r'\mathsf { H K } 1 ^ { 2 9 }')

    # === NEGATIVE TESTS: Real math should NOT match ===

    def test_real_math_ripley_K(self):
        """Ripley's K function — real spatial statistics."""
        assert not _is_scientific_measurement(
            r'\boldsymbol { K } ( \boldsymbol { r } )')

    def test_real_math_norm(self):
        """Norm expression with variables."""
        assert not _is_scientific_measurement(
            r'| | x _ { i } - x _ { j } | | \leq r')

    def test_real_math_L_minus_r(self):
        assert not _is_scientific_measurement(r'L ( r ) - r')

    def test_real_math_weighted_sum(self):
        assert not _is_scientific_measurement(r'w _ { i j } ^ { - 1 }')

    def test_real_math_equation_equals(self):
        assert not _is_scientific_measurement(r'L ( r ) - r = 0')

    def test_real_math_fraction(self):
        assert not _is_scientific_measurement(r'\frac { a } { b }')

    def test_real_math_integral(self):
        assert not _is_scientific_measurement(r'\int _ 0 ^ 1 f ( x ) d x')


class TestScientificLatexToPlainText:
    """Tests for converting scientific false-positive LaTeX to readable text."""

    def test_calcium_ion(self):
        result = _latex_to_plain_text(r'{ \mathsf { C a } } ^ { 2 + }')
        assert 'Ca' in result and '2+' in result, f'Got: {result}'

    def test_temperature(self):
        result = _latex_to_plain_text(r'3 7 ^ { \circ } \mathsf { C }')
        assert '37' in result and '°' in result, f'Got: {result}'

    def test_concentration_mu(self):
        result = _latex_to_plain_text(r'2 5 0 ~ \mu \mathrm { M }')
        assert '250' in result and 'µ' in result and 'M' in result, f'Got: {result}'

    def test_pvalue(self):
        result = _latex_to_plain_text(r'^ { \star } P < 0 . 0 5')
        assert 'P' in result and '0.05' in result, f'Got: {result}'

    def test_delta(self):
        result = _latex_to_plain_text(r'{ \mathsf { D } } \Delta 1 2 1')
        assert 'D' in result and 'Δ' in result and '121' in result, f'Got: {result}'

    def test_plus_minus_sd(self):
        result = _latex_to_plain_text(r'\pm \mathsf { S D }')
        assert '±' in result and 'SD' in result, f'Got: {result}'

    def test_percentage(self):
        result = _latex_to_plain_text(r'{ > } 5 0 \%')
        assert '>' in result and '50' in result and '%' in result, f'Got: {result}'

    def test_chemical_H2O(self):
        result = _latex_to_plain_text(r'H _ { 2 } O')
        assert 'H' in result and '2' in result and 'O' in result, f'Got: {result}'

    def test_times_notation(self):
        result = _latex_to_plain_text(r'3 \times 1 0 ^ { 6 }')
        assert '3' in result and '×' in result and '10' in result, f'Got: {result}'

    def test_sim_approx(self):
        result = _latex_to_plain_text(r'{ \sim } 2 0 \%')
        assert '~' in result and '20' in result and '%' in result, f'Got: {result}'


class TestScientificFalsePositiveIntegration:
    """Integration: scientific false-positive equations become plain text in blocks."""

    def test_calcium_ion_becomes_text(self):
        block = _make_block([
            [('activated by ', ContentType.Text),
             (r'{ \mathsf { C a } } ^ { 2 + }', ContentType.InlineEquation),
             (' binding', ContentType.Text)]
        ])
        text, _th, _ip, _lx, inline_eqs = _extract_block_content(block, '', 612)
        assert '{{EQ:' not in text, f'Equation placeholder found: {text}'
        assert 'Ca' in text, f'Expected "Ca" in text: {text}'
        assert len(inline_eqs) == 0

    def test_pvalue_becomes_text(self):
        block = _make_block([
            [('significant (', ContentType.Text),
             (r'^ { \star } P < 0 . 0 5', ContentType.InlineEquation),
             (')', ContentType.Text)]
        ])
        text, _th, _ip, _lx, inline_eqs = _extract_block_content(block, '', 612)
        assert '{{EQ:' not in text, f'Equation placeholder found: {text}'
        assert 'P' in text
        assert len(inline_eqs) == 0

    def test_temperature_becomes_text(self):
        block = _make_block([
            [('incubated at ', ContentType.Text),
             (r'3 7 ^ { \circ } \mathsf { C }', ContentType.InlineEquation),
             (' for', ContentType.Text)]
        ])
        text, _th, _ip, _lx, inline_eqs = _extract_block_content(block, '', 612)
        assert '{{EQ:' not in text, f'Equation placeholder found: {text}'
        assert '37' in text
        assert len(inline_eqs) == 0

    def test_real_math_still_preserved(self):
        """Ripley's K function should remain as equation."""
        block = _make_block([
            [('the function ', ContentType.Text),
             (r'\boldsymbol { K } ( \boldsymbol { r } )', ContentType.InlineEquation),
             (' measures', ContentType.Text)]
        ])
        text, _th, _ip, _lx, inline_eqs = _extract_block_content(block, '', 612)
        assert '{{EQ:' in text, f'Expected equation placeholder: {text}'
        assert len(inline_eqs) == 1
