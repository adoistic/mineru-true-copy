import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

/**
 * Scan a folder for OCR result JSONs produced by our OCR pipeline.
 *
 * The OCR pipeline writes:
 *   {output_folder}/{baseName}/Data/{baseName}_ocr_data.json
 *
 * We also fall back to:
 *   - Any *_ocr_data.json inside a Data/ subfolder
 *   - The first *.json inside a Data/ subfolder
 *   - A single loose .json file at the top level of the selected folder
 *     (e.g. the user points directly at one OCR output subfolder)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const folder: string | undefined = body?.folder;

    if (!folder || typeof folder !== 'string') {
      return Response.json({ error: 'folder is required' }, { status: 400 });
    }
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      return Response.json({ error: 'folder does not exist or is not a directory' }, { status: 400 });
    }

    const discovered: { json_path: string; base_name: string; doc_folder: string }[] = [];

    const entries = fs.readdirSync(folder, { withFileTypes: true });

    // Case A: the selected folder is itself one OCR doc — has a Data/ subfolder
    const hasData = entries.some((e) => e.isDirectory() && e.name === 'Data');
    if (hasData) {
      const found = findOcrJson(path.join(folder, 'Data'));
      if (found) {
        discovered.push({
          json_path: found,
          base_name: path.basename(folder),
          doc_folder: folder,
        });
      }
    }

    // Case B: the selected folder is a parent of many OCR doc folders
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const docFolder = path.join(folder, entry.name);
      const dataDir = path.join(docFolder, 'Data');
      if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) continue;

      const found = findOcrJson(dataDir);
      if (found) {
        // Avoid duplicating Case A if selected folder also matched
        if (!discovered.some((d) => d.json_path === found)) {
          discovered.push({
            json_path: found,
            base_name: entry.name,
            doc_folder: docFolder,
          });
        }
      }
    }

    // Case C: a loose .json directly in the selected folder (user points to
    // a raw export they saved outside the Data/ layout)
    if (discovered.length === 0) {
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
          discovered.push({
            json_path: path.join(folder, entry.name),
            base_name: path.parse(entry.name).name,
            doc_folder: folder,
          });
        }
      }
    }

    return Response.json({ files: discovered });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'scan failed';
    return Response.json({ error: message }, { status: 500 });
  }
}

function findOcrJson(dataDir: string): string | null {
  try {
    const files = fs.readdirSync(dataDir).filter((f) => f.toLowerCase().endsWith('.json'));
    if (files.length === 0) return null;
    // Prefer *_ocr_data.json, else first .json
    const preferred = files.find((f) => f.toLowerCase().endsWith('_ocr_data.json'));
    return path.join(dataDir, preferred ?? files[0]);
  } catch {
    return null;
  }
}
