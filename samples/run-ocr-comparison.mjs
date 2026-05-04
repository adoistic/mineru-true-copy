#!/usr/bin/env node
/**
 * Run the same PDF through MinerU's pipeline twice — once with local OCR
 * (PaddleOCR) and once with cloud OCR (vision-LLM via OpenRouter) — and emit
 * a side-by-side comparison HTML for the README hero image.
 *
 * Prerequisites: mineru_server.py running on 127.0.0.1:8765 with both modes
 * available (server-side OPENROUTER_API_KEY set). See samples/README.md.
 *
 * Usage:
 *   node samples/run-ocr-comparison.mjs samples/your-pdf.pdf
 */
import fs from 'node:fs';
import path from 'node:path';

const SERVER = process.env.MINERU_SERVER || 'http://127.0.0.1:8765';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

async function submitPdf(pdfPath, mode) {
  const fileBuf = fs.readFileSync(pdfPath);
  const fileName = path.basename(pdfPath);
  const fd = new FormData();
  fd.append('file', new Blob([fileBuf], { type: 'application/pdf' }), fileName);
  fd.append('processing_mode', mode);
  // Keep tables in local mode for both passes so the diff isolates OCR.
  fd.append('table_mode', 'local');

  const res = await fetch(`${SERVER}/file_parse`, { method: 'POST', body: fd });
  if (!res.ok) {
    throw new Error(`POST /file_parse failed (${mode}): ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  if (!json.task_id) throw new Error(`No task_id in response: ${JSON.stringify(json)}`);
  return json.task_id;
}

async function pollUntilDone(taskId, mode) {
  const start = Date.now();
  let lastStatus = '';
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const res = await fetch(`${SERVER}/tasks/${taskId}`);
    if (!res.ok) throw new Error(`GET /tasks/${taskId} failed: ${res.status}`);
    const data = await res.json();
    if (data.status !== lastStatus) {
      const prog = data.progress
        ? ` (${data.progress.completed ?? data.progress.current ?? '?'}/${data.progress.total ?? '?'} pages)`
        : '';
      console.log(`[${mode}] ${data.status}${prog}`);
      lastStatus = data.status;
    }
    if (data.status === 'completed') return data;
    if (data.status === 'failed') {
      throw new Error(`[${mode}] task failed: ${data.error || JSON.stringify(data)}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`[${mode}] task timed out after ${POLL_TIMEOUT_MS / 1000}s`);
}

async function getContentList(taskId) {
  const res = await fetch(`${SERVER}/tasks/${taskId}/export/content_list`);
  if (!res.ok) {
    throw new Error(`GET /tasks/${taskId}/export/content_list failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  // Server wraps content_list in {format, data}. Be permissive.
  return Array.isArray(json) ? json : (json.data || []);
}

async function deleteTask(taskId) {
  try {
    await fetch(`${SERVER}/tasks/${taskId}`, { method: 'DELETE' });
  } catch {
    // best-effort cleanup; not fatal
  }
}

async function runOnePass(pdfPath, mode) {
  console.log(`\n[${mode}] submitting ${path.basename(pdfPath)}…`);
  const taskId = await submitPdf(pdfPath, mode);
  console.log(`[${mode}] task ${taskId}; polling…`);
  await pollUntilDone(taskId, mode);
  const list = await getContentList(taskId);
  await deleteTask(taskId);
  console.log(`[${mode}] got ${list.length} content blocks`);
  return list;
}

// ─── HTML rendering ──────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Render a content-list text block. The block's `text` field may already
 * contain `<b>`, `<i>`, `<sup>`, `<sub>` tags (cloud mode), or be plain
 * (local mode). We escape HTML, then re-allow only the typographic tags so
 * the comparison is faithful to whatever the OCR backend actually returned.
 */
function renderTextWithSafeEmphasis(rawText) {
  const escaped = escapeHtml(rawText);
  return escaped.replace(
    /&lt;(\/?(?:b|i|sup|sub|strong|em))&gt;/g,
    '<$1>'
  );
}

function renderBlock(block) {
  if (!block) return '';

  if (block.type === 'image' || block.type === 'figure') {
    const pg = block.page_idx ?? '?';
    return `<div class="figure-marker">[figure on page ${pg}]</div>`;
  }
  if (block.type === 'equation' || block.type === 'interline_equation') {
    const t = block.text || block.latex || '';
    return `<pre class="equation">${escapeHtml(t)}</pre>`;
  }
  if (block.type === 'table') {
    return `<div class="figure-marker">[table on page ${block.page_idx ?? '?'}]</div>`;
  }

  const text = block.text;
  if (!text) return '';

  const rendered = renderTextWithSafeEmphasis(text);
  if (block.text_level === 1 || block.type === 'title') return `<h2>${rendered}</h2>`;
  if (block.text_level === 2) return `<h3>${rendered}</h3>`;
  if (block.text_level >= 3) return `<h4>${rendered}</h4>`;
  return `<p>${rendered}</p>`;
}

function renderColumn(contentList, label) {
  const html = contentList.map(renderBlock).filter(Boolean).join('\n');
  return `<div class="column">
    <div class="column-header"><span class="label">${label}</span></div>
    <div class="column-body">${html}</div>
  </div>`;
}

function countSpans(list) {
  const text = list.map(b => b.text || '').join(' ');
  return {
    bold: (text.match(/<b>/g) || []).length + (text.match(/<strong>/g) || []).length,
    italic: (text.match(/<i>/g) || []).length + (text.match(/<em>/g) || []).length,
  };
}

function buildComparisonHtml(localList, cloudList, basename) {
  const localCounts = countSpans(localList);
  const cloudCounts = countSpans(cloudList);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OCR comparison — ${escapeHtml(basename)}</title>
<style>
  :root { --bg: #fff; --fg: #1a1a1a; --muted: #888; --border: #e5e5e5; --bold: #d62828; --italic: #1d6f42; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--bg); color: var(--fg);
    margin: 0; padding: 24px;
    width: 1600px; box-sizing: border-box;
  }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
  .subtitle { color: var(--muted); font-size: 13px; margin: 0 0 16px; }
  .counts { font-size: 12px; color: var(--muted); margin: 0 0 24px; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .columns { display: flex; gap: 24px; }
  .column { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
  .column-header { background: #f5f5f5; padding: 12px 16px; border-bottom: 1px solid var(--border); font-weight: 600; font-size: 14px; }
  .column-header .label { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .column-body { padding: 16px 24px; font-family: "Times New Roman", Times, serif; font-size: 14px; line-height: 1.55; max-height: 1200px; overflow-y: auto; }
  .column-body p { margin: 0 0 0.6em; }
  .column-body h2 { font-size: 18px; margin: 1em 0 0.4em; }
  .column-body h3 { font-size: 16px; margin: 1em 0 0.4em; }
  .column-body h4 { font-size: 15px; margin: 1em 0 0.4em; }
  .column-body b, .column-body strong { color: var(--bold); }
  .column-body i, .column-body em { color: var(--italic); }
  .figure-marker { color: var(--muted); font-style: italic; font-size: 12px; padding: 4px 0; }
  .equation { background: #fafafa; padding: 6px 12px; border-radius: 3px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; }
  .legend { font-size: 12px; color: var(--muted); margin-top: 16px; }
  .swatch { display: inline-block; width: 10px; height: 10px; vertical-align: middle; margin-right: 4px; border-radius: 2px; }
  .swatch.bold { background: var(--bold); }
  .swatch.italic { background: var(--italic); }
</style>
</head>
<body>
  <h1>OCR comparison: ${escapeHtml(basename)}</h1>
  <p class="subtitle">Same PDF, two OCR backends through MinerU. Bold spans rendered in <b style="color:var(--bold)">red</b>, italic in <i style="color:var(--italic)">green</i>.</p>
  <p class="counts">local · PaddleOCR — bold=${localCounts.bold}, italic=${localCounts.italic}    ·    cloud · vision-LLM — bold=${cloudCounts.bold}, italic=${cloudCounts.italic}</p>
  <div class="columns">
    ${renderColumn(localList, 'local · PaddleOCR')}
    ${renderColumn(cloudList, 'cloud · vision-LLM')}
  </div>
  <p class="legend">
    <span class="swatch bold"></span> <b>bold spans</b>&nbsp;&nbsp;
    <span class="swatch italic"></span> <i>italic spans</i>
  </p>
</body>
</html>`;
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Usage: node samples/run-ocr-comparison.mjs <path-to-pdf>');
    process.exit(1);
  }
  if (!fs.existsSync(pdfPath)) {
    console.error(`File not found: ${pdfPath}`);
    process.exit(1);
  }

  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const outDir = path.join(path.dirname(path.resolve(pdfPath)), 'out');
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Checking ${SERVER}/health…`);
  let health;
  try {
    const h = await fetch(`${SERVER}/health`);
    health = await h.json();
  } catch (err) {
    console.error(`\nCannot reach ${SERVER}. Is mineru_server.py running?`);
    console.error(err.message);
    process.exit(1);
  }
  console.log(`Server: status=${health.status}, cloud=${health.cloud_available}, local=${health.local_available}`);
  if (health.status !== 'ok') {
    console.error(`\nServer not ready (status=${health.status}). Wait for model pre-warm to finish.`);
    process.exit(1);
  }
  if (!health.cloud_available) {
    console.error(`\nCloud OCR unavailable. Set OPENROUTER_API_KEY in the server's environment before starting it.`);
    process.exit(1);
  }
  if (!health.local_available) {
    console.error(`\nLocal OCR unavailable. PaddleOCR models missing — check the server's --models-dir.`);
    process.exit(1);
  }

  // Sequential — same GPU/MPS, no point running them in parallel.
  const localList = await runOnePass(pdfPath, 'local');
  fs.writeFileSync(path.join(outDir, `${basename}-local.json`), JSON.stringify(localList, null, 2));

  const cloudList = await runOnePass(pdfPath, 'cloud');
  fs.writeFileSync(path.join(outDir, `${basename}-cloud.json`), JSON.stringify(cloudList, null, 2));

  const html = buildComparisonHtml(localList, cloudList, basename);
  const htmlPath = path.join(outDir, `${basename}-comparison.html`);
  fs.writeFileSync(htmlPath, html);

  const lc = countSpans(localList);
  const cc = countSpans(cloudList);
  console.log(`\n────────────────────────────────────────`);
  console.log(`Saved:`);
  console.log(`  ${path.relative(process.cwd(), path.join(outDir, basename + '-local.json'))}   (${localList.length} blocks, bold=${lc.bold}, italic=${lc.italic})`);
  console.log(`  ${path.relative(process.cwd(), path.join(outDir, basename + '-cloud.json'))}   (${cloudList.length} blocks, bold=${cc.bold}, italic=${cc.italic})`);
  console.log(`  ${path.relative(process.cwd(), htmlPath)}`);
  console.log(`\nNext: open the HTML in your browser, screenshot a region with visible bold/italic differences, save as samples/comparison-bold-italic.png.`);
  if (cc.bold + cc.italic === 0) {
    console.log(`\nNote: cloud pass returned zero bold/italic spans. Either the PDF doesn't contain typographic emphasis or the VLM prompt didn't surface it for this document. Try a PDF with visible bold section headers (Hindi gazettes, NCERT textbooks, ACM/IEEE papers all work well).`);
  }
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
