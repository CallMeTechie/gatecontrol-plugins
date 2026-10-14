-- gatecontrol-familie 1.0.0: members, shopping lists, tasks and stars,
-- dates, locating children, "I've arrived" / SOS, place reminders.
-- Times are ms since the epoch (INTEGER), dates 'YYYY-MM-DD' (local dates of
-- the plugin's time zone), JSON lists as TEXT. The module switches are plugin
-- settings (gc.settings mod_*), not stored here.

-- Members: GateControl users (gc.users) that belong to the family
CREATE TABLE members (
  user_id     INTEGER PRIMARY KEY,
  role        TEXT NOT NULL,                     -- parent | child
  birthdate   TEXT,                              -- YYYY-MM-DD (required for children)
  locate_mode TEXT NOT NULL DEFAULT 'confirm',   -- confirm | auto | off (children only)
  star_goal   INTEGER NOT NULL DEFAULT 20,
  color       TEXT,
  created_at  INTEGER NOT NULL
);

-- Shopping (offline-first; client-generated ids; tombstones kept 30 days)
CREATE TABLE shop_lists (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  icon        TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_shop_lists_updated ON shop_lists(updated_at);

CREATE TABLE shop_items (
  id          TEXT PRIMARY KEY,
  list_id     TEXT NOT NULL,
  text        TEXT NOT NULL,
  qty         TEXT,
  checked     INTEGER NOT NULL DEFAULT 0,
  checked_by  INTEGER,
  created_by  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_shop_items_list ON shop_items(list_id);
CREATE INDEX idx_shop_items_updated ON shop_items(updated_at);

-- "I'm going shopping" (once per list, user and 15 minutes)
CREATE TABLE shop_going (
  list_id     TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  PRIMARY KEY (list_id, user_id)
);

-- Tasks; due_date is the anchor (first occurrence) of a repeating task and
-- the date of a one-off task
CREATE TABLE tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  mode            TEXT NOT NULL,                 -- fixed | rotate | first
  assignees_json  TEXT NOT NULL,                 -- [user ids], ordered (rotate)
  turn_user       INTEGER,                       -- rotate: whose turn it is
  repeat          TEXT NOT NULL DEFAULT 'none',  -- none | daily | weekly | monthly
  weekdays_json   TEXT,                          -- weekly: [1..7], 1 = Monday
  due_time        TEXT,                          -- HH:MM or NULL
  due_date        TEXT NOT NULL,
  stars           INTEGER NOT NULL DEFAULT 0,
  reminder        INTEGER NOT NULL DEFAULT 1,
  created_by      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Done per occurrence and person (stars booked with it, children only)
CREATE TABLE task_done (
  task_id     INTEGER NOT NULL,
  occurrence  TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  stars       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, occurrence, user_id)
);
CREATE INDEX idx_task_done_at ON task_done(at);

-- Reminders sent per occurrence and person (snooze: again after snooze_until)
CREATE TABLE task_reminders (
  task_id       INTEGER NOT NULL,
  occurrence    TEXT NOT NULL,
  user_id       INTEGER NOT NULL,
  sent_at       INTEGER,
  snooze_until  INTEGER,
  PRIMARY KEY (task_id, occurrence, user_id)
);

-- Dates and birthdays (member birthdays come from members.birthdate)
CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  date            TEXT NOT NULL,
  time            TEXT,
  end_date        TEXT,
  all_day         INTEGER NOT NULL DEFAULT 0,
  repeat          TEXT NOT NULL DEFAULT 'none',  -- none | yearly
  member_ids_json TEXT NOT NULL DEFAULT '[]',
  kind            TEXT NOT NULL DEFAULT 'event', -- event | birthday
  remind_days     INTEGER,
  note            TEXT NOT NULL DEFAULT '',
  created_by      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Date reminders sent (event key = id or member:<id>, occurrence date)
CREATE TABLE event_reminders (
  event_key   TEXT NOT NULL,
  occurrence  TEXT NOT NULL,
  sent_at     INTEGER NOT NULL,
  PRIMARY KEY (event_key, occurrence)
);

-- Locate requests (coordinates removed 7 days after the answer, rows after 90 days)
CREATE TABLE locate_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id      INTEGER NOT NULL,
  requested_by  INTEGER NOT NULL,
  mode          TEXT NOT NULL,                   -- auto | confirm
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | answered | declined | failed | expired
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  answered_at   INTEGER,
  lat           REAL,
  lon           REAL,
  accuracy      REAL,
  fix_at        INTEGER,
  battery       INTEGER,
  reason        TEXT,                            -- decline reason / fail code
  purged        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_locate_child ON locate_requests(child_id, created_at);
CREATE INDEX idx_locate_status ON locate_requests(status);

-- "I've arrived"
CREATE TABLE arrivals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  label       TEXT,
  lat         REAL,
  lon         REAL,
  accuracy    REAL,
  at          INTEGER NOT NULL,
  purged      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_arrivals_user ON arrivals(user_id, at);

-- SOS
CREATE TABLE sos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  lat         REAL,
  lon         REAL,
  accuracy    REAL,
  fix_at      INTEGER,
  at          INTEGER NOT NULL,
  purged      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sos_user ON sos(user_id, at);

CREATE TABLE sos_acks (
  sos_id      INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  PRIMARY KEY (sos_id, user_id)
);

-- Place reminders (geofencing runs on the phone)
CREATE TABLE places (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id        INTEGER NOT NULL,
  target_user_id  INTEGER NOT NULL,
  title           TEXT NOT NULL,
  note            TEXT NOT NULL DEFAULT '',
  lat             REAL NOT NULL,
  lon             REAL NOT NULL,
  radius          INTEGER NOT NULL,
  trigger_on      TEXT NOT NULL,                 -- enter | exit
  action_kind     TEXT NOT NULL,                 -- note | list | tell
  list_id         TEXT,
  tell_json       TEXT NOT NULL DEFAULT '[]',
  repeat          TEXT NOT NULL DEFAULT 'always',-- once | always
  active          INTEGER NOT NULL DEFAULT 1,
  consent         TEXT NOT NULL DEFAULT 'accepted',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_triggered_at INTEGER
);
CREATE INDEX idx_places_target ON places(target_user_id);

-- Geofence transitions reported by the target's app (no coordinates; 90 days)
CREATE TABLE place_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id    INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  title       TEXT NOT NULL,
  transition  TEXT NOT NULL,
  at          INTEGER NOT NULL,
  told        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_place_events_at ON place_events(at);
