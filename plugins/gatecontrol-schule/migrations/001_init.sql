-- gatecontrol-schule: WebUntis accounts, their students, the stored
-- timetable and the change log.
-- Credentials (the QR secret or the password of an account) are plugin
-- secrets (gc.settings.setSecret 'acct.<id>.secret' / 'acct.<id>.password'):
-- encrypted by the host, never sent to the browser, never in this file.

-- A WebUntis login (student or parent account)
CREATE TABLE accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  host            TEXT NOT NULL,              -- e.g. nessa.webuntis.com
  school          TEXT NOT NULL,              -- WebUntis school name (login name of the school)
  username        TEXT NOT NULL,
  auth            TEXT NOT NULL,              -- 'secret' (QR link, TOTP) | 'password'
  person_id       INTEGER,                    -- the account's own WebUntis person
  person_type     INTEGER,                    -- 5 student, 12 legal guardian, 2 teacher
  status          TEXT NOT NULL DEFAULT 'new',  -- new | ok | error
  last_error      TEXT,                       -- auth | no_right | network | failed (never a response body)
  error_count     INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,                    -- ms
  last_success_at INTEGER,                    -- ms
  last_error_at   INTEGER,                    -- ms
  next_fetch_at   INTEGER NOT NULL DEFAULT 0, -- ms
  refresh_asked_at INTEGER,                   -- ms, a quick action asked for an early fetch
  timegrid_json   TEXT,                       -- [{ day, units: [{ name, start, end }] }]
  holidays_json   TEXT,                       -- [{ name, from, to }]
  meta_day        TEXT,                       -- local date the timegrid / holidays were fetched
  created_at      INTEGER NOT NULL,
  UNIQUE (host, school, username)
);

-- A student found in an account (the account itself, or a child of a parent account)
CREATE TABLE students (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL,
  person_id       INTEGER NOT NULL,
  name            TEXT NOT NULL,              -- as WebUntis shows it
  alias           TEXT,                       -- the administrator's display name (NULL = name)
  klasse          TEXT,                       -- most frequent class of the stored lessons
  enabled         INTEGER NOT NULL DEFAULT 1,
  user_id         INTEGER,                    -- the child's GateControl user (optional)
  recipients_json TEXT NOT NULL DEFAULT '[]', -- further GateControl users (parents …)
  show_on_wall    INTEGER NOT NULL DEFAULT 0, -- visible to kiosk devices (wall tablet)
  baseline_done   INTEGER NOT NULL DEFAULT 0, -- 0: the next fetch only sets the baseline
  missing         INTEGER NOT NULL DEFAULT 0, -- no longer listed by the account
  range_from      TEXT,                       -- dates the last fetch covered (YYYY-MM-DD)
  range_to        TEXT,
  last_fetch_at   INTEGER,                    -- ms
  last_change_at  INTEGER,                    -- ms
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (account_id, person_id)
);

-- The stored timetable of a student (today − 14 days … the last fetched day)
CREATE TABLE lessons (
  student_id   INTEGER NOT NULL,
  lkey         TEXT NOT NULL,                 -- date|t_start|original subject ids (stable across WebUntis re-imports)
  date         TEXT NOT NULL,                 -- YYYY-MM-DD
  t_start      TEXT NOT NULL,                 -- HH:MM
  t_end        TEXT NOT NULL,                 -- HH:MM
  period       INTEGER,
  period_end   INTEGER,
  subject      TEXT NOT NULL DEFAULT '',
  subject_long TEXT NOT NULL DEFAULT '',
  subject_old  TEXT,
  teacher      TEXT NOT NULL DEFAULT '',
  teacher_old  TEXT,
  room         TEXT NOT NULL DEFAULT '',
  room_old     TEXT,
  klasse       TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL,                 -- normal | cancelled | changed (as WebUntis says)
  info         TEXT,
  subst_text   TEXT,
  lstext       TEXT,
  added        INTEGER NOT NULL DEFAULT 0,    -- appeared after the baseline (extra lesson)
  removed      INTEGER NOT NULL DEFAULT 0,    -- vanished from WebUntis on a school day: kept as cancelled
  PRIMARY KEY (student_id, lkey)
);
CREATE INDEX lessons_date ON lessons (student_id, date);

-- Change log: every change found after the baseline; status of its push
CREATE TABLE changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id  INTEGER NOT NULL,
  lkey        TEXT NOT NULL,
  date        TEXT NOT NULL,
  t_start     TEXT NOT NULL,
  t_end       TEXT NOT NULL,
  period      INTEGER,
  kind        TEXT NOT NULL,                  -- cancelled | changed | extra | restored
  subject     TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',     -- { subjectLong, teacher, teacherOld, room, roomOld, substText, info }
  detected_at INTEGER NOT NULL,               -- ms
  status      TEXT NOT NULL,                  -- pending | held | sent | logged | expired | no_recipients | failed
  sent_at     INTEGER
);
CREATE INDEX changes_student ON changes (student_id, detected_at);
CREATE INDEX changes_status ON changes (status);
