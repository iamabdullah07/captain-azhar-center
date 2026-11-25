-- Track per-(key_hash, model_id) cooldowns so a single-model 429 does not block fallback models on the same key

CREATE TABLE IF NOT EXISTS gemini_key_model_cooldowns (
  key_hash TEXT NOT NULL,
  model_id TEXT NOT NULL,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (key_hash, model_id)
);
