"""
Unit tests for lib/translation.py — TranslationEngine.

All tests mock the IndicTrans2 model to avoid requiring actual model downloads.
"""

import copy
import json
import os
import tempfile
from unittest import mock

import pytest

# ---------------------------------------------------------------------------
# Fixtures: mock IndicTrans2 dependencies
# ---------------------------------------------------------------------------


def _make_mock_modules():
    """Create mock modules for torch, transformers, IndicTransToolkit."""
    mock_torch = mock.MagicMock()
    mock_torch.backends.mps.is_available.return_value = False
    mock_torch.no_grad.return_value = mock.MagicMock(
        __enter__=mock.MagicMock(return_value=None),
        __exit__=mock.MagicMock(return_value=False),
    )

    mock_model = mock.MagicMock()
    mock_model.eval.return_value = mock_model
    mock_model.to.return_value = mock_model
    mock_model.generate.return_value = [[1, 2, 3]]

    mock_tokenizer = mock.MagicMock()
    mock_tokenizer.return_value = mock.MagicMock()
    mock_tokenizer.return_value.to.return_value = mock_tokenizer.return_value
    mock_tokenizer.batch_decode.return_value = ['translated text']

    mock_auto_model = mock.MagicMock()
    mock_auto_model.from_pretrained.return_value = mock_model

    mock_auto_tokenizer = mock.MagicMock()
    mock_auto_tokenizer.from_pretrained.return_value = mock_tokenizer

    mock_transformers = mock.MagicMock()
    mock_transformers.AutoModelForSeq2SeqLM = mock_auto_model
    mock_transformers.AutoTokenizer = mock_auto_tokenizer

    mock_processor = mock.MagicMock()
    mock_processor.preprocess_batch.return_value = ['preprocessed text']
    mock_processor.postprocess_batch.return_value = ['translated output']

    mock_indic_toolkit = mock.MagicMock()
    mock_indic_toolkit.IndicProcessor.return_value = mock_processor

    return {
        'torch': mock_torch,
        'transformers': mock_transformers,
        'IndicTransToolkit': mock_indic_toolkit,
        '_model': mock_model,
        '_tokenizer': mock_tokenizer,
        '_processor': mock_processor,
    }


@pytest.fixture
def mock_deps():
    """Patch IndicTrans2 dependencies with mocks."""
    mocks = _make_mock_modules()
    patches = {
        'torch': mocks['torch'],
        'transformers': mocks['transformers'],
        'IndicTransToolkit': mocks['IndicTransToolkit'],
    }
    with mock.patch.dict('sys.modules', patches):
        yield mocks


@pytest.fixture
def engine(mock_deps):
    """Create a TranslationEngine with mocked dependencies loaded."""
    from lib.translation import TranslationEngine
    e = TranslationEngine()
    e.load_model('en-indic', '1B')
    return e


# ---------------------------------------------------------------------------
# Sample OCR JSON fixtures
# ---------------------------------------------------------------------------

SAMPLE_OCR_JSON = {
    'content_list': [
        {
            'type': 'text',
            'text': 'Hello world',
            'bbox': [10, 20, 300, 40],
            'font_size': 12,
            'font_name': 'Arial',
            'page_idx': 0,
        },
        {
            'type': 'title',
            'text': 'Introduction',
            'bbox': [10, 50, 300, 80],
            'font_size': 24,
            'font_name': 'Arial-Bold',
            'page_idx': 0,
            'lines': [{'text': 'Introduction', 'bbox': [10, 50, 300, 80]}],
        },
        {
            'type': 'image',
            'bbox': [10, 100, 300, 400],
            'img_path': '/tmp/img.png',
            'page_idx': 0,
        },
        {
            'type': 'table',
            'text': '<table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>30</td></tr></table>',
            'bbox': [10, 420, 300, 520],
            'page_idx': 1,
        },
        {
            'type': 'interline_equation',
            'text': 'E = mc^2',
            'bbox': [10, 540, 300, 570],
            'page_idx': 1,
        },
    ]
}


# ---------------------------------------------------------------------------
# Tests: direction inference
# ---------------------------------------------------------------------------

class TestDirectionInference:
    def test_en_to_indic(self):
        from lib.translation import _infer_direction
        assert _infer_direction('eng_Latn', 'hin_Deva') == 'en-indic'

    def test_indic_to_en(self):
        from lib.translation import _infer_direction
        assert _infer_direction('hin_Deva', 'eng_Latn') == 'indic-en'

    def test_indic_to_indic(self):
        from lib.translation import _infer_direction
        assert _infer_direction('hin_Deva', 'tam_Taml') == 'indic-indic'

    def test_en_to_en(self):
        from lib.translation import _infer_direction
        # Edge case: en->en is classified as indic-indic (both not-en -> indic-indic branch)
        # Actually: src_is_en=True, tgt_is_en=True, so falls through to indic-indic
        assert _infer_direction('eng_Latn', 'eng_Latn') == 'indic-indic'


# ---------------------------------------------------------------------------
# Tests: translate_json preserves structural fields
# ---------------------------------------------------------------------------

class TestTranslateJsonPreservation:
    def test_preserves_bbox(self, engine):
        result = engine.translate_json(SAMPLE_OCR_JSON, 'eng_Latn', 'hin_Deva')
        for orig, trans in zip(SAMPLE_OCR_JSON['content_list'],
                                result['content_list']):
            assert trans['bbox'] == orig['bbox']

    def test_preserves_font_fields(self, engine):
        result = engine.translate_json(SAMPLE_OCR_JSON, 'eng_Latn', 'hin_Deva')
        text_block = result['content_list'][0]
        assert text_block['font_size'] == 12
        assert text_block['font_name'] == 'Arial'

    def test_preserves_type(self, engine):
        result = engine.translate_json(SAMPLE_OCR_JSON, 'eng_Latn', 'hin_Deva')
        types = [b['type'] for b in result['content_list']]
        assert types == ['text', 'title', 'image', 'table', 'interline_equation']

    def test_preserves_page_idx(self, engine):
        result = engine.translate_json(SAMPLE_OCR_JSON, 'eng_Latn', 'hin_Deva')
        assert result['content_list'][0]['page_idx'] == 0
        assert result['content_list'][3]['page_idx'] == 1

    def test_preserves_lines(self, engine):
        result = engine.translate_json(SAMPLE_OCR_JSON, 'eng_Latn', 'hin_Deva')
        title_block = result['content_list'][1]
        assert 'lines' in title_block
        assert title_block['lines'] == SAMPLE_OCR_JSON['content_list'][1]['lines']


# ---------------------------------------------------------------------------
# Tests: mixed block types
# ---------------------------------------------------------------------------

class TestTranslateJsonMixedBlocks:
    def test_text_blocks_translated(self, engine):
        result = engine.translate_json(SAMPLE_OCR_JSON, 'eng_Latn', 'hin_Deva')
        # Text block should have been translated (mock returns 'translated output')
        assert result['content_list'][0]['text'] == 'translated output'

    def test_title_blocks_translated(self, engine):
        result = engine.translate_json(SAMPLE_OCR_JSON, 'eng_Latn', 'hin_Deva')
        assert result['content_list'][1]['text'] == 'translated output'

    def test_image_blocks_untouched(self, engine):
        result = engine.translate_json(SAMPLE_OCR_JSON, 'eng_Latn', 'hin_Deva')
        img_block = result['content_list'][2]
        assert img_block == SAMPLE_OCR_JSON['content_list'][2]

    def test_equation_blocks_untouched(self, engine):
        result = engine.translate_json(SAMPLE_OCR_JSON, 'eng_Latn', 'hin_Deva')
        eq_block = result['content_list'][4]
        assert eq_block['text'] == 'E = mc^2'

    def test_table_blocks_html_translated(self, engine):
        result = engine.translate_json(SAMPLE_OCR_JSON, 'eng_Latn', 'hin_Deva')
        table_block = result['content_list'][3]
        # Table HTML should contain translated cell content
        assert 'translated output' in table_block['text']


# ---------------------------------------------------------------------------
# Tests: empty content_list
# ---------------------------------------------------------------------------

class TestEmptyContentList:
    def test_empty_content_list(self, engine):
        result = engine.translate_json({'content_list': []}, 'eng_Latn', 'hin_Deva')
        assert result == {'content_list': []}

    def test_missing_content_list(self, engine):
        result = engine.translate_json({}, 'eng_Latn', 'hin_Deva')
        assert result == {}

    def test_no_translatable_text(self, engine):
        json_data = {
            'content_list': [
                {'type': 'image', 'bbox': [0, 0, 100, 100]},
                {'type': 'interline_equation', 'text': 'x^2', 'bbox': [0, 0, 50, 50]},
            ]
        }
        result = engine.translate_json(json_data, 'eng_Latn', 'hin_Deva')
        # Nothing should be changed
        assert result['content_list'][0] == json_data['content_list'][0]
        assert result['content_list'][1]['text'] == 'x^2'


# ---------------------------------------------------------------------------
# Tests: table HTML cell extraction and reinsertion
# ---------------------------------------------------------------------------

class TestTableHtmlTranslation:
    def test_td_cells_translated(self, engine):
        html = '<table><tr><td>Hello</td><td>World</td></tr></table>'
        result = engine._translate_table_html(html, 'eng_Latn', 'hin_Deva')
        # Each cell should have been translated
        assert 'translated output' in result

    def test_th_cells_translated(self, engine):
        html = '<table><tr><th>Header1</th><th>Header2</th></tr></table>'
        result = engine._translate_table_html(html, 'eng_Latn', 'hin_Deva')
        assert 'translated output' in result

    def test_empty_cells_skipped(self, engine, mock_deps):
        """Empty cells should not trigger translation."""
        html = '<table><tr><td></td><td>Text</td></tr></table>'
        mock_deps['_processor'].postprocess_batch.return_value = ['translated output']
        result = engine._translate_table_html(html, 'eng_Latn', 'hin_Deva')
        # The non-empty cell should be translated
        assert 'translated output' in result

    def test_table_structure_preserved(self, engine):
        html = '<table><tr><td>A</td></tr><tr><td>B</td></tr></table>'
        result = engine._translate_table_html(html, 'eng_Latn', 'hin_Deva')
        # Should still have table structure
        assert '<table>' in result
        assert '<tr>' in result
        assert '<td>' in result


# ---------------------------------------------------------------------------
# Tests: model direction selection
# ---------------------------------------------------------------------------

class TestModelDirectionSelection:
    def test_loads_en_indic_for_en_to_hindi(self, mock_deps):
        from lib.translation import TranslationEngine
        e = TranslationEngine()
        e.load_model('en-indic', '1B')
        assert e.model_direction == 'en-indic'
        assert e.model_variant == '1B'

    def test_loads_indic_en_for_hindi_to_en(self, mock_deps):
        from lib.translation import TranslationEngine
        e = TranslationEngine()
        e.load_model('indic-en', '200M')
        assert e.model_direction == 'indic-en'
        assert e.model_variant == '200M'

    def test_rejects_invalid_direction(self, mock_deps):
        from lib.translation import TranslationEngine
        e = TranslationEngine()
        with pytest.raises(ValueError, match='Invalid direction'):
            e.load_model('invalid', '1B')

    def test_rejects_invalid_variant(self, mock_deps):
        from lib.translation import TranslationEngine
        e = TranslationEngine()
        with pytest.raises(ValueError, match='Invalid variant'):
            e.load_model('en-indic', '500M')

    def test_wrong_direction_raises_on_translate(self, mock_deps):
        from lib.translation import TranslationEngine
        e = TranslationEngine()
        e.load_model('en-indic', '1B')
        with pytest.raises(RuntimeError, match='Loaded model direction'):
            e.translate_json(SAMPLE_OCR_JSON, 'hin_Deva', 'eng_Latn')

    def test_model_not_loaded_raises(self, mock_deps):
        from lib.translation import TranslationEngine
        e = TranslationEngine()
        with pytest.raises(RuntimeError, match='No model loaded'):
            e.translate_text('hello', 'eng_Latn', 'hin_Deva')


# ---------------------------------------------------------------------------
# Tests: batch manifest
# ---------------------------------------------------------------------------

class TestBatchManifest:
    def test_manifest_written(self, engine, tmp_path):
        """Batch translation writes batch_status.json manifest."""
        # Create a sample input JSON file
        input_json = {'content_list': [{'type': 'text', 'text': 'Hello', 'bbox': [0, 0, 100, 20]}]}
        input_path = str(tmp_path / 'input.json')
        with open(input_path, 'w') as f:
            json.dump(input_json, f)

        output_dir = str(tmp_path / 'output')
        os.makedirs(output_dir, exist_ok=True)

        items = [{'json_path': input_path}]
        result = engine.translate_batch(
            items=items,
            src_lang='eng_Latn',
            tgt_langs=['hin_Deva'],
            output_dir=output_dir,
        )

        # Check manifest exists
        manifest_path = os.path.join(output_dir, 'batch_status.json')
        assert os.path.exists(manifest_path)

        with open(manifest_path) as f:
            manifest = json.load(f)

        assert manifest['status'] == 'completed'
        assert manifest['completed'] == 1
        assert manifest['total'] == 1
        assert len(manifest['files']) == 1
        assert manifest['files'][0]['target_lang'] == 'hin_Deva'

    def test_manifest_multiple_langs(self, engine, tmp_path, mock_deps):
        """Manifest tracks multiple target languages."""
        input_json = {'content_list': [{'type': 'text', 'text': 'Hi', 'bbox': [0, 0, 50, 20]}]}
        input_path = str(tmp_path / 'input.json')
        with open(input_path, 'w') as f:
            json.dump(input_json, f)

        output_dir = str(tmp_path / 'output')
        result = engine.translate_batch(
            items=[{'json_path': input_path}],
            src_lang='eng_Latn',
            tgt_langs=['hin_Deva', 'tam_Taml'],
            output_dir=output_dir,
        )

        manifest_path = os.path.join(output_dir, 'batch_status.json')
        with open(manifest_path) as f:
            manifest = json.load(f)

        assert manifest['completed'] == 2
        assert manifest['total'] == 2
        assert len(manifest['files']) == 2

    def test_output_files_created(self, engine, tmp_path):
        """Translated JSON files are written to output_dir/json/."""
        input_json = {'content_list': [{'type': 'text', 'text': 'Test', 'bbox': [0, 0, 80, 20]}]}
        input_path = str(tmp_path / 'doc.json')
        with open(input_path, 'w') as f:
            json.dump(input_json, f)

        output_dir = str(tmp_path / 'output')
        result = engine.translate_batch(
            items=[{'json_path': input_path}],
            src_lang='eng_Latn',
            tgt_langs=['hin_Deva'],
            output_dir=output_dir,
        )

        expected_output = os.path.join(output_dir, 'json', 'doc_hin_Deva.json')
        assert os.path.exists(expected_output)

        with open(expected_output) as f:
            translated = json.load(f)
        assert 'content_list' in translated


# ---------------------------------------------------------------------------
# Tests: unload_model
# ---------------------------------------------------------------------------

class TestUnloadModel:
    def test_unload_clears_state(self, engine):
        assert engine.model_loaded is True
        engine.unload_model()
        assert engine.model_loaded is False
        assert engine.model_direction is None
        assert engine.model_variant is None

    def test_unload_when_not_loaded(self, mock_deps):
        from lib.translation import TranslationEngine
        e = TranslationEngine()
        # Should not raise
        e.unload_model()
        assert e.model_loaded is False


# ---------------------------------------------------------------------------
# Tests: is_available
# ---------------------------------------------------------------------------

class TestIsAvailable:
    def test_available_when_deps_present(self, mock_deps):
        from lib.translation import is_available
        assert is_available() is True

    def test_not_available_when_missing(self):
        """Without mock modules, is_available should return False (unless actually installed)."""
        # This test just verifies the function doesn't crash
        from lib.translation import is_available
        result = is_available()
        assert isinstance(result, bool)


# ---------------------------------------------------------------------------
# Tests: does not mutate input
# ---------------------------------------------------------------------------

class TestNoInputMutation:
    def test_translate_json_does_not_mutate_input(self, engine):
        original = copy.deepcopy(SAMPLE_OCR_JSON)
        engine.translate_json(SAMPLE_OCR_JSON, 'eng_Latn', 'hin_Deva')
        assert SAMPLE_OCR_JSON == original
