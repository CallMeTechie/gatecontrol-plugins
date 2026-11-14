-- gatecontrol-familie 1.21.0: the shopping lists in „Notizen & Aufgaben“ (server/shopsync.js).
--
-- After the move (a button on the settings page) the hub owns the lists; Familie's tables stay the copy Familie shows
-- (the app, the portal, the wall tablet, the cards in the chat) and keeps working on.
--   synced_at  when the row was last in step with the hub (0: never — a list of Familie's own)
--   dirty      changes made in Familie that are not in the hub yet (counted, so one made while a push runs is not lost)
--   by_user    who changed the row last in Familie (the person the hub acts for)
-- Adding the columns writes no row; without the move nothing reads them.
ALTER TABLE shop_lists ADD COLUMN synced_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shop_lists ADD COLUMN by_user INTEGER;
ALTER TABLE shop_items ADD COLUMN synced_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shop_items ADD COLUMN by_user INTEGER;
ALTER TABLE shop_lists ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shop_items ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_shop_lists_dirty ON shop_lists(dirty) WHERE dirty > 0;
CREATE INDEX idx_shop_items_dirty ON shop_items(dirty) WHERE dirty > 0;
