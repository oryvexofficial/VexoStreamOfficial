-- Owner multi-notice banner (Admin > Notice, permission "notice")
-- Safe to run multiple times: only inserts notice_config if missing.
CREATE TABLE IF NOT EXISTS settings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,
  value       TEXT,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO settings (key, value)
VALUES ('notice_config', '{"items":[]}');
