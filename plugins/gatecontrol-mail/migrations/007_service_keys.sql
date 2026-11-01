-- Mail 1.6.0 — services for other plugins (server/services.js): the event a caller made with calendar_add { key } in a
-- calendar of a person. The same key of the same person and calendar answers that event again while it is there (Drive:
-- a deadline that went into a calendar of Mail). Goes with the calendar.
CREATE TABLE service_keys (
  caller      TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  calendar_id INTEGER NOT NULL,
  key         TEXT NOT NULL,
  event_id    INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  PRIMARY KEY (caller, user_id, calendar_id, key)
);
CREATE INDEX service_keys_calendar ON service_keys (calendar_id);
