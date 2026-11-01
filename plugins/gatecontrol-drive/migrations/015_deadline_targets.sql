-- Drive 1.17.0: deadlines also into a calendar of GateControl Mail (deadlines.js — Mail's services calendar_list and
-- calendar_add), chosen per person and area.

-- A deadline in a calendar: once per person, deadline and target ('family' — Familie's calendar_add — or
-- 'mail:<calendarId>' — Mail's calendar_add); kind and label of the target as it was chosen ('family' | 'mail'; the
-- label of a Mail calendar, e.g. „Outlook.com · Kalender“). SQLite cannot change a primary key, so the table is made
-- again; the entries of 1.14.0 – 1.16.x are in the family calendar.
CREATE TABLE doc_calendar_new (
  deadline_id INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  target      TEXT NOT NULL DEFAULT 'family',
  kind        TEXT NOT NULL DEFAULT 'family',
  label       TEXT,
  event_id,
  at          INTEGER NOT NULL,
  auto        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (deadline_id, user_id, target)
);
INSERT INTO doc_calendar_new (deadline_id, user_id, target, kind, label, event_id, at, auto)
  SELECT deadline_id, user_id, 'family', 'family', NULL, event_id, at, auto FROM doc_calendar;
DROP TABLE doc_calendar;
ALTER TABLE doc_calendar_new RENAME TO doc_calendar;

-- Where the new deadlines of an area go on their own for a person (PATCH areas/<id> { deadlinesTarget }, PUT
-- deadlines/targets): the target as JSON — null (not at all), { kind: 'family' } or { kind: 'mail', calendarId, label }.
-- Without a row the area's switch deadlines_to_calendar (012) holds: on → the family calendar, as before.
CREATE TABLE deadline_targets (
  user_id INTEGER NOT NULL,
  area_id TEXT NOT NULL,
  target  TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, area_id)
);
