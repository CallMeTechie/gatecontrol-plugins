-- Drive 1.8.0: AI for documents (server/insights.js, server/deadlines.js) and the import from Google Drive and OneDrive
-- (server/imports.js). Both need GateControl's AI service (gc.ai) or cloud accounts (gc.cloud) — without them these
-- tables stay empty.

-- What the AI suggested for a file — at most one recognition per version (rev). status: pending (in the queue of the
-- background run), ready, failed (error: the code). kind: invoice | contract | notice | medical | certificate |
-- statement | insurance | warranty | other. doc_date: YYYY-MM-DD. folder_id / name: the suggested folder (of the same
-- area) and file name — nothing is moved or renamed until someone takes it (POST nodes/<id>/insight/apply).
CREATE TABLE doc_insights (
  node_id    INTEGER PRIMARY KEY,
  rev        INTEGER NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  source     TEXT,                    -- 'text' (the recognised text, textSearch) | 'media' (the picture itself)
  kind       TEXT,
  title      TEXT,
  doc_date   TEXT,
  sender     TEXT,
  amount     REAL,
  currency   TEXT,
  folder_id  INTEGER,
  name       TEXT,
  error      TEXT,
  queued_at  INTEGER NOT NULL,
  queued_by  INTEGER,
  done_at    INTEGER,
  cost_cents REAL
);
CREATE INDEX doc_insights_queue ON doc_insights (status, queued_at);

-- Deadlines the AI found in a document (payment, cancellation, objection); date YYYY-MM-DD. They stay with the file
-- until a new recognition replaces them (the same kind and date keep their row and so their reminders).
CREATE TABLE doc_deadlines (
  id      INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('payment', 'cancellation', 'objection')),
  date    TEXT NOT NULL,
  label   TEXT
);
CREATE INDEX doc_deadlines_node ON doc_deadlines (node_id);
CREATE INDEX doc_deadlines_date ON doc_deadlines (date);

-- A person's reminder of a deadline: Drive's own notification (topic deadline) at `at` (days_before the day).
CREATE TABLE doc_reminders (
  deadline_id INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  days_before INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  sent_at     INTEGER,
  PRIMARY KEY (deadline_id, user_id)
);
CREATE INDEX doc_reminders_due ON doc_reminders (at) WHERE sent_at IS NULL;

-- Per area: AI for documents on (1) or off (0); no row: the default — off for a child's folder, on otherwise.
CREATE TABLE area_prefs (
  area_id TEXT PRIMARY KEY,
  doc_ai  INTEGER
);

-- An import from a cloud drive (gc.cloud) into a Drive folder, run by the background run as its person.
-- state: queued | running | paused (error: cloud_auth, quota, cloud_off — POST import/jobs/<id>/resume) | done |
-- failed | cancelled.
CREATE TABLE import_jobs (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  connection  TEXT NOT NULL,
  provider    TEXT NOT NULL,
  account     TEXT,
  target_id   INTEGER NOT NULL,
  area_id     TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('queued', 'running', 'paused', 'done', 'failed', 'cancelled')),
  total       INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX import_jobs_user ON import_jobs (user_id, id);
CREATE INDEX import_jobs_state ON import_jobs (state, id);

-- What a job still has to do (todo) and what it did: a file (imported into parent_node) or a folder (made or found in
-- parent_node as node_id, its listing continued from `cursor`). An interrupted job goes on from here.
CREATE TABLE import_items (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL,
  cloud_id    TEXT NOT NULL,
  is_dir      INTEGER NOT NULL,
  name        TEXT,
  size        INTEGER,
  modified_at INTEGER,
  parent_node INTEGER NOT NULL,
  node_id     INTEGER,
  cursor      TEXT,
  state       TEXT NOT NULL CHECK (state IN ('todo', 'done', 'failed', 'skipped')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
CREATE INDEX import_items_job ON import_items (job_id, state, id);
