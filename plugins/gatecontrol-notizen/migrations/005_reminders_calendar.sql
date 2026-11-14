-- Notizen & Aufgaben 1.3.0 — reminders with buttons, „Gestern offen geblieben“, tasks with a time in Mail's calendar.
--
-- tasks.snoozed_at   when „Später“ moved the reminder last (NULL: not snoozed; a reminder or due date set anew clears it)
-- tasks.missed_at    the reminder could not be sent any more (the server was off for over 24 hours): the task is part of
--                    „Gestern offen geblieben“ until it is decided
-- tasks.cal_event_id the event of this task in the calendar „Aufgaben“ of Mail (server/calsync.js), cal_id its calendar,
--                    cal_user whose calendar, cal_sig what was written (to see what changed)
-- tasks.cal_dirty    1: the calendar has to be looked at for this task (the background run does), 2: Mail refused for
--                    this person for now (no place, not allowed) — asked again once a day
-- Adding the columns writes no row; the UPDATE below marks the open tasks with a time from today on, so that they get
-- their event once Mail is there.
ALTER TABLE tasks ADD COLUMN snoozed_at INTEGER;
ALTER TABLE tasks ADD COLUMN missed_at INTEGER;
ALTER TABLE tasks ADD COLUMN cal_event_id INTEGER;
ALTER TABLE tasks ADD COLUMN cal_id INTEGER;
ALTER TABLE tasks ADD COLUMN cal_user INTEGER;
ALTER TABLE tasks ADD COLUMN cal_sig TEXT;
ALTER TABLE tasks ADD COLUMN cal_dirty INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_tasks_cal_dirty ON tasks(cal_dirty, id) WHERE cal_dirty != 0;
CREATE INDEX idx_tasks_cal_user ON tasks(cal_user) WHERE cal_event_id IS NOT NULL;
CREATE INDEX idx_tasks_missed ON tasks(missed_at) WHERE missed_at IS NOT NULL AND done_at IS NULL AND deleted_at IS NULL;
-- the open tasks due on one day, whatever their list („Gestern offen geblieben“ of everybody, once a day)
CREATE INDEX idx_tasks_dueday ON tasks(due_date) WHERE done_at IS NULL AND deleted_at IS NULL AND parent_id IS NULL AND due_date IS NOT NULL;
UPDATE tasks SET cal_dirty = 1 WHERE due_time IS NOT NULL AND due_date >= date('now') AND done_at IS NULL AND deleted_at IS NULL AND parent_id IS NULL;

-- the morning hint „Gestern offen geblieben“: the day it went out to a person last (once a day)
CREATE TABLE yesterday_sent (
  user_id INTEGER PRIMARY KEY,
  day     TEXT NOT NULL,
  at      INTEGER NOT NULL
);

-- the calendar „Aufgaben“ of a person in Mail (calendar_tasks), kept so that a task needs one call
CREATE TABLE cal_users (
  user_id     INTEGER PRIMARY KEY,
  calendar_id INTEGER NOT NULL,
  at          INTEGER NOT NULL
);

-- who had something in „Mein Tag“ on a day (the morning hint asks for yesterday, for everybody at once)
CREATE INDEX idx_my_day_day ON my_day(day, user_id);
