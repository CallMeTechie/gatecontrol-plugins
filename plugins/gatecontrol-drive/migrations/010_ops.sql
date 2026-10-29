-- Drive 1.12.0: several files and folders at once (server/ops.js — move, copy, trash, restore, purge as one job with
-- progress, cancel and undo), a ZIP of a selection and one link for several files (server/links.js).

-- A job of a person. kind: move | copy | trash | restore | purge | undo (undo_of: the job it undoes); state: running |
-- done | failed (error: the code) | cancelled. ids: the node ids asked for (JSON). target_id: the folder of a move or a copy.
-- items / total / done / bytes_*: the ids asked for, the files (and their bytes) the job handles and has handled.
-- n_done / n_skipped / n_failed and failures (JSON [{ id, name, reason }], ≤ 100): the result by id asked for (a copy:
-- by file). transfer_at: when a device last brought the bytes of a copy (a copy without GateControl's gc.media.copy).
CREATE TABLE ops (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  device       TEXT,
  app          INTEGER NOT NULL DEFAULT 0,
  kind         TEXT NOT NULL CHECK (kind IN ('move', 'copy', 'trash', 'restore', 'purge', 'undo')),
  state        TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed', 'cancelled')),
  ids          TEXT NOT NULL,
  target_id    INTEGER,
  target_area  TEXT,
  target_path  TEXT,
  target_name  TEXT,
  on_conflict  TEXT NOT NULL DEFAULT 'version',
  undo_of      TEXT,
  label        TEXT,
  items        INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  done         INTEGER NOT NULL DEFAULT 0,
  bytes_total  INTEGER NOT NULL DEFAULT 0,
  bytes_done   INTEGER NOT NULL DEFAULT 0,
  n_done       INTEGER NOT NULL DEFAULT 0,
  n_skipped    INTEGER NOT NULL DEFAULT 0,
  n_failed     INTEGER NOT NULL DEFAULT 0,
  failures     TEXT,
  results      TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  undo_until   INTEGER,
  undone_by    TEXT,
  transfer_at  INTEGER
);
CREATE INDEX ops_user ON ops (user_id, created_at);
CREATE INDEX ops_state ON ops (state);

-- The work list of a job: one row per id asked for (move, trash, restore, purge); a copy has one row per node below
-- them (parent_seq: the row of the folder it goes into, null: the target); an undo one per step of the job it undoes
-- (step_seq). size / files: the bytes and files the row stands for (a folder: everything below it). state: pending |
-- transfer (a copy's file waits for its bytes — a device brings them, lease_until while one does) | done | skipped |
-- failed | cancelled. dest_id: the folder a copy goes into; mode: new | version (a copy onto the file of the same
-- name); existing_id: that file; result_id: the node made or changed.
CREATE TABLE op_items (
  op_id       TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  node_id     INTEGER NOT NULL,
  parent_seq  INTEGER,
  is_dir      INTEGER NOT NULL DEFAULT 0,
  name        TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  files       INTEGER NOT NULL DEFAULT 0,
  sha256      TEXT,
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'transfer', 'done', 'skipped', 'failed', 'cancelled')),
  dest_id     INTEGER,
  mode        TEXT,
  existing_id INTEGER,
  result_id   INTEGER,
  reason      TEXT,
  lease_until INTEGER,
  step_seq    INTEGER,
  PRIMARY KEY (op_id, seq)
);
CREATE INDEX op_items_state ON op_items (op_id, state);

-- What a job did, for its undo (in reverse order): moved { from: { parentId, name, areaId }, to: { parentId, name } },
-- trashed { at } (into the trash by this job), restored, created (a node a copy made — the top one of what it made),
-- versioned { rev, versionId } (a copy became the new content of a file), merged (a move made a file a version of
-- another one — not undone).
CREATE TABLE op_steps (
  op_id   TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  action  TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  data    TEXT,
  PRIMARY KEY (op_id, seq)
);

-- One link for several files (since 1.12.0): every file of a link (links.node_id is the first). A ZIP of a selection is
-- a short-lived link of GateControl too (zip = 1: not in the lists).
CREATE TABLE link_nodes (
  token   TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  PRIMARY KEY (token, node_id)
);
CREATE INDEX link_nodes_node ON link_nodes (node_id);
ALTER TABLE links ADD COLUMN zip INTEGER NOT NULL DEFAULT 0;
