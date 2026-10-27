-- Recognised text of a file (since 1.3.0): a scan's text, recognised on the phone, sent with uploads/commit { text }.
-- GET search finds files by it. A new version or a restored one without text drops it; purging the file removes it.
CREATE TABLE doc_text (
  node_id INTEGER PRIMARY KEY,
  text    TEXT NOT NULL,
  at      INTEGER NOT NULL
);
