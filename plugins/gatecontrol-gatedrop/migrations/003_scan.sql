-- GateDrop 1.4.0: the virus scan of GateControl (server/scan.js) per file of a send — state pending | clean | infected |
-- unscannable | unchecked, blocked 1 = GateControl does not hand it out (quarantine, still being checked, not checkable
-- and blocked), finding = the name of the find or why it could not be checked. NULL: no result known (an older
-- GateControl, a file from before the scan, a file only on the sender's device).
ALTER TABLE items ADD COLUMN scan_state TEXT;
ALTER TABLE items ADD COLUMN scan_blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN scan_finding TEXT;
