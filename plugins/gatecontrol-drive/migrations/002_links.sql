-- Links for people without an account (GateControl's public links v2): which node a link shares, what it may do.
-- The link itself (expiry, PIN, counts, log) lives in GateControl; a row here goes when GateControl forgot the link.
CREATE TABLE links (
  token      TEXT PRIMARY KEY,
  node_id    INTEGER NOT NULL,
  area_id    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('files', 'folder', 'upload')),
  mode       TEXT NOT NULL CHECK (mode IN ('view', 'download', 'upload')),
  path       TEXT NOT NULL DEFAULT '',  -- folder and upload links: the folder's path when the link was made
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at   INTEGER,                   -- Drive ended it (the folder moved or went into the trash)
  ended_why  TEXT
);
CREATE INDEX links_node ON links (node_id);
CREATE INDEX links_owner ON links (created_by, created_at);
