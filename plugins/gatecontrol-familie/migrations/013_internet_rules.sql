-- gatecontrol-familie 1.20.0: „Internet zu Hause“ — the rule action „Internet pausieren“ and „Zeit abgelaufen“
-- (server/internet.js). rule_id / rule_title: the rule that set the pause in by_user_id's name (NULL: the parent
-- themselves); done_at: when the end of a pause / extra time was dealt with (the child told once, or nothing to tell).
ALTER TABLE internet_log ADD COLUMN rule_id INTEGER;
ALTER TABLE internet_log ADD COLUMN rule_title TEXT;
ALTER TABLE internet_log ADD COLUMN done_at INTEGER;
