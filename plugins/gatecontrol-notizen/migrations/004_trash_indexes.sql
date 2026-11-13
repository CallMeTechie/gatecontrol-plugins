-- Notizen & Aufgaben 1.2.1 — the housekeeping of the trash (server/housekeeping.js purge) asks whether a notebook or a
-- list that left the trash is empty. The indexes of notebook_id and list_id hold only the rows still there
-- (idx_notes_nb, idx_tasks_list), so that question read every note (with its text) or every task. These two hold the
-- rest: notes in the trash, and tasks in the trash or below another task. A row gets in only when it is deleted (or is
-- a sub-task) — a note or task that is written or ticked off never touches them.
CREATE INDEX idx_notes_gone ON notes(notebook_id) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_tasks_rest ON tasks(list_id) WHERE deleted_at IS NOT NULL OR parent_id IS NOT NULL;
