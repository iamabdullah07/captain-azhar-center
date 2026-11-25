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
