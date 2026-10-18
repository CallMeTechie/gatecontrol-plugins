-- gatecontrol-familie 1.9.0: rules and reminders (an extension of the presence
-- rules), assigning a shopping list to a person, tasks from the chat.
-- Times are ms since the epoch.

-- A rule's title (the name of before stays for older pages), house rule or a
-- person's own reminder, the schedule of the trigger 'schedule'
ALTER TABLE presence_rules ADD COLUMN title TEXT;
ALTER TABLE presence_rules ADD COLUMN scope TEXT NOT NULL DEFAULT 'house';   -- house | personal
ALTER TABLE presence_rules ADD COLUMN schedule_json TEXT;                    -- { weekdays: [1..7], time: 'HH:MM' }
UPDATE presence_rules SET title = name WHERE title IS NULL;

-- One reminder a person got from a rule (snooze / done through the buttons of the notification)
CREATE TABLE rule_reminders (
  id            INTEGER PRIMARY KEY,
  rule_id       INTEGER NOT NULL,
  fire_key      TEXT NOT NULL,                      -- 'sched:<YYYY-MM-DD>' | 'run:<ms>'
  user_id       INTEGER NOT NULL,
  day           TEXT NOT NULL,                      -- local date of the first notification
  state         TEXT NOT NULL DEFAULT 'open',       -- open | snoozed | done | resolved
  sends         INTEGER NOT NULL DEFAULT 1,         -- notifications so far (at most 3 a day)
  snooze_until  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (rule_id, fire_key, user_id)
);
CREATE INDEX idx_rule_reminders_state ON rule_reminders(state, snooze_until);
CREATE INDEX idx_rule_reminders_user ON rule_reminders(user_id, state);

-- A shopping list asked of a person ("Kannst du einkaufen gehen?")
ALTER TABLE shop_lists ADD COLUMN assignee_id INTEGER;
ALTER TABLE shop_lists ADD COLUMN assigned_by INTEGER;
ALTER TABLE shop_lists ADD COLUMN assigned_at INTEGER;
ALTER TABLE shop_lists ADD COLUMN due_at INTEGER;
ALTER TABLE shop_lists ADD COLUMN assign_state TEXT;                         -- open | taken | declined
ALTER TABLE shop_lists ADD COLUMN assign_notify TEXT;                        -- direct | family | push (how it was asked)

-- Tasks made in a chat ("Aufgabe" in the attachment menu)
ALTER TABLE tasks ADD COLUMN source TEXT;                                    -- NULL | 'chat'
ALTER TABLE tasks ADD COLUMN conversation_id INTEGER;
