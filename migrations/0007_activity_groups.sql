-- The streets (by name) and neighborhoods each activity touched, so "activities per street /
-- neighborhood" counts read one row per pair instead of every matched segment. Derived from
-- activity_segments and segments: written alongside activity_segments when an activity is matched.
CREATE TABLE activity_groups (
  activity_id INTEGER NOT NULL,
  kind TEXT NOT NULL, -- 'name' | 'neighborhood'
  key TEXT NOT NULL,
  PRIMARY KEY (activity_id, kind, key)
) WITHOUT ROWID;

INSERT INTO activity_groups (activity_id, kind, key)
SELECT DISTINCT a.activity_id, 'neighborhood', s.neighborhood
FROM activity_segments a JOIN segments s ON s.id = a.segment_id
WHERE s.neighborhood IS NOT NULL;

INSERT INTO activity_groups (activity_id, kind, key)
SELECT DISTINCT a.activity_id, 'name', s.name
FROM activity_segments a JOIN segments s ON s.id = a.segment_id
WHERE s.name IS NOT NULL;
