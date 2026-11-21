-- Back up and inspect owner records before running this migration.
-- The index intentionally fails if more than one owner exists; do not delete
-- or demote an account without first resolving the conflict deliberately.
CREATE TABLE IF NOT EXISTS admin_users (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  password_hash TEXT NOT NULL, salt TEXT NOT NULL,
  iterations INTEGER NOT NULL DEFAULT 100000,
  permissions TEXT NOT NULL DEFAULT '[]',
  is_owner INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
  stamp TEXT NOT NULL, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP, last_login TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_single_owner
  ON admin_users(is_owner) WHERE is_owner = 1;
