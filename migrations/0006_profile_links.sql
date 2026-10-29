-- Public profile links: an X (Twitter) handle, and whether to link the connected Strava athlete.
ALTER TABLE users ADD COLUMN x_username TEXT;
ALTER TABLE users ADD COLUMN show_strava INTEGER NOT NULL DEFAULT 0;
