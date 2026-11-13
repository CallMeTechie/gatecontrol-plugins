-- Mail 1.14.0: the search index (server/search.js) — an option, off unless the administrator switches it on.
--
-- messages.fts: what the full-text index holds of a mail — 0 nothing (every mail while the option is off), 1 all of
-- it, 2 all but the rest of a very long text. Adding the column writes no row (SQLite keeps the default in the
-- schema). Everything else — the FTS5 tables, their triggers, the partial index messages_fts_todo — is made by the
-- plugin when the option is switched on, and taken away again when it is switched off.
ALTER TABLE messages ADD COLUMN fts INTEGER NOT NULL DEFAULT 0;
