-- Mail 1.14.0: the search index (server/search.js).
--
-- messages.fts: what the full-text index holds of a mail — 0 nothing yet, 1 all of it, 2 all but the rest of a very
-- long text. The index itself (an FTS5 table and its triggers) is made by the plugin when it starts, not here: a
-- database that cannot do FTS5 with the trigram tokenizer keeps working, with the search of before.
ALTER TABLE messages ADD COLUMN fts INTEGER NOT NULL DEFAULT 0;
-- the mails the index does not hold (completely): the build's rest (fts = 0, newest first — and how many are left,
-- from the index alone) and what GET search still looks through the old way. Empty but for the very long mails once
-- the build is through.
CREATE INDEX messages_fts_todo ON messages (fts, date) WHERE fts <> 1;
