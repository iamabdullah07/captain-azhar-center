-- Reservations for allocating a short ID before uploading the QR-embedded PDF
CREATE TABLE IF NOT EXISTS upload_reservations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  source_id TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_upload_reservations_expires
  ON upload_reservations (expires_at);
