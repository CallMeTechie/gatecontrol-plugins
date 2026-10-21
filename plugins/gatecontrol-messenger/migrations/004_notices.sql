-- gatecontrol-messenger 1.6.0: the chat sink of GateControl's notification center (permissions.notifySink, hook
-- deliverNotice). A notification lands at most once per conversation: a second call with the same notification id
-- (GateControl retrying, a restart in between) answers the people it reached the first time and posts nothing.
-- Kept 7 days (background). The notice channels themselves are conversations with managed_by =
-- 'gatecontrol-messenger' and managed_key = 'notice:<source>:<user id>' (no new columns).

CREATE TABLE notices (
  notice_id TEXT NOT NULL,                -- GateControl's notification id
  conv_id INTEGER NOT NULL,
  msg_id INTEGER NOT NULL,
  users TEXT NOT NULL,                    -- JSON: the user ids it reached there (answered as `covered`)
  at INTEGER NOT NULL,
  PRIMARY KEY (notice_id, conv_id)
);
CREATE INDEX notices_at ON notices (at);
