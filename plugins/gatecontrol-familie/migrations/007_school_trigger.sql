-- gatecontrol-familie 1.12.0: the rule trigger 'school_change' („Stunde fällt aus“) — events of
-- the Schule plugin through the service rule_event. Times are ms since the epoch.

-- The options of a trigger that has more than a person or a place:
-- school_change { kinds: ['cancelled' | 'changed' | 'extra' | 'restored'], days: 'today' | 'tomorrow' | 'any' }
ALTER TABLE presence_rules ADD COLUMN trigger_json TEXT;

-- What a run was about, for the log („Lena: Mathe 3. Std. (09:50) fällt aus“)
ALTER TABLE presence_log ADD COLUMN event_text TEXT;

-- The events a rule has handled ('school:<userId>:<date>:<start>:<kind>'): a repeated event never runs it twice
CREATE TABLE rule_fired (
  rule_id   INTEGER NOT NULL,
  fire_key  TEXT NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (rule_id, fire_key)
);
CREATE INDEX idx_rule_fired_at ON rule_fired(at);
