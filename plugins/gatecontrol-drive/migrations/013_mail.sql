-- Services for GateControl Mail (1.15.0, server/mail.js).

-- Where a person files what a sender sends: save_file { learn: { from, always? } } — one row per person and sender
-- (lower case address), the folder of the last save; `hits` saves in a row into that folder; `always` = "Immer für
-- diesen Absender" (reason 'rule' of suggest_folder, else 'learned').
CREATE TABLE filing_rules (
  user_id    INTEGER NOT NULL,
  sender     TEXT NOT NULL,
  folder_id  INTEGER NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 1,
  always     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, sender)
);
CREATE INDEX filing_rules_folder ON filing_rules (folder_id);

-- Where a file came from: save_file { source: { plugin, label, ref } } — shown at the file (node.source) with a jump
-- back (the app link gatecontrol://plugin/<plugin>/message/<ref>). Goes with the node.
CREATE TABLE node_sources (
  node_id INTEGER PRIMARY KEY,
  plugin  TEXT NOT NULL,
  label   TEXT NOT NULL,
  ref     TEXT,
  at      INTEGER NOT NULL
);
