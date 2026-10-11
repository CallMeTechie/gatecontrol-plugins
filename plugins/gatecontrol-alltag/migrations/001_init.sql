-- gatecontrol-alltag: waste collection plans and calendar subscriptions.
-- Secrets (the internet address of a calendar, Basic-auth credentials of a
-- home-network calendar) are plugin secrets (gc.settings.setSecret
-- 'sub.<id>.url' / '.user' / '.password'), never stored in this file.
-- Reminder state (what was sent) lives in gc.storage ('notify.state').

-- Abfuhrplan: one address / location; source 'ics' | 'rules' | 'provider'
CREATE TABLE plans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  source          TEXT NOT NULL,
  provider        TEXT,
  provider_config TEXT,              -- JSON { service, serviceTitle, place, street, house }
  ics_text        TEXT,              -- uploaded calendar (source 'ics'), ≤ 900 KB
  ics_name        TEXT,
  rules_json      TEXT,              -- JSON [{ name, type, start, weeks, until }]
  exceptions_json TEXT,              -- JSON [{ date, name, to }]
  users_json      TEXT,              -- JSON [user ids] or NULL = everyone
  enabled         INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'new',   -- new | ok | error
  last_error      TEXT,              -- error code (never a response body)
  error_count     INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,           -- ms
  last_success_at INTEGER,           -- ms
  next_refresh_at INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fractions of a plan, keyed by the normalised source name
CREATE TABLE fractions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id     INTEGER NOT NULL,
  source_key  TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_color TEXT,
  type        TEXT NOT NULL,
  name        TEXT,                  -- admin's name (NULL = source name)
  color       TEXT,                  -- admin's colour (NULL = type colour)
  hidden      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (plan_id, source_key)
);
CREATE INDEX idx_fractions_plan ON fractions(plan_id);

-- Last good dates of a plan (replaced on every successful refresh)
CREATE TABLE waste_dates (
  plan_id     INTEGER NOT NULL,
  date        TEXT NOT NULL,         -- YYYY-MM-DD
  fraction_id INTEGER NOT NULL,
  PRIMARY KEY (plan_id, date, fraction_id)
);
CREATE INDEX idx_waste_dates_date ON waste_dates(date);

-- Calendar subscriptions; source 'url' (internet, secret address) | 'target' (home network)
CREATE TABLE subscriptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  color           TEXT NOT NULL DEFAULT '#0d9488',
  source          TEXT NOT NULL,
  url_host        TEXT,              -- shown masked; the address itself is a secret
  target_index    INTEGER,
  target_path     TEXT,
  reminder        TEXT NOT NULL DEFAULT '15',    -- off | start | 10 | 15 | 30 | 60 (minutes before)
  allday_reminder INTEGER NOT NULL DEFAULT 1,
  users_json      TEXT NOT NULL DEFAULT '[]',    -- who sees it and gets its reminders
  created_by      INTEGER,
  enabled         INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'new',
  last_error      TEXT,
  error_count     INTEGER NOT NULL DEFAULT 0,
  etag            TEXT,
  last_modified   TEXT,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_parsed_at  INTEGER,
  next_refresh_at INTEGER NOT NULL DEFAULT 0,
  event_count     INTEGER NOT NULL DEFAULT 0,
  truncated       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Expanded instances (window -1 … +90 days) of the last good calendar
CREATE TABLE events (
  sub_id    INTEGER NOT NULL,
  ikey      TEXT NOT NULL,           -- uid|original start
  title     TEXT NOT NULL,
  location  TEXT,
  all_day   INTEGER NOT NULL DEFAULT 0,
  start_ms  INTEGER NOT NULL,
  end_ms    INTEGER NOT NULL,
  date      TEXT NOT NULL,           -- local start date (plugin time zone)
  end_date  TEXT,                    -- all-day: exclusive end date
  PRIMARY KEY (sub_id, ikey)
);
CREATE INDEX idx_events_start ON events(start_ms);
