-- Messenger 1.28.0: „Meine Orte“ from GateControl's profile (server/profileplaces.js, gc.places).
--
-- place_messages.place_ref — the place's reference ('profile:<id>' | 'home' | 'place:<id>'), next to the sealed copy of
-- name and point (place_enc, the fallback). Not a secret: an id, never a coordinate. The hook placesChanged finds the
-- place messages of a changed profile place by it. place_missing = 1: the profile place went or is not visible to the
-- person any more — the copy still holds (place.missing in the answer).
ALTER TABLE place_messages ADD COLUMN place_ref TEXT;
ALTER TABLE place_messages ADD COLUMN place_missing INTEGER NOT NULL DEFAULT 0;
CREATE INDEX place_messages_ref ON place_messages (place_ref);

-- arrivals.dest_ref — the same for a live arrival (the copy is the message's dest).
ALTER TABLE arrivals ADD COLUMN dest_ref TEXT;

-- place_uses — one row per use of a place by a person here (a place message saved, an arrival sent): GET places sorts
-- the picker's chips by it (most used in the last 90 days, then last used). Older rows go with the clean-up.
CREATE TABLE place_uses (
  user_id INTEGER NOT NULL,
  ref TEXT NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE INDEX place_uses_user ON place_uses (user_id, used_at);
