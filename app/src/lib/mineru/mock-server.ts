/**
 * Mock MinerU REST API server for development.
 * Simulates /health, /file_parse, and /tasks endpoints.
 * Generates realistic structured output from PDF files.
 */
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';

interface MockTask {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  fileName: string;
  result?: unknown;
  createdAt: number;
}

const tasks = new Map<string, MockTask>();

function generateMockOutput(fileName: string): unknown {
  // Generate realistic MinerU-style output
  const pageCount = 5 + Math.floor(Math.random() * 20);
  const pages = [];

  for (let i = 0; i < pageCount; i++) {
    const blocks = [];

    // Title on first page
    if (i === 0) {
      blocks.push({
        type: 'title',
        bbox: [72, 72, 540, 120],
        text: `Document: ${fileName.replace('.pdf', '')}`,
      });
    }

    // Header (on every page)
    blocks.push({
      type: 'header',
      bbox: [72, 20, 540, 40],
      text: `Header - Page ${i + 1}`,
    });

    // Add some section headings
    if (i % 3 === 0 && i > 0) {
      blocks.push({
        type: 'title',
        bbox: [72, 80, 540, 110],
        text: `Section ${Math.ceil(i / 3)}: Sample Heading`,
      });
    }

    // Text paragraphs
    const paragraphCount = 2 + Math.floor(Math.random() * 4);
    let yPos = 140;
    for (let j = 0; j < paragraphCount; j++) {
      blocks.push({
        type: 'text',
        bbox: [72, yPos, 540, yPos + 60],
        text: `This is paragraph ${j + 1} on page ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.`,
      });
      yPos += 80;
    }

    // Add a table on some pages
    if (i % 4 === 2) {
      blocks.push({
        type: 'table',
        bbox: [72, yPos, 540, yPos + 120],
        text: 'Table content',
        table_html: `<table>
          <thead><tr><th>Column A</th><th>Column B</th><th>Column C</th></tr></thead>
          <tbody>
            <tr><td>Data 1</td><td>Value 1</td><td>100</td></tr>
            <tr><td>Data 2</td><td>Value 2</td><td>200</td></tr>
            <tr><td>Data 3</td><td>Value 3</td><td>300</td></tr>
          </tbody>
        </table>`,
      });
      yPos += 140;
    }

    // Add a formula on some pages
    if (i % 5 === 3) {
      blocks.push({
        type: 'equation',
        bbox: [72, yPos, 540, yPos + 40],
        text: 'E = mc^2',
        latex: 'E = mc^2',
      });
      yPos += 60;
    }

    // Add a list on some pages
    if (i % 3 === 1) {
      blocks.push({
        type: 'list',
        bbox: [72, yPos, 540, yPos + 80],
        text: '• First item in the list\n• Second item in the list\n• Third item in the list',
      });
      yPos += 100;
    }

    // Footer
    blocks.push({
      type: 'footer',
      bbox: [72, 750, 540, 770],
      text: `Page ${i + 1} of ${pageCount}`,
    });

    pages.push({
      page_idx: i,
      page_size: { width: 612, height: 792 },
      preproc_blocks: blocks,
    });
  }

  return pages;
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || '/', `http://localhost`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mock: true }));
    return;
  }

  // File parse
  if (url.pathname === '/file_parse' && req.method === 'POST') {
    const taskId = uuidv4();

    // Collect the request body to get filename
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const task: MockTask = {
        id: taskId,
        status: 'processing',
        fileName: 'uploaded.pdf',
        createdAt: Date.now(),
      };
      tasks.set(taskId, task);

      // Simulate processing delay (2-5 seconds)
      const delay = 2000 + Math.random() * 3000;
      setTimeout(() => {
        const t = tasks.get(taskId);
        if (t) {
          t.status = 'completed';
          t.result = generateMockOutput(t.fileName);
        }
      }, delay);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ task_id: taskId }));
    });
    return;
  }

  // Task status
  const taskMatch = url.pathname.match(/^\/tasks\/(.+)$/);
  if (taskMatch && req.method === 'GET') {
    const taskId = taskMatch[1];
    const task = tasks.get(taskId);

    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Task not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: task.status,
      result: task.status === 'completed' ? task.result : undefined,
      error: task.status === 'failed' ? 'Processing failed' : undefined,
    }));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

export function startMockMineruServer(port = 51820): http.Server {
  const server = http.createServer(handleRequest);
  server.listen(port, '127.0.0.1', () => {
    console.log(`[MinerU Mock] Running on http://127.0.0.1:${port}`);
  });
  return server;
}

// Run directly
if (require.main === module) {
  const port = parseInt(process.env.MINERU_PORT || '51820', 10);
  startMockMineruServer(port);
}
