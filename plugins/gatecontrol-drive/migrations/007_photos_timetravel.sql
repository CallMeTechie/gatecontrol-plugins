-- Drive 1.7.0: when a photo was taken, the history of names and folders (time travel), albums with the photo frame,
-- the overview of the storage.

-- uploads/commit { takenAt }: when the picture or video was taken (ms; null: not sent — mtime, then created_at count).
ALTER TABLE nodes ADD COLUMN taken_at INTEGER;
-- when the current bytes became the file's (a new file, a new version, a restored one); null: before 1.7.0
ALTER TABLE nodes ADD COLUMN content_at INTEGER;
CREATE INDEX nodes_taken ON nodes (COALESCE(taken_at, mtime, created_at)) WHERE is_dir = 0 AND deleted_at IS NULL;
CREATE INDEX nodes_sha ON nodes (sha256, size) WHERE is_dir = 0 AND deleted_at IS NULL;

-- versions: since when these bytes were the file's (null: before 1.7.0); hold_until: a version a time travel made —
-- its undo needs it, versions_max and versions_days leave it until then
ALTER TABLE versions ADD COLUMN since INTEGER;
ALTER TABLE versions ADD COLUMN hold_until INTEGER;

-- The history of a node (time travel, server/timetravel.js): the state before each rename or move (op 'move') and
-- before each restore from the trash (op 'restore': where it was and since when it was in the trash). Rows go with
-- the node (purge).
CREATE TABLE node_log (
  id            INTEGER PRIMARY KEY,
  node_id       INTEGER NOT NULL,
  at            INTEGER NOT NULL,
  op            TEXT NOT NULL CHECK (op IN ('move', 'restore')),
  area_id       TEXT NOT NULL,
  parent_id     INTEGER,
  name          TEXT NOT NULL,
  deleted_since INTEGER
);
CREATE INDEX node_log_node ON node_log (node_id, at);
CREATE INDEX node_log_parent ON node_log (parent_id, at);

-- Small values of the plugin: history_since — since when node_log is written (the first start of 1.7.0).
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- An album of an area (server/albums.js): it points at nodes, copies nothing. frame: shown on the photo frame of the
-- kiosk devices (frame_by: who switched it on — the frame shows what that person may read and still may show).
CREATE TABLE albums (
  id         INTEGER PRIMARY KEY,
  area_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  cover_id   INTEGER,
  frame      INTEGER NOT NULL DEFAULT 0,
  frame_by   INTEGER,
  created_at INTEGER NOT NULL,
  created_by INTEGER,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER
);
CREATE INDEX albums_area ON albums (area_id);

CREATE TABLE album_items (
  album_id INTEGER NOT NULL,
  node_id  INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  added_by INTEGER,
  PRIMARY KEY (album_id, node_id)
);
CREATE INDEX album_items_node ON album_items (node_id);
