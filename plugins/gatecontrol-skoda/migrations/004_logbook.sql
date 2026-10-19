-- gatecontrol-skoda 1.5.0: the logbook (Fahrtenbuch). A trip is recorded when
-- a vehicle reports a higher mileage at a new parking position; keyed by the
-- VIN (not the vehicle row), so a vehicle removed with its account and added
-- again keeps its trips. purpose: 'private' | 'business' | 'commute' | NULL
-- (not classified yet); source: 'auto' (detected) | 'manual' (entered).
CREATE TABLE trips (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  vin            TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  ended_at       TEXT NOT NULL,
  start_km       INTEGER,
  end_km         INTEGER,
  distance_km    INTEGER NOT NULL,
  start_lat      REAL,
  start_lon      REAL,
  start_address  TEXT,
  end_lat        REAL,
  end_lon        REAL,
  end_address    TEXT,
  purpose        TEXT,
  note           TEXT,
  driver_user_id INTEGER,
  source         TEXT NOT NULL DEFAULT 'auto',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at      TEXT
);
CREATE INDEX idx_trips_vin_start ON trips(vin, started_at);
-- Where each vehicle was last seen parked (the start of its next trip).
CREATE TABLE trip_state (
  vin          TEXT PRIMARY KEY,
  km           INTEGER,
  lat          REAL,
  lon          REAL,
  address      TEXT,
  seen_at      TEXT,
  moving_since TEXT
);
