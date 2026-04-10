import { Document, Packer, Paragraph, TextRun } from 'docx';
import fs from 'fs';

const doc = new Document({
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
      }
    },
    children: [
      new Paragraph({
        children: [new TextRun({ text: "This text should be in Tinos (Times-like font)", font: "Tinos", size: 24 })],
      }),
      new Paragraph({
        children: [new TextRun({ text: "This is a second paragraph in Tinos Bold", font: "Tinos", bold: true, size: 24 })],
      }),
    ]
  }]
});

const buffer = await Packer.toBuffer(doc);
fs.writeFileSync('spikes/spike2-base.docx', buffer);
console.log('Base DOCX created, size:', buffer.length);
