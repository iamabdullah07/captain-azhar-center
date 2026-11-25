-- All Files Data extraction, Gemini API keys (encrypted), and settings

CREATE TABLE IF NOT EXISTS gemini_api_keys (
  id TEXT PRIMARY KEY,
  label TEXT,
  encrypted_key TEXT NOT NULL,
  masked_key TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gemini_key_runtime (
  key_hash TEXT PRIMARY KEY,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS extract_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  max_pdf_mb INTEGER NOT NULL DEFAULT 50,
  concurrency INTEGER NOT NULL DEFAULT 5,
  inline_threshold_mb INTEGER NOT NULL DEFAULT 4,
  key_rr_cursor INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO extract_settings (id, max_pdf_mb, concurrency, inline_threshold_mb, key_rr_cursor)
VALUES (1, 50, 5, 4, 0);

CREATE TABLE IF NOT EXISTS extraction_files (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  access_token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed'))
);

CREATE INDEX IF NOT EXISTS idx_extraction_files_cleanup
  ON extraction_files (status, expires_at);
