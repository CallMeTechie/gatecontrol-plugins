-- Drive 1.19.0: the virus scan of GateControl (server/scan.js). The result the host gave per media id (current files
-- and versions): state pending | clean | infected | unscannable | unchecked, blocked 1 = not served (quarantine, still
-- being checked, not checkable and blocked), finding = the name of the find or why it could not be checked. No row: no
-- result known (a GateControl without the virus scan, a file from before it).
CREATE TABLE media_scan (
  media_id TEXT PRIMARY KEY,
  state    TEXT NOT NULL,
  blocked  INTEGER NOT NULL DEFAULT 0,
  finding  TEXT,
  at       INTEGER NOT NULL
);
CREATE INDEX media_scan_pending ON media_scan (state, at);
