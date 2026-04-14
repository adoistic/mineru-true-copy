import { submitTranslation } from '@/lib/mineru/client';
import { exportAll } from '@/lib/export';
import { NextRequest } from 'next/server';
import type { ExportFormat, MineruOutput } from '@/types';
import fs from 'fs';
import path from 'path';

/**
 * WebKit / WKWebView aborts fetch() if no bytes arrive for ~60s
 * (timeoutIntervalForRequest), regardless of any AbortSignal the caller
 * set. Long translations (~14 min for 282 regions) blow right past
 * that. So instead of a normal JSON response we stream: send a
 * whitespace byte every KEEPALIVE_INTERVAL_MS while the translation
 * is still running, then append the real JSON payload at the end.
 * JSON allows arbitrary leading whitespace, so res.json() on the
 * client parses correctly regardless of how many spaces we sent.
 */
const KEEPALIVE_INTERVAL_MS = 25_000; // 25s — comfortably under WebKit's 60s
const KEEPALIVE_BYTE = ' ';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) {
    return Response.json({ error: 'invalid json body' }, { status: 400 });
  }

  const {
    json_data: bodyJsonData,
    json_path,
    src_lang,
    tgt_lang,
    model_variant = '1B',
    output_folder,
    file_name: bodyFileName,
    output_formats,
    remove_headers_footers,
    formula_display,
    table_display,
    include_figures,
    figure_display,
  } = body;

  if (!tgt_lang) {
    return Response.json({ error: 'tgt_lang is required' }, { status: 400 });
  }

  // Accept either inline json_data (single-file UI) or a json_path
  // (folder-scan). json_path is resolved and loaded here.
  let json_data = bodyJsonData;
  let file_name = bodyFileName;
  if (!json_data && json_path) {
    if (!fs.existsSync(json_path)) {
      return Response.json({ error: `json_path not found: ${json_path}` }, { status: 400 });
    }
    json_data = JSON.parse(fs.readFileSync(json_path, 'utf-8'));
    if (!file_name) file_name = path.basename(json_path);
  }

  if (!json_data) {
    return Response.json({ error: 'json_data or json_path is required' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let done = false;
      // Keepalive: emit a whitespace byte every KEEPALIVE_INTERVAL_MS while
      // we wait on the Python server so WebKit doesn't time out the socket.
      const keepalive = setInterval(() => {
        if (done) return;
        try {
          controller.enqueue(encoder.encode(KEEPALIVE_BYTE));
        } catch {
          // Controller closed — stop.
        }
      }, KEEPALIVE_INTERVAL_MS);

      const finish = (payload: object) => {
        done = true;
        clearInterval(keepalive);
        try {
          controller.enqueue(encoder.encode(JSON.stringify(payload)));
          controller.close();
        } catch {
          // Already closed — nothing to do.
        }
      };

      try {
        const result = await submitTranslation(json_data, src_lang, tgt_lang, model_variant);

        let outputFile: string | undefined;
        let outputFiles: string[] = [];

        if (output_folder && file_name) {
          let baseName = path.parse(file_name).name;
          if (baseName.toLowerCase().endsWith('_ocr_data')) {
            baseName = baseName.slice(0, -'_ocr_data'.length);
          }
          const docFolder = path.join(output_folder, baseName);
          const langFolder = path.join(docFolder, tgt_lang);
          fs.mkdirSync(langFolder, { recursive: true });

          outputFile = path.join(langFolder, `${baseName}_${tgt_lang}.json`);
          fs.writeFileSync(outputFile, JSON.stringify(result.translated_json, null, 2));
          outputFiles.push(outputFile);

          const requested = Array.isArray(output_formats) ? (output_formats as ExportFormat[]) : [];
          const formats = requested.filter((f) => f !== 'searchable_pdf');

          if (formats.length > 0) {
            try {
              const exported = await exportAll({
                mineruOutput: result.translated_json as unknown as MineruOutput,
                taskId: undefined,
                formats,
                outputFolder: langFolder,
                baseName: `${baseName}_${tgt_lang}`,
                originalPdfPath: '',
                removeHeadersFooters: Boolean(remove_headers_footers),
                formulaDisplay: formula_display === 'image' ? 'image' : 'rendered',
                tableDisplay: table_display === 'image' ? 'image' : 'rendered',
                includeFigures: include_figures !== false,
                figureDisplay: figure_display === 'text' ? 'text' : 'image',
              });
              outputFiles = outputFiles.concat(exported);
            } catch (err) {
              console.error('[Translation] Export pipeline failed:', err);
            }
          }
        }

        finish({
          translated_json: result.translated_json,
          duration_ms: result.duration_ms,
          output_file: outputFile,
          output_files: outputFiles,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Translation failed';
        // Emit the error payload with the same streaming envelope so the
        // client still sees a valid JSON body. Status stays 200 — the client
        // inspects the body for `error`. (We can't set a non-2xx status from
        // a ReadableStream body started like this without re-architecting.)
        finish({ error: message });
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      // Hint proxies / dev servers not to buffer.
      'X-Accel-Buffering': 'no',
    },
  });
}
