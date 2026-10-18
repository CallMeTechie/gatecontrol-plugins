-- gatecontrol-familie 1.8.0: dates from the Messenger (family chat). A place
-- label and an end time for every date; dates the Messenger keeps in step
-- (service calendar_upsert / calendar_remove) carry its reference and are
-- read-only in Familie. Dates made with "Termin anlegen" in a chat
-- (calendar_add) are ordinary dates with source 'chat'.

ALTER TABLE events ADD COLUMN place TEXT;                  -- label only (never coordinates), ≤ 80 characters
ALTER TABLE events ADD COLUMN end_time TEXT;               -- HH:MM or NULL
ALTER TABLE events ADD COLUMN source TEXT;                 -- NULL | 'chat'
ALTER TABLE events ADD COLUMN source_ref TEXT;             -- calendar_upsert: e.g. 'messenger:123'
CREATE UNIQUE INDEX idx_events_source_ref ON events(source_ref);
