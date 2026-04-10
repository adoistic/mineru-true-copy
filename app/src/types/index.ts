// Core types for DocTransform

export type JobType = 'ocr' | 'extract' | 'heading_correction' | 'wizard' | 'translate';
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'retrying' | 'permanently_failed';
export type PipelineErrorType = 'mineru_crash' | 'llm_api_error' | 'rate_limited' | 'insufficient_credits' | 'key_expired' | 'partial_failure' | 'network_error';
export type KeyStatus = 'active' | 'revoked' | 'expired';
export type ExportFormat = 'html' | 'markdown' | 'searchable_pdf' | 'epub' | 'json' | 'csv' | 'docx' | 'true_copy_html' | 'zip';

export interface Job {
  id: string;
  file_path: string;
  file_name: string;
  job_type: JobType;
  status: JobStatus;
  tool_config: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  error_type: PipelineErrorType | null;
  retry_count: number;
  credits_reserved: number;
  credits_charged: number;
  total_pages: number;
  completed_pages: number;
  output_folder: string;
  output_files?: string[];
}

export interface ActivationKey {
  key: string;
  client_label: string;
  credit_balance: number;
  credits_reserved: number;
  can_whitelabel: boolean;
  status: KeyStatus;
  device_id: string | null;
  app_name: string | null;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

export interface UsageLog {
  key_id: string;
  job_type: JobType;
  file_name: string;
  pages_processed: number;
  credits_charged: number;
  status: 'success' | 'partial' | 'failed';
  error_message: string | null;
  timestamp: string;
}

export interface SchemaTemplate {
  id: string;
  name: string;
  description: string;
  schema: Record<string, unknown>;
  prompt: string;
  created_at: string;
  updated_at: string;
}

export interface MineruRegion {
  type: 'text' | 'title' | 'table' | 'figure' | 'formula' | 'header' | 'footer' | 'list' | 'caption';
  bbox: [number, number, number, number]; // [x1, y1, x2, y2]
  content: string;
  page_number: number;
  html?: string;
  table_html?: string;
  latex?: string;
  img_data?: string; // Base64-encoded image data
  img_mime?: string; // MIME type (image/jpeg, image/png)
  level?: number; // Heading level 1-6 for title regions (set by heading correction)
  inline_equations?: Array<{latex: string; display: string; img_data?: string; img_mime?: string; bbox?: [number, number, number, number]; line_bbox?: [number, number, number, number]}>;
  // Per-page (un-merged) variants for true-copy export.
  // MinerU merges cross-page paragraphs for reading order, which stuffs
  // continuation text into the earlier page's bbox. True-copy needs the
  // per-page view so each region only holds what visually sits in its bbox.
  // Normal HTML/markdown export ignores these and uses `content` as usual.
  content_per_page?: string;
  inline_equations_per_page?: Array<{latex: string; display: string; img_data?: string; img_mime?: string; bbox?: [number, number, number, number]; line_bbox?: [number, number, number, number]}>;
  /** Font family name from bundled fonts (e.g. "Arimo", "Tinos"). True-copy only. */
  font_family?: string;
  children?: MineruRegion[];
}

export interface MineruPage {
  page_number: number;
  width: number;
  height: number;
  regions: MineruRegion[];
}

export interface MineruOutput {
  pages: MineruPage[];
  metadata: {
    total_pages: number;
    file_name: string;
  };
  /** Map of bundled WOFF2 filename → CSS family name. Only fonts used in this document. */
  used_fonts?: Record<string, string>;
}

export interface LLMCallOptions {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' };
}

export interface LLMResponse {
  content: string;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface PipelineProgress {
  job_id: string;
  current_page: number;
  total_pages: number;
  status: JobStatus;
  message?: string;
}

export interface CreditReservation {
  reservation_id: string;
  key_id: string;
  amount: number;
  job_id: string;
  created_at: string;
}

export interface ProcessingOptions {
  remove_headers_footers: boolean;
  remove_metadata: boolean;
  join_broken_pages: boolean;
  page_range?: { start: number; end: number };
  output_formats: ExportFormat[];
  output_folder: string;
  fix_headings?: boolean;
  formula_display?: 'rendered' | 'image';  // default 'image'
  table_display?: 'rendered' | 'image';    // default 'rendered'
  include_figures?: boolean;               // default true
  figure_display?: 'image' | 'text';       // default 'image'
  include_benchmark_images?: boolean;      // true-copy HTML: also produce version with page images
}

export interface ExtractionOptions {
  schema: Record<string, unknown>;
  prompt: string;
  output_formats: ('json' | 'csv')[];
  output_folder: string;
}

export interface WhiteLabelConfig {
  enabled: boolean;
  logo_path?: string;
  brand_color?: string;
  app_name?: string;
  mode?: 'light' | 'dark';
}
