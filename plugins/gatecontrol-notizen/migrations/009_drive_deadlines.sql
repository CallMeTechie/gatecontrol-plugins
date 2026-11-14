-- Notizen & Aufgaben 1.7.0 — the reminders of Drive's deadlines ring from here (server/drivedue.js).
--
-- Drive keeps the deadline at its file and the person's reminder („3 Tage vorher“); it hands the reminders over as a
-- whole list (service deadline_reminders). Each one becomes a task that carries Drive's item of the deadline — so the
-- reminder with „Erledigt“ / „Später“, GET reminders and „Gestern offen geblieben“ are those of every task.
--
-- ext_id       Drive's item of the deadline ('deadline:<id>', src_items.ext_id)
-- user_id      whose reminder
-- at           when Drive wants it to ring (ms); days_before: what the person chose there
-- task_id      the task that carries it. That task deleted by the person: no reminder until Drive names another time.
--              NULL: none was made (Drive had rung already, the deadline was ticked off)
-- made         1: the hub made that task for the reminder (it goes with the reminder); 0: a task the person had made of
--              the item themselves (it only loses the reminder)
-- claimed_at   Drive said „ring“ for this `at` (service deadline_claim of Drive): asked once per reminder
-- title        the item's title the task was made with (it follows the item while the person has not renamed it)
-- seen         when a list named it last
-- A new table: no row is written, nothing existing is read.
CREATE TABLE drive_due (
  ext_id      TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  days_before INTEGER NOT NULL DEFAULT 0,
  task_id     INTEGER,
  made        INTEGER NOT NULL DEFAULT 1,
  claimed_at  INTEGER,
  title       TEXT,
  seen        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (ext_id, user_id)
);
CREATE INDEX idx_drive_due_task ON drive_due(task_id) WHERE task_id IS NOT NULL;
