-- gatecontrol-schule 1.2.0: homework and exams per student (WebUntis api/homeworks/lessons and
-- api/exams), once-only reminders, and the early ends of a school day for the Familie plugin
-- (service school_day_end).

-- Homework of a student (replaced by every successful fetch; kept until 14 days after it was due)
CREATE TABLE homework (
  student_id   INTEGER NOT NULL,
  hw_id        TEXT NOT NULL,                 -- WebUntis homework id
  given_date   TEXT,                          -- YYYY-MM-DD the homework was given
  due_date     TEXT NOT NULL,                 -- YYYY-MM-DD it is due
  subject      TEXT NOT NULL DEFAULT '',
  subject_long TEXT,
  text         TEXT NOT NULL DEFAULT '',
  remark       TEXT,
  completed    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (student_id, hw_id)
);
CREATE INDEX homework_due ON homework (student_id, due_date);

-- Exams of a student within the fetched dates (no grades are stored)
CREATE TABLE exams (
  student_id   INTEGER NOT NULL,
  ex_id        TEXT NOT NULL,                 -- WebUntis exam id
  date         TEXT NOT NULL,                 -- YYYY-MM-DD
  t_start      TEXT,                          -- HH:MM
  t_end        TEXT,                          -- HH:MM
  subject      TEXT NOT NULL DEFAULT '',
  subject_long TEXT,
  name         TEXT NOT NULL DEFAULT '',
  type         TEXT,
  text         TEXT,
  PRIMARY KEY (student_id, ex_id)
);
CREATE INDEX exams_date ON exams (student_id, date);

-- Once-only notices: the evening reminders ('remind:<studentId>:<date>:exams|homework')
CREATE TABLE notices (
  key TEXT PRIMARY KEY,
  at  INTEGER NOT NULL
);

-- A school day that ends earlier than planned (found after the baseline), handed to Familie once
CREATE TABLE day_ends (
  student_id  INTEGER NOT NULL,
  date        TEXT NOT NULL,                  -- YYYY-MM-DD
  new_end     TEXT NOT NULL,                  -- HH:MM the last lesson that takes place ends
  planned_end TEXT NOT NULL,                  -- HH:MM the planned last lesson ends
  detected_at INTEGER NOT NULL,               -- ms
  status      TEXT NOT NULL,                  -- pending | sent | failed | skipped | expired
  sent_at     INTEGER,
  PRIMARY KEY (student_id, date, new_end)
);
CREATE INDEX day_ends_status ON day_ends (status);

-- { homework: { code, until }, exams: { code, until } }: an optional endpoint that failed is left
-- alone until `until` (ms)
ALTER TABLE accounts ADD COLUMN extras_json TEXT;
