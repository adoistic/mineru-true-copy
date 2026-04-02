/**
 * ZIP export: bundles all selected output formats into a single archive.
 */
import archiver from 'archiver';
import fs from 'fs';
import path from 'path';

export async function createZip(filePaths: string[], outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => resolve());
    archive.on('error', (err) => reject(err));

    archive.pipe(output);

    for (const filePath of filePaths) {
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: path.basename(filePath) });
      }
    }

    archive.finalize();
  });
}
