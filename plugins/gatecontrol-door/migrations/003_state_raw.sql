-- gatecontrol-door 1.0.2: Nuki Web's cloud copy can stay on a transitional
-- state ("Öffnet …") while the lock is long unlocked. Kept per lock for the
-- admin diagnostics and the stale check: when the cloud last changed its copy
-- (smartlock.updateDate) and the raw fields Nuki reported (a small JSON of
-- numbers / short strings — Web: mode, state, lastAction, trigger, doorState,
-- serverState, updateDate; Bridge: mode, state, stateName, doorsensorState,
-- doorsensorStateName, timestamp). Never tokens.
ALTER TABLE lock_state ADD COLUMN cloud_at INTEGER; -- Nuki Web updateDate of the saved state (ms), NULL = unknown / bridge
ALTER TABLE lock_state ADD COLUMN nuki_raw TEXT;    -- JSON of the raw fields above (diagnostics only)
