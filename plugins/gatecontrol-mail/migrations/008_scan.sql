-- Mail 1.8.0: the virus scan of GateControl (server/scan.js) per attachment copy and per file of a draft — state
-- pending | clean | infected | unscannable | unchecked, or 'removed' (GateControl deleted the attachment at once:
-- "Anhang entfernt (Schadsoftware)"); blocked 1 = GateControl does not hand it out; finding = the name of the find or
-- why it could not be checked. NULL: no result known (an older GateControl, a copy from before the scan, not loaded).
ALTER TABLE attachments ADD COLUMN scan_state TEXT;
ALTER TABLE attachments ADD COLUMN scan_blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attachments ADD COLUMN scan_finding TEXT;
ALTER TABLE draft_atts ADD COLUMN scan_state TEXT;
ALTER TABLE draft_atts ADD COLUMN scan_blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE draft_atts ADD COLUMN scan_finding TEXT;
