-- gatecontrol-schule 1.8.0: „Notizen & Aufgaben“ (gatecontrol-notizen) — homework and exams of the children as its items
-- (server/todohub.js, server/notizen.js).

-- What the hub got: one row per item id, the hash of the item as it went out and when (only real changes are pushed).
CREATE TABLE todo_sent (
  id   TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  at   INTEGER NOT NULL
);

-- Homework ticked off in GateControl (in „Notizen & Aufgaben“): WebUntis' own `completed` is read only, so the tick is
-- kept here, beside the homework (a fetch replaces the homework rows, this row stays). Shown as done everywhere.
CREATE TABLE homework_done (
  student_id INTEGER NOT NULL,
  hw_id      TEXT NOT NULL,
  user_id    INTEGER NOT NULL,              -- who ticked it off
  at         INTEGER NOT NULL,              -- ms
  PRIMARY KEY (student_id, hw_id)
);
