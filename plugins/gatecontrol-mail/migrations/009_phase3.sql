-- Mail 1.9.0 (Phase 3): free/busy, shared GateControl calendars, resources with booking requests.
--
-- Shares of an own GateControl calendar (source 'local') to a person or a person group of GateControl (gc.groups):
-- level freebusy | read | write. One row per calendar and principal.
CREATE TABLE cal_shares (
  id           INTEGER PRIMARY KEY,
  calendar_id  INTEGER NOT NULL,
  owner_id     INTEGER NOT NULL,
  type         TEXT NOT NULL,          -- user | group
  principal_id INTEGER NOT NULL,
  level        TEXT NOT NULL,          -- freebusy | read | write
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (calendar_id, type, principal_id)
);
CREATE INDEX cal_shares_principal ON cal_shares (type, principal_id);
-- What a recipient did with a calendar shared with them („Mit mir geteilt“): shown or not, an own colour. A row means
-- the person has seen it (the owner reads „hat angenommen“ once it was shown).
CREATE TABLE cal_shared (
  user_id      INTEGER NOT NULL,
  calendar_id  INTEGER NOT NULL,
  visible      INTEGER NOT NULL DEFAULT 0,
  color        TEXT,
  accepted_at  INTEGER,
  PRIMARY KEY (user_id, calendar_id)
);
-- Resources the administrator keeps (Einstellungen › Plugins › Mail › Ressourcen): a room, a vehicle, a device or
-- something else. bookers_json { all, principals: [{ type, id, label }] }; approval auto | approval with
-- approvers_json [{ type, id, label }]; the rules max_minutes, horizon_days and hours_json { days: [1…7], from, to }
-- (bookable times in time_zone). Each resource has its calendar on the server: its bookings.
CREATE TABLE resources (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,          -- room | vehicle | device | other
  location     TEXT,
  seats        INTEGER,
  equipment    TEXT,
  color        TEXT NOT NULL,
  bookers_json TEXT NOT NULL,
  approval     TEXT NOT NULL DEFAULT 'auto',
  approvers_json TEXT NOT NULL DEFAULT '[]',
  max_minutes  INTEGER,
  horizon_days INTEGER,
  hours_json   TEXT,
  time_zone    TEXT NOT NULL DEFAULT 'Europe/Berlin',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
-- A booking of a resource: the booker's event (a GateControl calendar, the resource as an attendee) and its state
-- pending | confirmed | declined | cancelled. violations_json: the rules it breaks; override 1: an approver confirmed it
-- anyway (logged in resource_log).
CREATE TABLE bookings (
  id           INTEGER PRIMARY KEY,
  resource_id  INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  event_id     INTEGER,
  title        TEXT NOT NULL DEFAULT '',
  start        INTEGER NOT NULL,
  end          INTEGER NOT NULL,
  all_day      INTEGER NOT NULL DEFAULT 0,
  state        TEXT NOT NULL,
  violations_json TEXT NOT NULL DEFAULT '[]',
  note         TEXT,
  decided_by   INTEGER,
  decided_at   INTEGER,
  override     INTEGER NOT NULL DEFAULT 0,
  comment      TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX bookings_resource ON bookings (resource_id, start);
CREATE INDEX bookings_user ON bookings (user_id, start);
CREATE INDEX bookings_event ON bookings (event_id);
-- What happened to resources and bookings (requests, decisions, overrides, changes by an administrator).
CREATE TABLE resource_log (
  id           INTEGER PRIMARY KEY,
  resource_id  INTEGER NOT NULL,
  booking_id   INTEGER,
  user_id      INTEGER,
  action       TEXT NOT NULL,
  detail_json  TEXT,
  at           INTEGER NOT NULL
);
CREATE INDEX resource_log_resource ON resource_log (resource_id, at);
-- Calendars of Microsoft accounts: the mailbox that owns one (Graph `owner`) — a calendar another person shared with the
-- account shows under „Mit mir geteilt“.
ALTER TABLE calendars ADD COLUMN owner_email TEXT;
