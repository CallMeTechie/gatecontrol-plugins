-- 1.2.0: list days in „Mein Tag“ (Einkaufstag), roles read | write for members of lists and notebooks, delete with
-- „Rückgängig“ (what a delete did, to undo it while the list or notebook is in the trash).

-- ISO weekdays as bits (bit 0 = Monday … bit 6 = Sunday): the list shows at the top of „Mein Tag“ on these days, for
-- every member (set by the owner)
ALTER TABLE lists ADD COLUMN days INTEGER NOT NULL DEFAULT 0;
-- 'HH:MM': a push in the morning of those days (topic listday), NULL = none
ALTER TABLE lists ADD COLUMN remind TEXT;
-- the day ('YYYY-MM-DD') the listday push went out last
ALTER TABLE lists ADD COLUMN reminded_day TEXT;
-- what the delete did ({ mode, members: [[user, role, group, position, mydayOff, since]], moved: [taskId], target }) —
-- POST lists/<id>/restore undoes it; NULL for lists deleted before 1.2.0
ALTER TABLE lists ADD COLUMN trash_json TEXT;
CREATE INDEX idx_lists_remind ON lists(remind) WHERE remind IS NOT NULL AND days != 0 AND deleted_at IS NULL;

-- role: owner | write | read (1.2.0); myday_off: this member does not want the list day card; since: when shared
ALTER TABLE list_members ADD COLUMN myday_off INTEGER NOT NULL DEFAULT 0;
ALTER TABLE list_members ADD COLUMN since INTEGER;

-- role: owner | write | read (1.2.0)
ALTER TABLE notebook_members ADD COLUMN since INTEGER;
ALTER TABLE notebooks ADD COLUMN trash_json TEXT;
