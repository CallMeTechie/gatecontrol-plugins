-- gatecontrol-messenger 1.5.0: home actions — requests end after the administrator's time (requestTtlMin, kept per
-- request when it is sent), grants may switch the device off when they end.

-- request: open until this time (ms); NULL = created_at + 24 h (requests sent before 1.5.0)
ALTER TABLE action_msgs ADD COLUMN expires_at INTEGER;
-- grant: run the action with state 'off' as the granter when the grant ends (1 = yes, 2 = done)
ALTER TABLE action_msgs ADD COLUMN off_at_end INTEGER NOT NULL DEFAULT 0;
