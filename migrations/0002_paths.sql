-- Network now includes paths (footways, trails, cycleways, steps) alongside streets.
ALTER TABLE segments ADD COLUMN kind TEXT NOT NULL DEFAULT 'street';
