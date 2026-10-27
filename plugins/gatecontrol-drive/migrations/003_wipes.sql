-- "Löschen auf allen Geräten" (since 1.2.0, server/wipes.js).

-- The devices of a person that used Drive: every app request carries the asking device (user.device,
-- permissions.devices — the id of its device token). The targets of a wipe are those seen in the last 180 days.
CREATE TABLE devices (
  user_id    INTEGER NOT NULL,
  device_id  TEXT NOT NULL,
  platform   TEXT,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id)
);

-- A wipe: DELETE nodes/<id>?everywhere=1 by user_id — every device of that person removes its local copies of the
-- files (wipe_entries). trash_id: the deleted node (restoring it from the trash cancels the wipe).
CREATE TABLE wipes (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  trash_id   INTEGER NOT NULL,
  device     TEXT,                    -- the device that deleted (null: the portal)
  created_at INTEGER NOT NULL
);
CREATE INDEX wipes_trash ON wipes (trash_id);
CREATE INDEX wipes_created ON wipes (created_at);

-- A file of a wipe as it was when it was deleted (what a device finds its copy by).
CREATE TABLE wipe_entries (
  id      INTEGER PRIMARY KEY,
  wipe_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL,
  name    TEXT NOT NULL,
  sha256  TEXT,
  size    INTEGER NOT NULL DEFAULT 0,
  mime    TEXT
);
CREATE INDEX wipe_entries_wipe ON wipe_entries (wipe_id);

-- Which device has yet to handle which entry (POST wipes/done removes the row; an entry without rows goes).
CREATE TABLE wipe_pending (
  entry_id  INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  PRIMARY KEY (device_id, entry_id)
);
CREATE INDEX wipe_pending_entry ON wipe_pending (entry_id);
