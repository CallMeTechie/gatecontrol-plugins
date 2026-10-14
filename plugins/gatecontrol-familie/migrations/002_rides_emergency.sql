-- gatecontrol-familie 1.1.0: rides (Abholen & Fahrten), the emergency card
-- (Notfall-Karte) and once-only background pushes. Members may now also have
-- the role 'wall' (a wall tablet; members.role is free text, no change here).
-- Times are ms since the epoch, dates 'YYYY-MM-DD' (local dates of the
-- plugin's time zone), JSON lists as TEXT.

-- Rides: a one-off ride (series = 0, one leg on `date`) or a weekly series
-- (series = 1: on weekdays_json from `date` until end_date or open-ended).
-- Status is derived: cancelled, else taken with a driver, else open. For a
-- series the columns are the defaults of every occurrence; changes to one
-- occurrence are stored in ride_overrides.
CREATE TABLE rides (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  series          INTEGER NOT NULL DEFAULT 0,
  date            TEXT NOT NULL,                 -- one-off: the date; series: first date
  end_date        TEXT,                          -- series: last date (NULL = open-ended)
  weekdays_json   TEXT,                          -- series: [1..7], 1 = Monday
  time            TEXT NOT NULL,                 -- HH:MM (local)
  title           TEXT NOT NULL,
  place           TEXT NOT NULL DEFAULT '',
  lat             REAL,
  lon             REAL,
  child_ids_json  TEXT NOT NULL DEFAULT '[]',
  driver_user     INTEGER,                       -- a member drives …
  driver_label    TEXT,                          -- … or free text ("Familie Weber", "Bus")
  cancelled       INTEGER NOT NULL DEFAULT 0,
  requested_by    INTEGER NOT NULL,
  declined_json   TEXT NOT NULL DEFAULT '[]',    -- parents who said "kann nicht"
  asked_at        INTEGER,
  remind_minutes  INTEGER NOT NULL DEFAULT 20,
  note            TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_rides_date ON rides(date);

-- One occurrence of a series changed (take, decline, driver, cancel, time …):
-- data_json holds only the changed fields.
CREATE TABLE ride_overrides (
  ride_id     INTEGER NOT NULL,
  date        TEXT NOT NULL,
  data_json   TEXT NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (ride_id, date)
);

-- Once-only background pushes (ride reminders, open rides, the 14th birthday)
CREATE TABLE notices (
  key         TEXT PRIMARY KEY,
  at          INTEGER NOT NULL
);
CREATE INDEX idx_notices_at ON notices(at);

-- Emergency card per member (health data: only here, never in pushes or logs)
CREATE TABLE emergency_cards (
  user_id           INTEGER PRIMARY KEY,
  blood_type        TEXT,
  weight_kg         REAL,
  allergies         TEXT NOT NULL DEFAULT '',
  medications       TEXT NOT NULL DEFAULT '',
  conditions        TEXT NOT NULL DEFAULT '',
  notes             TEXT NOT NULL DEFAULT '',
  insurance_name    TEXT,
  insurance_number  TEXT,
  contacts_json     TEXT NOT NULL DEFAULT '[]',
  updated_at        INTEGER NOT NULL,
  updated_by        INTEGER
);

-- Family-wide emergency contacts (Kinderarzt, Giftnotruf …), one row
CREATE TABLE emergency_family (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  contacts_json TEXT NOT NULL DEFAULT '[]',
  updated_at    INTEGER NOT NULL,
  updated_by    INTEGER
);
