-- GateControl Mail 1.1.0 — who counts against the licence's people (like Drive): a person the administrator allows gets
-- a seat of their kind the first time they use Mail, while the licence has room (seats.js); an administrator can change
-- the kind or switch a person off ('none': no seat, never given again on its own).
CREATE TABLE seats (
  user_id    INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('family', 'business', 'none')),
  enabled_at INTEGER NOT NULL,
  enabled_by INTEGER           -- the administrator; NULL: given on first use
);
