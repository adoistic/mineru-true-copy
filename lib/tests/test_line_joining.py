"""Tests for _merge_block_text() — MinerU structural line joining."""
import sys
import os

# Add project root to path so we can import mineru_server
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from mineru_server import _merge_block_text, _join_visual_lines


def _make_block(lines_content: list[list[str]], list_starts: list[int] | None = None) -> dict:
    """Build a para_block dict from a list of lines, each containing span texts."""
    lines = []
    for i, spans_text in enumerate(lines_content):
        spans = [{'content': text, 'type': 'Text'} for text in spans_text]
        line = {'spans': spans}
        if list_starts and i in list_starts:
            line['is_list_start_line'] = True
        lines.append(line)
    return {'type': 'text', 'lines': lines}


class TestMergeBlockText:
    """Tests for the new structural line joining function."""

    def test_western_text_joins_with_spaces(self):
        block = _make_block([
            ['Hello, my name is'],
            ['Claude and I help'],
            ['with coding tasks.'],
        ])
        result = _merge_block_text(block)
        assert 'Hello, my name is' in result
        assert 'Claude and I help' in result
        # Lines should be joined with spaces (Western text)
        assert 'is Claude' in result or 'is  Claude' in result

    def test_hyphenated_line_end_joins_without_space(self):
        block = _make_block([
            ['trace-class opera-'],
            ['tor in Hilbert space'],
        ])
        result = _merge_block_text(block)
        # Hyphen at line end should be removed and words joined
        assert 'operator' in result

    def test_list_items_preserve_line_breaks(self):
        block = _make_block(
            [
                ['Introduction to the topic'],
                ['1. First item in the list'],
                ['2. Second item in the list'],
            ],
            list_starts=[1, 2],
        )
        result = _merge_block_text(block)
        assert '\n' in result
        assert '1. First item' in result

    def test_empty_block_returns_empty(self):
        block = {'type': 'text', 'lines': []}
        result = _merge_block_text(block)
        assert result == ''

    def test_empty_spans_handled_gracefully(self):
        block = _make_block([
            ['Some text'],
            [''],  # empty span
            ['More text'],
        ])
        result = _merge_block_text(block)
        assert 'Some text' in result
        assert 'More text' in result

    def test_single_line_block(self):
        block = _make_block([['Just one line of text.']])
        result = _merge_block_text(block)
        assert result == 'Just one line of text.'

    def test_formatting_tags_preserved(self):
        block = _make_block([
            ['The <strong>bold</strong> text'],
            ['continues with <em>italic</em> here.'],
        ])
        result = _merge_block_text(block)
        assert '<strong>bold</strong>' in result
        assert '<em>italic</em>' in result

    def test_sup_sub_tags_preserved(self):
        block = _make_block([
            ['x<sup>2</sup> + y<sup>3</sup>'],
            ['and H<sub>2</sub>O'],
        ])
        result = _merge_block_text(block)
        assert '<sup>2</sup>' in result
        assert '<sub>2</sub>' in result

    def test_fallback_when_no_lines(self):
        block = {'type': 'text', 'text': 'Fallback text content'}
        result = _merge_block_text(block)
        assert result == 'Fallback text content'

    def test_multiple_spans_per_line(self):
        block = _make_block([
            ['First span', 'second span'],
            ['Third span'],
        ])
        result = _merge_block_text(block)
        assert 'First span' in result
        assert 'second span' in result
        assert 'Third span' in result


class TestJoinVisualLinesLegacy:
    """Verify the legacy fallback still works correctly."""

    def test_basic_joining(self):
        result = _join_visual_lines(['Hello world', 'this is a test'])
        assert 'Hello world' in result
        assert 'this is a test' in result

    def test_empty_input(self):
        assert _join_visual_lines([]) == ''

    def test_single_part(self):
        assert _join_visual_lines(['Only line']) == 'Only line'

    def test_sentence_terminal_creates_break(self):
        result = _join_visual_lines(['End of sentence.', 'Start of new one'])
        assert '\n' in result

    def test_list_item_creates_break(self):
        result = _join_visual_lines(['Some text', '1. First item'])
        assert '\n' in result

    def test_hyphen_joining(self):
        result = _join_visual_lines(['opera-', 'tor'])
        assert 'operator' in result
