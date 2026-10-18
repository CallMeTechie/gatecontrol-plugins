'use strict';

// The admin pages' API (administrators in GateControl's admin UI only, never a
// portal or app caller). Numbers, storage and errors — never a message text, a
// group title, a file name, a member list or who writes to whom.
//
//   GET admin/overview      counts, storage (gc.media.usage + per type), licence
//   GET admin/settings      the settings + the media limits of GateControl (read only)
//   PUT admin/settings      { retentionDays, allowDisappearing, editWindowMin, maxVoiceS, allowStories, allowActions, defaults: { readReceipts, typing, preview } } (partial)
//   1.4.0: overview.v14 — counts only (statuses, stories, polls, events, live arrivals, home actions, blocks, reminders)
//   GET admin/log?days=     errors and limits (log.js)

const store = require('./store');
const config = require('./config');
const people = require('./people');
const { fail, posInt, iso } = require('./util');

const DAY = 86400000;

/** Midnight of `now` in the server's time zone (the plugin process has the server's TZ). */
function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function media(gc) {
  try { return await gc.media.usage(); } catch { return null; }
}

async function overview(gc, now) {
  const users = await people.users(gc, now);
  const day0 = startOfDay(now);
  const n = async (sql, args) => { const r = await store.one(gc, sql, args || []); return r ? Number(r.n) || 0 : 0; };
  const kiosk = new Set((await store.all(gc, 'SELECT user_id FROM prefs WHERE kiosk = 1')).map((r) => r.user_id));
  const active = await store.all(gc, 'SELECT user_id FROM prefs WHERE last_seen >= ?', [day0]);
  const byKind = { image: 0, voice: 0, file: 0, avatar: 0 };
  for (const r of await store.all(gc, 'SELECT kind, SUM(bytes) AS b FROM media WHERE orphan = 0 GROUP BY kind')) if (r.kind in byKind) byKind[r.kind] = Number(r.b) || 0;
  const lic = await gc.license.status().catch(() => null);
  return {
    accounts: { total: [...users.keys()].filter((id) => !kiosk.has(id)).length, activeToday: active.filter((r) => users.has(r.user_id)).length, kiosk: kiosk.size },
    conversations: {
      total: await n('SELECT COUNT(*) AS n FROM conversations c WHERE EXISTS (SELECT 1 FROM members m WHERE m.conv_id = c.id AND m.left_at IS NULL)'),
      direct: await n("SELECT COUNT(*) AS n FROM conversations c WHERE kind = 'direct' AND last_msg_id IS NOT NULL"),
      groups: await n("SELECT COUNT(*) AS n FROM conversations c WHERE kind = 'group' AND managed_by IS NULL AND EXISTS (SELECT 1 FROM members m WHERE m.conv_id = c.id AND m.left_at IS NULL)"),
      managed: await n('SELECT COUNT(*) AS n FROM conversations c WHERE managed_by IS NOT NULL AND EXISTS (SELECT 1 FROM members m WHERE m.conv_id = c.id AND m.left_at IS NULL)'),
      disappearing: await n('SELECT COUNT(*) AS n FROM conversations WHERE disappearing_s > 0'),
    },
    messages: {
      today: await n("SELECT COUNT(*) AS n FROM messages WHERE created_at >= ? AND (kind != 'system' OR via IS NOT NULL)", [day0]),
      fromPluginsToday: await n('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ? AND via IS NOT NULL', [day0]),
      last7Days: await n("SELECT COUNT(*) AS n FROM messages WHERE created_at >= ? AND (kind != 'system' OR via IS NOT NULL)", [now - 7 * DAY]),
      total: await n("SELECT COUNT(*) AS n FROM messages WHERE kind != 'system' OR via IS NOT NULL"),
    },
    storage: { usage: await media(gc), byKind },
    v14: {
      statusesActive: await n('SELECT COUNT(*) AS n FROM statuses WHERE until IS NULL OR until > ?', [now]),
      storiesActive: await n('SELECT COUNT(*) AS n FROM stories WHERE expires_at > ?', [now]),
      pollsOpen: await n('SELECT COUNT(*) AS n FROM polls WHERE closed_at IS NULL AND (closes_at IS NULL OR closes_at > ?)', [now]),
      eventsUpcoming: await n('SELECT COUNT(*) AS n FROM events WHERE cancelled = 0 AND starts_at > ?', [now]),
      arrivalsLive: await n("SELECT COUNT(*) AS n FROM arrivals WHERE state = 'live'"),
      actionMessages7Days: await n("SELECT COUNT(*) AS n FROM action_msgs WHERE mode != 'card' AND created_at >= ?", [now - 7 * DAY]),
      cards7Days: await n("SELECT COUNT(*) AS n FROM action_msgs WHERE mode = 'card' AND created_at >= ?", [now - 7 * DAY]),
      blocks: await n('SELECT COUNT(*) AS n FROM blocks'),
      remindersPending: await n('SELECT COUNT(*) AS n FROM reminders WHERE sent_at IS NULL'),
      actionsAvailable: !!(gc.actions && typeof gc.actions.list === 'function' && typeof gc.actions.run === 'function'),
    },
    errors7Days: await n('SELECT COALESCE(SUM(count), 0) AS n FROM log WHERE last_at >= ?', [now - 7 * DAY]),
    license: lic ? { required: !!lic.required, licensed: !!lic.licensed, state: lic.state || null, expiresAt: lic.expiresAt || null } : null,
  };
}

async function settings(gc) {
  const cfg = await config.load(gc);
  return {
    settings: cfg,
    options: { retentionDays: config.RETENTION_DAYS, editWindowMin: config.EDIT_WINDOW_MIN, maxVoiceS: config.VOICE_MAX_S, disappearingS: config.DISAPPEARING_S },
    media: await media(gc),
  };
}

async function logPage(gc, query, now) {
  const q = query || {};
  const days = q.days == null || q.days === '' ? 7 : posInt(String(q.days));
  if (!days || days > 30) throw fail('invalid');
  const rows = await store.all(gc, 'SELECT * FROM log WHERE last_at >= ? ORDER BY last_at DESC LIMIT 500', [now - days * DAY]);
  return { days, entries: rows.map((r) => ({ id: r.id, at: iso(r.at), lastAt: iso(r.last_at), level: r.level, code: r.code, detail: r.detail || null, count: r.count })) };
}

async function route(req, gc, seg, now) {
  const m = String(req.method || 'GET').toUpperCase();
  const [, a] = seg;
  if (seg.length === 2 && a === 'overview' && m === 'GET') return overview(gc, now);
  if (seg.length === 2 && a === 'settings' && m === 'GET') return settings(gc);
  if (seg.length === 2 && a === 'settings' && (m === 'PUT' || m === 'PATCH')) { await config.update(gc, req.body); return settings(gc); }
  if (seg.length === 2 && a === 'log' && m === 'GET') return logPage(gc, req.query, now);
  throw fail('not_found');
}

module.exports = { route, overview, settings, logPage };
