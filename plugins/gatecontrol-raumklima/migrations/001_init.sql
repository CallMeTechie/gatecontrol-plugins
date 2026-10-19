-- gatecontrol-midea: the tables of the former built-in Klimaanlage
-- (GateControl midea_devices / midea_device_owners), in the plugin's own
-- database. A LAN device is reached through the plugin's home target "ac"
-- (target_index = the administrator's assignment); its token/key (protocol
-- V3) and the Midea account's password and session are secret settings of
-- the plugin (gc.settings.setSecret), never stored in this file.
CREATE TABLE devices (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  device_sn          TEXT NOT NULL UNIQUE,
  device_id          TEXT,
  transport          TEXT NOT NULL DEFAULT 'lan',
  cloud_appliance_id TEXT,
  target_index       INTEGER,
  protocol_version   INTEGER NOT NULL DEFAULT 3,
  model              TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  last_seen_at       TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_devices_enabled ON devices(enabled);
CREATE TABLE device_owners (
  device_id  INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (device_id, user_id)
);
CREATE INDEX idx_device_owners_user ON device_owners(user_id);
