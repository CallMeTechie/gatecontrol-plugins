-- Drive 1.26.0: the page „Erinnerungen“ (server/memories.js) groups every private photo of a person by the hour it was
-- taken and its city. This index holds every column that query reads, so it never reads the rows of nodes themselves
-- (50 000 photos: well under 200 ms).
CREATE INDEX nodes_memories ON nodes (area_id, is_dir, deleted_at, taken_at, mtime, created_at, geo_place, review_at, parent_id, vault_id, mime) WHERE is_dir = 0 AND deleted_at IS NULL;
