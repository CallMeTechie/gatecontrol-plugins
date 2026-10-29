-- Drive 1.13.0: work photos apart (server/work.js, server/photos.js — feature `photoClasses`).

-- The review mark of a picture or video (POST photos/review): review_at — since when it is to be checked (null: not
-- marked), review_hint — how likely it is a work photo in % (0 … 100, the device's AI; null: no guess), review_by — who
-- marked it. A move into or out of the mover's work folder ends it (nodes.update), so does review: false.
ALTER TABLE nodes ADD COLUMN review_at INTEGER;
ALTER TABLE nodes ADD COLUMN review_hint INTEGER;
ALTER TABLE nodes ADD COLUMN review_by INTEGER;
CREATE INDEX nodes_review ON nodes (review_at) WHERE review_at IS NOT NULL;

-- A person's photo settings (GET|PUT photos/settings) — the same on every device and in the portal. work_folder: the
-- folder work photos go into (a folder they write to, no vault; null: none); work_subfolders: <year>/<month> below it
-- (the devices make them); work_in_memories: the work folder in memories and on the photo frame (0: left out).
CREATE TABLE photo_settings (
  user_id          INTEGER PRIMARY KEY,
  work_folder      INTEGER,
  work_subfolders  INTEGER NOT NULL DEFAULT 1,
  work_in_memories INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);
