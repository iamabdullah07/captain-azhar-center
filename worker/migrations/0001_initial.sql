-- Captain Azhar Center — D1 Initial Schema

-- 1. Uploaded files and shortened links
CREATE TABLE IF NOT EXISTS links_files (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('link', 'image', 'document', 'video')),
  original_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,
  target_url TEXT,
  created_at INTEGER NOT NULL,
  delete_token_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed', 'blocked')),
  removed_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_links_files_cleanup
  ON links_files (status, type, created_at, id);

CREATE INDEX IF NOT EXISTS idx_links_files_created
  ON links_files (created_at DESC);

-- 2. Single-owner admin account (enforced at DB level: at most 1 row with id = 1)
CREATE TABLE IF NOT EXISTS admin_user (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 3. Active admin sessions (token stored hashed)
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
  ON admin_sessions (expires_at);

-- 4. One-time password resets (30-minute TTL)
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- 5. Storage cleanup audit log
CREATE TABLE IF NOT EXISTS cleanup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_time INTEGER NOT NULL,
  files_deleted INTEGER NOT NULL,
  bytes_freed INTEGER NOT NULL,
  total_after INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('upload', 'daily', 'manual'))
);

-- 6. Running storage stats & admin-configurable thresholds (single row id = 1)
CREATE TABLE IF NOT EXISTS storage_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_bytes INTEGER NOT NULL DEFAULT 0,
  trigger_pct INTEGER NOT NULL DEFAULT 80,
  target_pct INTEGER NOT NULL DEFAULT 70,
  expire_links_months INTEGER DEFAULT NULL,
  cleanup_lock_until INTEGER NOT NULL DEFAULT 0,
  last_alert_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO storage_stats (id, total_bytes, trigger_pct, target_pct)
VALUES (1, 0, 80, 70);

-- 7. Login & failed attempt log (never stores passwords)
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time INTEGER NOT NULL,
  ip TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_time
  ON login_attempts (time DESC);

-- 8. Public abuse reports
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  time INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_reports_time
  ON reports (time DESC);

-- 9. Sliding/fixed-window rate limits stored in D1 (avoids KV 1k writes/day free limit)
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
