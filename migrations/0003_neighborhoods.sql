-- Official neighborhood each segment's midpoint falls in (NULL if outside all of them).
ALTER TABLE segments ADD COLUMN neighborhood TEXT;
CREATE INDEX segments_neighborhood ON segments (city, neighborhood);
