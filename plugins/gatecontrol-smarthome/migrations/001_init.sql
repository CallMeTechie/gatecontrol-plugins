-- gatecontrol-smarthome: the tables of the former built-in Smart Home
-- (GateControl smarthome_* tables), in the plugin's own database. A gateway
-- is reached through the plugin's home target "gateway" (target_index = the
-- administrator's assignment); its deCONZ API key is a secret setting
-- (gc.settings.setSecret 'gw.<id>.apikey'), never stored in this file.
CREATE TABLE gateways (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  target_index INTEGER,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE resources (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_id        INTEGER NOT NULL,
  deconz_id         TEXT NOT NULL,
  deconz_type       TEXT NOT NULL,
  uniqueid          TEXT,
  kind              TEXT NOT NULL,
  name              TEXT,
  capabilities_json TEXT,
  state_json        TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_resources_gw ON resources(gateway_id);
CREATE UNIQUE INDEX idx_resources_uniq ON resources(gateway_id, deconz_type, deconz_id);
CREATE TABLE resource_owners (
  resource_id INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (resource_id, user_id)
);
CREATE INDEX idx_owners_user ON resource_owners(user_id);
CREATE TABLE rules (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_id            INTEGER NOT NULL,
  name                  TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1,
  definition_json       TEXT NOT NULL,
  deconz_rule_id        TEXT,
  deconz_schedule_id    TEXT,
  deconz_clip_sensor_id TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
