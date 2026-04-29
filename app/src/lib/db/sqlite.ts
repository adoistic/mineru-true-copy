import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { Job, JobStatus, JobType, SchemaTemplate } from '@/types';
import { v4 as uuidv4 } from 'uuid';

let db: Database.Database | null = null;

function getDbPath(): string {
  const appDataDir = path.join(os.homedir(), '.mineru-true-copy');
  if (!fs.existsSync(appDataDir)) {
    fs.mkdirSync(appDataDir, { recursive: true });
  }
  return path.join(appDataDir, 'mineru-true-copy.db');
}

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = getDbPath();
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initSchema(db);
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      tool_config TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error_message TEXT,
      error_type TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      total_pages INTEGER NOT NULL DEFAULT 0,
      completed_pages INTEGER NOT NULL DEFAULT 0,
      output_folder TEXT NOT NULL DEFAULT '',
      output_files TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS schema_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      schema TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(job_type);
  `);
}

// Job operations
export function createJob(params: {
  file_path: string;
  file_name: string;
  job_type: JobType;
  tool_config: Record<string, unknown>;
  total_pages: number;
  output_folder: string;
}): Job {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  const job: Job = {
    id,
    file_path: params.file_path,
    file_name: params.file_name,
    job_type: params.job_type,
    status: 'queued',
    tool_config: params.tool_config,
    created_at: now,
    started_at: null,
    completed_at: null,
    error_message: null,
    error_type: null,
    retry_count: 0,
    total_pages: params.total_pages,
    completed_pages: 0,
    output_folder: params.output_folder,
  };

  db.prepare(`
    INSERT INTO jobs (id, file_path, file_name, job_type, status, tool_config, created_at, total_pages, output_folder)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.file_path, params.file_name, params.job_type, 'queued', JSON.stringify(params.tool_config), now, params.total_pages, params.output_folder);

  return job;
}

export function updateJobStatus(jobId: string, status: JobStatus, extra?: Partial<Job>): void {
  const db = getDb();
  const updates: string[] = ['status = ?'];
  const values: unknown[] = [status];

  if (status === 'processing') {
    const currentJob = getJob(jobId);
    if (!currentJob?.started_at) {
      updates.push('started_at = ?');
      values.push(new Date().toISOString());
    }
  }

  if (status === 'completed' || status === 'failed' || status === 'permanently_failed') {
    updates.push('completed_at = ?');
    values.push(new Date().toISOString());
  }

  if (extra?.error_message !== undefined) {
    updates.push('error_message = ?');
    values.push(extra.error_message);
  }

  if (extra?.error_type !== undefined) {
    updates.push('error_type = ?');
    values.push(extra.error_type);
  }

  if (extra?.completed_pages !== undefined) {
    updates.push('completed_pages = ?');
    values.push(extra.completed_pages);
  }

  if (extra?.retry_count !== undefined) {
    updates.push('retry_count = ?');
    values.push(extra.retry_count);
  }

  if (extra?.output_files !== undefined) {
    updates.push('output_files = ?');
    values.push(JSON.stringify(extra.output_files));
  }

  values.push(jobId);
  db.prepare(`UPDATE jobs SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

export function getJob(jobId: string): Job | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...row,
    tool_config: JSON.parse(row.tool_config as string),
    output_files: row.output_files ? JSON.parse(row.output_files as string) : [],
  } as Job;
}

export function getActiveJobs(): Job[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM jobs WHERE status IN ('queued', 'processing', 'retrying') ORDER BY created_at ASC").all() as Record<string, unknown>[];
  return rows.map(r => ({ ...r, tool_config: JSON.parse(r.tool_config as string) }) as Job);
}

export function resetStuckJobs(): number {
  const db = getDb();
  const result = db.prepare("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'processing'").run();
  return result.changes;
}

// Schema template operations
export function saveTemplate(template: Omit<SchemaTemplate, 'id' | 'created_at' | 'updated_at'>): SchemaTemplate {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO schema_templates (id, name, description, schema, prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, template.name, template.description, JSON.stringify(template.schema), template.prompt, now, now);

  return { id, ...template, created_at: now, updated_at: now };
}

export function getTemplates(): SchemaTemplate[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM schema_templates ORDER BY updated_at DESC').all() as Record<string, unknown>[];
  return rows.map(r => ({ ...r, schema: JSON.parse(r.schema as string) }) as SchemaTemplate);
}

export function deleteTemplate(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM schema_templates WHERE id = ?').run(id);
}
