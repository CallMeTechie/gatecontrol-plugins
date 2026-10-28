-- Drive 1.6.0: protection against ransomware (server/guard.js) — the journal of what each device changed, the
-- incidents (a device stopped) and the device's entropy hint kept with a file.

-- What a device (an app request, user.device) changed: op create | overwrite | rename | delete. parent_id: the folder
-- (a rename: the folder before), name: the name now (a delete: the name it had), old_name: a rename's name before,
-- version_id: an overwrite's version with the bytes before, flags: the signs of an attack (ext, entropy, swap).
-- Rows of no incident go once they are older than the window (background run).
CREATE TABLE guard_log (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  device      TEXT NOT NULL,
  at          INTEGER NOT NULL,
  op          TEXT NOT NULL,
  node_id     INTEGER NOT NULL,
  area_id     TEXT NOT NULL,
  parent_id   INTEGER,
  name        TEXT NOT NULL,
  old_name    TEXT,
  version_id  INTEGER,
  flags       TEXT,
  incident_id INTEGER
);
CREATE INDEX guard_log_device ON guard_log (user_id, device, at);
CREATE INDEX guard_log_incident ON guard_log (incident_id);
CREATE INDEX guard_log_node ON guard_log (node_id);

-- An incident: the device was stopped (state open: it may not write), released (a false alarm) or undone.
CREATE TABLE guard_incidents (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  device      TEXT NOT NULL,
  device_name TEXT,
  at          INTEGER NOT NULL,
  since       INTEGER NOT NULL,
  files       INTEGER NOT NULL,
  reasons     TEXT,
  sample      TEXT,
  state       TEXT NOT NULL DEFAULT 'open',
  ended_at    INTEGER,
  ended_by    INTEGER,
  undone_at   INTEGER,
  undone_by   INTEGER,
  restored    INTEGER,
  trashed     INTEGER,
  failed      INTEGER
);
CREATE INDEX guard_incidents_device ON guard_incidents (user_id, device, state);

-- uploads/commit { entropy }: how random the device found the bytes (0–8 bits per byte), null when not sent.
ALTER TABLE nodes ADD COLUMN entropy REAL;
