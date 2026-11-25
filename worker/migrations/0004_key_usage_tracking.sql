-- Track daily Gemini token/request usage per API key hash and configurable daily token budget

ALTER TABLE extract_settings ADD COLUMN daily_token_budget INTEGER NOT NULL DEFAULT 1000000;

CREATE TABLE IF NOT EXISTS gemini_key_daily_usage (
  key_hash TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  requests_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_hash, usage_date)
);
