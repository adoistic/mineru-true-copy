/**
 * End-to-end OCR pipeline test.
 *
 * Submits a PDF to the MinerU API server, polls for completion,
 * then runs the full export pipeline (HTML, Markdown, JSON, Searchable PDF).
 *
 * Usage:
 *   cd app && npx tsx ../test_e2e_ocr.ts
 */
import { submitFile, pollForCompletion, checkHealth } from '@/lib/mineru/client';
import { mineruToHtml } from '@/lib/mineru/html-converter';
import { exportAll } from '@/lib/export';
import fs from 'fs';
import path from 'path';

const PDF_PATH = path.resolve(__dirname, 'PDF/iess102.pdf');
const OUTPUT_DIR = path.resolve(__dirname, 'output/e2e_test');

async function main() {
  console.log('=== End-to-End OCR Pipeline Test ===\n');

  // Step 0: Check MinerU health
  console.log('[1/5] Checking MinerU health...');
  const healthy = await checkHealth();
  if (!healthy) {
    console.error('ERROR: MinerU server is not running on http://127.0.0.1:8765');
    console.error('Start it with: ./mineru-venv/bin/python mineru_server.py');
    process.exit(1);
  }
  console.log('  ✓ MinerU server is healthy\n');

  // Step 1: Submit PDF
  console.log('[2/5] Submitting PDF to MinerU...');
  console.log(`  File: ${PDF_PATH}`);
  const taskId = await submitFile(PDF_PATH);
  console.log(`  ✓ Task created: ${taskId}\n`);

  // Step 2: Poll for completion
  console.log('[3/5] Processing PDF (this may take a few minutes)...');
  const startTime = Date.now();
  const mineruOutput = await pollForCompletion(taskId, (pagesCompleted) => {
    process.stdout.write(`\r  Processing... ${pagesCompleted} pages completed`);
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  ✓ Processing complete in ${elapsed}s`);
  console.log(`  Pages: ${mineruOutput.pages.length}`);

  let totalRegions = 0;
  for (const page of mineruOutput.pages) {
    totalRegions += page.regions.length;
  }
  console.log(`  Total regions: ${totalRegions}\n`);

  // Set file name in metadata
  mineruOutput.metadata.file_name = 'iess102.pdf';

  // Step 3: Save raw MinerU JSON
  console.log('[4/5] Saving raw MinerU output...');
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const mineruJsonPath = path.join(OUTPUT_DIR, 'iess102_mineru.json');
  fs.writeFileSync(mineruJsonPath, JSON.stringify(mineruOutput, null, 2));
  console.log(`  ✓ ${mineruJsonPath}\n`);

  // Step 4: Export all formats
  console.log('[5/5] Exporting to all formats...');
  const outputFiles = await exportAll({
    mineruOutput,
    htmlOptions: {
      removeHeadersFooters: false,
      removeMetadata: false,
      joinBrokenPages: false,
    },
    formats: ['html', 'markdown', 'json', 'searchable_pdf'],
    outputFolder: OUTPUT_DIR,
    baseName: 'iess102',
    originalPdfPath: PDF_PATH,
  });

  console.log(`  ✓ Generated ${outputFiles.length} output files:\n`);
  for (const f of outputFiles) {
    const stats = fs.statSync(f);
    const size = stats.size < 1024
      ? `${stats.size} B`
      : stats.size < 1048576
        ? `${(stats.size / 1024).toFixed(1)} KB`
        : `${(stats.size / 1048576).toFixed(1)} MB`;
    console.log(`    ${path.basename(f)} (${size})`);
  }

  // Show markdown preview
  const mdPath = path.join(OUTPUT_DIR, 'iess102.md');
  if (fs.existsSync(mdPath)) {
    const md = fs.readFileSync(mdPath, 'utf-8');
    console.log(`\n--- Markdown preview (first 500 chars) ---`);
    console.log(md.substring(0, 500));
    console.log('...');
  }

  console.log(`\n=== All outputs saved to ${OUTPUT_DIR} ===`);
}

main().catch(err => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
