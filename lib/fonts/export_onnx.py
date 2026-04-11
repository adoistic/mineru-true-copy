"""One-time dev script: export gaborcselle/font-identifier ResNet-18 to ONNX.

Usage:
    python lib/fonts/export_onnx.py

Outputs:
    lib/fonts/font_classifier.onnx   (~44MB)
    lib/fonts/font_classifier_labels.json  (id2label mapping)

After running, compute SHA-256 and update _MODEL_SHA256 in font_classifier.py:
    shasum -a 256 lib/fonts/font_classifier.onnx
"""

import json
import os
import sys

import torch
from transformers import AutoImageProcessor, AutoModelForImageClassification

MODEL_ID = 'gaborcselle/font-identifier'
OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))
ONNX_PATH = os.path.join(OUTPUT_DIR, 'font_classifier.onnx')
LABELS_PATH = os.path.join(OUTPUT_DIR, 'font_classifier_labels.json')


def main():
    print(f'Loading {MODEL_ID}...')
    processor = AutoImageProcessor.from_pretrained(MODEL_ID)
    model = AutoModelForImageClassification.from_pretrained(MODEL_ID)
    model.eval()

    # Save label mapping
    id2label = dict(model.config.id2label)
    with open(LABELS_PATH, 'w') as f:
        json.dump(id2label, f, indent=2)
    print(f'Saved {len(id2label)} labels to {LABELS_PATH}')

    # Create dummy input matching the processor's expected size
    # ResNet-18 expects 224x224 RGB images
    dummy_input = torch.randn(1, 3, 224, 224)

    print(f'Exporting to ONNX...')
    # Use legacy exporter (dynamo=False) to ensure weights are embedded
    torch.onnx.export(
        model,
        dummy_input,
        ONNX_PATH,
        export_params=True,
        opset_version=14,
        do_constant_folding=True,
        input_names=['pixel_values'],
        output_names=['logits'],
        dynamic_axes={
            'pixel_values': {0: 'batch_size'},
            'logits': {0: 'batch_size'},
        },
        dynamo=False,
    )

    file_size_mb = os.path.getsize(ONNX_PATH) / (1024 * 1024)
    print(f'Saved ONNX model to {ONNX_PATH} ({file_size_mb:.1f}MB)')

    # Compute SHA-256
    import hashlib
    with open(ONNX_PATH, 'rb') as f:
        sha256 = hashlib.sha256(f.read()).hexdigest()
    print(f'SHA-256: {sha256}')
    print(f'\nUpdate _MODEL_SHA256 in lib/font_classifier.py with this value.')


if __name__ == '__main__':
    main()
