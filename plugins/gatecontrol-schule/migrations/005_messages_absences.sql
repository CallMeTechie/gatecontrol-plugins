-- gatecontrol-schule 1.4.0: school messages (the WebUntis inbox of an account) and the absences of a
-- student (WebUntis class register). Read only: nothing is ever marked as read or changed in WebUntis.

-- A message of an account's inbox (a parent account: the parents' inbox; a student account: the student's)
CREATE TABLE messages (
  account_id      INTEGER NOT NULL,
  msg_id          TEXT NOT NULL,                -- WebUntis message id
  subject         TEXT NOT NULL DEFAULT '',     -- plain text
  preview         TEXT NOT NULL DEFAULT '',     -- plain text (HTML stripped)
  body            TEXT,                         -- plain text, only when the list gives the text
  sender          TEXT NOT NULL DEFAULT '',
  sent_at         INTEGER,                      -- ms (NULL: WebUntis gave no time)
  has_attachments INTEGER NOT NULL DEFAULT 0,
  detected_at     INTEGER NOT NULL,             -- ms, first seen here
  seen_at         INTEGER NOT NULL,             -- ms, last listed by WebUntis
  status          TEXT NOT NULL,                -- baseline | pending | held | sent | no_recipients | failed | expired
  pushed_at       INTEGER,
  PRIMARY KEY (account_id, msg_id)
);
CREATE INDEX messages_status ON messages (status);
CREATE INDEX messages_sent ON messages (account_id, sent_at);

-- An absence of a student (the school year; replaced within the fetched dates by every fetch)
CREATE TABLE absences (
  student_id  INTEGER NOT NULL,
  abs_id      TEXT NOT NULL,                    -- WebUntis absence id
  date        TEXT NOT NULL,                    -- YYYY-MM-DD (start)
  end_date    TEXT,                             -- YYYY-MM-DD when it ends on another day
  t_start     TEXT,                             -- HH:MM
  t_end       TEXT,                             -- HH:MM
  reason      TEXT,
  text        TEXT,
  excused     INTEGER,                          -- 1 excused | 0 not excused | NULL open
  sig         TEXT NOT NULL,                    -- what a change is looked for in
  detected_at INTEGER NOT NULL,                 -- ms
  changed_at  INTEGER NOT NULL,                 -- ms
  status      TEXT NOT NULL,                    -- baseline | pending | held | sent | no_recipients | failed | expired
  change      TEXT,                             -- new | excused | unexcused | changed (what the push says)
  pushed_at   INTEGER,
  PRIMARY KEY (student_id, abs_id)
);
CREATE INDEX absences_date ON absences (student_id, date);
CREATE INDEX absences_status ON absences (status);

-- The last good inbox fetch of an account (NULL: the next one is the baseline — no pushes)
ALTER TABLE accounts ADD COLUMN messages_at INTEGER;
-- The last good absence fetch of a student (NULL: the next one is the baseline — no pushes)
ALTER TABLE students ADD COLUMN absences_at INTEGER;
