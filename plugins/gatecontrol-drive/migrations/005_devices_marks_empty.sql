-- Drive 1.5.0: a person's registered devices with their folders (server/devices.js), "deleted on the device — goes
-- into the trash on …" (a mark on a node, server/marks.js) and empty files (0 bytes, without a media object).

-- A device a person registered (PUT devices/<id>): a PC or phone that backs up or syncs folders. `id` is the device's
-- own stable id, `name` is unique per person ignoring case ("PC", "PC (2)") and is the name of its folder
-- Meine Dateien › Geräte › <name> (folder_id). `folders`: JSON [{ localPath, mode, nodeId, lastBackup }].
CREATE TABLE user_devices (
  user_id      INTEGER NOT NULL,
  id           TEXT NOT NULL,
  name         TEXT NOT NULL,
  wanted       TEXT NOT NULL,           -- the name the device asked for
  platform     TEXT,
  version      TEXT,
  token_device TEXT,                    -- user.device.id (its device token) of the last PUT
  folder_id    INTEGER,
  folders      TEXT NOT NULL DEFAULT '[]',
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX user_devices_name ON user_devices (user_id, name COLLATE NOCASE);
CREATE INDEX user_devices_token ON user_devices (user_id, token_device);

-- The mark: the node goes into the trash at delete_at (background run) unless it changes before.
ALTER TABLE nodes ADD COLUMN delete_at INTEGER;
ALTER TABLE nodes ADD COLUMN delete_by INTEGER;
ALTER TABLE nodes ADD COLUMN delete_device TEXT;        -- the asking device (user.device.id) — the change log's device
ALTER TABLE nodes ADD COLUMN delete_device_name TEXT;   -- its name as the person sees it ("PC")
CREATE INDEX nodes_delete_at ON nodes (delete_at) WHERE delete_at IS NOT NULL;

-- versions: media_id may be null now (a version of an empty file has no media object). A NOT NULL cannot be changed
-- in place, so the table is rebuilt with the same columns and rows.
CREATE TABLE versions_new (
  id       INTEGER PRIMARY KEY,
  node_id  INTEGER NOT NULL,
  rev      INTEGER NOT NULL,
  media_id TEXT UNIQUE,
  size     INTEGER NOT NULL DEFAULT 0,
  sha256   TEXT,
  at       INTEGER NOT NULL,
  by       INTEGER
);
INSERT INTO versions_new (id, node_id, rev, media_id, size, sha256, at, by) SELECT id, node_id, rev, media_id, size, sha256, at, by FROM versions;
DROP TABLE versions;
ALTER TABLE versions_new RENAME TO versions;
CREATE INDEX versions_node ON versions (node_id, at);
