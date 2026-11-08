-- gatecontrol-familie 1.19.0: „Notizen & Aufgaben“ (gatecontrol-notizen).

-- What the hub got of Familie's to-dos (tasks, shopping lists, reminders — server/todohub.js, server/notizen.js): one
-- row per item id, the hash of the item as it went out and when (only real changes are pushed).
CREATE TABLE todo_sent (
  id   TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  at   INTEGER NOT NULL
);

-- Pinnwand and Packlisten in the hub (server/boardsync.js): a board note ('note') or checklist ('checklist') of Familie
-- and its note in the hub's notebook 'pinnwand' / 'packlisten'. hub_id NULL: made in Familie, not in the hub yet.
-- synced_at: Familie's updated_at when the two were last in step (a later one goes to the hub); hub_at: the hub's
-- updatedAt then; title: the hub note's title (Familie's notes have none); by_user: who changed it in Familie last;
-- dirty: changes in Familie not yet in the hub (counted, so one made while a push runs is not lost).
CREATE TABLE hub_notes (
  kind      TEXT NOT NULL,
  local_id  INTEGER NOT NULL,
  hub_id    INTEGER,
  hub_at    INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL DEFAULT 0,
  title     TEXT,
  by_user   INTEGER,
  dirty     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, local_id)
);
CREATE UNIQUE INDEX hub_notes_hub ON hub_notes (kind, hub_id);

-- Deleted in Familie, still to delete in the hub (note_delete as by_user).
CREATE TABLE hub_gone (
  kind    TEXT NOT NULL,
  hub_id  INTEGER NOT NULL,
  by_user INTEGER,
  PRIMARY KEY (kind, hub_id)
);

-- The hub's id of a checklist item (its checklist note's item).
ALTER TABLE checklist_items ADD COLUMN hub_item TEXT;
