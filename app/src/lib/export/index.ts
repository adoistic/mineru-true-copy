/**
 * Export engine: generates all selected output formats.
 *
 * All formats are generated from the structured OCR JSON via html-converter,
 * which uses properly joined text from preproc_blocks and supports
 * formula/table display modes.
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

export async function exportAll(params: ExportParams): Promise<string[]> {
  const { formats, outputFolder } = params;

  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder, { recursive: true });
  }

  const outputFiles: string[] = [];

  for (const format of formats) {
    if (format === 'zip') continue;

    try {
      const filePath = await exportFormat(format, params);
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
      const benchmarkPath = path.join(outputFolder, `${params.baseName}_true_copy_benchmark.html`);
      fs.writeFileSync(benchmarkPath, withImages, 'utf-8');
      outputFiles.push(benchmarkPath);
    } catch (err) {
      console.error('[Export] Failed to export benchmark true-copy HTML:', err);
    }
  }

  if (formats.includes('zip') && outputFiles.length > 0) {
    try {
      const zipPath = path.join(outputFolder, `${params.baseName}.zip`);
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
  params: ExportParams
): Promise<string | null> {
  const { mineruOutput, taskId, outputFolder, baseName, originalPdfPath } = params;

  switch (format) {
    case 'markdown': {
      const mdContent = await getMarkdown(params);
      const filePath = path.join(outputFolder, `${baseName}.md`);
      fs.writeFileSync(filePath, mdContent, 'utf-8');
      return filePath;
    }

    case 'json': {
      const content = mineruOutput;
      const filePath = path.join(outputFolder, `${baseName}.json`);
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf-8');
      return filePath;
    }

    case 'html': {
      const htmlContent = await getHtml(params);
      const filePath = path.join(outputFolder, `${baseName}.html`);
      fs.writeFileSync(filePath, htmlContent, 'utf-8');
      return filePath;
    }

    case 'searchable_pdf': {
      const filePath = path.join(outputFolder, `${baseName}_searchable.pdf`);
      await createSearchablePdf(mineruOutput, originalPdfPath, filePath);
      return filePath;
    }

    case 'epub': {
      const htmlContent = await getHtml(params);
      const filePath = path.join(outputFolder, `${baseName}.epub`);
      await createEpub(htmlContent, baseName, filePath);
      return filePath;
    }

    case 'true_copy_html': {
      if (!taskId) {
        console.warn('[Export] True-copy HTML requires a live taskId');
        return null;
      }
      // Text-only true copy (standard)
      const textOnly = await createTrueCopyHtml(mineruOutput, taskId, baseName, {
        removeHeadersFooters: params.removeHeadersFooters,
        includeImages: false,
      });
      const filePath = path.join(outputFolder, `${baseName}_true_copy.html`);
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
      const filePath = path.join(outputFolder, `${baseName}_true_copy.docx`);
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
      const filePath = path.join(outputFolder, `${baseName}_true_copy.pdf`);
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
      const filePath = path.join(outputFolder, `${baseName}_true_copy.pptx`);
      fs.writeFileSync(filePath, Buffer.from(pptxBuffer));
      return filePath;
    }

    case 'reflowed_docx': {
      const reflowedDocxBuf = await createReflowedDocx(mineruOutput, {
        removeHeadersFooters: params.removeHeadersFooters,
      });
      const filePath = path.join(outputFolder, `${baseName}.docx`);
      fs.writeFileSync(filePath, Buffer.from(reflowedDocxBuf));
      return filePath;
    }

    case 'reflowed_pdf': {
      const reflowedPdfBuf = await createReflowedPdf(mineruOutput, {
        removeHeadersFooters: params.removeHeadersFooters,
      });
      const filePath = path.join(outputFolder, `${baseName}.pdf`);
      fs.writeFileSync(filePath, Buffer.from(reflowedPdfBuf));
      return filePath;
    }

    default:
      console.warn(`[Export] Unsupported format: ${format}`);
      return null;
  }
}
