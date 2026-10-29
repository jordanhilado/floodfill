-- Accounts: email-code sign-in, a unique username, and a Strava connection per user.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,              -- stored lowercase
  username TEXT UNIQUE COLLATE NOCASE,     -- chosen after the first sign-in
  created_at INTEGER NOT NULL
);

-- One pending sign-in code per email (hashed), valid for a few minutes.
CREATE TABLE login_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL
);

-- Session cookies hold a random token; only its hash is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Strava OAuth tokens and import cursors, one athlete per user.
CREATE TABLE strava_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  athlete_id INTEGER NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  scope TEXT,
  backfill_before INTEGER,
  backfill_done INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER,
  connected_at INTEGER NOT NULL
);

-- Activities belong to a user. Rows imported before accounts existed have NULL and are
-- claimed by whichever user connects the Strava athlete they came from.
ALTER TABLE activities ADD COLUMN user_id TEXT;
CREATE INDEX activities_user ON activities (user_id, status, start_ts);

ALTER TABLE sync_runs ADD COLUMN user_id TEXT;

-- Coverage is now per user. It is derived data: re-matching stored tracks rebuilds it.
DROP TABLE coverage;
CREATE TABLE coverage (
  user_id TEXT NOT NULL,
  segment_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  mask INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  first_activity_id INTEGER,
  completed_at TEXT,
  PRIMARY KEY (user_id, segment_id, mode)
) WITHOUT ROWID;
CREATE INDEX coverage_mode_completed ON coverage (mode, completed, user_id);

-- Per-user import cursors replace the single-athlete ones.
DELETE FROM state WHERE key IN ('backfill', 'strava_token');
