-- Mail 1.10.1: indexes for the statements of the background run and of the lists that read too much of the database.
--
-- The bytes of a person (limits.usedBytes, the quota, the body prefetch — every background run and every GET me) were
-- summed from the rows of bodies, events and card_photos: SQLite reads the whole row up to the column `bytes`,
-- i.e. every mail body (html, text) with its overflow pages — the whole database at every run. An index with `bytes`
-- answers the sum without the rows (the statements name it: INDEXED BY — without statistics SQLite would take the row).
CREATE INDEX bodies_bytes ON bodies (message_id, bytes, used_at);
CREATE INDEX events_bytes ON events (user_id, bytes);
CREATE INDEX card_photos_bytes ON card_photos (card_id, bytes);
-- the thread of a new mail (mailstore.threadOf): In-Reply-To of the person, Graph's conversation of the account —
-- before, every new mail read all mail of the person
CREATE INDEX messages_reply ON messages (user_id, in_reply_to);
CREATE INDEX messages_conv ON messages (account_id, conv) WHERE conv IS NOT NULL;
-- unread counts per folder (GET folders, GET messages counts, GET me)
CREATE INDEX messages_unread ON messages (folder_id, unread, tab);
-- bodies to fetch (engine.backfill, every run and account) and attachments to file (drive.tick, every run)
CREATE INDEX messages_body_state ON messages (account_id, body_state, date);
CREATE INDEX messages_unfiled ON messages (date) WHERE filed = 0 AND has_att = 1;
-- the retention (engine.retention) and „Zum Ablegen“ (GET filing, tofile_count for Drive)
CREATE INDEX messages_date ON messages (date);
CREATE INDEX filing_user ON filing (user_id);
