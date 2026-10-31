-- Each user's progress per city and mode, so leaderboards and standings read one row per user
-- instead of every segment everyone has completed. applyActivityCoverage marks a row stale when
-- it changes coverage; the next read recomputes stale rows (refreshUserStats in queries.ts).
CREATE TABLE user_stats (
  user_id TEXT NOT NULL,
  city TEXT NOT NULL,
  mode TEXT NOT NULL,
  meters REAL NOT NULL DEFAULT 0,
  activities INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, city, mode)
) WITHOUT ROWID;
CREATE INDEX user_stats_stale ON user_stats (stale) WHERE stale = 1;

-- Everyone's existing progress, computed on first read.
INSERT INTO user_stats (user_id, city, mode)
SELECT DISTINCT user_id, city, mode FROM activities
WHERE user_id IS NOT NULL AND city IS NOT NULL AND mode IS NOT NULL;

-- Set by Strava webhook events (routes/api/strava/webhook.ts): this athlete has something new,
-- so the next sync lists their activities. Without webhooks, every account is listed each run.
ALTER TABLE strava_accounts ADD COLUMN pending_sync INTEGER NOT NULL DEFAULT 0;

-- Activities Strava says were deleted, checked with Strava and removed by the next sync.
CREATE TABLE strava_deletions (
  activity_id INTEGER PRIMARY KEY,
  athlete_id INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
