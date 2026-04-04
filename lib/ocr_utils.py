"""
OCR utility functions extracted from MinerU (magic_pdf).

Only the functions needed by VisionLLMOCR are included:
  check_img, merge_det_boxes, sorted_boxes, update_det_boxes

Original source: https://github.com/opendatalab/MinerU
Copyright (c) Opendatalab. All rights reserved.
"""

import cv2
import numpy as np

LINE_WIDTH_TO_HEIGHT_RATIO_THRESHOLD = 4


# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------

def img_decode(content: bytes):
    np_arr = np.frombuffer(content, dtype=np.uint8)
    return cv2.imdecode(np_arr, cv2.IMREAD_UNCHANGED)


def check_img(img):
    if isinstance(img, bytes):
        img = img_decode(img)
    if isinstance(img, np.ndarray) and len(img.shape) == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    return img


def sorted_boxes(dt_boxes):
    """Sort text boxes top-to-bottom, left-to-right."""
    num_boxes = len(dt_boxes)
    sorted_boxes = sorted(dt_boxes, key=lambda x: (x[0][1], x[0][0]))
    _boxes = list(sorted_boxes)
    for i in range(num_boxes - 1):
        for j in range(i, -1, -1):
            if abs(_boxes[j + 1][0][1] - _boxes[j][0][1]) < 10 and \
                    (_boxes[j + 1][0][0] < _boxes[j][0][0]):
                tmp = _boxes[j]
                _boxes[j] = _boxes[j + 1]
                _boxes[j + 1] = tmp
            else:
                break
    return _boxes


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def bbox_to_points(bbox):
    x0, y0, x1, y1 = bbox
    return np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]).astype('float32')


def points_to_bbox(points):
    x0, y0 = points[0]
    x1, _ = points[1]
    _, y1 = points[2]
    return [x0, y0, x1, y1]


def calculate_is_angle(poly):
    p1, p2, p3, p4 = poly
    height = ((p4[1] - p1[1]) + (p3[1] - p2[1])) / 2
    if 0.8 * height <= (p3[1] - p1[1]) <= 1.2 * height:
        return False
    return True


def _is_overlaps_y_exceeds_threshold(bbox1, bbox2, overlap_ratio_threshold=0.8):
    _, y0_1, _, y1_1 = bbox1
    _, y0_2, _, y1_2 = bbox2
    overlap = max(0, min(y1_1, y1_2) - max(y0_1, y0_2))
    height1, height2 = y1_1 - y0_1, y1_2 - y0_2
    min_height = min(height1, height2)
    return (overlap / min_height) > overlap_ratio_threshold if min_height > 0 else False


# ---------------------------------------------------------------------------
# Interval math
# ---------------------------------------------------------------------------

def merge_intervals(intervals):
    intervals.sort(key=lambda x: x[0])
    merged = []
    for interval in intervals:
        if not merged or merged[-1][1] < interval[0]:
            merged.append(interval)
        else:
            merged[-1][1] = max(merged[-1][1], interval[1])
    return merged


def remove_intervals(original, masks):
    merged_masks = merge_intervals(masks)
    result = []
    original_start, original_end = original
    for mask in merged_masks:
        mask_start, mask_end = mask
        if mask_start > original_end:
            continue
        if mask_end < original_start:
            continue
        if original_start < mask_start:
            result.append([original_start, mask_start - 1])
        original_start = max(mask_end + 1, original_start)
    if original_start <= original_end:
        result.append([original_start, original_end])
    return result


# ---------------------------------------------------------------------------
# Span/line merging
# ---------------------------------------------------------------------------

def merge_spans_to_line(spans, threshold=0.6):
    if len(spans) == 0:
        return []
    spans.sort(key=lambda span: span['bbox'][1])
    lines = []
    current_line = [spans[0]]
    for span in spans[1:]:
        if _is_overlaps_y_exceeds_threshold(span['bbox'], current_line[-1]['bbox'], threshold):
            current_line.append(span)
        else:
            lines.append(current_line)
            current_line = [span]
    if current_line:
        lines.append(current_line)
    return lines


def merge_overlapping_spans(spans):
    if not spans:
        return []
    spans.sort(key=lambda x: x[0])
    merged = []
    for span in spans:
        x1, y1, x2, y2 = span
        if not merged or merged[-1][2] < x1:
            merged.append(span)
        else:
            last_span = merged.pop()
            x1 = min(last_span[0], x1)
            y1 = min(last_span[1], y1)
            x2 = max(last_span[2], x2)
            y2 = max(last_span[3], y2)
            merged.append((x1, y1, x2, y2))
    return merged


# ---------------------------------------------------------------------------
# Box merging and updating
# ---------------------------------------------------------------------------

def merge_det_boxes(dt_boxes):
    """Merge detection boxes into larger text regions."""
    dt_boxes_dict_list = []
    angle_boxes_list = []
    for text_box in dt_boxes:
        text_bbox = points_to_bbox(text_box)
        if calculate_is_angle(text_box):
            angle_boxes_list.append(text_box)
            continue
        dt_boxes_dict_list.append({'bbox': text_bbox})

    lines = merge_spans_to_line(dt_boxes_dict_list)

    new_dt_boxes = []
    for line in lines:
        line_bbox_list = [span['bbox'] for span in line]
        min_x = min(bbox[0] for bbox in line_bbox_list)
        max_x = max(bbox[2] for bbox in line_bbox_list)
        min_y = min(bbox[1] for bbox in line_bbox_list)
        max_y = max(bbox[3] for bbox in line_bbox_list)
        line_width = max_x - min_x
        line_height = max_y - min_y

        if line_width > line_height * LINE_WIDTH_TO_HEIGHT_RATIO_THRESHOLD:
            merged_spans = merge_overlapping_spans(line_bbox_list)
            for span in merged_spans:
                new_dt_boxes.append(bbox_to_points(span))
        else:
            for bbox in line_bbox_list:
                new_dt_boxes.append(bbox_to_points(bbox))

    new_dt_boxes.extend(angle_boxes_list)
    return new_dt_boxes


def update_det_boxes(dt_boxes, mfd_res):
    """Remove portions of text boxes that overlap with formula regions."""
    new_dt_boxes = []
    angle_boxes_list = []
    for text_box in dt_boxes:
        if calculate_is_angle(text_box):
            angle_boxes_list.append(text_box)
            continue
        text_bbox = points_to_bbox(text_box)
        masks_list = []
        for mf_box in mfd_res:
            mf_bbox = mf_box['bbox']
            if _is_overlaps_y_exceeds_threshold(text_bbox, mf_bbox):
                masks_list.append([mf_bbox[0], mf_bbox[2]])
        text_x_range = [text_bbox[0], text_bbox[2]]
        text_remove_mask_range = remove_intervals(text_x_range, masks_list)
        temp_dt_box = []
        for text_remove_mask in text_remove_mask_range:
            temp_dt_box.append(bbox_to_points([text_remove_mask[0], text_bbox[1], text_remove_mask[1], text_bbox[3]]))
        if len(temp_dt_box) > 0:
            new_dt_boxes.extend(temp_dt_box)

    new_dt_boxes.extend(angle_boxes_list)
    return new_dt_boxes
