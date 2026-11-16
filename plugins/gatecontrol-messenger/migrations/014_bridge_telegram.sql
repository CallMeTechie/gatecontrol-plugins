-- Messenger 1.24.0: Telegram (GateControl with gc.bridges version 11, server/bridges.js, server/bridgechats.js).

-- „Telegram-Kanäle“ — the parents' second switch per child: channels (and the like) of Telegram appear for the child only
-- with it (default off; only next to the permission for Telegram itself)
ALTER TABLE bridge_grants ADD COLUMN channels INTEGER NOT NULL DEFAULT 0;

-- a direct chat with a Telegram bot (shown with „Bot“), and the member count of a group as Telegram reports it (a group of
-- 200 and more is created muted)
ALTER TABLE conversations ADD COLUMN bridge_bot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN bridge_members INTEGER;
