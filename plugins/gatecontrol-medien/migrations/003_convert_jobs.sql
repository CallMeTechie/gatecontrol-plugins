-- gatecontrol-medien 1.6.0 — "Videos umwandeln", step 2: converting through the service "umwandeln" of a gateway
-- (host API gc.transcode). The plugin keeps its own queue and decides when and in which order (night window,
-- pause while somebody watches); the gateway converts one file at a time, swaps it in place and keeps the original
-- in .gc-papierkorb for the trash days.

-- One row per file the administrator touched (queued, converted, hidden, requested from an app). conv_items is
-- rebuilt by every scan — a converted file drops out of it — so the row keeps what the list showed (snap).
CREATE TABLE conv_files (
  source_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'none',        -- none | queued | running | checking | done | failed | skipped | restored
  snap TEXT NOT NULL DEFAULT '{}',           -- JSON: the row of the list when it was last touched (title, path, size …)
  path TEXT,                                 -- the path Jellyfin reported (the only kind of path ever submitted)
  queued_at INTEGER,                         -- in the plugin's queue since
  now INTEGER NOT NULL DEFAULT 0,            -- "Jetzt umwandeln": submit at once, outside the night window too
  not_before INTEGER,                        -- no_space: not before the next night
  fails INTEGER NOT NULL DEFAULT 0,          -- failed attempts (two → skipped)
  error TEXT,                                -- the last code of the gateway (no_space, encode_failed …)
  job_id TEXT,                               -- the current or last job
  gateway_id INTEGER,
  check_state TEXT,                          -- JSON: Jellyfin read again ({ refreshed, tries, bits, runtime, ok, at })
  done_at INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0,         -- "Ausblenden"
  requested_at INTEGER,                      -- "Umwandeln anfragen" from an app (only into the list, Frage 100 b)
  requested_by INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, item_id)
);
CREATE INDEX conv_files_state ON conv_files (state);

-- Every attempt (a new id per file and attempt). Kept after the gateway forgot it (ack) — the night summary, the
-- measured speed and the view "geprüft" come from here.
CREATE TABLE conv_jobs (
  id TEXT PRIMARY KEY,                       -- [A-Za-z0-9_-]{16}
  source_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  gateway_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  state TEXT NOT NULL,                       -- submitted | queued | running | paused | verifying | done | failed | cancelled | lost
  error TEXT,
  percent REAL,
  fps REAL,
  speed REAL,
  paused INTEGER NOT NULL DEFAULT 0,         -- this job alone was paused ("Anhalten")
  software INTEGER NOT NULL DEFAULT 0,
  result TEXT,                               -- JSON result of the gateway (source, output, mode, seconds, trashPath …)
  acked INTEGER NOT NULL DEFAULT 0,
  submitted_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX conv_jobs_file ON conv_jobs (source_id, item_id);
CREATE INDEX conv_jobs_gateway ON conv_jobs (gateway_id, state);
