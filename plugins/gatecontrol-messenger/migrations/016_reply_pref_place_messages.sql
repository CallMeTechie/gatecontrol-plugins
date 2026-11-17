-- Messenger 1.27.0: the way a person is written to, and place messages.
--
-- persons.reply_pref — „Nachrichten senden über“ in the chat info (server/persons.js): NULL = automatic (the way of the
-- newest incoming message), 'gatecontrol' or a network ('whatsapp', 'signal', 'telegram'): always that way, while it can
-- send (else the chat inside GateControl, marked as a fallback). Only in the view of the person who merged the ways.
ALTER TABLE persons ADD COLUMN reply_pref TEXT;

-- place_messages — „Beim Ankommen senden“ (server/placemsgs.js): a rule of one person, watched on one phone (device_id).
-- The phone knows the place; the server keeps it sealed and never learns where the person is: when the phone reaches or
-- leaves the place it asks POST place-messages/:id/fire, and only the finished message goes out.
CREATE TABLE place_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  trig TEXT NOT NULL,                 -- enter | exit
  place_enc BLOB NOT NULL,            -- sealed { familieId, name, lat, lon, radiusM }
  text_enc BLOB NOT NULL,             -- sealed text
  conv_id INTEGER NOT NULL,           -- a chat, or the lead conversation of a person
  way TEXT NOT NULL DEFAULT 'auto',   -- auto | gatecontrol | a network
  repeat TEXT NOT NULL DEFAULT 'once',-- once | always
  window_json TEXT,                   -- { days: [1..7], from: 'HH:MM', to: 'HH:MM' } or NULL
  ask INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_at INTEGER,
  done_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX place_messages_user ON place_messages (user_id);
