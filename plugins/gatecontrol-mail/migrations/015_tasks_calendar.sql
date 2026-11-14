-- Mail 1.15.0: the calendar „Aufgaben“ of a person (server/services.js calendar_tasks) — a GateControl calendar of its
-- own that Notizen & Aufgaben writes the tasks with a time into. role = 'tasks' marks it (NULL: every other calendar);
-- there is at most one per person, made on the first call. Adding the column writes no row.
ALTER TABLE calendars ADD COLUMN role TEXT;
CREATE UNIQUE INDEX calendars_role ON calendars (user_id, role) WHERE role IS NOT NULL;
-- calendar_update / calendar_delete find the key of an event (service_keys had only the way from the key to the event)
CREATE INDEX service_keys_event ON service_keys (event_id);
