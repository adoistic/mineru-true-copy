/**
 * Spike 1: Verify that docx-js can place text boxes at absolute (x, y)
 * positions on a page using Paragraph.frame (TextFrame / framePr).
 *
 * Expected OOXML output: <w:framePr> elements with w:x, w:y, w:w, w:h
 * attributes anchored to the page.
 */

import { createRequire } from "module";
const require = createRequire(new URL("../app/", import.meta.url));
const { Document, Packer, Paragraph, TextRun, FrameAnchorType, FrameWrap } = require("docx");
import { writeFileSync } from "fs";

const boxes = [
  { label: "Top Left",     x: 2000,  y: 2000,  w: 4000, h: 1000 },
  { label: "Center",       x: 5000,  y: 7000,  w: 4000, h: 1000 },
  { label: "Bottom Right",  x: 8000,  y: 13000, w: 4000, h: 1000 },
];

const paragraphs = boxes.map(
  (box) =>
    new Paragraph({
      frame: {
        position: {
          x: box.x,
          y: box.y,
        },
        width: box.w,
        height: box.h,
        anchor: {
          horizontal: FrameAnchorType.PAGE,
          vertical: FrameAnchorType.PAGE,
        },
        wrap: FrameWrap.NONE,
      },
      children: [
        new TextRun({
          text: box.label,
          size: 24, // 12pt
        }),
      ],
    })
);

const doc = new Document({
  sections: [
    {
      properties: {
        page: {
          size: {
            width: 12240,  // US Letter width in DXA (8.5" * 1440)
            height: 15840, // US Letter height in DXA (11" * 1440)
          },
          margin: {
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
          },
        },
      },
      children: paragraphs,
    },
  ],
});

import { dirname, join } from "path";
import { fileURLToPath } from "url";
const outPath = join(dirname(fileURLToPath(import.meta.url)), "spike1-output.docx");

const buffer = await Packer.toBuffer(doc);
writeFileSync(outPath, buffer);
console.log(`Written to ${outPath} (${buffer.length} bytes)`);
