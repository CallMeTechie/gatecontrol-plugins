-- Messenger 1.12.0: bridges to other messengers, first stage (server/bridges.js). Three small tables — who confirmed
-- the notes before linking, which child a parent allowed which network, and which account is linked where. Never a
-- phone number, a contact or a session key: those stay in the bridge next to GateControl.

CREATE TABLE bridge_consent (
  user_id INTEGER NOT NULL,
  network TEXT NOT NULL,                  -- 'whatsapp'
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, network)
);

-- Children (Familie's family_roles) may not link until a parent allows it, per child and network.
CREATE TABLE bridge_grants (
  child_id INTEGER NOT NULL,
  network TEXT NOT NULL,
  granted_by INTEGER NOT NULL,            -- the parent
  at INTEGER NOT NULL,
  PRIMARY KEY (child_id, network)
);

CREATE TABLE bridge_links (
  user_id INTEGER NOT NULL,
  network TEXT NOT NULL,
  login_id TEXT NOT NULL,                 -- the bridge's id of the login (no number)
  state TEXT NOT NULL,                    -- connected | connecting | logged_out | error | unknown, as last seen
  linked_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, network, login_id)
);
