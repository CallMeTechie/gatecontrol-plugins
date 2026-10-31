-- Mail 1.4.0 — the GateControl contact as the master. Duplicates become one contact in the person's own address book
-- (GC); the cards of the accounts are linked to it (cards.link_id), stay at their provider and are not listed on
-- their own. What a linked card has more is taken over (card_origins: from which linked card), another value of the
-- same kind is a conflict (card_conflicts) the person takes over or dismisses (card_dismissed, since 1.3.6).

-- GateControl's own, never at a provider: a favourite (0 = no, else its position from 1) and the chosen main number
-- (the value key — the digits — of one of its numbers; NULL: the first mobile number, else the first number).
ALTER TABLE cards ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN main_phone TEXT;
CREATE INDEX cards_favorite ON cards (user_id, favorite);
CREATE INDEX cards_link ON cards (link_id);

-- A value of a GC contact taken over from a linked card (field and value key as in card_dismissed). A change of such a
-- value by the person is written back to exactly that card at its provider.
CREATE TABLE card_origins (
  card_id   INTEGER NOT NULL,
  field     TEXT NOT NULL,
  value_key TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (card_id, field, value_key)
);
CREATE INDEX card_origins_source ON card_origins (source_id);

-- A linked card with another value of the same kind than its GC contact (another mobile number, another company).
-- replaces_key: the GC contact's value it would replace (NULL: added).
CREATE TABLE card_conflicts (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  card_id      INTEGER NOT NULL,
  source_id    INTEGER NOT NULL,
  field        TEXT NOT NULL,
  type         TEXT,
  value_key    TEXT NOT NULL,
  value_json   TEXT NOT NULL,
  replaces_key TEXT,
  at           INTEGER NOT NULL,
  UNIQUE (card_id, source_id, field, value_key)
);
CREATE INDEX card_conflicts_user ON card_conflicts (user_id);

-- The protocol of the merges (mode auto | manual | migrated; created: the GC contact was made by it); removed_json: the
-- GC cards that went up in it (their vCard), back on an undo.
CREATE TABLE card_merges (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  master_id    INTEGER NOT NULL,
  created      INTEGER NOT NULL,
  mode         TEXT NOT NULL,
  reason       TEXT,
  cards_json   TEXT NOT NULL,
  removed_json TEXT NOT NULL DEFAULT '[]',
  at           INTEGER NOT NULL,
  undone_at    INTEGER
);
CREATE INDEX card_merges_user ON card_merges (user_id, at);
CREATE INDEX card_merges_master ON card_merges (master_id);

-- The one run per person after the update (old links into GC contacts, certain duplicates merged), with its numbers.
CREATE TABLE card_runs (
  user_id    INTEGER PRIMARY KEY,
  master_at  INTEGER,
  stats_json TEXT
);
