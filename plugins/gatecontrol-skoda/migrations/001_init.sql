-- gatecontrol-skoda: the tables of the former built-in Fahrzeuge (GateControl
-- skoda_accounts / skoda_vehicles / skoda_vehicle_owners), in the plugin's own
-- database. The MySkoda password, the S-PIN and the session tokens of an
-- account are secret settings (gc.settings.setSecret 'acc.<id>.password',
-- '.spin', '.access', '.refresh'), never stored in this file.
CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'ok',
  status_detail TEXT,
  backoff_min   INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE vehicles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL,
  vin         TEXT NOT NULL UNIQUE,
  name        TEXT,
  model       TEXT,
  state_json  TEXT,
  image_b64   TEXT,
  image_type  TEXT,
  image_url   TEXT,
  fetched_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_vehicles_account ON vehicles(account_id);
CREATE TABLE vehicle_owners (
  vehicle_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (vehicle_id, user_id)
);
CREATE INDEX idx_owners_user ON vehicle_owners(user_id);
