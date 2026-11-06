-- gatecontrol-print 1.0.0 — Drucken & Scannen
-- Times are ms since the epoch (UTC). The files themselves are GateControl's (gc.print, gc.media):
-- this database keeps the rights per person, the history and the open scan sessions.

-- Rights per person (a row only when an administrator changed the defaults; administrators may always everything)
CREATE TABLE rights (
  user_id INTEGER PRIMARY KEY,
  can_print INTEGER NOT NULL DEFAULT 1,
  can_scan INTEGER NOT NULL DEFAULT 1,
  pages_per_day INTEGER NOT NULL DEFAULT 0,   -- 0 = no limit
  bw_only INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Print jobs (id = GateControl's job id), kept in step with gc.print.jobs()
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  name TEXT NOT NULL,
  pages INTEGER NOT NULL DEFAULT 1,
  copies INTEGER NOT NULL DEFAULT 1,
  color INTEGER NOT NULL DEFAULT 0,
  duplex INTEGER NOT NULL DEFAULT 0,
  via TEXT NOT NULL DEFAULT 'portal',
  state TEXT NOT NULL,
  error TEXT,
  message TEXT,
  notified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_user ON jobs(user_id, created_at);
CREATE INDEX idx_jobs_created ON jobs(created_at);

-- Scan sessions: one or more scans (another page) until saved in Drive or discarded
CREATE TABLE scans (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  host_scan TEXT,                         -- the running scan of GateControl (gc.print.scan), null when none
  pages TEXT NOT NULL DEFAULT '[]',       -- [{ mediaId, thumb }]
  suggestion TEXT,                        -- the AI's { name, where, folderId } (JSON)
  state TEXT NOT NULL,                    -- open | saved | discarded
  error TEXT,
  saved_name TEXT,
  saved_where TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_scans_user ON scans(user_id, created_at);
