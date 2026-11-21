-- gatecontrol-smarthome 1.11.0: logic chains, stage 1 — the protocol and the brake of the chains on a GateControl
-- gateway. rule_runs: what the edge part did (edge/rules.js run records), the last 200 per gateway; uid =
-- '<epoch>:<n>' of the edge part's ring, seq = its sequence number (a run that finishes later comes again with a
-- higher one); late = it came only after the gateway was back ("nachgereicht"). rules.stopped_at / stopped_reason:
-- the edge part stopped the chain (more than 10 runs a minute) and the server part switched it off; resumed_at: when
-- it was started again ("Wieder starten") — a stop of before that does not count any more.
ALTER TABLE rules ADD COLUMN stopped_at TEXT;
ALTER TABLE rules ADD COLUMN stopped_reason TEXT;
ALTER TABLE rules ADD COLUMN resumed_at TEXT;
CREATE TABLE rule_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway_id  INTEGER NOT NULL,
  rule_id     INTEGER NOT NULL,
  uid         TEXT NOT NULL,
  epoch       TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  result      TEXT NOT NULL,
  reason      TEXT,
  detail_json TEXT,
  late        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_rule_runs_uid ON rule_runs(gateway_id, uid);
CREATE INDEX idx_rule_runs_gw ON rule_runs(gateway_id, started_at);
CREATE INDEX idx_rule_runs_rule ON rule_runs(rule_id);
