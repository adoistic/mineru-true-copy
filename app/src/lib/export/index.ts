/**
 * Export engine: takes MinerU output and generates all selected formats.
 * HTML is the primary internal representation. All other formats derive from it.
 */
import { MineruOutput, ExportFormat } from '@/types';
import { HtmlConversionOptions, mineruToHtml } from '@/lib/mineru/html-converter';
import { htmlToMarkdown } from './markdown';
import { createSearchablePdf } from './searchable-pdf';
import { createEpub } from './epub';
import { createZip } from './zip';
import fs from 'fs';
import path from 'path';

export interface ExportParams {
  mineruOutput: MineruOutput;
  htmlOptions: HtmlConversionOptions;
  formats: ExportFormat[];
  outputFolder: string;
  baseName: string;
  originalPdfPath: string;
}

export async function exportAll(params: ExportParams): Promise<string[]> {
  const { mineruOutput, htmlOptions, formats, outputFolder, baseName, originalPdfPath } = params;

  // Ensure output folder exists
  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder, { recursive: true });
  }

  // Generate HTML (always needed as the base)
  const htmlContent = mineruToHtml(mineruOutput, htmlOptions);
  const outputFiles: string[] = [];

  // Export each selected format
  for (const format of formats) {
    if (format === 'zip') continue; // ZIP is handled last

    try {
      const filePath = await exportFormat(format, {
        htmlContent,
        mineruOutput,
        htmlOptions,
        outputFolder,
        baseName,
        originalPdfPath,
      });
      if (filePath) outputFiles.push(filePath);
    } catch (err) {
      console.error(`[Export] Failed to export ${format}:`, err);
    }
  }

  // ZIP export: bundle all generated files
  if (formats.includes('zip') && outputFiles.length > 0) {
    try {
      const zipPath = path.join(outputFolder, `${baseName}.zip`);
      await createZip(outputFiles, zipPath);
      outputFiles.push(zipPath);
    } catch (err) {
      console.error('[Export] Failed to create ZIP:', err);
    }
  }

  return outputFiles;
}

async function exportFormat(
  format: ExportFormat,
  params: {
    htmlContent: string;
    mineruOutput: MineruOutput;
    htmlOptions: HtmlConversionOptions;
    outputFolder: string;
    baseName: string;
    originalPdfPath: string;
  }
): Promise<string | null> {
  const { htmlContent, mineruOutput, htmlOptions, outputFolder, baseName, originalPdfPath } = params;

  switch (format) {
    case 'html': {
      const filePath = path.join(outputFolder, `${baseName}.html`);
      fs.writeFileSync(filePath, htmlContent, 'utf-8');
      return filePath;
    }

    case 'markdown': {
      const mdContent = htmlToMarkdown(htmlContent);
      const filePath = path.join(outputFolder, `${baseName}.md`);
      fs.writeFileSync(filePath, mdContent, 'utf-8');
      return filePath;
    }

    case 'json': {
      const filePath = path.join(outputFolder, `${baseName}.json`);
      fs.writeFileSync(filePath, JSON.stringify(mineruOutput, null, 2), 'utf-8');
      return filePath;
    }

    case 'searchable_pdf': {
      const filePath = path.join(outputFolder, `${baseName}_searchable.pdf`);
      await createSearchablePdf(mineruOutput, originalPdfPath, filePath);
      return filePath;
    }

    case 'epub': {
      const filePath = path.join(outputFolder, `${baseName}.epub`);
      await createEpub(htmlContent, baseName, filePath);
      return filePath;
    }

    default:
      console.warn(`[Export] Unsupported format: ${format}`);
      return null;
  }
}
