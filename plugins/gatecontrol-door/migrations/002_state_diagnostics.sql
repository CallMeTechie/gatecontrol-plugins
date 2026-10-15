-- gatecontrol-door 1.0.1: locks stuck in a transitional state ("Öffnet …").
-- The bridge's /list (its cached lastKnownState) and Nuki Web's /smartlock can
-- keep reporting unlocking / locking / unlatching (opener: opening / boot_run)
-- long after the lock has stopped. The plugin then asks the lock itself
-- (bridge /lockState, Nuki Web GET /smartlock/{id}) and, after 3 minutes,
-- shows the last stable state with "stale" instead. Rows written by 1.0.0
-- keep NULL here until the next poll fills them.
ALTER TABLE lock_state ADD COLUMN moving_since INTEGER;      -- the saved state is transitional since (ms), NULL = stable
ALTER TABLE lock_state ADD COLUMN stable_state TEXT;         -- the last non-transitional state we saw
ALTER TABLE lock_state ADD COLUMN nuki_via TEXT;             -- where the saved state came from: list | lockState | smartlock | smartlock_id | assumed
ALTER TABLE lock_state ADD COLUMN list_nuki_state INTEGER;   -- raw Nuki code of the source's overview (bridge /list, web /smartlock)
ALTER TABLE lock_state ADD COLUMN list_moving_since INTEGER; -- that overview code is transitional since (ms), NULL = stable
