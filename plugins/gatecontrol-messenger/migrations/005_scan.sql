-- Messenger 1.11.0: the virus scan of GateControl per file (server/scan.js) — state pending | clean | infected |
-- unscannable | unchecked, blocked 1 = GateControl does not hand it out (quarantine, still being checked, not checkable
-- and blocked), finding = the name of the find or why it could not be checked. NULL: no result known (an older
-- GateControl, a file from before the scan).
ALTER TABLE media ADD COLUMN scan_state TEXT;
ALTER TABLE media ADD COLUMN scan_blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media ADD COLUMN scan_finding TEXT;
