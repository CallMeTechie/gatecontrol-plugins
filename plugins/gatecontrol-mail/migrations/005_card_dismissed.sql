-- Mail 1.3.6: values of a linked contact the person removed from the contact it is linked to (card_id: the contact
-- shown, source_id: the linked card that still has the value). The view leaves them out until the value at the
-- provider changes (another value_key). field: emails | phones | addresses | urls | company | department | title |
-- birthday; value_key: the compared form (address lower case, the digits of a number, street|postal code|city folded).
CREATE TABLE card_dismissed (
  user_id   INTEGER NOT NULL,
  card_id   INTEGER NOT NULL,
  source_id INTEGER NOT NULL,
  field     TEXT NOT NULL,
  value_key TEXT NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (card_id, source_id, field, value_key)
);
CREATE INDEX card_dismissed_source ON card_dismissed (source_id);
