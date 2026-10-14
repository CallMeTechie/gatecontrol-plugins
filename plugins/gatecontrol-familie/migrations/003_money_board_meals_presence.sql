-- gatecontrol-familie 1.2.0: pocket money (Taschengeld), wishlists,
-- household book (Haushaltsbuch), pinboard & packing lists, meal plan,
-- presence & smart home rules. Money is bookkeeping only: integer cents (EUR),
-- nothing is ever paid, charged or transferred. Times are ms since the epoch,
-- dates 'YYYY-MM-DD' (local dates of the plugin's time zone), JSON as TEXT.

-- Pocket money: the rule per child (one row once a parent set it)
CREATE TABLE allowance_rules (
  child_id        INTEGER PRIMARY KEY,
  amount_cents    INTEGER NOT NULL DEFAULT 0,
  interval        TEXT NOT NULL DEFAULT 'weekly',   -- weekly | monthly
  weekday         INTEGER,                          -- weekly: 1..7, 1 = Monday
  day_of_month    INTEGER,                          -- monthly: 1..28
  active          INTEGER NOT NULL DEFAULT 0,
  active_since    INTEGER,                          -- ms: periods before this are never paid
  star_stars      INTEGER,                          -- star rate: star_stars stars = star_cents cents
  star_cents      INTEGER,
  updated_at      INTEGER NOT NULL,
  updated_by      INTEGER
);

-- Bookings (the balance is their sum); period: the payout period of an
-- automatic booking ('w:<date>' / 'm:<YYYY-MM>'), unique per child — idempotent
CREATE TABLE allowance_bookings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id    INTEGER NOT NULL,
  cents       INTEGER NOT NULL,
  kind        TEXT NOT NULL,                        -- allowance | manual | stars | spend
  note        TEXT NOT NULL DEFAULT '',
  period      TEXT,
  at          INTEGER NOT NULL,
  by_user     INTEGER
);
CREATE INDEX idx_allowance_bookings_child ON allowance_bookings(child_id, at);
CREATE UNIQUE INDEX idx_allowance_bookings_period ON allowance_bookings(child_id, period) WHERE period IS NOT NULL;

-- A child asks to convert stars into money; parents approve or decline
CREATE TABLE allowance_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id    INTEGER NOT NULL,
  stars       INTEGER NOT NULL,
  cents       INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | declined
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  decided_by  INTEGER,
  booking_id  INTEGER
);
CREATE INDEX idx_allowance_requests_child ON allowance_requests(child_id, status);

-- Convertible stars per child: earned (task_done.stars + carried) − converted.
-- carried keeps the stars of task_done rows removed by the retention.
CREATE TABLE star_accounts (
  user_id     INTEGER PRIMARY KEY,
  carried     INTEGER NOT NULL DEFAULT 0,
  converted   INTEGER NOT NULL DEFAULT 0
);

-- Wishlists (reserved_by is never shown to the owner)
CREATE TABLE wishes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id      INTEGER NOT NULL,
  title         TEXT NOT NULL,
  url           TEXT,
  price_cents   INTEGER,
  note          TEXT NOT NULL DEFAULT '',
  occasion      TEXT,                                -- birthday | christmas | other | NULL
  sort          INTEGER NOT NULL DEFAULT 0,
  reserved_by   INTEGER,
  reserved_at   INTEGER,
  got_it        INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_wishes_owner ON wishes(owner_id, sort);

-- Household book (parents only)
CREATE TABLE expenses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cents       INTEGER NOT NULL,
  category    TEXT NOT NULL,                        -- food | kids | household | leisure | mobility | other
  paid_by     INTEGER NOT NULL,
  date        TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  shared      INTEGER NOT NULL DEFAULT 1,
  list_id     TEXT,                                 -- from a shopping list ("Einkauf erfassen")
  created_by  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_expenses_date ON expenses(date);

-- A month marked settled (record only — nothing is paid)
CREATE TABLE expense_settlements (
  month           TEXT PRIMARY KEY,                 -- YYYY-MM
  transfers_json  TEXT NOT NULL DEFAULT '[]',
  settled_at      INTEGER NOT NULL,
  settled_by      INTEGER
);

-- Pinboard
CREATE TABLE board_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT 'yellow',
  pinned      INTEGER NOT NULL DEFAULT 0,
  author_id   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  expires_at  INTEGER
);

-- Checklists (packing lists) and their templates
CREATE TABLE checklists (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  title             TEXT NOT NULL,
  from_template_id  INTEGER,
  created_by        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE checklist_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  checklist_id  INTEGER NOT NULL,
  text          TEXT NOT NULL,
  done          INTEGER NOT NULL DEFAULT 0,
  done_by       INTEGER,
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_checklist_items_list ON checklist_items(checklist_id, sort);

CREATE TABLE checklist_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  items_json  TEXT NOT NULL DEFAULT '[]',
  created_by  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Meal plan: one meal per date and slot
CREATE TABLE meals (
  date              TEXT NOT NULL,
  slot              TEXT NOT NULL,                  -- lunch | dinner
  title             TEXT NOT NULL,
  note              TEXT NOT NULL DEFAULT '',
  cook_id           INTEGER,
  ingredients_json  TEXT NOT NULL DEFAULT '[]',
  updated_at        INTEGER NOT NULL,
  updated_by        INTEGER,
  PRIMARY KEY (date, slot)
);

-- Presence: consent per person (only for oneself) and the last state
CREATE TABLE presence_consent (
  user_id     INTEGER PRIMARY KEY,
  share       INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE presence_state (
  user_id       INTEGER PRIMARY KEY,
  home          INTEGER NOT NULL,
  since         INTEGER NOT NULL,
  reported_at   INTEGER NOT NULL
);

-- Presence rules (owner: whose quick actions run — the person who last set the actions)
CREATE TABLE presence_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL DEFAULT '',
  trigger_type    TEXT NOT NULL,                    -- all_away | first_home | child_home_alone | person_home | person_away
  user_id         INTEGER,                          -- person_home / person_away
  grace_minutes   INTEGER NOT NULL DEFAULT 10,      -- all_away
  conditions_json TEXT NOT NULL DEFAULT '{}',
  actions_json    TEXT NOT NULL DEFAULT '[]',
  active          INTEGER NOT NULL DEFAULT 1,
  owner_id        INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_run_at     INTEGER,
  last_key        TEXT                              -- all_away: the episode already handled
);

-- Rule runs (the last 50 are shown; kept 90 days)
CREATE TABLE presence_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id       INTEGER NOT NULL,
  rule_name     TEXT NOT NULL DEFAULT '',
  trigger_type  TEXT NOT NULL,
  user_id       INTEGER,
  at            INTEGER NOT NULL,
  ok            INTEGER NOT NULL,
  results_json  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_presence_log_at ON presence_log(at);
