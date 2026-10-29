-- Streets are grouped and looked up by name for the street ranking.
CREATE INDEX segments_city_name ON segments (city, name);
