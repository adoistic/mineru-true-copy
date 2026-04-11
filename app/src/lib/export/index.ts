/**
 * Export engine: generates all selected output formats.
 *
 * Output structure:
 *   outputFolder/
 *     <baseName>/
 *       True Copy/    — pixel-perfect positioned exports
 *       Reflowed/     — semantic, editable exports
 *       Data/         — structured data + searchable PDF
 *       <baseName>.zip (optional)
 */
import { MineruOutput, ExportFormat } from '@/types';
import { mineruToHtml, HtmlConversionOptions } from '@/lib/mineru/html-converter';
import { htmlToMarkdown } from './markdown';
import { createSearchablePdf } from './searchable-pdf';
import { createTrueCopyHtml } from './true-copy-html';
import { createTrueCopyDocx } from './true-copy-docx';
import { createTrueCopyPdf } from './true-copy-pdf';
import { createTrueCopyPptx } from './true-copy-pptx';
import { createReflowedDocx } from './reflowed-docx';
import { createReflowedPdf } from './reflowed-pdf';
import { createEpub } from './epub';
import { createZip } from './zip';
import fs from 'fs';
import path from 'path';

export interface ExportParams {
  mineruOutput: MineruOutput;
  taskId?: string;
  formats: ExportFormat[];
  outputFolder: string;
  baseName: string;
  originalPdfPath: string;
  removeHeadersFooters?: boolean;
  formulaDisplay?: 'rendered' | 'image';
  tableDisplay?: 'rendered' | 'image';
  includeFigures?: boolean;
  figureDisplay?: 'image' | 'text';
  includeBenchmarkImages?: boolean;
  /** @deprecated Used only by re-export paths (heading correction, API) that lack a taskId */
  htmlOptions?: HtmlConversionOptions;
}

/** Subfolder category for each export format */
function formatCategory(format: ExportFormat): 'True Copy' | 'Reflowed' | 'Data' {
  switch (format) {
    case 'true_copy_html':
    case 'true_copy_docx':
    case 'true_copy_pdf':
    case 'true_copy_pptx':
    case 'docx': // legacy key → true-copy
      return 'True Copy';
    case 'html':
    case 'reflowed_docx':
    case 'reflowed_pdf':
    case 'markdown':
    case 'epub':
      return 'Reflowed';
    case 'searchable_pdf':
    case 'json':
    case 'csv':
      return 'Data';
    default:
      return 'Data';
  }
}

export async function exportAll(params: ExportParams): Promise<string[]> {
  const { formats, outputFolder, baseName } = params;

  // Create per-document folder
  const docFolder = path.join(outputFolder, baseName);
  if (!fs.existsSync(docFolder)) {
    fs.mkdirSync(docFolder, { recursive: true });
  }

  // Create category subfolders as needed
  const neededCategories = new Set(
    formats.filter(f => f !== 'zip').map(f => formatCategory(f))
  );
  for (const cat of neededCategories) {
    const catDir = path.join(docFolder, cat);
    if (!fs.existsSync(catDir)) {
      fs.mkdirSync(catDir, { recursive: true });
    }
  }

  const outputFiles: string[] = [];

  for (const format of formats) {
    if (format === 'zip') continue;

    try {
      const filePath = await exportFormat(format, params, docFolder);
      if (filePath) outputFiles.push(filePath);
    } catch (err) {
      console.error(`[Export] Failed to export ${format}:`, err);
    }
  }

  // Benchmark true-copy: produce a second file with page images if requested
  if (formats.includes('true_copy_html') && params.includeBenchmarkImages && params.taskId) {
    try {
      const withImages = await createTrueCopyHtml(
        params.mineruOutput, params.taskId, params.baseName, {
          removeHeadersFooters: params.removeHeadersFooters,
          includeImages: true,
        }
      );
      const benchmarkPath = path.join(docFolder, 'True Copy', `${baseName}_benchmark.html`);
      fs.writeFileSync(benchmarkPath, withImages, 'utf-8');
      outputFiles.push(benchmarkPath);
    } catch (err) {
      console.error('[Export] Failed to export benchmark true-copy HTML:', err);
    }
  }

  // Save raw OCR data JSON in Data/
  const dataDir = path.join(docFolder, 'Data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const ocrDataPath = path.join(dataDir, `${baseName}_ocr_data.json`);
  fs.writeFileSync(ocrDataPath, JSON.stringify(params.mineruOutput, null, 2));
  outputFiles.push(ocrDataPath);

  if (formats.includes('zip') && outputFiles.length > 0) {
    try {
      const zipPath = path.join(docFolder, `${baseName}.zip`);
      await createZip(outputFiles, zipPath);
      outputFiles.push(zipPath);
    } catch (err) {
      console.error('[Export] Failed to create ZIP:', err);
    }
  }

  return outputFiles;
}

/**
 * Get markdown content — generates from mineruToHtml (which uses properly joined
 * text from preproc_blocks) then converts to markdown.
 */
async function getMarkdown(params: ExportParams): Promise<string> {
  const html = await getHtml(params);
  return htmlToMarkdown(html);
}

/**
 * Get HTML content — always uses mineruToHtml which supports formula/table display
 * modes and uses properly joined text from preproc_blocks.
 */
async function getHtml(params: ExportParams): Promise<string> {
  const htmlOptions = params.htmlOptions ?? {
    removeHeadersFooters: params.removeHeadersFooters ?? false,
    removeMetadata: false,
    joinBrokenPages: false,
    formulaDisplay: params.formulaDisplay ?? 'image',
    tableDisplay: params.tableDisplay ?? 'rendered',
    includeFigures: params.includeFigures ?? true,
    figureDisplay: params.figureDisplay ?? 'image',
  };
  return mineruToHtml(params.mineruOutput, htmlOptions);
}

async function exportFormat(
  format: ExportFormat,
  params: ExportParams,
  docFolder: string,
): Promise<string | null> {
  const { mineruOutput, taskId, baseName, originalPdfPath } = params;
  const category = formatCategory(format);
  const catDir = path.join(docFolder, category);

  switch (format) {
    case 'markdown': {
      const mdContent = await getMarkdown(params);
      const filePath = path.join(catDir, `${baseName}.md`);
      fs.writeFileSync(filePath, mdContent, 'utf-8');
      return filePath;
    }

    case 'json': {
      const content = mineruOutput;
      const filePath = path.join(catDir, `${baseName}.json`);
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf-8');
      return filePath;
    }

    case 'html': {
      const htmlContent = await getHtml(params);
      const filePath = path.join(catDir, `${baseName}.html`);
      fs.writeFileSync(filePath, htmlContent, 'utf-8');
      return filePath;
    }

    case 'searchable_pdf': {
      const filePath = path.join(catDir, `${baseName}_searchable.pdf`);
      await createSearchablePdf(mineruOutput, originalPdfPath, filePath);
      return filePath;
    }

    case 'epub': {
      const htmlContent = await getHtml(params);
      const filePath = path.join(catDir, `${baseName}.epub`);
      await createEpub(htmlContent, baseName, filePath);
      return filePath;
    }

    case 'true_copy_html': {
      if (!taskId) {
        console.warn('[Export] True-copy HTML requires a live taskId');
        return null;
      }
      const textOnly = await createTrueCopyHtml(mineruOutput, taskId, baseName, {
        removeHeadersFooters: params.removeHeadersFooters,
        includeImages: false,
      });
      const filePath = path.join(catDir, `${baseName}.html`);
      fs.writeFileSync(filePath, textOnly, 'utf-8');
      return filePath;
    }

    case 'true_copy_docx':
    case 'docx': {
      if (!taskId) {
        console.warn('[Export] True-copy DOCX requires a live taskId');
        return null;
      }
      const docxBuffer = await createTrueCopyDocx(mineruOutput, taskId, {
        removeHeadersFooters: params.removeHeadersFooters,
        includeImages: params.includeBenchmarkImages,
      });
      const filePath = path.join(catDir, `${baseName}.docx`);
      fs.writeFileSync(filePath, Buffer.from(docxBuffer));
      return filePath;
    }

    case 'true_copy_pdf': {
      if (!taskId) {
        console.warn('[Export] True-copy PDF requires a live taskId');
        return null;
      }
      const pdfBuffer = await createTrueCopyPdf(mineruOutput, taskId, {
        removeHeadersFooters: params.removeHeadersFooters,
        includeImages: params.includeBenchmarkImages,
      });
      const filePath = path.join(catDir, `${baseName}.pdf`);
      fs.writeFileSync(filePath, Buffer.from(pdfBuffer));
      return filePath;
    }

    case 'true_copy_pptx': {
      if (!taskId) {
        console.warn('[Export] True-copy PPTX requires a live taskId');
        return null;
      }
      const pptxBuffer = await createTrueCopyPptx(mineruOutput, taskId, {
        removeHeadersFooters: params.removeHeadersFooters,
        includeImages: params.includeBenchmarkImages,
      });
      const filePath = path.join(catDir, `${baseName}.pptx`);
      fs.writeFileSync(filePath, Buffer.from(pptxBuffer));
      return filePath;
    }

    case 'reflowed_docx': {
      const reflowedDocxBuf = await createReflowedDocx(mineruOutput, {
        removeHeadersFooters: params.removeHeadersFooters,
      });
      const filePath = path.join(catDir, `${baseName}.docx`);
      fs.writeFileSync(filePath, Buffer.from(reflowedDocxBuf));
      return filePath;
    }

    case 'reflowed_pdf': {
      const reflowedPdfBuf = await createReflowedPdf(mineruOutput, {
        removeHeadersFooters: params.removeHeadersFooters,
      });
      const filePath = path.join(catDir, `${baseName}.pdf`);
      fs.writeFileSync(filePath, Buffer.from(reflowedPdfBuf));
      return filePath;
    }

    default:
      console.warn(`[Export] Unsupported format: ${format}`);
      return null;
  }
}
