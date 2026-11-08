-- gatecontrol-alltag 1.5.0: what „Notizen & Aufgaben“ (gatecontrol-notizen) got from Alltag — the waste collections of the
-- next days as its items (server/todohub.js, server/notizen.js). One row per item id: the hash of the item as it went out
-- and when, so only real changes are pushed. Empty without the hub.
CREATE TABLE todo_sent (
  id   TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  at   INTEGER NOT NULL
);
