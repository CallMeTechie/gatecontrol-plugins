-- gatecontrol-familie 1.24.0: the tasks and the place reminders in „Notizen & Aufgaben“ (server/tasksync.js).
--
-- After the move (a button on the settings page) the hub owns the tasks; Familie's tables stay the copy Familie shows
-- (the app, the portal, the wall tablet, the cards in the chat, older apps) and keeps working on — and stay where the
-- stars are counted (task_done).
--   tasks.hub_uid     the task's id in the hub's words when it was made there ('h<n>'; NULL: 'f<id>')
--   tasks.synced_at   when the row was last in step with the hub (0: never — a task of Familie's own)
--   tasks.dirty       changes made in Familie that are not in the hub yet (counted)
--   tasks.gone_at     deleted while the hub owns the tasks (there, or here: the hub is told) — hidden everywhere, removed
--                     for good after 30 days
--   places.in_hub     the reminder lives in the hub as a task at a place (never one that tells others: those stay here)
--   places.synced_at, places.dirty, places.gone_at   as for the tasks
--   hub_watch         whose phone asks the hub which places to watch (when last) — such a phone gets a moved reminder
--                     from the hub, any other one still from Familie: no reminder rings twice, none is lost
-- Adding the columns writes no row; without the move nothing reads them.
ALTER TABLE tasks ADD COLUMN hub_uid TEXT;
ALTER TABLE tasks ADD COLUMN synced_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN gone_at INTEGER;
CREATE INDEX idx_tasks_dirty ON tasks(dirty) WHERE dirty > 0;
CREATE INDEX idx_tasks_hub_uid ON tasks(hub_uid) WHERE hub_uid IS NOT NULL;
ALTER TABLE places ADD COLUMN in_hub INTEGER NOT NULL DEFAULT 0;
ALTER TABLE places ADD COLUMN synced_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE places ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE places ADD COLUMN gone_at INTEGER;
CREATE INDEX idx_places_dirty ON places(dirty) WHERE dirty > 0;
CREATE TABLE hub_watch (
  user_id  INTEGER PRIMARY KEY,
  at       INTEGER NOT NULL
);
