-- Drive 1.14.0: AI in Drive — deadlines into the family calendar (D2), questions to the documents (D1), scans become
-- documents (D5, no tables), photos found by what is on them (D3). Server: deadlines.js, ask.js, scans.js, labels.js.

-- New kinds of deadlines (warranty: the end of a warranty, renewal: the last day to cancel before a contract renews) —
-- SQLite cannot change a CHECK, so the table is made again (ids kept: the reminders point at them). found_at: when the
-- deadline was found (the portal's and the apps' "neu"); the old rows: unknown.
CREATE TABLE doc_deadlines_new (
  id       INTEGER PRIMARY KEY,
  node_id  INTEGER NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('payment', 'cancellation', 'objection', 'warranty', 'renewal')),
  date     TEXT NOT NULL,
  label    TEXT,
  found_at INTEGER
);
INSERT INTO doc_deadlines_new (id, node_id, kind, date, label, found_at) SELECT id, node_id, kind, date, label, NULL FROM doc_deadlines;
DROP TABLE doc_deadlines;
ALTER TABLE doc_deadlines_new RENAME TO doc_deadlines;
CREATE INDEX doc_deadlines_node ON doc_deadlines (node_id);
CREATE INDEX doc_deadlines_date ON doc_deadlines (date);

-- A deadline a person put into the family calendar (POST deadlines/<id>/calendar — the Familie plugin's service
-- calendar_add): its date there (event_id) and when. Once per person and deadline.
CREATE TABLE doc_calendar (
  deadline_id INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  event_id    INTEGER,
  at          INTEGER NOT NULL,
  auto        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (deadline_id, user_id)
);

-- Per area: new deadlines into the family calendar on their own (PATCH areas/<id> { deadlinesToCalendar }; default off).
ALTER TABLE area_prefs ADD COLUMN deadlines_to_calendar INTEGER;

-- Questions to the documents (POST ask): when each person asked — at most 30 an hour; rows older than a day go.
CREATE TABLE ai_asks (
  id      INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX ai_asks_user ON ai_asks (user_id, at);

-- What is on a picture (PUT nodes/<id>/labels): the image labels a phone recognised on the device (ML Kit, English,
-- lower case) — GET photos?q= finds photos by them (German words through server/labels.json).
CREATE TABLE node_labels (
  node_id INTEGER NOT NULL,
  label   TEXT NOT NULL,
  source  TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (node_id, label)
);
CREATE INDEX node_labels_label ON node_labels (label);
-- when a picture got its labels (also none found): the phones fill in the ones without (GET photos?unlabeled=1)
ALTER TABLE nodes ADD COLUMN labels_at INTEGER;
