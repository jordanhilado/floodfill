-- Street network (static per city, seeded from OpenStreetMap by scripts/build-streets.ts)
CREATE TABLE segments (
  id INTEGER PRIMARY KEY,
  city TEXT NOT NULL,
  way_id INTEGER NOT NULL,
  name TEXT,
  highway TEXT,
  length_m REAL NOT NULL,
  foot INTEGER NOT NULL,
  bike INTEGER NOT NULL,
  min_lat REAL NOT NULL,
  min_lng REAL NOT NULL,
  max_lat REAL NOT NULL,
  max_lng REAL NOT NULL,
  coords TEXT NOT NULL -- encoded polyline, precision 6
);
CREATE INDEX segments_city ON segments (city);

-- Strava activities (summary from the list endpoint, detailed track from streams)
CREATE TABLE activities (
  id INTEGER PRIMARY KEY,
  name TEXT,
  sport_type TEXT,
  mode TEXT, -- 'foot' | 'bike' | NULL (not counted)
  start_date TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  distance_m REAL,
  moving_time_s INTEGER,
  city TEXT, -- city whose bounds the track touches
  summary_polyline TEXT,
  polyline TEXT, -- full-resolution track, precision 5
  -- ignored: not a foot/bike activity or outside every enabled city
  -- summary: matched using the summary polyline, detailed track still to fetch
  -- detailed: matched using the full GPS stream
  -- error: stream unavailable
  status TEXT NOT NULL,
  new_segments INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX activities_status ON activities (status, start_ts DESC);

-- What each activity contributed: bitset of a segment's sample points that the
-- track passed within the match radius of. Replaced when the detailed track arrives.
CREATE TABLE activity_segments (
  activity_id INTEGER NOT NULL,
  segment_id INTEGER NOT NULL,
  mask INTEGER NOT NULL,
  PRIMARY KEY (activity_id, segment_id)
) WITHOUT ROWID;
CREATE INDEX activity_segments_segment ON activity_segments (segment_id);

-- Per-segment, per-mode coverage: OR of all activity masks for that mode.
CREATE TABLE coverage (
  segment_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  mask INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  first_activity_id INTEGER,
  completed_at TEXT,
  PRIMARY KEY (segment_id, mode)
) WITHOUT ROWID;
CREATE INDEX coverage_mode_completed ON coverage (mode, completed);

-- Small key/value state: OAuth tokens, sync cursors, rate-limit usage, lock.
CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  requests INTEGER NOT NULL DEFAULT 0,
  listed INTEGER NOT NULL DEFAULT 0,
  detailed INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  error TEXT
);
