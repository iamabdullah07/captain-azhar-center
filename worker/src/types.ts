export interface Env {
  FILES: R2Bucket;
  DB: D1Database;
  ADMIN_EMAIL?: string;
  SESSION_SECRET?: string;
  EMAIL_API_KEY?: string;
  EMAIL_PROVIDER?: string;
  EMAIL_FROM?: string;
  TURNSTILE_SECRET_KEY?: string;
  ALLOWED_ORIGINS?: string;
  FRONTEND_URL?: string;
  APP_NAME?: string;
  SAME_ORIGIN_COOKIES?: string;
  UPLOAD_RATE_LIMIT_MAX?: string;
  UPLOAD_RATE_LIMIT_WINDOW_SECONDS?: string;
  WORD_CONVERTER_URL?: string;
  WORD_CONVERTER_SECRET?: string;
  GEMINI_API_KEY?: string;
  GEMINI_API_KEYS?: string;
  EXTRACT_MAX_PDF_MB?: string;
  EXTRACT_CONCURRENCY?: string;
}

export type ItemType = 'link' | 'image' | 'document' | 'video';
export type ItemStatus = 'active' | 'removed' | 'blocked';

export interface LinkFileRow {
  id: string;
  type: ItemType;
  original_name: string | null;
  mime_type: string | null;
  size_bytes: number;
  r2_key: string | null;
  target_url: string | null;
  created_at: number;
  delete_token_hash: string | null;
  status: ItemStatus;
  removed_reason: string | null;
}

export interface AdminUserRow {
  id: number;
  email: string;
  password_hash: string;
  salt: string;
  created_at: number;
}

export interface StorageStatsRow {
  id: number;
  total_bytes: number;
  trigger_pct: number;
  target_pct: number;
  expire_links_months: number | null;
  cleanup_lock_until: number;
  last_alert_at: number;
}

export interface CleanupLogRow {
  id: number;
  run_time: number;
  files_deleted: number;
  bytes_freed: number;
  total_after: number;
  trigger: 'upload' | 'daily' | 'manual';
}

export interface ReportRow {
  id: number;
  file_id: string;
  reason: string;
  time: number;
  resolved: number;
}

export interface GeminiApiKeyRow {
  id: string;
  label: string | null;
  encrypted_key: string;
  masked_key: string;
  key_hash: string;
  enabled: number;
  cooldown_until: number;
  last_used_at: number;
  success_count: number;
  error_count: number;
  last_error: string | null;
  created_at: number;
}

export interface GeminiKeyRuntimeRow {
  key_hash: string;
  cooldown_until: number;
  last_used_at: number;
  success_count: number;
  error_count: number;
  last_error: string | null;
}

export interface ExtractSettingsRow {
  id: number;
  max_pdf_mb: number;
  concurrency: number;
  inline_threshold_mb: number;
  key_rr_cursor: number;
  daily_token_budget: number;
}

export interface GeminiKeyDailyUsageRow {
  key_hash: string;
  usage_date: string;
  prompt_tokens: number;
  output_tokens: number;
  total_tokens: number;
  requests_count: number;
  last_used_at: number;
}

export interface ExtractionFileRow {
  id: string;
  r2_key: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  access_token_hash: string;
  created_at: number;
  expires_at: number;
  status: 'active' | 'removed';
}
