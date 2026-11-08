-- Drive 1.27.0: „Notizen & Aufgaben“ (gatecontrol-notizen) — the deadlines of documents as its items (server/todohub.js,
-- server/notizen.js).

-- What the hub got: one row per item id, the hash of the item as it went out and when (only real changes are pushed).
CREATE TABLE todo_sent (
  id   TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  at   INTEGER NOT NULL
);

-- A deadline ticked off (paid, cancelled, done): for everyone who reads the file — in „Notizen & Aufgaben“ or with
-- POST deadlines/<id>/done. A new recognition keeps a deadline of the same kind and date, and so its tick.
ALTER TABLE doc_deadlines ADD COLUMN done_at INTEGER;
ALTER TABLE doc_deadlines ADD COLUMN done_by INTEGER;
