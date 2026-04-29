/**
 * EPUB export: generates a reflowable EPUB from HTML content.
 */
import fs from 'fs';

export async function createEpub(
  htmlContent: string,
  title: string,
  outputPath: string
): Promise<void> {
  try {
    // Dynamic import for epub-gen-memory
    const epubGen = await import('epub-gen-memory');
    const EPub = epubGen.default || epubGen;

    // Extract body content from full HTML
    const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    const bodyContent = bodyMatch ? bodyMatch[1] : htmlContent;

    // Split into chapters by H1 tags
    const chapters = splitIntoChapters(bodyContent, title);

    const options = {
      title,
      author: 'MinerU True Copy',
    };

    const epubBuffer = await EPub(options, chapters);
    fs.writeFileSync(outputPath, Buffer.from(epubBuffer));
  } catch (err) {
    console.error('[EPUB] Generation failed:', err);
    // Fallback: write a simple EPUB-compatible HTML
    const fallbackContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title></head>
<body>${htmlContent}</body>
</html>`;
    fs.writeFileSync(outputPath, fallbackContent, 'utf-8');
  }
}

function splitIntoChapters(html: string, defaultTitle: string): Array<{ title: string; content: string }> {
  const parts = html.split(/(?=<h1[^>]*>)/i);

  if (parts.length <= 1) {
    return [{ title: defaultTitle, content: html }];
  }

  return parts
    .filter(part => part.trim())
    .map((part, idx) => {
      const titleMatch = part.match(/<h1[^>]*>(.*?)<\/h1>/i);
      const title = titleMatch
        ? titleMatch[1].replace(/<[^>]*>/g, '').trim()
        : `Chapter ${idx + 1}`;

      return { title, content: part };
    });
}
