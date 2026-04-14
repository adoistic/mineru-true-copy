import { MineruOutput } from '@/types';
import fs from 'fs';
import path from 'path';
import { Agent, fetch as undiciFetch } from 'undici';

// undici (Node's built-in fetch implementation) defaults bodyTimeout to
// 5 minutes — if the upstream is silent for that long, the connection
// is aborted. For long-running translations (~14 min on math-heavy docs)
// that's catastrophic. This dispatcher disables both header and body
// timeouts so we can wait as long as the upstream needs.
const LONG_RUNNING_DISPATCHER = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  keepAliveTimeout: 60_000,
});

const HEALTH_CHECK_INTERVAL_MS = 30000;
const STARTUP_TIMEOUT_MS = 60000;

export type MineruStatus = 'stopped' | 'starting' | 'running' | 'crashed';

let mineruStatus: MineruStatus = 'stopped';
let healthCheckTimer: NodeJS.Timeout | null = null;

export function getMineruUrl(): string {
  return process.env.MINERU_API_URL || 'http://localhost:51820';
}

export function getMineruStatus(): MineruStatus {
  return mineruStatus;
}

export interface HealthStatus {
  status: string;
  cloud_available: boolean;
  local_available: boolean;
  modes: string[];
}

let _lastHealth: HealthStatus | null = null;

export async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${getMineruUrl()}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      mineruStatus = 'running';
      _lastHealth = await response.json();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function getLastHealth(): HealthStatus | null {
  return _lastHealth;
}

export async function waitForReady(timeoutMs = STARTUP_TIMEOUT_MS): Promise<boolean> {
  const start = Date.now();
  mineruStatus = 'starting';

  while (Date.now() - start < timeoutMs) {
    const healthy = await checkHealth();
    if (healthy) {
      mineruStatus = 'running';
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  mineruStatus = 'crashed';
  return false;
}

export function startHealthMonitoring(): void {
  if (healthCheckTimer) return;

  healthCheckTimer = setInterval(async () => {
    if (mineruStatus === 'running') {
      const healthy = await checkHealth();
      if (!healthy) {
        console.warn('[MinerU] Health check failed');
        mineruStatus = 'crashed';
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

export function stopHealthMonitoring(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

export interface SubmitOptions {
  formulaEnable?: boolean;
  formulaDisplay?: 'rendered' | 'image';
  tableDisplay?: 'rendered' | 'image';
  includeFigures?: boolean;
  figureDisplay?: 'image' | 'text';
  processingMode?: 'local' | 'cloud';
  tableMode?: 'local' | 'cloud';
  ocrLang?: string;
}

export async function submitFile(filePath: string, options?: SubmitOptions): Promise<string> {
  if (mineruStatus !== 'running') {
    // Try to check health first
    const healthy = await checkHealth();
    if (!healthy) {
      throw new Error('MinerU is not running. Status: ' + mineruStatus);
    }
  }

  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), fileName);
  formData.append('parse_method', 'auto');
  formData.append('is_json_md_dump', 'true');
  if (options?.formulaEnable !== undefined) formData.append('formula_enable', String(options.formulaEnable));
  if (options?.formulaDisplay) formData.append('formula_display', options.formulaDisplay);
  if (options?.tableDisplay) formData.append('table_display', options.tableDisplay);
  if (options?.includeFigures !== undefined) formData.append('include_figures', String(options.includeFigures));
  if (options?.figureDisplay) formData.append('figure_display', options.figureDisplay);
  if (options?.processingMode) formData.append('processing_mode', options.processingMode);
  if (options?.tableMode) formData.append('table_mode', options.tableMode);
  if (options?.ocrLang) formData.append('ocr_lang', options.ocrLang);

  const response = await fetch(`${getMineruUrl()}/file_parse`, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(300000), // 5 minute timeout for large files
  });

  if (!response.ok) {
    const error = await response.text().catch(() => 'Unknown error');
    throw new Error(`MinerU file_parse failed: ${response.status} ${error}`);
  }

  const data = await response.json();
  return data.task_id;
}

export async function getTaskResult(taskId: string): Promise<{
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: MineruOutput;
  error?: string;
}> {
  // Completed tasks for large/dense PDFs can return multi-megabyte JSON
  // (10k+ font spans, hundreds of blocks). 10s is too tight for that
  // transfer under load. 120s covers a couple-hundred-MB result comfortably.
  const response = await fetch(`${getMineruUrl()}/tasks/${taskId}`, {
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    throw new Error(`MinerU task query failed: ${response.status}`);
  }

  const data = await response.json();

  if (data.status === 'completed' && data.result) {
    return {
      status: 'completed',
      result: parseMineruResult(data.result),
    };
  }

  return {
    status: data.status,
    error: data.error,
  };
}

/**
 * Generic polling loop — reusable for OCR (MinerU) and translation tasks.
 * Calls `pollFn` every `intervalMs` until it returns `{ done: true }` or
 * throws on failure / timeout.
 */
export async function pollTask<T>(opts: {
  pollFn: () => Promise<{ done: boolean; result?: T; failed?: boolean; error?: string; progress?: number }>;
  onProgress?: (progress: number) => void;
  intervalMs?: number;
  timeoutMs?: number;
  label?: string;
}): Promise<T> {
  const { pollFn, onProgress, intervalMs = 2000, label = 'Task' } = opts;
  // Default deadline is generous so batch jobs waiting behind hundreds of
  // others on a semaphore don't time out.
  const timeoutMs = opts.timeoutMs ?? 24 * 60 * 60 * 1000; // 24 hours
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const poll = await pollFn();

    if (poll.done && poll.result !== undefined) {
      return poll.result;
    }

    if (poll.failed) {
      throw new Error(`${label} failed: ${poll.error || 'Unknown error'}`);
    }

    if (poll.progress !== undefined && onProgress) {
      onProgress(poll.progress);
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error(`${label} timed out`);
}

export async function pollForCompletion(
  taskId: string,
  onProgress?: (pagesCompleted: number) => void,
  timeoutMs = 24 * 60 * 60 * 1000
): Promise<MineruOutput> {
  return pollTask<MineruOutput>({
    pollFn: async () => {
      const result = await getTaskResult(taskId);
      if (result.status === 'completed' && result.result) {
        return { done: true, result: result.result };
      }
      if (result.status === 'failed') {
        return { done: false, failed: true, error: result.error };
      }
      return { done: false };
    },
    onProgress,
    timeoutMs,
    label: 'MinerU processing',
  });
}

/**
 * Fetch native exports from MinerU server.
 * These call pipe_result.get_markdown() / get_content_list() on the Python side.
 */

export async function getPageImage(taskId: string, pageIdx: number): Promise<Buffer> {
  const response = await fetch(`${getMineruUrl()}/tasks/${taskId}/page_image/${pageIdx}`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`Page image fetch failed: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Signal the server to free heavy resources for a completed task.
 * Fire-and-forget: auto-cleanup thread is the safety net.
 */
export async function deleteTask(taskId: string): Promise<void> {
  try {
    const response = await fetch(`${getMineruUrl()}/tasks/${taskId}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.warn(`[MinerU] DELETE task ${taskId} failed: ${response.status}`);
    }
  } catch (err) {
    console.warn(`[MinerU] DELETE task ${taskId} error:`, err);
  }
}

function parseMineruResult(raw: unknown): MineruOutput {
  // MinerU returns a structured JSON with pages and their content blocks
  // This normalizes it into our internal format
  const data = raw as Record<string, unknown>;

  if (Array.isArray(data)) {
    // MinerU may return an array of pages directly
    return {
      pages: data.map((page: Record<string, unknown>, idx: number) => ({
        page_number: idx + 1,
        width: ((page.page_size as Record<string, unknown>)?.width as number) || 612,
        height: ((page.page_size as Record<string, unknown>)?.height as number) || 792,
        regions: parseRegions(page),
      })),
      metadata: {
        total_pages: data.length,
        file_name: '',
      },
    };
  }

  // Handle object-style response
  const pages = (data.pdf_info || data.pages || []) as Record<string, unknown>[];
  return {
    pages: pages.map((page, idx) => ({
      page_number: idx + 1,
      width: ((page.page_size as Record<string, unknown>)?.width as number) || 612,
      height: ((page.page_size as Record<string, unknown>)?.height as number) || 792,
      regions: parseRegions(page),
    })),
    metadata: {
      total_pages: pages.length,
      file_name: (data.file_name as string) || '',
    },
    used_fonts: (data.used_fonts as Record<string, string>) || undefined,
  };
}

function parseRegions(page: Record<string, unknown>): MineruOutput['pages'][0]['regions'] {
  const blocks = (page.preproc_blocks || page.blocks || page.para_blocks || []) as Record<string, unknown>[];

  return blocks.map(block => {
    const type = mapBlockType(block.type as string);
    const bbox = (block.bbox || [0, 0, 0, 0]) as [number, number, number, number];

    return {
      type,
      bbox,
      content: extractContent(block),
      page_number: (page.page_idx as number || 0) + 1,
      level: block.level as number | undefined,
      html: block.html as string | undefined,
      table_html: block.table_html as string | undefined,
      latex: block.latex as string | undefined,
      img_data: block.img_data as string | undefined,
      img_mime: block.img_mime as string | undefined,
      inline_equations: block.inline_equations as Array<{latex: string; display: string; img_data?: string; img_mime?: string}> | undefined,
      content_per_page: block.text_per_page as string | undefined,
      inline_equations_per_page: block.inline_equations_per_page as Array<{latex: string; display: string; img_data?: string; img_mime?: string}> | undefined,
      font_family: block.font_family as string | undefined,
    };
  });
}

function mapBlockType(type: string): MineruOutput['pages'][0]['regions'][0]['type'] {
  const typeMap: Record<string, MineruOutput['pages'][0]['regions'][0]['type']> = {
    'text': 'text',
    'title': 'title',
    'table': 'table',
    'figure': 'figure',
    'equation': 'formula',
    'header': 'header',
    'footer': 'footer',
    'list': 'list',
    'caption': 'caption',
    'interline_equation': 'formula',
    'inline_equation': 'formula',
    'image': 'figure',
    'image_body': 'figure',
  };
  return typeMap[type] || 'text';
}

// ---------------------------------------------------------------------------
// Translation server client
// ---------------------------------------------------------------------------

const TRANSLATION_SERVER_URL = process.env.TRANSLATION_API_URL || 'http://localhost:51823';

export function getTranslationServerUrl(): string {
  return TRANSLATION_SERVER_URL;
}

export async function checkTranslationHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${TRANSLATION_SERVER_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function submitTranslation(
  jsonData: Record<string, unknown>,
  srcLang: string,
  tgtLang: string,
  modelVariant: string = '1B',
): Promise<{ translated_json: Record<string, unknown>; duration_ms: number }> {
  // undici's default bodyTimeout (5 min) kills the connection during long
  // translations. Use LONG_RUNNING_DISPATCHER (no body/header timeout).
  // Cast: undici's fetch type is structurally compatible with global fetch
  // but TypeScript doesn't see them as identical because of subtype drift.
  const response = await undiciFetch(`${TRANSLATION_SERVER_URL}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      json_data: jsonData,
      src_lang: srcLang,
      tgt_lang: tgtLang,
      model_variant: modelVariant,
    }),
    dispatcher: LONG_RUNNING_DISPATCHER,
    // Belt + suspenders: total budget cap. 45 min covers any realistic doc.
    signal: AbortSignal.timeout(45 * 60 * 1000),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
    throw new Error(data.error || `Translation failed: ${response.status}`);
  }

  return (await response.json()) as { translated_json: Record<string, unknown>; duration_ms: number };
}

export async function submitTranslationBatch(
  items: Array<{ json_path: string; tgt_langs: string[] }>,
  srcLang: string,
  modelVariant: string,
  outputDir: string,
): Promise<string> {
  const response = await fetch(`${TRANSLATION_SERVER_URL}/translate/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items,
      src_lang: srcLang,
      model_variant: modelVariant,
      output_dir: outputDir,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(data.error || `Batch submission failed: ${response.status}`);
  }

  const data = await response.json();
  return data.task_id;
}

export async function getTranslationStatus(taskId: string): Promise<{
  task_id: string;
  status: 'processing' | 'completed' | 'failed';
  progress: { completed: number; total: number; current_file: string | null; current_lang: string | null };
  error?: string;
}> {
  const response = await fetch(`${TRANSLATION_SERVER_URL}/translate/status/${taskId}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`Translation status query failed: ${response.status}`);
  }
  return response.json();
}

export async function getTranslationModels(): Promise<{
  available: boolean;
  supported_languages: Record<string, string>;
  directions: string[];
  variants: string[];
  loaded: { direction: string; variant: string } | null;
}> {
  const response = await fetch(`${TRANSLATION_SERVER_URL}/translate/models`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`Translation models query failed: ${response.status}`);
  }
  return response.json();
}

export async function loadTranslationModel(direction: string, variant: string): Promise<void> {
  const response = await fetch(`${TRANSLATION_SERVER_URL}/translate/model/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction, variant }),
    signal: AbortSignal.timeout(300000), // model load can take a while
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(data.error || `Model load failed: ${response.status}`);
  }
}

export async function unloadTranslationModel(): Promise<void> {
  const response = await fetch(`${TRANSLATION_SERVER_URL}/translate/model/unload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`Model unload failed: ${response.status}`);
  }
}

export async function pollTranslationCompletion(
  taskId: string,
  onProgress?: (completed: number, total: number, currentLang: string | null) => void,
  timeoutMs = 24 * 60 * 60 * 1000,
): Promise<void> {
  await pollTask<true>({
    pollFn: async () => {
      const status = await getTranslationStatus(taskId);
      if (status.status === 'completed') {
        return { done: true, result: true as const };
      }
      if (status.status === 'failed') {
        return { done: false, failed: true, error: status.error };
      }
      if (onProgress) {
        onProgress(
          status.progress.completed,
          status.progress.total,
          status.progress.current_lang,
        );
      }
      return { done: false, progress: status.progress.completed };
    },
    timeoutMs,
    label: 'Translation',
  });
}

function extractContent(block: Record<string, unknown>): string {
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;

  // Handle nested spans/lines — join with space for text/title (visual line wraps),
  // keep \n for tables/lists (semantic separators)
  const blockType = block.type as string || 'text';
  const lines = (block.lines || []) as Record<string, unknown>[];
  const lineTexts = lines.map(line => {
    const spans = (line.spans || []) as Record<string, unknown>[];
    return spans.map(span => span.text || span.content || '').join('');
  });
  return lineTexts.join('\n');
}
