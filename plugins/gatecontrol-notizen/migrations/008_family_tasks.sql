-- Notizen & Aufgaben 1.6.0 — whose turn it is, whoever is first, stars, and the family's tasks (server/famtasks.js).
--
-- tasks.turn         NULL | 'rotate' (one person at a time, the next one after it is ticked off) | 'first' (it goes to
--                    everybody of `people`, the first one ticks it off for all)
-- tasks.people_json  '[5,6]' — the people of the turn, in their order (members of the list; who left is passed over)
-- tasks.stars        0–10 — the number a task of the family list carries; counted and settled by Familie
-- tasks.credit_id    for whom it was ticked off (a parent ticks a child's task off: done_by the parent, credit the child)
-- tasks.fam_uid      the task's id in Familie's copy ('f12', 'f12.5', 'p3', 'h345') — one open task per uid
-- lists.fam_tasks    'gatecontrol-familie': THE list of the family's tasks (its members are the family)
-- Adding the columns writes no row.
ALTER TABLE tasks ADD COLUMN turn TEXT;
ALTER TABLE tasks ADD COLUMN people_json TEXT;
ALTER TABLE tasks ADD COLUMN stars INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN credit_id INTEGER;
ALTER TABLE tasks ADD COLUMN fam_uid TEXT;
CREATE INDEX idx_tasks_fam ON tasks(fam_uid) WHERE fam_uid IS NOT NULL;
ALTER TABLE lists ADD COLUMN fam_tasks TEXT;
CREATE INDEX idx_lists_fam_tasks ON lists(fam_tasks) WHERE fam_tasks IS NOT NULL;

-- The family as Familie told it for its tasks (service tasks_bind) — apart from shop_family: the tasks and the shopping
-- lists move (and go back) on their own. dirty: something changed here that Familie has not been told (tasks_changed).
-- stars: does Familie count stars (its module)? moved: what the move brought ({ at, by, tasks, places }).
CREATE TABLE task_family (
  plugin   TEXT PRIMARY KEY,
  members  TEXT NOT NULL DEFAULT '[]',
  parents  TEXT NOT NULL DEFAULT '[]',
  list_id  INTEGER,
  stars    INTEGER NOT NULL DEFAULT 0,
  moved    TEXT,
  at       INTEGER NOT NULL,
  dirty    INTEGER NOT NULL DEFAULT 0
);

-- What was ticked off (or taken back: undone = 1) HERE in a task Familie keeps a copy of — Familie fetches the rows
-- (tasks_list, by seq) and books the stars. A row is written once and changed once at most (undone); kept 60 days.
CREATE TABLE fam_done (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  uid       TEXT NOT NULL,
  task_id   INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,                  -- for whom (the stars)
  by_id     INTEGER NOT NULL,                  -- who ticked
  due_date  TEXT,
  stars     INTEGER NOT NULL DEFAULT 0,
  at        INTEGER NOT NULL,
  undone    INTEGER NOT NULL DEFAULT 0,
  rev       INTEGER NOT NULL                   -- counts up with every write (the cursor of tasks_list)
);
CREATE INDEX idx_fam_done_rev ON fam_done(rev);
CREATE INDEX idx_fam_done_task ON fam_done(task_id);

-- „Umzug abgeschlossen“: who has seen the note about the move (once per person and move).
CREATE TABLE fam_seen (
  user_id  INTEGER PRIMARY KEY,
  at       INTEGER NOT NULL
);
