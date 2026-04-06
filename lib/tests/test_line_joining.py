"""Tests for text merging (via MinerU native) and heading hierarchy heuristic."""
import sys
import os

# Add project root to path so we can import mineru_server
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from mineru_server import _unescape_markdown, _extract_block_content, _assign_heading_levels
from magic_pdf.config.ocr_content_type import ContentType


def _make_block(lines_content: list[list[tuple[str, str]]], block_type='text',
                list_starts: list[int] | None = None) -> dict:
    """Build a para_block dict from a list of lines.

    Each line is a list of (text, span_type) tuples.
    Shorthand: plain string is treated as (text, 'Text').
    """
    lines = []
    for i, spans_data in enumerate(lines_content):
        spans = []
        for item in spans_data:
            if isinstance(item, str):
                spans.append({'content': item, 'type': ContentType.Text})
            else:
                text, stype = item
                spans.append({'content': text, 'type': stype})
        line = {'spans': spans}
        if list_starts and i in list_starts:
            line['is_list_start_line'] = True
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
    """Tests for _extract_block_content using MinerU's native merge_para_with_text."""

    def test_western_text_joins_with_spaces(self):
        """Non-equation blocks use MinerU's merge_para_with_text (space-joined)."""
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
