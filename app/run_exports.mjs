/**
 * Test script: runs the export pipeline on MinerU output.
 * Bypasses the API route's key/credit validation.
 */
import fs from 'fs';
import path from 'path';

// We need to run this from the app directory for module resolution
const mineruOutputPath = '/tmp/iess102_mineru_output.json';
const outputFolder = '/tmp/iess102_exports';
const originalPdfPath = process.cwd() + '/../PDF/iess102_rasterized.pdf';

// Read MinerU output and transform to MineruOutput format
const raw = JSON.parse(fs.readFileSync(mineruOutputPath, 'utf-8'));

// Import the client's parseMineruResult logic inline
function parseMineruResult(data) {
  const pages = (data.pdf_info || data.pages || []);
  return {
    pages: pages.map((page, idx) => ({
      page_number: idx + 1,
      width: page.page_size?.width || 612,
      height: page.page_size?.height || 792,
      regions: parseRegions(page),
    })),
    metadata: {
      total_pages: pages.length,
      file_name: data.file_name || 'iess102_rasterized',
    },
  };
}

function parseRegions(page) {
  const blocks = page.preproc_blocks || page.blocks || page.para_blocks || [];
  return blocks.map(block => {
    const typeMap = {
      'text': 'text', 'title': 'title', 'table': 'table',
      'figure': 'figure', 'equation': 'formula', 'header': 'header',
      'footer': 'footer', 'list': 'list', 'caption': 'caption',
      'interline_equation': 'formula', 'image': 'figure',
    };
    return {
      type: typeMap[block.type] || 'text',
      bbox: block.bbox || [0, 0, 0, 0],
      content: block.text || block.content || '',
      page_number: (page.page_idx || 0) + 1,
      html: block.html,
      table_html: block.table_html,
      latex: block.latex,
      img_data: block.img_data,
      img_mime: block.img_mime,
    };
  });
}

const mineruOutput = parseMineruResult(raw);
mineruOutput.metadata.file_name = 'iess102_rasterized';

console.log(`Parsed ${mineruOutput.pages.length} pages, ${mineruOutput.pages.reduce((a, p) => a + p.regions.length, 0)} regions`);

// Now import and run each export function
const { mineruToHtml } = await import('./src/lib/mineru/html-converter.js');
const { htmlToMarkdown } = await import('./src/lib/export/markdown.js');
const { createSearchablePdf } = await import('./src/lib/export/searchable-pdf.js');
const { createEpub } = await import('./src/lib/export/epub.js');

if (!fs.existsSync(outputFolder)) fs.mkdirSync(outputFolder, { recursive: true });

const baseName = 'iess102_rasterized';
const htmlOptions = { removeHeadersFooters: false, removeMetadata: false, joinBrokenPages: false };

// 1. HTML
console.log('Generating HTML...');
const htmlContent = mineruToHtml(mineruOutput, htmlOptions);
const htmlPath = path.join(outputFolder, `${baseName}.html`);
fs.writeFileSync(htmlPath, htmlContent, 'utf-8');
console.log(`  HTML: ${htmlPath} (${(fs.statSync(htmlPath).size/1024).toFixed(1)}KB)`);

// 2. Markdown
console.log('Generating Markdown...');
const mdContent = htmlToMarkdown(htmlContent);
const mdPath = path.join(outputFolder, `${baseName}.md`);
fs.writeFileSync(mdPath, mdContent, 'utf-8');
console.log(`  Markdown: ${mdPath} (${(fs.statSync(mdPath).size/1024).toFixed(1)}KB)`);

// 3. JSON
console.log('Generating JSON...');
const jsonPath = path.join(outputFolder, `${baseName}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(mineruOutput, null, 2), 'utf-8');
console.log(`  JSON: ${jsonPath} (${(fs.statSync(jsonPath).size/1024).toFixed(1)}KB)`);

// 4. Searchable PDF
console.log('Generating Searchable PDF...');
const pdfPath = path.join(outputFolder, `${baseName}_searchable.pdf`);
await createSearchablePdf(mineruOutput, originalPdfPath, pdfPath);
console.log(`  Searchable PDF: ${pdfPath} (${(fs.statSync(pdfPath).size/(1024*1024)).toFixed(1)}MB)`);

// 5. EPUB
console.log('Generating EPUB...');
const epubPath = path.join(outputFolder, `${baseName}.epub`);
await createEpub(htmlContent, 'Physical Features of India', epubPath);
console.log(`  EPUB: ${epubPath} (${(fs.statSync(epubPath).size/1024).toFixed(1)}KB)`);

// 6. Raw MinerU JSON
const rawJsonPath = path.join(outputFolder, `${baseName}_mineru.json`);
fs.writeFileSync(rawJsonPath, JSON.stringify(raw, null, 2), 'utf-8');
console.log(`  Raw MinerU: ${rawJsonPath}`);

console.log('\nAll formats generated!');
console.log('Output folder:', outputFolder);
