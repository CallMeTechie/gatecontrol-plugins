-- gatecontrol-schule 1.1.0: changes handed to the Familie plugin's rules (service rule_event).
-- rule_at: when the change was taken into a rule_event call (or skipped because Familie is not there);
-- NULL = not yet. Each change is handed over at most once.
ALTER TABLE changes ADD COLUMN rule_at INTEGER;
