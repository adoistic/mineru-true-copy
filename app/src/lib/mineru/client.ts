import { MineruOutput } from '@/types';
import fs from 'fs';
import path from 'path';

const HEALTH_CHECK_INTERVAL_MS = 30000;
const STARTUP_TIMEOUT_MS = 60000;

export type MineruStatus = 'stopped' | 'starting' | 'running' | 'crashed';

let mineruStatus: MineruStatus = 'stopped';
let healthCheckTimer: NodeJS.Timeout | null = null;

function getMineruUrl(): string {
  return process.env.MINERU_API_URL || 'http://127.0.0.1:8765';
}

export function getMineruStatus(): MineruStatus {
  return mineruStatus;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${getMineruUrl()}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      mineruStatus = 'running';
      return true;
    }
    return false;
  } catch {
    return false;
  }
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
  formulaDisplay?: 'rendered' | 'image';
  tableDisplay?: 'rendered' | 'image';
  includeFigures?: boolean;
  figureDisplay?: 'image' | 'text';
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
  if (options?.formulaDisplay) formData.append('formula_display', options.formulaDisplay);
  if (options?.tableDisplay) formData.append('table_display', options.tableDisplay);
  if (options?.includeFigures !== undefined) formData.append('include_figures', String(options.includeFigures));
  if (options?.figureDisplay) formData.append('figure_display', options.figureDisplay);

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
  const response = await fetch(`${getMineruUrl()}/tasks/${taskId}`, {
    signal: AbortSignal.timeout(10000),
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

export async function pollForCompletion(
  taskId: string,
  onProgress?: (pagesCompleted: number) => void,
  timeoutMs = 600000 // 10 minutes
): Promise<MineruOutput> {
  const start = Date.now();
  let lastPages = 0;

  while (Date.now() - start < timeoutMs) {
    const result = await getTaskResult(taskId);

    if (result.status === 'completed' && result.result) {
      return result.result;
    }

    if (result.status === 'failed') {
      throw new Error(`MinerU processing failed: ${result.error || 'Unknown error'}`);
    }

    // Brief delay between polls
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error('MinerU processing timed out');
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
