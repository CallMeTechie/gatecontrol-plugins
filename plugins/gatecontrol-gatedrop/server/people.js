'use strict';

// Who is who: the accounts (gc.users), Familie's parents (service family_roles), the person's devices
// (gc.devices.list, GateControl ≥ 1.193.0), what the other plugins offer right now (gc.services.available),
// whether the person can save into their own Drive (the Drive plugin's list_areas, cached per person),
// whether public links are on (gc.publicLinks), and the people table (language for pushes, kiosk marks).
//
// Permission rules (contract B): sending to people and to one's own devices — every account, never a kiosk
// device; links for outsiders and NAS folders — administrators and Familie's parents; one's own Drive — every
// account with a Drive seat.

const store = require('./store');

const MESSENGER = 'gatecontrol-messenger';
const SYNOLOGY = 'gatecontrol-synology';
const FAMILIE = 'gatecontrol-familie';
const DRIVE = 'gatecontrol-drive';
const ROLES_MS = 10 * 60000;    // family_roles at most every 10 minutes (60 service calls per hour for everything)
const FOLDERS_MS = 5 * 60000;   // list_drop_folders
const LINKS_MS = 60000;         // is the administrator's switch on?
const DRIVE_MS = 30 * 60000;    // list_areas per person: GateDrop has 60 service calls per hour for everything
const DRIVE_RETRY_MS = 60000;   // … after a call that did not answer (rate limit, timeout)
const DRIVE_KEEP = 500;         // people remembered at most

const cache = { roles: null, folders: null, links: null, drive: new Map() };

function reset() { cache.roles = null; cache.folders = null; cache.links = null; cache.drive.clear(); }

/** Enabled accounts → Map id → { id, name, role, avatarUrl, initials, colorHex }. */
async function users(gc) {
  let list = [];
  try { list = await gc.users.list(); } catch { list = []; }
  const out = new Map();
  for (const u of Array.isArray(list) ? list : []) {
    if (u && Number.isSafeInteger(u.id)) out.set(u.id, { id: u.id, name: u.name || `#${u.id}`, role: u.role, avatarUrl: u.avatarUrl || null, initials: u.initials || null, colorHex: u.colorHex || null });
  }
  return out;
}

/** Would gc.services.call reach that service now (never throws)? */
async function available(gc, plugin, service) {
  if (!gc.services || typeof gc.services.available !== 'function') return false;
  try { return (await gc.services.available(plugin, service)) === true; } catch { return false; }
}

/** Familie's { parents, children } (cached) or null when Familie does not answer. */
async function roles(gc, now = Date.now()) {
  if (cache.roles && now - cache.roles.at < ROLES_MS && now >= cache.roles.at) return cache.roles.value;
  let value = null;
  if (await available(gc, FAMILIE, 'family_roles')) {
    try {
      const r = await gc.services.call({ plugin: FAMILIE, service: 'family_roles', payload: {} });
      const ids = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => Number.isSafeInteger(x) && x > 0))] : null);
      if (r && r.ok !== false && ids(r.parents) && ids(r.children)) value = { parents: ids(r.parents), children: ids(r.children) };
    } catch { value = null; }
  }
  cache.roles = { at: now, value };
  return value;
}

/** May this person create links for outsiders and save into NAS folders? Administrators and Familie's parents. */
async function canShare(gc, user, now) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const r = await roles(gc, now);
  return !!(r && r.parents.includes(user.id));
}

/** The NAS drop folders of the Synology plugin (cached) → [{ id, label, path }] ([] when not offered). */
async function folders(gc, now = Date.now()) {
  if (cache.folders && now - cache.folders.at < FOLDERS_MS && now >= cache.folders.at) return cache.folders.value;
  let value = [];
  if (await available(gc, SYNOLOGY, 'list_drop_folders')) {
    try {
      const r = await gc.services.call({ plugin: SYNOLOGY, service: 'list_drop_folders', payload: {} });
      const list = Array.isArray(r) ? r : (r && Array.isArray(r.folders) ? r.folders : []);
      value = list.filter((f) => f && Number.isSafeInteger(f.id) && typeof f.path === 'string' && f.path.startsWith('/'))
        .map((f) => ({ id: f.id, label: typeof f.label === 'string' && f.label ? f.label.slice(0, 80) : f.path, path: f.path.slice(0, 400) }))
        .slice(0, 50);
    } catch { value = []; }
  }
  cache.folders = { at: now, value };
  return value;
}

/** Are public links on (permission + the administrator's switch)? Probed with gc.publicLinks.list, cached a minute. */
async function linksEnabled(gc, userId, now = Date.now()) {
  if (cache.links && now - cache.links.at < LINKS_MS && now >= cache.links.at) return cache.links.value;
  let value = false;
  if (gc.publicLinks && typeof gc.publicLinks.list === 'function') {
    try { await gc.publicLinks.list({ ownerUserId: userId }); value = true; } catch { value = false; }
  }
  cache.links = { at: now, value };
  return value;
}

function forgetLinks() { cache.links = null; }

/** Remember whether `userId` can save into their own Drive (also from a delivery's outcome). */
function setDrive(userId, value, now = Date.now(), ttl = DRIVE_MS) {
  if (cache.drive.size >= DRIVE_KEEP && !cache.drive.has(userId)) cache.drive.clear();
  cache.drive.set(userId, { at: now, until: now + ttl, value: value === true });
}

/**
 * Can this person save into their own Drive (target "Mein Drive")? The Drive plugin offers save_file, and its list_areas
 * for the person answers with a writable area of their own ('mine') — no seat or no licence → false. Cached per person
 * (30 minutes; a minute when Drive did not answer); a delivery's outcome updates it.
 */
async function drive(gc, userId, now = Date.now()) {
  if (!(await available(gc, DRIVE, 'save_file')) || !(await available(gc, DRIVE, 'list_areas'))) return false;
  const c = cache.drive.get(userId);
  if (c && now < c.until && now >= c.at) return c.value;
  let value = false;
  let ttl = DRIVE_MS;
  try {
    const r = await gc.services.call({ plugin: DRIVE, service: 'list_areas', userId, payload: {} });
    value = !!(r && r.ok === true && Array.isArray(r.areas) && r.areas.some((a) => a && a.kind === 'mine' && a.writable === true));
  } catch { value = false; ttl = DRIVE_RETRY_MS; }
  setDrive(userId, value, now, ttl);
  return value;
}

/** The person's own app installations (no web clients) → [{ id, name, platform, online, lastSeen, via }]. */
async function devicesOf(gc, userId) {
  if (!gc.devices || typeof gc.devices.list !== 'function') return [];
  let list = [];
  try { list = await gc.devices.list({ userId }); } catch { list = []; }
  return (Array.isArray(list) ? list : []).filter((d) => d && typeof d.id === 'string' && d.platform !== 'web')
    .map((d) => ({ id: d.id, name: typeof d.name === 'string' && d.name ? d.name.slice(0, 80) : d.id, platform: d.platform || null, online: d.online === true, lastSeen: d.lastSeen || null, via: d.via || null }));
}

/** Remember the viewer's language (pushes to them) — never a kiosk device. */
async function touch(gc, user, lang, now) {
  await store.run(gc, 'INSERT INTO people (user_id, lang, seen_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET lang = excluded.lang, seen_at = excluded.seen_at',
    [user.id, lang === 'en' ? 'en' : 'de', now]);
}

async function markKiosk(gc, userId, now = Date.now()) {
  await store.run(gc, 'INSERT INTO people (user_id, kiosk, seen_at) VALUES (?, 1, ?) ON CONFLICT(user_id) DO UPDATE SET kiosk = 1', [userId, now]);
}

async function kioskIds(gc) {
  return new Set((await store.all(gc, 'SELECT user_id FROM people WHERE kiosk = 1')).map((r) => r.user_id));
}

async function langOf(gc, userId) {
  const r = await store.one(gc, 'SELECT lang FROM people WHERE user_id = ?', [userId]);
  return r && r.lang === 'en' ? 'en' : 'de';
}

module.exports = { MESSENGER, SYNOLOGY, FAMILIE, DRIVE, users, available, roles, canShare, folders, linksEnabled, forgetLinks, drive, setDrive, devicesOf, touch, markKiosk, kioskIds, langOf, reset };
