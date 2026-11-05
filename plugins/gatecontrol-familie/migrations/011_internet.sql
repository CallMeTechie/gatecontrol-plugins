-- gatecontrol-familie 1.18.0: „Internet zu Hause“ — parents pause the internet of a child at home or give it more time
-- (GateControl ≥ 1.231.0, gc.homeNetwork.internet — server/internet.js). GateControl keeps the pause itself and logs it in
-- its activity log; this table remembers who in the family did it and when, for the card („von Anna um 17:52“).
CREATE TABLE internet_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id    INTEGER NOT NULL,
  kind        TEXT NOT NULL,                  -- pause | resume | extend | extend_end
  until_at    INTEGER,                        -- ms: the end GateControl answered (pause / extend), NULL otherwise
  minutes     INTEGER,                        -- what was asked for (pause in minutes, extend), NULL otherwise
  by_user_id  INTEGER NOT NULL,               -- the parent
  at          INTEGER NOT NULL
);
CREATE INDEX internet_log_child ON internet_log (child_id, kind, at);
