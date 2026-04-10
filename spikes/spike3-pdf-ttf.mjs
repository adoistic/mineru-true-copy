import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Load pdf-lib from app/node_modules
const require = createRequire(path.join(projectRoot, 'app', 'package.json'));
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

// Read the TTF font
const ttfBytes = fs.readFileSync(path.join(projectRoot, 'spikes', 'Tinos-Regular.ttf'));
console.log('TTF font loaded:', ttfBytes.length, 'bytes');

// Create a new PDF
const doc = await PDFDocument.create();

// Register fontkit for custom font support
doc.registerFontkit(fontkit);

// Embed the custom TTF font
const customFont = await doc.embedFont(ttfBytes);
console.log('Font embedded successfully');
console.log('Font name:', customFont.name);

// Add a page with US Letter dimensions (612 x 792 points)
const page = doc.addPage([612, 792]);

// Draw visible text at specific positions
// PDF coordinate system: origin at bottom-left, Y increases upward

// Text 1: "Hello World" near top-left
page.drawText('Hello World - Tinos Font', {
  x: 72,
  y: 704,
  size: 16,
  font: customFont,
  color: rgb(0, 0, 0),
});

// Text 2: "Center of Page"
page.drawText('Center of Page - Custom TTF', {
  x: 200,
  y: 398,
  size: 14,
  font: customFont,
  color: rgb(0, 0, 0),
});

// Text 3: "Bottom area"
page.drawText('Bottom Area Text', {
  x: 72,
  y: 80,
  size: 12,
  font: customFont,
  color: rgb(0, 0, 0),
});

// Test: measure text width with the embedded font
const width16 = customFont.widthOfTextAtSize('Hello World', 16);
const width14 = customFont.widthOfTextAtSize('Center of Page', 14);
const width12 = customFont.widthOfTextAtSize('Bottom Area Text', 12);
console.log('\n--- Text Width Measurements ---');
console.log('  "Hello World" at 16pt:', width16.toFixed(2), 'points');
console.log('  "Center of Page" at 14pt:', width14.toFixed(2), 'points');
console.log('  "Bottom Area Text" at 12pt:', width12.toFixed(2), 'points');

// Also test height metrics
const heightAt16 = customFont.heightAtSize(16);
const heightAt14 = customFont.heightAtSize(14);
const heightAt12 = customFont.heightAtSize(12);
console.log('\n--- Font Height Metrics ---');
console.log('  Height at 16pt:', heightAt16.toFixed(2), 'points');
console.log('  Height at 14pt:', heightAt14.toFixed(2), 'points');
console.log('  Height at 12pt:', heightAt12.toFixed(2), 'points');

// Save
const pdfBytes = await doc.save();
const outputPath = path.join(projectRoot, 'spikes', 'spike3-output.pdf');
fs.writeFileSync(outputPath, pdfBytes);
console.log('\nPDF saved:', outputPath);
console.log('PDF size:', pdfBytes.length, 'bytes');

// Verify font embedding by reloading
const loaded = await PDFDocument.load(pdfBytes);
const allObjects = loaded.context.enumerateIndirectObjects();
let fontCount = 0;
for (const [ref, obj] of allObjects) {
  const str = obj?.toString?.() || '';
  if (str.includes('/Type /Font')) fontCount++;
}
console.log('\nEmbedded font objects in output PDF:', fontCount);
console.log('\nSpike 3 complete - all checks passed');
