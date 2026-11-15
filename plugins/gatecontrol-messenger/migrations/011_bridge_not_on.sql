-- Messenger 1.18.0: „Neuer Chat“ with contacts (server/contactchat.js). A number of the person's address book (Mail) that
-- the service said it does not know is not asked again for 30 days: only the address book contact's id, the kind of
-- number (mobile, work, home, other; the second of a kind mobile-2 …) and when — never the number. Unlinking the service
-- deletes the rows; the background run removes what is older than 30 days.
CREATE TABLE bridge_not_on (
  user_id INTEGER NOT NULL,
  network TEXT NOT NULL,
  card_id INTEGER NOT NULL,
  phone_key TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, network, card_id, phone_key)
);
CREATE INDEX bridge_not_on_at ON bridge_not_on (at);

-- The protocol gets a third level, info: „WhatsApp-Nummer geprüft · Quelle Adressbuch · gefunden / nicht gefunden“
-- (code bridge_number_checked — no number, no name). SQLite cannot change a CHECK: the table is made anew.
CREATE TABLE log_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('error', 'limit', 'info')),
  code TEXT NOT NULL,
  detail TEXT,
  count INTEGER NOT NULL DEFAULT 1
);
INSERT INTO log_new (id, at, last_at, level, code, detail, count) SELECT id, at, last_at, level, code, detail, count FROM log;
DROP TABLE log;
ALTER TABLE log_new RENAME TO log;
CREATE INDEX log_at ON log (last_at);
