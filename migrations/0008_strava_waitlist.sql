-- People who couldn't connect Strava because the app was at Strava's limit on connected athletes.
-- They're emailed, oldest first, as connections open up again.
CREATE TABLE strava_waitlist (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  notified_at INTEGER
);
