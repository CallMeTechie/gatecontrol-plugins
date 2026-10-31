-- GateControl Mail 1.2.0 — calendars and contacts (Phase 2). Everything belongs to exactly one person (user_id); the
-- administrators see numbers only. Local events are stored as iCalendar, local contacts as vCard (round trip: unknown
-- properties stay); Microsoft (Graph) keeps fields. Secrets (an own CalDAV/CardDAV password 'acct.<id>' davPassword, the
-- address of an iCal subscription 'ics.<calendarId>') are secrets of the plugin, never columns here.

-- Calendars of a person: source local | graph | caldav | ics; kind private | business | other.
CREATE TABLE calendars (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  account_id    INTEGER,
  source        TEXT NOT NULL,
  remote_id     TEXT,             -- Graph calendar id | CalDAV collection URL | NULL
  name          TEXT NOT NULL,
  color         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'other',
  writable      INTEGER NOT NULL DEFAULT 1,
  visible       INTEGER NOT NULL DEFAULT 1,
  notify        INTEGER NOT NULL DEFAULT 1,
  is_default    INTEGER NOT NULL DEFAULT 0,
  sort          INTEGER NOT NULL DEFAULT 0,
  ctag          TEXT,
  sync_token    TEXT,
  delta         TEXT,             -- CalDAV getctag / sync-token, Graph deltaLink or nextLink
  window_from   INTEGER,
  window_to     INTEGER,          -- the window synced (Graph calendarView)
  auto_schedule INTEGER NOT NULL DEFAULT 0,  -- the CalDAV server schedules itself (RFC 6638 calendar-auto-schedule)
  state         TEXT NOT NULL DEFAULT 'syncing',
  error_code    TEXT,
  error_at      INTEGER,
  synced_at     INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  UNIQUE (account_id, remote_id)
);
CREATE INDEX calendars_user ON calendars (user_id);

-- An event = one calendar object (a series with its exceptions). ics: the whole VCALENDAR (local, caldav, ics); Graph:
-- fields, remote_id = the Graph id (a series: its seriesMaster), change_key.
CREATE TABLE events (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL,
  calendar_id    INTEGER NOT NULL,
  uid            TEXT NOT NULL,
  remote_id      TEXT,
  href           TEXT,
  etag           TEXT,
  change_key     TEXT,
  ics            TEXT,
  title          TEXT NOT NULL DEFAULT '',
  location       TEXT,
  online_url     TEXT,
  description    TEXT,
  start          INTEGER NOT NULL,
  end            INTEGER NOT NULL,
  all_day        INTEGER NOT NULL DEFAULT 0,
  tz             TEXT,
  rrule          TEXT,
  status         TEXT NOT NULL DEFAULT 'confirmed',
  busy           TEXT NOT NULL DEFAULT 'busy',
  private        INTEGER NOT NULL DEFAULT 0,
  organizer_json TEXT,
  attendees_json TEXT NOT NULL DEFAULT '[]',
  reminders_json TEXT NOT NULL DEFAULT '[]',
  my_response    TEXT,
  sequence       INTEGER NOT NULL DEFAULT 0,
  pending        TEXT,            -- NULL | 'create' | 'update' | 'delete' (not at the provider yet)
  base_ics       TEXT,            -- the state before the own change (field merge after a 412)
  bytes          INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX events_uid ON events (calendar_id, uid);
CREATE INDEX events_remote ON events (calendar_id, remote_id);

-- Occurrences in the window −13 … +24 months (ical.js expansion or Graph calendarView), for ranges and reminders.
CREATE TABLE occurrences (
  event_id      INTEGER NOT NULL,
  occ           TEXT NOT NULL DEFAULT '',
  user_id       INTEGER NOT NULL,
  calendar_id   INTEGER NOT NULL,
  start         INTEGER NOT NULL,
  end           INTEGER NOT NULL,
  all_day       INTEGER NOT NULL,
  remote_id     TEXT,
  override_json TEXT,
  PRIMARY KEY (event_id, occ)
);
CREATE INDEX occurrences_range ON occurrences (user_id, start);
CREATE TABLE reminders_sent (
  event_id INTEGER NOT NULL,
  occ      TEXT NOT NULL,
  minutes  INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (event_id, occ, minutes)
);

-- Invitations (from mail or internal). state open | answered | applied | cancelled | outdated.
CREATE TABLE invitations (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  message_id INTEGER,
  account_id INTEGER,
  from_user  INTEGER,
  method     TEXT NOT NULL,
  uid        TEXT NOT NULL,
  occ        TEXT NOT NULL DEFAULT '',
  sequence   INTEGER NOT NULL DEFAULT 0,
  dtstamp    INTEGER,
  ics        TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'open',
  event_id   INTEGER,
  response   TEXT,
  comment    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX invitations_uid ON invitations (user_id, uid);
CREATE TABLE cal_prefs (user_id INTEGER PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);   -- CalPrefs + overlays (visible, color)

-- Address books and contacts. vcard: the whole vCard (local, carddav; round trip), Graph: fields.
CREATE TABLE addressbooks (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  account_id    INTEGER,
  source        TEXT NOT NULL,
  remote_id     TEXT,
  name          TEXT NOT NULL,
  writable      INTEGER NOT NULL DEFAULT 1,
  visible       INTEGER NOT NULL DEFAULT 1,
  is_default    INTEGER NOT NULL DEFAULT 0,
  ctag          TEXT,
  sync_token    TEXT,
  delta         TEXT,
  vcard_version TEXT NOT NULL DEFAULT '3.0',
  state         TEXT NOT NULL DEFAULT 'syncing',
  error_code    TEXT,
  error_at      INTEGER,
  synced_at     INTEGER,
  created_at    INTEGER NOT NULL,
  UNIQUE (account_id, remote_id)
);
CREATE INDEX addressbooks_user ON addressbooks (user_id);
CREATE TABLE cards (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL,
  addressbook_id INTEGER NOT NULL,
  uid            TEXT NOT NULL,
  remote_id      TEXT,
  href           TEXT,
  etag           TEXT,
  change_key     TEXT,
  vcard          TEXT,
  display        TEXT NOT NULL DEFAULT '',
  given          TEXT,
  family         TEXT,
  sort_key       TEXT NOT NULL DEFAULT '',
  company        TEXT,
  title          TEXT,
  birthday       TEXT,
  fields_json    TEXT NOT NULL DEFAULT '{}',
  photo_etag     TEXT,
  link_id        INTEGER,
  pending        TEXT,
  base_vcard     TEXT,
  bytes          INTEGER NOT NULL DEFAULT 0,
  version        INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX cards_uid ON cards (addressbook_id, uid);
CREATE INDEX cards_sort ON cards (user_id, sort_key);
CREATE TABLE card_emails (card_id INTEGER NOT NULL, user_id INTEGER NOT NULL, email TEXT NOT NULL, PRIMARY KEY (card_id, email));
CREATE INDEX card_emails_lookup ON card_emails (user_id, email);
CREATE TABLE card_phones (card_id INTEGER NOT NULL, user_id INTEGER NOT NULL, digits TEXT NOT NULL, PRIMARY KEY (card_id, digits));
CREATE TABLE card_photos (card_id INTEGER PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL, bytes INTEGER NOT NULL, etag TEXT NOT NULL);
CREATE TABLE card_tombstones (user_id INTEGER NOT NULL, card_id INTEGER NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, card_id));
CREATE TABLE card_versions (user_id INTEGER PRIMARY KEY, version INTEGER NOT NULL);   -- the counter per person for ?since=
CREATE TABLE card_groups (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, color TEXT, created_at INTEGER NOT NULL);
CREATE TABLE card_group_members (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL, card_id INTEGER, email TEXT, name TEXT);
CREATE INDEX card_group_members_group ON card_group_members (group_id);
CREATE TABLE card_dup_ignored (user_id INTEGER NOT NULL, a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (user_id, a, b));
CREATE TABLE card_prefs (user_id INTEGER PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);

-- The calendar / address book side of an account (what = 'calendar' | 'contacts'): its state for Account.calendar /
-- Account.contacts (ok | syncing | auth_failed | unreachable | consent_required | none), the server's host and the home
-- set found by the discovery (CalDAV / CardDAV), when it was asked.
CREATE TABLE pim_state (
  account_id INTEGER NOT NULL,
  what       TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'syncing',
  error_code TEXT,
  error_at   INTEGER,
  server     TEXT,
  home       TEXT,
  checked_at INTEGER,
  PRIMARY KEY (account_id, what)
);

-- Accounts: the Microsoft scopes granted and the switches.
ALTER TABLE accounts ADD COLUMN ms_scopes TEXT;            -- NULL = the scopes of Phase 1
ALTER TABLE accounts ADD COLUMN calendar_sync INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN contacts_sync INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN caldav_url TEXT;
ALTER TABLE accounts ADD COLUMN carddav_url TEXT;
ALTER TABLE accounts ADD COLUMN dav_username TEXT;
ALTER TABLE messages ADD COLUMN invite TEXT;               -- request | cancel | reply | counter | NULL
